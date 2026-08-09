# Task d030-manifest-handle-type-import

## Objective

Restore the documented TypeScript gate without changing tmux authority or
runtime behavior.

Regression: yes
Regression id: manifest-handle-private-reexport-assumption
Regression symptom: TS2459 importing private `ManifestHandle` from run-state.
Regression guard: documented tsc command plus migration checker and owning test

## Scope

One type-only import correction, D-030 metadata, and defect backlog. No value
authority, product lane, historical run evidence, or modernization file.

## Verification

- Exact documented TypeScript command: PASS.
- Derived tmux migration checker: PASS.
- Owning pane-liveness suite: 30/30 tests, 94 assertions.
- Ultracite: 205 source-owned files clean.
- Independent evaluation: PASS.
