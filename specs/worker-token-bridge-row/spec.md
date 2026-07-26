# Worker token ceiling and bridge row

## Requirements

- Raise the default worker completion limit from 1,800 to 2,400 tokens and the
  cumulative per-job limit from 8,000 to 16,000 tokens, while retaining both
  environment overrides and existing cost/step caps.
- Add one width-bounded governess row under bridge activity showing worker
  messages in, messages out, pending replies, and the latest in/out ages.
- Count worker input from routed request transcript records and output from
  terminal response transcript records so active work naturally shows pending.
- Preserve the current pane geometry and internal `utility-*` compatibility.

