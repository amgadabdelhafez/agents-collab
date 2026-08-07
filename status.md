# status — Utility scope-satisfiable capabilities and bounded evidence recovery

Worktree: `/private/tmp/agents-collab-utility-scope-evidence-recovery`
Branch: `codex/utility-scope-evidence-recovery`
Base: `defdf74949e34fe69b0f8e8601bba0afa152585f` — supervisor-cleared OSS-seat
lineage, also `main`. Not `origin/main` (`0f69b9a…`, older).
Spec bundle: `specs/utility-scope-evidence-recovery/{spec,plan,tasks,verify}.md`.

Authorized by founder directive relayed as work request
`338d1fcf-6b4a-41fa-9d62-11f9b3f92595`. Plan approved with six required
amendments in `0a27f1ab-9e4f-4522-a70a-aea69aeff0a3`, all applied to the bundle
before any source work.

## State: PAUSED on Defect B, awaiting supervisor bootstrap authority

Per Codex decision `92851faf-9a64-4415-92ed-afd80d6c3c1e`: do not split A, do not
implement unverified B, do not install. Both defects remain the approved scope.
Defect A stays **uncommitted** in this worktree with its RED artifacts preserved.

HEAD is still `defdf74949e34fe69b0f8e8601bba0afa152585f`; nothing committed here.

## Isolation

The Claude kickoff submit guard candidate
`951ea73eb1ab00a2677c3cf93eeeb080daf8f211` lives in a separate worktree,
`/private/tmp/agents-collab-claude-kickoff-submit-guard`, verified clean and
untouched. Nothing from this task may be amended into it.

## Harness map, established from source

- `utility-runtime.ts:1384` → `runLegacyUtilityConversation` (declared `:1302`),
  legacy conversational.
- `utility-runtime.ts:1542` → `runDirectUtilityConversation` (declared `:1491`),
  **Direct — receives no recovery.**
- `utility-runtime.ts:1957` → `runPiUtilityConversation` (declared `:1779`),
  Pi SDK conversational.
- `session.dispose()` at `:1874` and `:1949`, both **before** the assertion at
  `:1957`. The Pi recovery hook must therefore sit inside the `try`, after
  `await session.waitForIdle()`, before the `finally`.

Recorded from source rather than inferred from the line numbers, because the
line numbers alone would have suggested three interchangeable call sites.

## Defect A — implemented, RED-evidenced, green. Uncommitted by instruction.

RED captured on the unmodified base at
`runs/utility-scope-evidence-recovery/artifacts/red-defect-a-unmodified-base.txt`
(sha256 `1c2b38b2b4c75f6f67696cc5835d78a0fe5ed8e20b424d279d266f6cb4644222`):
3 fail / 2 pass. The three failures are the new-behaviour assertions, each
failing for the intended reason — `Expected to not contain: "run_check"`,
`Received: [ "read_file", "run_check" ]`. The two passes are deliberate
preserved-behaviour guards and are green on base by design.

Implementation, `loop-fork/src/loop/utility-tools.ts`:

- `hasSatisfiableCommandCwd()` iterates the declared `commandCwds` and calls
  **`resolveCommandCwd` itself**, so satisfiability and enforcement cannot drift
  apart. No second predicate.
- **Behaviour change worth a reviewer's eye**: `resolveCommandCwd` did not assert
  the cwd is a directory. A declared FILE path passed scope, realpath, and
  containment, and failed later as an opaque spawn error. Added
  `Command cwd is not a directory`. This is what makes reusing the same call a
  correct satisfiability test rather than a looser one, and it makes execution
  fail closed earlier with a clear message.
- `narrowUnsatisfiableCapabilities()` runs last in `validateConfiguration`, once,
  as a broker-creation-time snapshot, narrowing both `allowedTools` and
  `definitions`. Those two lost their `readonly` modifiers so the single
  narrowing can happen; nothing mutates them after `create()` returns.
- Scoped to `run_check` only. No general per-tool satisfiability registry.

Current results: the five new regressions are **5 pass / 0 fail**.

## Suites that can run here, and what they establish

- `utility-tools.test.ts` **49 pass / 0 fail** — the suite most exposed to this
  change, including its eleven `run_check` tests. They are unaffected because
  they supply either an explicit `commandCwds: ["."]` or a directory
  `readScopes` fallback (`["src","tests"]`), so they sit on the satisfiable
  path. Established by running it, not assumed.
- `utility-execution-tier.test.ts` 11/0.
- `utility-observability.test.ts` 5/0.

## The blocker

`utility-runtime.test.ts`, `utility-workspace.test.ts`, and
`utility-pi-harness.test.ts` do not load:

```
error: Cannot find module 'caveman-installer/skills/caveman/SKILL.md' from '.../src/loop/caveman.ts'
0 pass, 1 fail, 1 error
```

This worktree has no `node_modules`; `caveman-installer` is a declared
dependency. **Control**: stashing all changes and rerunning on the unmodified
base reproduces the identical failure, so it is environmental and not caused by
this work.

It blocks Defect B specifically. B lives in `utility-runtime.ts` and its
regressions belong in the two unloadable files, so B's RED-on-base evidence
cannot be produced and B cannot be verified.

`bun install` has **not** been run. `bun.lock` sha256 is
`31d0bdb8a54bae9fd4dc29d287013e2a1821041072839b9859c6c9362273c321`, unchanged,
and `node_modules` does not exist. The founder's install grant is conditional on
supervisor and Codex jointly approving an exact candidate, and there is no
candidate for this task, so the grant does not yet apply. Codex agreed the
condition is circular here and escalated a narrowly scoped exception.

## What should happen next

1. **Supervisor decision required**: authorize one narrowly scoped,
   lockfile-enforcing `bun install` in this worktree only — no global install,
   no accepted lock or dependency changes, with command and output plus pre/post
   lock hash and `git status` captured as evidence. Codex requested this on my
   behalf; I am paused until it answers.
2. On authorization: run the install with that evidence captured, then produce
   B's RED on the untouched base **before** any B source change, per the
   approved order of work.
3. Implement B in both conversational harnesses (Pi and legacy), leaving Direct,
   `CONTEXT_INSUFFICIENT`, fatal and provider errors, the `edit` and `command`
   assertions, and `MAX_CONSECUTIVE_BROKER_REJECTIONS` untouched.
4. Full governed verification, then commit A and B together as one candidate and
   request native Codex exact-SHA review. Stop at supervisor review. No merge,
   rebase, push to main, or deploy.

## Separate, still open

Supervisor disposition of the earlier prohibited `bun install` on the kickoff
task. That gates release of `951ea73eb1ab00a2677c3cf93eeeb080daf8f211`, which
Codex has already technically approved.
