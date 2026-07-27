# Spec: Governess Usage Display Stability

## Problem

The live Usage Tracker `/stats` endpoint occasionally stalls past the governess
timeout. The pricing-only fallback keeps cost estimates available, but it has no
quota windows, so the limits cell still alternates between a real weekly value
and a partial fallback value. The user still sees the row flicker.

Live run 50 reproduced one timeout in twelve direct probes. Successful probes
returned both provider quota objects and pricing.

## Goal

Keep recently observed quota windows and current local pricing visible through
short transient or incomplete tracker responses, without carrying data across
authentication failures or an unbounded outage.

## Non-goals

- Persisting tracker quota data across governess process restarts.
- Changing Usage Tracker, its lock behavior, scrape cadence, or quota meaning.
- Treating rejected credentials as a transient response.
- Restarting Claude, Codex, or the utility worker.

## Acceptance criteria

- A configured reader retains each provider's last observed quota through a
  transient pricing-only response.
- A partial response can refresh one provider without blanking the other.
- Retained quota expires after a bounded interval.
- A disabled or authentication-rejected reader clears retained quota.
- Current pricing remains authoritative on every response.
- Focused tests, full tests, build, Harness verification, and independent
  evaluation pass or isolate unchanged baseline failures.
- Live run 50 shows stable Codex limits and cost across multiple tracker stalls
  after replacing only the governess pane.
