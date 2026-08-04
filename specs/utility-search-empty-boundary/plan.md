# Plan: Utility Search Empty Boundary

1. Reproduce loop 121's absent-directory call directly through the real utility
   tool broker.
2. Separate safely validated absence from every other path-resolution failure.
3. Make only `search_repo` treat validated absence as an empty boundary.
4. Add mixed-boundary and fail-closed negative controls.
5. Run focused and full verification, commit the isolated branch, and request
   exact-SHA supervisor review without deployment.
