# Plan

1. Add a process snapshot abstraction that enumerates exact loop executables
   and obtains their full command lines through bounded `ps` calls.
2. Parse only the exact bridge command shape and require a canonical run path
   directly below the configured runs root.
3. Classify the run directory as affirmatively absent, terminal, or unknown;
   preserve every unknown or active case.
4. Re-read the candidate identity immediately before signaling and reject PID
   reuse or any executable/command change.
5. Invoke the sweep beside existing startup maintenance, after the immediate
   helper/version/help bypass and before current-repository abandoned-run GC.
6. Add unit and CLI ordering/bypass regressions, then run focused and full
   verification and request an exact-SHA independent review.
