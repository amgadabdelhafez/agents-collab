# D-028 Installed-binary manifest forward compatibility

## Problem

T-15 still described additive `tmuxSocket` compatibility as an inference and
bound the check to an installed-binary SHA captured earlier in T-00. Runtime
truth changed after restart, so the old snapshot cannot certify the currently
installed binary.

## Required behavior

- Reverify the installed binary version and SHA immediately before use.
- Copy the checked-in producer manifest into an isolated HOME.
- Put a denying trace wrapper first on PATH so no live supervisor server can be
  contacted, including through the fixture's explicit `-S` socket.
- Exercise a read-only installed-binary command and record its exact outcome.
- Prove the copied fixture is byte-identical before and after.
- Record the old SHA as a superseded snapshot, not current evidence.

## Acceptance

- `governess doctor 1` exits zero and reports `checks.manifest: true`.
- The trace proves every tmux attempt was intercepted and rejected.
- The copied manifest hash is unchanged and no additional isolated file exists.
- Evidence records the observed v1.0.38 SHA and the T-00 snapshot drift.
- No install, product lane, live run, or modernization file is changed.
