# Dependency compatibility proof — no install performed

No `bun install`, `npm install`, lockfile write, or dependency change occurred.

## Link created

`loop-fork/node_modules` → `/Users/amgad/dev_projects/agents-collab/loop-fork/node_modules`

A symlink only, ignored by `loop-fork/.gitignore:2` (`git check-ignore -v
node_modules` → `loop-fork/.gitignore:2:node_modules`). It must be removed at
clean closure.

## This checkout's pinned metadata

- `loop-fork/package.json` SHA-256
  `c79cf0a69fb14de061c190c6bda5a93b8fdd5342d06e396d68c807cd6c302588`
- `loop-fork/bun.lock` SHA-256
  `31d0bdb8a54bae9fd4dc29d287013e2a1821041072839b9859c6c9362273c321`

Lock equality with the shared tree's owning checkout does **not** hold and was
not used as the authorization. The proof is package-by-package against *this*
checkout's lock, using the read-only verifier from run 118,
`verify-dependency-tree.py`, invoked as:

```
python3 <verifier> loop-fork/bun.lock loop-fork/package.json \
  /Users/amgad/dev_projects/agents-collab/loop-fork/node_modules
```

Full output: `dependency-tree-verify.txt`.

## Result

```
SUMMARY reachable=161 resolved=146 platform_skipped=15 mismatches=23
```

Decomposed by class, because an aggregate can read wrong while its parts are
fine:

- missing: 0
- version mismatch: 0
- name mismatch: 0
- commit mismatch: 0
- broken symlink: 0
- unreadable package.json: 0
- unresolved lock edge: 0
- workspace/package.json drift: 0
- extra resolution/shadowing: 23

Every one of the 23 is the same class: a physical package root present in the
shared tree that is **absent from this checkout's lock closure**
(`@oxc-project/types`, `@rolldown/*`, `@types/react`, `@types/react-dom`,
`@vitejs/plugin-react`, `csstype`, `detect-libc`, `fdir`, `fsevents`,
`lightningcss`, `lightningcss-darwin-arm64`, `nanoid`, `picocolors`,
`picomatch`, `postcss`, `react`, `react-dom`, `rolldown`, `scheduler`,
`source-map-js`, `tinyglobby`, `vite`). No name our graph resolves matches any
of them, so none can shadow an ancestor or root resolution for this checkout.
The tree is a strict superset of what this lock requires: every one of the 161
reachable edges is satisfied at the exact pinned version, with 15 correctly
skipped as platform/cpu gated.

## Instrument audit

A verifier that cannot fail is not evidence. The decisive fail-open probe was
run: the same verifier against an **empty** directory returned

```
SUMMARY reachable=161 resolved=0 platform_skipped=15 mismatches=146
RESULT: FAIL (146 mismatches)
```

so absence of packages returns nonzero rather than passing.
