# Spec: Exact Replay Release Gate

## Problem

Harness comparisons can look green while changing the model, prompt, tools,
corpus, or metric definitions. Aggregate pass counts also hide efficiency and
correction-churn regressions. A comparison must be registered and independently
reviewed before measurement, then evaluated from raw case observations.

## Required behavior

1. A registration pins the baseline and candidate harness SHAs plus one exact
   model, reasoning effort, prompt hash, tool-config hash, replay-corpus hash,
   and metrics-extractor hash.
2. A detached reviewer stamp binds `CONCUR` to the SHA-256 of the registration,
   its repository-relative path, and a commit containing those exact bytes.
3. The registration commit precedes independent review, and measurement starts
   only after the reviewer stamp timestamp.
4. Every registered replay case must appear exactly once, with the registered
   input hash, in both baseline and candidate observations. Extra, missing, or
   duplicate cases fail closed.
5. Success, token use, tool calls, latency, and correction churn are derived
   from case observations. Submitted aggregate claims are not accepted.
6. Correction churn uses the registered loop-metrics vocabulary:
   reviewer CHANGES rounds before final approval, driver self-retractions, and
   reviewer disproofs. Candidate ambiguity is bounded explicitly.
7. Every configured threshold is mandatory. Missing, malformed, non-finite, or
   negative measurements fail closed.
8. The command exits nonzero and prints all gate failures when the comparison
   is not releasable.

## Non-goals

- Running the agents or generating the observations.
- Replacing independent review or exact-SHA code review.
- Inferring non-derivable quality metrics from prose or subject-line mentions.
- Deploying, merging, or mutating a live loop.

## Acceptance

- Producer-backed tests cover the passing path and every fail-closed boundary
  above, including a green-by-count identity swap.
- The built `loop` binary exposes `release-gate verify`.
- Focused tests, build, changed-file formatting, and `git diff --check` pass.
- An independent evaluator reviews the committed exact SHA before release.
