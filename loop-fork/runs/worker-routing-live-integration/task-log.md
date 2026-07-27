# Task worker-routing-live-integration

Created: 2026-07-27T05:39:27Z
Mode: planned
Description: Integrate the widened utility-worker router with governess usage stability fixes and deploy the current runtime

## What I changed

- Created the task worktree from current `main` (`39e479b`) and wrote the
  integration spec before touching runtime source.
- Ported the three previously verified governess fixes exactly onto current
  main: live session rebinding, transient pricing retention, and per-provider
  quota snapshot retention.
- Added their seven regression tests and kept the widened router source
  unchanged.

## Why

- Run 50 initially retained a pre-widening executable inode after the installed
  path changed. Run 51 then proved the widened router was loaded and that the
  observed low job total came from eligibility and worker satisfiability, not a
  hard five-request ceiling.

## Notes

Regression: yes
Regression id: stale-live-worker-router-binary
Regression symptom: Live governess does not run the merged widened classifier.
Regression guard: combined focused routing/governess suites plus live binary hash and pane PID checks

Live baseline proved the precise deployment fault: the installed binary was
replaced at 22:25 with widened-router code, but pane 2 still had the 22:09
executable inode loaded. Focused combined verification: 222 pass, 0 fail.

The user advanced to run 51 before deployment. Fresh run-51 evidence changed
the diagnosis: its governess and utility pane both loaded the widened 22:25
inode. In the first 17 candidates it routed two bounded reads, while useful Git
metadata commands remained ineligible. The first routed read then churned for
45 model/tool rounds because its 134,990-byte file exceeded the broker's
131,072-byte whole-file ceiling; 17 tool calls were denied and one of the two
pool slots stayed occupied. The task scope was therefore expanded before any
routing/broker implementation to fix both eligibility and satisfiability.

Implemented an exact, fail-closed integration contract instead of increasing
the worker pool blindly:

- Each automatic route now carries a narrow execution profile, so the worker
  only sees the single broker tool that can satisfy that request.
- Added literal-argv `git_inspect` actions for bounded ref resolution, oneline
  logs, stats, branch listing, and object typing, including safe 2-4 command
  metadata chains. Network, mutating, mixed, and malformed Git commands remain
  direct.
- Raised the broker's input-file ceiling from 128 KiB to 1 MiB while retaining
  the existing 64 KiB selected-output ceiling.
- Preserved the runtime-based worker budget; no step-count budget was
  reintroduced.

Verification evidence:

- Red-first verification reproduced 20 expected failures plus the missing
  profile export before implementation.
- Focused Harness unit attempt 003: 283 pass, 0 fail, 795 assertions.
- Full Harness integration attempt 003: 914 pass, 4 fail. Those are the exact
  four pre-existing Codex app/config environment failures on current main;
  the delta added 17 passing tests and zero new failures.
- Smoke attempt 005 passed targeted formatting/checks, build, and
  `git diff --check`.
- The first independent evaluation found two fail-closed gaps: widening the
  shared input-file ceiling also allowed a single oversized search result, and
  an unknown persisted execution profile fell back to unrestricted tools.
  Search output is now checked against the 64 KiB serialized budget, while an
  unknown, non-string, or prototype-named profile exposes zero tools. Both
  findings have dedicated regression coverage.
- Verified executable SHA-256 after those corrections:
  `e04e60191aec2c63e200fc06f0a19693dcf65277b123b36eda5fe6e404e3474a`.

Independent re-evaluation passed with no remaining findings, and both Harness
preflight and stop gate passed. The verified executable was atomically moved to
the canonical install and only run 51 panes 2 (governess) and 3 (worker
display) were respawned. Claude remained PID 22530 and Codex remained PID
22532.

Live acceptance passed:

- `governess doctor 51` reported `ok: true` with every check true.
- Four refresh samples kept the Codex model, weekly limit, and cost populated;
  total estimated cost remained nonzero and continued increasing.
- A post-deploy three-query Git inspection completed with exactly three
  successful `git_inspect` calls and zero tool failures.
- A post-deploy 300-line read of the 134,990-byte file that previously failed
  completed with exactly one successful `read_file` call and zero tool
  failures.
- The live board reached `routed worker 6`, `6j`, and `5ok/1fail`, thereby
  serving beyond the reported five-job symptom. The one failure was an old
  pre-restart claim intentionally fenced by the governess epoch change; it had
  already completed its sole `git_status` tool call successfully.

See `artifacts/live-proof.md` for the exact live identifiers and canary IDs.
