# Spec: Lower-Agent Hardening

## Problem

The first governed GLM utility tier has the correct fail-closed architecture,
but six operational gaps limit its usefulness and integrity: focused checks are
hard-coded to `bun test`; detached-worker liveness is inferred only from time;
patch preimages are not guarded at application time; workers inherit the full
loop environment; configuration and route fallback details are too quiet; and
estimate-less jobs do not reserve run budget before usage arrives.

## Goal

Harden the released utility tier before the next loop so repository-specific
verification is usable, dead or over-time workers are reaped externally,
patches can be applied only through a preimage-checked full-agent action,
worker environment inheritance is minimal, failures are visible, and job/run
cost limits remain conservative under concurrency.

## Requirements

1. Keep the deterministic router pure and preserve its existing reason
   taxonomy and fail-closed behavior.
2. Load additional literal-argv focused-check prefixes from a repository-owned
   policy file. Validate its schema, reject shell executables, executable paths,
   shell metacharacters, dangerous options, empty prefixes, and protected or
   dependency-file mutation. Preserve `bun test` as the built-in default.
3. Support Harvto's `npx vitest run <scoped-file>` as a built-in local-only,
   offline check and through the same repository-policy shape without granting
   arbitrary `npx`, options, package download, or shell execution.
4. Persist the utility worker PID in its fenced claim. Governess must check PID
   liveness for claimed/running jobs, externally terminate a live worker that
   exceeds its runtime, transition dead/over-time jobs to a terminal failure,
   deliver one compact escalation, and thereby release their write claims.
   A pre-claim crash remains bounded by the existing claim-start timeout.
5. Add a full-agent-only guarded patch-application bridge tool. It accepts a
   completed edit job plus the expected patch hash, revalidates artifact
   containment, declared write scope, protected/dependency paths, patch hash,
   and every preimage immediately before application. It refuses drift and
   journals applied-at metadata plus postimage hashes. Repeated calls are
   idempotent only while the recorded postimages still match.
6. Spawn detached utility workers with a minimal allowlisted environment:
   `HOME`, safe process/runtime variables, and non-secret `LOOP_UTILITY_*`
   configuration. Never forward unrelated variables, `OPENROUTER_API_KEY`, or
   `LOOP_UTILITY_API_KEY`; the worker reads its credential from the configured
   mode-safe key file.
7. Return a structured utility availability diagnostic without exposing a key.
   The pane and durable route decision must distinguish missing, unreadable,
   empty, non-regular, and overly permissive key files, including a safe
   `chmod 600` remediation where applicable.
8. The observer pane shows the latest route target/reason/detail alongside
   current work, latest tool, and latest usage. Pane state remains read-only and
   cannot affect worker scheduling.
9. An omitted job estimate reserves the tier's maximum job cost. Add an
   explicit run-cost cap and subtract both recorded spend and active-job
   reservations before routing another job.
10. Record delegation eligibility and route outcomes for later hit-rate
    analysis, but do not enforce proactive/forced delegation in this slice.
11. Preserve the key outside repositories, bridge visibility fixes, existing
    paired-agent roles, and provider-neutral tier interfaces.
12. Do not restart, signal, re-pane, or message live loop 43. Release applies
    to subsequent loops through the global `~/.local/bin/loop` entrypoint.
13. Do not push remotely.

## Acceptance criteria

- [ ] Repository policy enables exactly `npx vitest run <scoped-file>` for a
      Harvto-like fixture while malformed/broad policies fail closed.
- [ ] Worker subprocess tests prove unrelated secrets and direct API-key
      variables are absent while the external key-file configuration survives.
- [ ] Dead PID, live PID, pre-claim timeout, runtime kill, stale epoch, and
      terminal-state races have deterministic tests.
- [ ] Guarded patch application passes a clean apply, refuses preimage drift,
      wrong hash, scope escape, protected/dependency targets, symlink escape,
      repeat-after-drift, and non-agent invocation.
- [ ] Pane and task status expose safe key/route diagnostics without credential
      content.
- [ ] Concurrent estimate-less jobs cannot reserve beyond the configured run
      budget.
- [ ] Focused lower-agent/bridge/governess/tmux tests pass.
- [ ] Full `bun test`, `bun run build`, and `git diff --check` run with any
      unrelated baseline failures isolated.
- [ ] The integrated binary is installed through the global entrypoint and a
      disposable new-loop smoke proves the default GLM observer.
- [ ] Loop-43 pane IDs and PIDs are identical before and after release.

## Non-goals

- Making GLM a driver, reviewer, recovery target, or human-facing agent.
- Automatically delegating inferred main-agent actions.
- Giving GLM arbitrary shell, dependency, network, release, or credential
  authority.
- Letting GLM apply its own patch.
- Retrofitting the worker into loop 43.
- Remote push or pull-request creation.
