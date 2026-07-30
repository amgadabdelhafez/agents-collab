# Plan: Utility Health Fail-Open

1. Add a bounded, pure readiness reader for dispatcher and tier inference
   evidence.
2. Select the normalized execution tier in the hook and fail open unless its
   leases are fresh.
3. Feed recent tier failures into runtime tier health as a short circuit while
   leaving unknown/expired state probeable by explicit requests.
4. Add focused hook/runtime tests and stabilize the redraw smoke startup.
5. Run focused and full verification, write the run eval, then build and
   announce any deployment with exact commit and SHA-256.
