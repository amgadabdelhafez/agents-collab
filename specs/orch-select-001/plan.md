# Plan: workflow engine selection

1. Re-read the exact closure artifacts for the port, fixture, Temporal, and
   DBOS slices and bind their SHAs.
2. Write one architecture decision using only independently accepted evidence.
3. Update the system overview and dependency map from “selection deferred” to
   “Temporal selected,” while retaining DBOS as comparison evidence.
4. Run static and diff checks, freeze one exact commit, and obtain an
   independent zero-write exact-SHA review.
