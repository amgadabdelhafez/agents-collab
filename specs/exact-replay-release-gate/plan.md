# Plan: Exact Replay Release Gate

1. Define strict versioned registration, reviewer-stamp, and observation
   contracts in a pure loop module.
2. Hash the registration bytes, validate exact bindings and chronology, and
   materialize the registered case set.
3. Derive paired baseline/candidate totals and quality bounds from raw cases.
4. Evaluate every preregistered threshold without tolerated failures.
5. Add `loop release-gate verify <registration> <stamp> <observations>` and
   JSON output suitable for durable run evidence.
6. Add table-driven regressions for drift, missing cases, duplicates, stale or
   dissenting stamps, invalid measurements, metric ambiguity, and efficiency
   regression.
