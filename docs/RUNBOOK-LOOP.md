# Loop cost reports

From a repository or one of its registered worktrees:

```bash
loop governess cost 38
loop governess cost 38 --json
```

The command reads the existing run manifest and session sources. It does not start or modify a run. Exit 0 means all reported components have prices and attribution; exit 1 means incomplete evidence or invalid input. An incomplete report still includes known components. `costUsd: null` means unknown, never zero. `knownSubtotalUsd` is explicitly partial and must not be treated as the run total.

Routed usage comes from `~/.config/loop/switchyard/routing.jsonl`, overridden by `LOOP_SWITCHYARD_ROUTING_LOG`. Only rows with `task` exactly equal to the Loop run ID are candidates. The report counts excluded unattributed and other-task rows over the whole log. No timestamp join is used. A same-number run under another local repository makes ownership ambiguous and refuses pricing. The header currently carries only a Loop run ID, so per-task reporting has that same granularity; utility-job breakdown is unavailable. The local collision check cannot prove the absence of foreign or deleted runs in an imported log.

Routed USD is derived from prompt/completion token totals times the current public OpenRouter per-token rates. Cache and reasoning counters are subsets, not additional tokens. These standard-rate estimates are not provider-reported invoices, do not reconstruct historic prices, and do not account for provider-specific cache discounts. Every model row shows rates and cache provenance. Local/unknown models have no invented zero rate.

The public models response is fetched without credentials, validated, then atomically cached at `~/.cache/loop/openrouter-models.json` for 24 hours. Fetches emit a bounded timing/status span on stderr. `LOOP_OPENROUTER_PRICE_CACHE` supplies an offline raw models response; missing, stale, future-dated, malformed or incomplete offline evidence is rejected without network fallback. Failed default refresh never falls back to stale data.

Claude and Codex retain `readAgentUsage` and the existing usage-tracker pricing path and environment settings. Reports label transcript tokens, bundled API-equivalent estimates, or usage-tracker credit estimates separately. Missing transcripts or price coverage produce unknown amounts. Existing session-reader limitations (including current-session fallback and model aggregation) remain; these estimates are not subscription invoices.

For a run predating the intake header, routed and full run cost are unknown because the unowned rows cannot establish either task ownership or zero spend. Available subscription components remain visible in the known subtotal. Loop's Pi `usage.jsonl` routed zero costs are not consumed or changed by this command.

Rate schema: [OpenRouter models API](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties). Prior derivation/cache design: harness-engineering `origin/main:.harness/kit/scripts/budget_routing.py` (read-only reference).

## Completion and review attribution

Loop accepts completion, review, and error signals only from the active Codex
app-server thread and turn. An event that names a different thread or turn is
foreign even when its body contains `DONE`, `PASS`, `FAIL`, or a matching error
string. Parsed output from the active turn is authoritative. Raw combined
transport output is a compatibility fallback only when that active parsed
output is empty; the two streams must never be concatenated for a decision.
The raw/combined stream admits only canonical parent `agentMessage` deltas and
completed messages after that ownership check. All supported thread and turn
identity aliases must agree. Outer params alone never attribute an item:
every `threadId`/`thread_id`/`turnId`/`turn_id` alias and every nested
`thread.id`/`turn.id` anywhere in the payload, including the `item` and its
nested records, must name the exact owned thread and turn, or the whole frame
is rejected from parsed, raw, combined, completion, review, and error sinks.
Deltas must be scalar strings; their exact
whitespace and validated item identity are preserved so the renderer can
deduplicate a matching completed message. Collaboration/tool items,
nested child state, turn envelopes, errors, and arbitrary transport metadata
are diagnostic or semantic events, not completion-authoritative text.
Authentic attributed review failures remain failures.

Local-runner approval and input requests also require an active thread or turn
identity. Unattributed requests are refused instead of being assigned to the
only open turn. Process stderr is diagnostic transport output and is not
attributed to a turn.

## Codex app-server ownership and cleanup

App-server startup is serialized in-process. Before connection, the configured
TCP port must have exactly one listening owner and that owner must be the newly
spawned child PID. The same listener ownership is rechecked around connection,
and the exact returned client descriptor's established TCP tuple must have a
reversed server tuple owned by that exact child before initialization or
publication. This connection proof prevents a foreign process from accepting
the socket and handing the listening port back to the intended child. Foreign,
ambiguous, or unverifiable ownership fails startup and closes only the exact
attempted socket/child handles. Delayed exit or close callbacks carry their
launch generation and exact child/socket identity, so an old launcher cannot
clear or close a replacement launch.

Each startup generation also owns its WebSocket-upgrade cancellation signal.
Closing, releasing, or losing that exact generation aborts the pending upgrade
before awaiting child exit. Cancellation rejects startup immediately and
force-terminates the exact raw socket, including a socket delivered after the
cancellation request; it cannot be retried into a newer generation.

Releasing a handed-off app server closes the launcher's exact local client
socket and drops its other local handles; it does not terminate the detached
server now owned by the persistent Loop run.
Unexpected closure before handoff terminates only the exact locally owned
child. These rules do not authorize cleanup of a process inferred solely from
a port, stale manifest, or dirty worktree.

## Draft pull-request publication

The default post-review result is a local handoff. Loop does not push or create
a pull request unless the invocation explicitly supplies
`--publish-draft-pr <remote>`. The value is an exact Git remote name, not a URL.
Loop resolves that named remote's push URL and publishes only when it identifies
a supported GitHub repository. SCP and URL-form remotes pass through the same
positive GitHub owner/repository component grammar; whitespace, controls,
quotes, shell/prompt metacharacters, leading option text, encoded unsafe text,
unsupported protocols, query strings, and fragments fail closed. The validated
repository is still rendered as a shell-quoted `gh --repo` argument. An absent
or unsupported remote produces an accurate local handoff without calling the
publication agent. Existing-PR checks and publication failures remain visible;
a failed publication is never reported as success.
