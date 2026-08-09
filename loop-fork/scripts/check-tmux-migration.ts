#!/usr/bin/env bun

/**
 * AST-based tmux migration guard.
 *
 * The checker resolves file-local const string/array aliases and imported
 * process-runner aliases. It intentionally does not claim interprocedural
 * runtime provenance or arbitrary TmuxLiveness value-flow coverage; those
 * properties remain covered by the manifest-capability types and named
 * consumer tests.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";

export type TmuxMigrationViolationCode =
  | "BARE_ATTACH_FORMATTER"
  | "BARE_LIVENESS_CALL"
  | "DIRECT_TMUX_INVOCATION"
  | "ILLEGAL_AUTHORITY_IMPORT"
  | "PANE_AUTHORITY_WIDENING"
  | "PRIVATE_COMPOSER_IMPORT"
  | "TARGET_FLAG_LITERAL";

export interface TmuxMigrationViolation {
  readonly code: TmuxMigrationViolationCode;
  readonly column: number;
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

const PROCESS_MODULES = new Set(["bun", "node:child_process"]);
const PROCESS_RUNNERS = new Set([
  "execFile",
  "execFileSync",
  "spawn",
  "spawnSync",
]);
const TARGET_FLAGS = new Set(["-S", "-s", "-t"]);
const LIVENESS_NAMES = new Set([
  "tmuxSessionLiveness",
  "tmuxSessionLivenessAsync",
]);
const LAUNCH_ONLY_COMPOSERS = new Set([
  "launchAttachCommand",
  "launchServerArgv",
  "launchSessionArgv",
  "pairedLaunchArgv",
]);
const PANE_EFFECT_RE =
  /(?:capture|kill|paste|respawn|select|send|set|show|split|swap).*pane|pane.*(?:capture|kill|paste|respawn|select|send|set|show|split|swap)/i;
const ATTACH_COMMAND_RE = /^\s*tmux\s+attach(?:-session)?\b/;
const PANE_NAME_RE = /pane/i;
const TMUX_TARGET_TYPE_RE = /\bTmuxTarget\b/;
const PANE_REQUEST_ONLY_MARKER = "@tmux-pane-request-only";
const APPROVED_PANE_REQUEST_MEMBERS = new Set([
  "capturePane",
  "paneCommand",
  "respawnPane",
  "sendKeys",
  "sendText",
  "setGovernessPaneIdentity",
  "setPaneLabel",
]);
const TMUX_SOCKET_MODULE_RE = /(?:^|\/)tmux-socket(?:\.[cm]?[jt]s)?$/;

const sourceFiles = (root: string): string[] => {
  const src = resolve(root, "src");
  const files: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path)) {
      const child = resolve(path, entry);
      const stat = statSync(child);
      if (stat.isDirectory()) {
        visit(child);
      } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
        files.push(child);
      }
    }
  };
  visit(src);
  return files.sort();
};

const literalString = (
  expression: ts.Expression,
  strings: ReadonlyMap<string, string>
): string | undefined => {
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return expression.text;
  }
  if (ts.isIdentifier(expression)) {
    return strings.get(expression.text);
  }
  if (ts.isParenthesizedExpression(expression)) {
    return literalString(expression.expression, strings);
  }
  if (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  ) {
    return literalString(expression.expression, strings);
  }
  return undefined;
};

const literalArray = (
  expression: ts.Expression,
  strings: ReadonlyMap<string, string>,
  arrays: ReadonlyMap<string, readonly string[]>
): readonly string[] | undefined => {
  if (ts.isIdentifier(expression)) {
    return arrays.get(expression.text);
  }
  if (ts.isParenthesizedExpression(expression)) {
    return literalArray(expression.expression, strings, arrays);
  }
  if (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  ) {
    return literalArray(expression.expression, strings, arrays);
  }
  if (!ts.isArrayLiteralExpression(expression)) {
    return undefined;
  }
  const values: string[] = [];
  for (const element of expression.elements) {
    if (ts.isSpreadElement(element)) {
      return undefined;
    }
    const value = literalString(element, strings);
    if (value === undefined) {
      return undefined;
    }
    values.push(value);
  }
  return values;
};

interface PartialArrayValue {
  readonly head?: string;
  readonly knownStrings: readonly string[];
}

const partialArray = (
  expression: ts.Expression,
  strings: ReadonlyMap<string, string>,
  arrays: ReadonlyMap<string, PartialArrayValue>
): PartialArrayValue | undefined => {
  if (ts.isIdentifier(expression)) {
    return arrays.get(expression.text);
  }
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  ) {
    return partialArray(expression.expression, strings, arrays);
  }
  if (!ts.isArrayLiteralExpression(expression)) {
    return undefined;
  }
  const first = expression.elements[0];
  const spreadHead =
    first && ts.isSpreadElement(first)
      ? partialArray(first.expression, strings, arrays)
      : undefined;
  let head: string | undefined;
  if (first) {
    head = ts.isSpreadElement(first)
      ? spreadHead?.head
      : literalString(first, strings);
  }
  const knownStrings = expression.elements.flatMap((element) => {
    if (ts.isSpreadElement(element)) {
      return (
        partialArray(element.expression, strings, arrays)?.knownStrings ?? []
      );
    }
    const value = literalString(element, strings);
    return value === undefined ? [] : [value];
  });
  return { head, knownStrings };
};

const partialArrayBranches = (
  expression: ts.Expression,
  strings: ReadonlyMap<string, string>,
  arrays: ReadonlyMap<string, PartialArrayValue>
): readonly PartialArrayValue[] => {
  if (ts.isConditionalExpression(expression)) {
    return [
      ...partialArrayBranches(expression.whenTrue, strings, arrays),
      ...partialArrayBranches(expression.whenFalse, strings, arrays),
    ];
  }
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  ) {
    return partialArrayBranches(expression.expression, strings, arrays);
  }
  const value = partialArray(expression, strings, arrays);
  return value ? [value] : [];
};

const calleeName = (expression: ts.Expression): string | undefined => {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return undefined;
};

const isExported = (node: ts.Node): boolean =>
  Boolean(
    ts.canHaveModifiers(node) &&
      ts
        .getModifiers(node)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );

const functionName = (node: ts.FunctionLikeDeclaration): string | undefined => {
  if ("name" in node && node.name && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  const parent = node.parent;
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(parent) &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name.text;
  }
  return undefined;
};

const functionIsExported = (node: ts.FunctionLikeDeclaration): boolean => {
  if (isExported(node)) {
    return true;
  }
  const declaration = node.parent;
  return (
    ts.isVariableDeclaration(declaration) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    ts.isVariableStatement(declaration.parent.parent) &&
    isExported(declaration.parent.parent)
  );
};

const exportedTypeAncestor = (
  node: ts.Node
): ts.InterfaceDeclaration | ts.TypeAliasDeclaration | undefined => {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isInterfaceDeclaration(current) ||
      ts.isTypeAliasDeclaration(current)
    ) {
      return isExported(current) ? current : undefined;
    }
    current = current.parent;
  }
  return undefined;
};

const templateHeadText = (node: ts.Node): string | undefined => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    return node.head.text;
  }
  return undefined;
};

const typeText = (parameter: ts.ParameterDeclaration): string =>
  parameter.type?.getText() ?? "";

const lexicalScope = (node: ts.Node): ts.Node => {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isSourceFile(current) ||
      ts.isBlock(current) ||
      ts.isFunctionLike(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return node.getSourceFile();
};

const scopeContains = (scope: ts.Node, node: ts.Node): boolean => {
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === scope) {
      return true;
    }
    current = current.parent;
  }
  return false;
};

const scopeDepth = (node: ts.Node): number => {
  let depth = 0;
  let current: ts.Node | undefined = node.parent;
  while (current) {
    depth += 1;
    current = current.parent;
  }
  return depth;
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This source-file pass enumerates independent syntax kinds; splitting it would obscure the shared alias table.
const scanFile = (root: string, file: string): TmuxMigrationViolation[] => {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const displayFile = relative(root, file);
  const isSocketAuthority = displayFile === "src/loop/tmux-socket.ts";
  const isInstall = displayFile === "src/install.ts";
  const runnerAliases = new Set<string>();
  const runnerNamespaces = new Set<string>();
  const violations: TmuxMigrationViolation[] = [];
  let exactInstallProbeCount = 0;

  const report = (
    node: ts.Node,
    code: TmuxMigrationViolationCode,
    message: string
  ): void => {
    const position = source.getLineAndCharacterOfPosition(
      node.getStart(source)
    );
    violations.push({
      code,
      column: position.character + 1,
      file: displayFile,
      line: position.line + 1,
      message,
    });
  };

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const moduleName = ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : "";
      const clause = statement.importClause;
      const bindings = clause?.namedBindings;
      const isTmuxSocketModule = TMUX_SOCKET_MODULE_RE.test(moduleName);
      if (
        PROCESS_MODULES.has(moduleName) &&
        bindings &&
        ts.isNamedImports(bindings)
      ) {
        for (const element of bindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (PROCESS_RUNNERS.has(imported)) {
            runnerAliases.add(element.name.text);
          }
        }
      }
      if (
        PROCESS_MODULES.has(moduleName) &&
        bindings &&
        ts.isNamespaceImport(bindings)
      ) {
        runnerNamespaces.add(bindings.name.text);
      }
      if (
        !isSocketAuthority &&
        isTmuxSocketModule &&
        bindings &&
        ts.isNamespaceImport(bindings)
      ) {
        report(
          bindings,
          "ILLEGAL_AUTHORITY_IMPORT",
          "tmux-socket namespace imports can expose restricted authority functions"
        );
      }
      if (!isSocketAuthority && bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (imported === "tmuxArgv") {
            report(
              element,
              "PRIVATE_COMPOSER_IMPORT",
              "tmuxArgv is module-private and may not be imported"
            );
          }
          if (
            imported === "createManifestHandle" &&
            displayFile !== "src/loop/run-state.ts"
          ) {
            report(
              element,
              "ILLEGAL_AUTHORITY_IMPORT",
              "createManifestHandle may be imported only by the manifest read path"
            );
          }
          if (
            LAUNCH_ONLY_COMPOSERS.has(imported) &&
            displayFile !== "src/loop/tmux.ts"
          ) {
            report(
              element,
              "ILLEGAL_AUTHORITY_IMPORT",
              `${imported} is restricted to the pre-manifest launch path`
            );
          }
          if (
            imported === "resolveTmuxSocket" &&
            !["src/loop/launch-reservation.ts", "src/loop/tmux.ts"].includes(
              displayFile
            )
          ) {
            report(
              element,
              "ILLEGAL_AUTHORITY_IMPORT",
              "resolveTmuxSocket is restricted to launch reservation and launch"
            );
          }
        }
      }
    }
    if (ts.isExportDeclaration(statement) && !isSocketAuthority) {
      const clause = statement.exportClause;
      const moduleName = ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : "";
      if (!clause && TMUX_SOCKET_MODULE_RE.test(moduleName)) {
        report(
          statement,
          "ILLEGAL_AUTHORITY_IMPORT",
          "tmux-socket export-star barrels can expose restricted authority functions"
        );
      }
      if (
        clause &&
        ts.isNamespaceExport(clause) &&
        TMUX_SOCKET_MODULE_RE.test(moduleName)
      ) {
        report(
          clause,
          "ILLEGAL_AUTHORITY_IMPORT",
          "tmux-socket namespace-export barrels can expose restricted authority functions"
        );
      }
      if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          const exported = element.propertyName?.text ?? element.name.text;
          if (exported === "tmuxArgv") {
            report(
              element,
              "PRIVATE_COMPOSER_IMPORT",
              "tmuxArgv may not be re-exported"
            );
          }
          if (
            exported === "createManifestHandle" ||
            LAUNCH_ONLY_COMPOSERS.has(exported) ||
            exported === "resolveTmuxSocket"
          ) {
            report(
              element,
              "ILLEGAL_AUTHORITY_IMPORT",
              `${exported} may not be re-exported outside its authority module`
            );
          }
        }
      }
    }
  }

  const declarations: ts.VariableDeclaration[] = [];
  const collectDeclarations = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isVariableDeclarationList(node.parent) &&
      node.parent.flags === ts.NodeFlags.Const
    ) {
      declarations.push(node);
    }
    ts.forEachChild(node, collectDeclarations);
  };
  collectDeclarations(source);
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Lexical alias construction deliberately resolves the supported string, argv, partial argv, and runner forms in one scope-ordered pass.
  const aliasesAt = (node: ts.Node) => {
    const strings = new Map<string, string>();
    const arrays = new Map<string, readonly string[]>();
    const partialArrays = new Map<string, PartialArrayValue>();
    const visibleRunnerAliases = new Set(runnerAliases);
    const visible = declarations
      .filter(
        (declaration) =>
          declaration.getStart(source) < node.getStart(source) &&
          scopeContains(lexicalScope(declaration), node)
      )
      .sort((left, right) => {
        const depth =
          scopeDepth(lexicalScope(left)) - scopeDepth(lexicalScope(right));
        return depth || left.getStart(source) - right.getStart(source);
      });
    for (const _pass of visible) {
      for (const declaration of visible) {
        if (!(ts.isIdentifier(declaration.name) && declaration.initializer)) {
          continue;
        }
        const name = declaration.name.text;
        const value = literalString(declaration.initializer, strings);
        if (value !== undefined) {
          strings.set(name, value);
        }
        const argv = literalArray(declaration.initializer, strings, arrays);
        if (argv !== undefined) {
          arrays.set(name, argv);
        }
        const partial = partialArray(
          declaration.initializer,
          strings,
          partialArrays
        );
        if (partial) {
          partialArrays.set(name, partial);
        }
        if (
          ts.isIdentifier(declaration.initializer) &&
          visibleRunnerAliases.has(declaration.initializer.text)
        ) {
          visibleRunnerAliases.add(name);
        }
      }
    }
    return {
      arrays,
      partialArrays,
      runnerAliases: visibleRunnerAliases,
      strings,
    };
  };

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This guard compares independent supported invocation forms and violation classes.
  const inspectRunnerCall = (node: ts.CallExpression): void => {
    const aliases = aliasesAt(node);
    const directRunner =
      (ts.isIdentifier(node.expression) &&
        aliases.runnerAliases.has(node.expression.text)) ||
      (ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        (node.expression.expression.text === "Bun" ||
          runnerNamespaces.has(node.expression.expression.text)) &&
        PROCESS_RUNNERS.has(node.expression.name.text));
    if (!directRunner) {
      return;
    }
    const first = node.arguments[0];
    if (!first) {
      return;
    }
    const argv = literalArray(first, aliases.strings, aliases.arrays);
    const partialArgv = partialArrayBranches(
      first,
      aliases.strings,
      aliases.partialArrays
    );
    const command = literalString(first, aliases.strings);
    const nodeArgs = node.arguments[1]
      ? literalArray(node.arguments[1], aliases.strings, aliases.arrays)
      : undefined;
    const invokesTmux =
      argv?.[0] === "tmux" ||
      partialArgv.some((value) => value.head === "tmux") ||
      command === "tmux";
    if (!invokesTmux) {
      return;
    }
    const exactInstallProbe =
      isInstall &&
      command === "tmux" &&
      nodeArgs?.length === 1 &&
      nodeArgs[0] === "-V";
    if (exactInstallProbe) {
      exactInstallProbeCount += 1;
      if (exactInstallProbeCount === 1) {
        return;
      }
    }
    report(
      node,
      "DIRECT_TMUX_INVOCATION",
      "direct tmux process invocation bypasses the socket authority composers"
    );
    const targetArgs = [
      ...(argv ?? []),
      ...(nodeArgs ?? []),
      ...partialArgv.flatMap((value) => value.knownStrings),
    ];
    if (
      targetArgs.some((arg) =>
        [...TARGET_FLAGS].some(
          (flag) => arg === flag || arg.startsWith(`${flag}=`)
        )
      )
    ) {
      report(
        node,
        "TARGET_FLAG_LITERAL",
        "caller-supplied tmux target flag bypasses authority composition"
      );
    }
  };

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The visitor is a flat set of independent security rules, not branching domain logic.
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      inspectRunnerCall(node);
      const name = calleeName(node.expression);
      if (name && LIVENESS_NAMES.has(name)) {
        report(
          node,
          "BARE_LIVENESS_CALL",
          `${name} accepts a bare session and is forbidden post-migration`
        );
      }
    }
    const attachText = templateHeadText(node);
    if (
      !isSocketAuthority &&
      attachText !== undefined &&
      ATTACH_COMMAND_RE.test(attachText)
    ) {
      report(
        node,
        "BARE_ATTACH_FORMATTER",
        "attach hints must be composed by the socket authority module"
      );
    }
    if (ts.isFunctionLike(node) && functionIsExported(node)) {
      const name = functionName(node) ?? "";
      if (LIVENESS_NAMES.has(name)) {
        report(
          node,
          "BARE_LIVENESS_CALL",
          `${name} exposes socket-blind session liveness and is forbidden post-migration`
        );
      }
      if (PANE_EFFECT_RE.test(name)) {
        const paneStrings = node.parameters.filter((parameter) => {
          const parameterName = parameter.name.getText(source);
          return (
            PANE_NAME_RE.test(parameterName) && typeText(parameter) === "string"
          );
        });
        const hasSeparableTarget = node.parameters.some((parameter) =>
          TMUX_TARGET_TYPE_RE.test(typeText(parameter))
        );
        for (const parameter of paneStrings) {
          report(
            parameter,
            "PANE_AUTHORITY_WIDENING",
            hasSeparableTarget
              ? "pane effect accepts separable TmuxTarget and pane string"
              : "pane effect accepts a bare pane string instead of OwnedPaneTarget"
          );
        }
      }
    }
    if (
      (ts.isMethodSignature(node) || ts.isPropertySignature(node)) &&
      exportedTypeAncestor(node)
    ) {
      const owner = exportedTypeAncestor(node);
      if (
        owner &&
        displayFile === "src/loop/governess.ts" &&
        owner.name.text === "GovernessDeps" &&
        APPROVED_PANE_REQUEST_MEMBERS.has(node.name?.getText(source) ?? "") &&
        source.text
          .slice(owner.getFullStart(), owner.getStart())
          .includes(PANE_REQUEST_ONLY_MARKER)
      ) {
        ts.forEachChild(node, visit);
        return;
      }
      const name = node.name?.getText(source) ?? "";
      const functionType =
        ts.isPropertySignature(node) &&
        node.type &&
        ts.isFunctionTypeNode(node.type)
          ? node.type
          : undefined;
      const parameters = ts.isMethodSignature(node)
        ? node.parameters
        : (functionType?.parameters ?? []);
      if (PANE_EFFECT_RE.test(name)) {
        for (const parameter of parameters) {
          if (
            PANE_NAME_RE.test(parameter.name.getText(source)) &&
            typeText(parameter) === "string"
          ) {
            report(
              parameter,
              "PANE_AUTHORITY_WIDENING",
              "exported pane-effect callback accepts a bare pane string"
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
};

export const checkTmuxMigration = (
  root: string
): readonly TmuxMigrationViolation[] =>
  sourceFiles(root).flatMap((file) => scanFile(root, file));

const formatViolation = (violation: TmuxMigrationViolation): string =>
  `${violation.file}:${violation.line}:${violation.column} ${violation.code} ${violation.message}`;

if (import.meta.main) {
  const rootIndex = process.argv.indexOf("--root");
  const root = resolve(
    rootIndex >= 0 ? (process.argv[rootIndex + 1] ?? ".") : "."
  );
  const violations = checkTmuxMigration(root);
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(formatViolation(violation));
    }
    process.exit(1);
  }
  console.log("tmux migration check passed");
}
