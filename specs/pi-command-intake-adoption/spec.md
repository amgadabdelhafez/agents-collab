# Pi command intake and lower-tier adoption

## Problem

The shared Pi runtime is installed and Loop 56 has live proof for Direct,
Nanny/Qwen, and Au Pair/GLM, but most mechanical work still stays with Claude
and Codex. At the 2026-07-27 baseline snapshot, Loop 56 had 84 historical
`compound-or-unsafe-command` events; replaying those events through the current
classifier made only one eligible. The utility journal also showed only one
completed Pi Nanny job and one completed Pi Au Pair job.

There are two independent causes:

1. The pre-tool classifier rejects a whole shell line before Pi starts when an
   exact safe read/check chain cannot be represented by the current read-only
   plan schema.
2. The paired-agent prompt says delegation is mandatory, but it does not tell
   either agent to decompose work early, keep lower-tier jobs in flight, or
   distinguish useful Nanny and Au Pair work packets from peer review.

## Goal

Move a materially larger share of bounded repository inspection, focused
verification, and small patch-proposal work off Claude and Codex without giving
either lower model a shell or authority. Deterministic code remains the sole
permission boundary; Pi receives only broker-approved tools after a request is
proven bounded.

## Requirements

### Structured command intake

1. Generalize the existing structured `read-plan` into a bounded execution
   plan that may contain repository-read stages and exact focused-check stages.
   Preserve backward compatibility for persisted `read-plan` jobs.
2. Accept one through eight executable stages separated by literal `&&`, `;`,
   or a mixture, plus bounded literal `echo` labels. Every executable stage must
   independently classify through an existing or newly specified broker-backed
   operation.
3. A focused-check stage must carry exact normalized argv, an exact verified
   cwd, declared file scopes, and its output boundary. The per-stage broker must
   expose only `run_check` for that stage and must revalidate the repository
   command policy.
4. Direct executes a fully structured plan without a model. A plan containing
   an intentionally reasoning-backed search/inspection may use Nanny or Au Pair
   under the existing tier classifier, but models never receive shell text as
   authority or choose their tier.
5. Add exact support for common safe inspection forms observed in Loop 56:
   - `head -N <regular-file>` as a bounded first-lines read;
   - fixed `awk` `NR` prefix/range slices with whitespace-normalized predicates;
   - bounded alternation searches composed only of literal alternatives;
   - no-op terminal `| cat` on an otherwise safe stage;
   - safe git inspection chains already supported by `git_inspect`.
6. Preserve output semantics in structured metadata. Do not pass pipes or
   redirects to a shell. Existing bounded stderr/head/tail behavior remains
   enforced by the broker.
7. Repository-local test executables, arbitrary `node` scripts, and custom
   checks remain unavailable unless a committed `.loop/utility-policy.json`
   explicitly grants an exact broker command policy. This slice does not add a
   default arbitrary-code execution grant.
8. Continue rejecting heredocs, loops, conditionals, substitutions, variable
   expansion, arbitrary redirects, mutation, process control, dependency
   changes, network/remote commands, commits, pushes, PR operations, and paths
   outside a verified repository or registered worktree.
9. One unsupported or unsafe stage rejects the whole automatic candidate. The
   classifier must never execute a safe prefix while silently dropping an
   unsafe suffix.

### Claude and Codex adoption prompts

10. At the start of concrete work, both agents are instructed to identify and
    immediately submit one to three independent bounded packets while keeping
    judgment-heavy work on their own critical path.
11. Guidance names the roles and useful packet shapes:
    - Nanny: small read-only inspection, search, evidence extraction, and
      bounded result synthesis;
    - Au Pair: broader bounded investigation, focused verification, and small
      scoped patch proposals;
    - Direct: exact structured reads/checks chosen automatically by Governess.
12. Agents cannot request a tier. They describe objective, scopes, risk,
    capabilities, and acceptance criteria; Governess chooses the sole owner.
13. Prompts say explicitly that being capable of doing a mechanical task
    natively is not an exemption, that independent lower-tier work should stay
    in flight during implementation, and that returned patches/evidence require
    main-agent review.
14. Prompts discourage opaque compound shell for delegable work and show that
    one bounded `route_task` is preferable to repeated native reads.
15. The same adoption guidance appears in startup prompts, Claude channel
    instructions, and the `route_task` tool description so dynamic instruction
    refreshes do not dilute it.

### Observability and rollout

16. Add compact counters for structured plan routes and prompt-origin explicit
    routes without persisting prompt or command content.
17. Provide a replay artifact for Loop 56 showing old reason, new reason, plan
    stage counts, and safety-retained counts without raw commands.
18. Focused tests, full suite, build, diff check, repository verify, replay, and
    an independent evaluation must pass before installation.
19. Install atomically. Do not restart Claude or Codex. A live hot-swap may
    restart only Governess and the filtered Nanny/Au Pair viewers, then must
    prove the original agent pane IDs/PIDs are unchanged.

## Acceptance

- Mixed safe inspection/focused-check fixtures become structured plans and
  complete through stage-scoped brokers with zero model calls when fully exact.
- Unsafe near-neighbors fail closed before a job is created.
- Loop 56 replay materially improves safe eligibility while every mutation,
  heredoc, interpreter-edit, remote, and unverified-path event remains rejected.
- Prompt tests prove early decomposition, role examples, no tier override, work
  kept in flight, and main-agent review of results.
- A live canary submits one small inspection and one broader bounded task and
  records Nanny and Au Pair Pi usage without changing application source.

## Non-goals

- Giving Pi built-in Bash, Read, Write, or Edit tools.
- Letting an LLM parse shell syntax to grant itself permissions.
- Automatically applying Au Pair patches.
- Routing product, architecture, release, authority, or peer-review decisions
  to a lower tier.
- Adding LiteLLM, a stock interactive Pi CLI, or persistent lower-model chat.
