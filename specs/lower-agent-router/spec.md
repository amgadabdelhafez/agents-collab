# Spec: Lower-Agent Router

## Problem

Paired loop runs spend frontier-agent tokens on many bounded repository tasks
that do not require the full conversation, broad product judgment, or a second
frontier model. The current bridge can carry work requests, but it has no
capability router or subordinate execution tier. Adding another value to the
existing `Agent` union would incorrectly make a cheap model eligible as a
primary, reviewer, driver, recovery target, and handoff participant.

## Goal

Add an always-governed execution router that can progressively move bounded
token load from the two main agents to cheaper OSS or local models. The first
utility tier uses `z-ai/glm-5.2` through an OpenAI-compatible endpoint, with
OpenRouter as the default provider.

The route policy, job protocol, tools, evidence, and telemetry must be provider
independent so additional local or hosted tiers can be evaluated and enabled
without changing paired-agent semantics.

## Required capabilities

1. Either main agent, and an optional registered external supervisor, can submit
   a structured route request without relaying through the human.
2. Governess is the only scheduler and job-claim authority. Routing and claims
   are fenced by its current epoch and persisted for replay.
3. A small deterministic router assigns a request to `utility`, `driver`,
   `peer`, or `escalate` using explicit capabilities, risk, scope, health,
   budget, and conflict evidence.
4. The existing full-agent union remains unchanged. Utility workers and bridge
   supervisors use separate participant/capability types.
5. Utility inference and tools run in a separate worker process so provider
   latency or tool failure cannot block governess watchdog ticks.
6. Each utility job receives only its explicit task, governing spec/task refs,
   declared file scope, relevant file excerpts, and tool results. It never
   inherits the paired conversation by default.
7. Utility tools are locally executed through a broker with path, symlink,
   command, environment, output, time, token, and cost limits.
8. Every job records its request, route decision, claim, state transitions,
   model calls, tool calls, usage/cost, artifacts, checks, and compact result.
9. Results return to the requester through the bridge. Large output and patches
   are artifact references rather than injected prompt text.
10. Utility visibility is optional. Worker availability and routing do not
    depend on a pane or external supervisor connection.
11. The execution-tier registry supports later OSS/local tiers with different
    capabilities, costs, context limits, and health without route-code changes.
12. Workspace routing policy supports tier wildcard allowlists, a 0-10
    cost/quality preference, locked defaults, an eligible fallback tier, and
    balanced/price/throughput/latency/tool-call-quality selection metadata.
    These borrow the useful concepts from OpenRouter Routing while remaining
    provider neutral.
13. New paired tmux loops show a compact lower-agent observer by default in the
    top-right. It reports availability, active/queued counts, job state, latest
    bounded tool, and recent completion cost without exposing prompts or
    credentials. `LOOP_UTILITY_PANE=0` is the explicit opt-out.

## P0 routing policy

Utility is eligible only when all of the following are true:

- The request kind is `inspect`, `edit`, or `command`.
- Objective and acceptance criteria are explicit.
- Read/write scope is bounded and does not touch protected or secret paths.
- No destructive, remote, release, product, credential, migration, or broad
  architectural authority is required.
- No active file claim overlaps the requested write scope.
- The configured tier is healthy and within job/run budget.

`review` routes to the main peer. Ambiguous, cross-cutting, or ineligible work
stays with the requester/current driver. Authority decisions escalate. Model
output can never weaken these gates.

## Safety invariants

- Unknown route evidence, stale epochs, missing scope, and malformed jobs fail
  closed and are never claimed by a utility worker.
- Utility cannot commit, push, merge, deploy, delete, change dependencies,
  access credentials, choose product direction, or message the human.
- Provider credentials never enter prompts, manifests, traces, result files,
  child tool environments, or command arguments.
- The default OpenRouter credential may be loaded from a mode-0600 file outside
  the repository, so it does not need to be exported into main-agent process
  environments.
- Patch application validates declared paths and preimage hashes. Existing dirty
  work and concurrent main-agent edits are preserved.
- P0 utility edits are patch proposals only. A full agent remains responsible
  for reviewing and applying them until the guarded apply protocol is verified.
- A disconnected external supervisor cannot stall or change routing.
- A closed utility pane cannot stop the headless worker.
- Pane geometry must not change bridge delivery or governess observation
  targets; actual pane targets are persisted instead of inferred from fixed
  numeric positions.
- Utility failure returns a compact failure/escalation once; it cannot bounce a
  task indefinitely between participants.
- Actual provider usage and cost are persisted; token savings are measured from
  artifacts, not inferred from a successful response.

## Non-goals

- Replacing the two-agent driver/reviewer loop.
- Automatically rerouting the original human task.
- Granting utility workers the complete tools or permissions of main agents.
- Making one provider or model a permanent architectural dependency.
- Automatically widening utility eligibility without replay and live evidence.
