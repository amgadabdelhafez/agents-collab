# Plan: Lower-Agent Hardening

1. Capture loop-43 identities and create an isolated Harness run.
2. Add validated repository check policy and a Harvto policy fixture/config.
3. Minimize worker launch environment and surface credential diagnostics.
4. Persist claim PIDs and add governess-owned liveness/runtime reaping.
5. Add guarded, idempotent patch application and its bridge surface.
6. Reserve default job costs against an explicit run cap and improve pane route
   visibility.
7. Run focused and full verification, build, integrate locally, atomically
   install through the global entrypoint, and prove loop 43 unchanged.
