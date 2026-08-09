# Phase 0B Verification

The slice passes only when all of the following are true:

1. A legal transition succeeds and an illegal transition returns a stable
   `ILLEGAL_TRANSITION` rejection.
2. Admission with an incomplete dependency returns `DEPENDENCY_BLOCKED` and
   admission at the WIP limit returns `WIP_LIMIT_REACHED`.
3. Release approval without explicit deterministic approval returns
   `APPROVAL_REQUIRED`.
4. The default timezone is `America/Los_Angeles`; winter and summer cases prove
   portfolio-local `00/08/16` boundaries across different UTC offsets.
5. A handoff becomes acknowledged only after every required acknowledger has
   acknowledged it, and its worker continuity remains `preserve`.
6. Strict scoped typecheck, static check, build smoke, and `git diff --check`
   pass.
7. `eval.json` records commands, results, hashes, review, and confirms no live
   service, installed binary, product lane, or defect backlog was changed.
8. One scoped commit is produced without merge, install, push, or activation.
