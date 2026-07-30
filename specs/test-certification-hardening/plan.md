# Plan

1. Reproduce bare `bun test` with exact exit and last completed test file.
2. Isolate the smallest cross-file/lifecycle trigger and correct it, or add an
   immediate explicit guard if the Bun runtime cannot support this mode.
3. Make redraw-smoke cleanup conditional and add bounded failure diagnostics.
4. Add focused regression coverage and apply the local `bytesRead` nit if safe.
5. Run full verification, record eval evidence, and request exact-SHA review.
