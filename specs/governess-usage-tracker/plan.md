# Plan: Governess Usage Tracker Contract

1. Replace the fixed quota DTO with a backward-compatible dynamic snapshot.
2. Add config-token fallback and authenticated retry behavior.
3. Parse aggregate quota windows and exact reset timestamps.
4. Load and validate Usage Tracker pricing catalog data with a current bundled
   fallback, then price the current transcript per provider.
5. Update the compact board labels and dynamic limit rendering.
6. Add contract, auth, pricing, reset, and layout regressions.
7. Build, run full verification, and narrowly deploy the governess pane.
