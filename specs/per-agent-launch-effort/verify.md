# Verify

- Default paired launch proves driver=`medium` and reviewer=`medium` in both command lines and manifest.
- Asymmetric launch proves driver=`medium`, reviewer=`high` in the correct provider command regardless of which provider owns each role.
- Per-role CLI overrides global CLI and environment; global CLI overrides role and global environment; role environment overrides global environment.
- Invalid or missing effort arguments fail before startup actions.
- Existing deployed safety symbols remain present.
- Focused argument, tmux, paired-option, and run-state tests pass.
- Full certified suite, formatting, build, and diff check pass.
