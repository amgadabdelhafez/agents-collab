# PLAN — Provider-Neutral OSS Agent Seat

Spec bundle: `specs/oss-agent-seat/{spec,plan,tasks,verify}.md`
Branch: `codex/glm-full-agent`. Base commit: `0f69b9a99f9163bf9f83075530e26aed21258463`.
Package under change: `loop-fork/`.

## Decision recap

Launchable full-agent topology becomes `claude | codex | oss`. `oss` is backed by
the OpenCode CLI and takes any `provider/model` identifier; `openrouter/z-ai/glm-5.2`
is only the default. `gemini`, `cursor`, `copilot` are retired: still parseable in
historical manifests for diagnosis and reaping, never launchable or resumable.

## Verified environment facts (measured 2026-08-06, not assumed)

- `opencode` 1.4.3 at `/Users/amgad/.opencode/bin/opencode`.
- `opencode run` supports `-m provider/model`, `-s/--session <id>`, `--format json`,
  `--title`, `--variant`, `--dangerously-skip-permissions`, `--print-logs`.
- `opencode run --session <unknown-id>` fails with `Session not found: <id>`.
  Session IDs therefore **cannot** be pre-assigned; the first turn runs without
  `--session`, the ID is captured from the JSON event stream and persisted, and
  later turns resume with `--session <persisted-id>`.
- Config isolation, measured with a positive control (a fake global config dir
  holding an MCP server `user-noise`):
  - `OPENCODE_CONFIG=<file>` does **not** isolate: global + project entries still merge.
  - `OPENCODE_CONFIG_DIR=<run-scoped dir>` **does** drop the user global config
    (`user-noise` absent), and a same-named entry in the run-scoped config wins
    over a project-level `opencode.json`.
  - A repository-level `opencode.json` in the working tree still contributes.
    That is project configuration, not unrelated *user* configuration; recorded
    as a known limit rather than claimed away.
- Bus event names present in the binary: `session.created`, `session.updated`,
  `session.idle`, `session.error`, `message.updated`, `message.part.updated`.
- `permission` config accepts `{edit, bash, webfetch}` and round-trips through
  `opencode debug config`.

## Work breakdown

1. **Identity split** — `agents.ts`, `types.ts`.
   `Agent = "claude" | "codex" | "oss"`, `RetiredAgent = "gemini" | "cursor" | "copilot"`,
   `HistoricalAgent = Agent | RetiredAgent`. `isAgent` narrows to launchable;
   `isRetiredAgent` / `isHistoricalAgent` added; retired identities get one
   migration message naming `oss`.
2. **CLI surface** — `args.ts`, `constants.ts`.
   Add `--oss-only`, `--oss-model`, `--oss-reviewer-model` (spaced and `=` forms),
   `LOOP_OSS_MODEL`, `DEFAULT_OSS_MODEL = "openrouter/z-ai/glm-5.2"`. Retired
   flags and retired values for `--agent`, `--pair-with/--reviewer`, `--review`,
   `--review-plan` are still *recognised* so they fail closed with the migration
   message instead of a generic "Unknown argument".
3. **OSS adapter** — new `oss-adapter.ts`.
   Run-scoped config dir under the run directory, containing exactly one MCP
   server (the loop bridge, source `oss`) plus an explicit permission policy.
   Argv builder for `opencode run --format json`. Session-ID extraction from the
   JSON event stream. Credentials from provider-native lookup or a mode-0600 key
   file, injected as child env only — never argv, config, manifest, or trace.
4. **Seat wiring** — `runner.ts`, `tmux.ts`, `paired-options.ts`, `run-state.ts`,
   `bridge.ts`, `bridge-utility.ts`, `governess*.ts`, `hooks`, `cli.ts`,
   `session-pressure.ts`, `install.ts`, alias entrypoints.
   Persist `ossSessionId`; route/observe/recover through the persisted pane.
5. **Historical read path** — manifest parsing keeps retired agent values
   (`HistoricalAgent`) so old runs stay inspectable and reapable; launch and
   resume fail before any pane or process is created.
6. **Reviewer authority** — new `review-authority.ts`.
   Release authority is a property of policy, not of occupancy. `claude` and
   `codex` hold it by default; `oss` is advisory unless
   `LOOP_OSS_RELEASE_AUTHORITY=1` grants it. `runReviewWith` only reports
   `approved: true` when an authoritative reviewer passed.

## Acceptance criteria (from `specs/oss-agent-seat/verify.md`)

1. Every ordered distinct pair from `{claude, codex, oss}` parses in either order.
2. `gemini`, `cursor`, `copilot` rejected for agent, pair, review, plan review,
   only-mode flags, model flags, and resume launch.
3. An arbitrary `provider/model` identifier reaches OpenCode unrewritten;
   GLM-5.2 is only the default.
4. Generated OpenCode config is run-scoped, bridge-only, source `oss`, and holds
   no credential value.
5. Persisted OSS sessions resume through their stored session ID.
6. Bridge and governess target the persisted OSS pane, not a numeric assumption.
7. Binding ruling `06fa755e-e432-4239-bb9a-fe924a2989dc`: a named regression
   proves an OSS reviewer APPROVE cannot open the release gate without an
   explicit policy grant, and a mutation deleting the authority check makes that
   regression fail. The mutation is executed and its failure output recorded.

## Verification approach

- Focused: `bun test` on the affected test files.
- Full governed: `bun run check`, `bun run build`,
  `scripts/verify.sh oss-agent-seat oss-agent-seat`, plus an eval.
- Mutation proof for the authority check run explicitly and reverted, with the
  failing test name and output captured under `runs/oss-agent-seat/artifacts/`.
- Peer review by Codex over the bridge, then exact-SHA supervisor review.
  No merge, push, install, or deploy.

## Non-goals

Claiming OSS-model capability parity; auto-granting an OSS reviewer release
authority; reusing the Au Pair worker protocol as a full-agent session; deleting
historical evidence for retired agents.

---

## Run 8 — recovery successor (incident 6b0c37a8-2ead-485c-a6b4-46e10c51c560)

Run-7 source changes are preserved and audited; implementation was not restarted.
The run-7 compiled eval escaped isolation and is the only thing rewritten.

### Additional acceptance criteria adopted this run

The spec's acceptance list stands. These are added because the incident showed
the eval itself was the unsafe component:

1. The eval must be safe **independently of the code under test**. Its isolation
   may not depend on the launcher failing closed.
2. Isolation must be **proven before** any launch-shaped argv is used; if it
   cannot be proven, the eval aborts having run nothing (absence of evidence
   returns nonzero).
3. Zero survivors must be **producer-backed**: the spawned processes record
   themselves, and teardown asserts against those records plus the process
   groups the probe wrapper created.
4. The eval must not perform network I/O, and must not be able to modify the
   artifact under test or any binary outside its sandbox.
5. Every guard must be shown to **fire** on a positive control, not merely to be
   silent on a passing run.

### Verification approach

- Isolation levers: sandbox `$HOME` (`resolveStorageRoot`), sandbox git repo as
  cwd (`resolveRepoId`), `env -i`, PATH stubs, sandboxed binary copy, seeded
  auto-update throttle.
- Controls, each of which must produce the stated outcome:
  - hostile launcher reproducing the incident → contained, zero survivors;
  - base-commit binary → eval fails (discriminates, not fail-open);
  - throttle disabled → network guard fires (guard is non-vacuous);
  - probe cap exceeded and unprovable isolation → exit 2, nothing further runs.
- Binding ruling `06fa755e-e432-4239-bb9a-fe924a2989dc`: both mutation
  directions on `review-authority.ts` must fail named tests, and the file must be
  restored byte-identically.
- `env -u TMUX scripts/verify.sh oss-agent-seat oss-agent-seat` exit 0.

### Decisions taken this run

- The network fix is **harness-side** (seeded throttle + sandboxed `execPath`),
  not a product change. Adding a launcher-level "no auto-update" flag would be a
  product decision beyond this spec; raised with Codex, left to the supervisor.
- Retired-seat bridge-config debris (`.cursor/`, `.gemini/`, `.github/copilot/`)
  is quarantined outside the tree with contents and sha256 preserved in
  `runs/oss-agent-seat/artifacts/quarantine-manifest.txt`. `/.loop/` is gitignored
  and left on disk because the live run writes utility artifacts there.
- `loop-fork/package.json` `bin` had entries for deleted retired entrypoints and
  none for `oss-loop`; fixed. The compiled eval cannot catch manifest-level
  defects because it certifies the binary, not the package manifest.

### Out of scope, deliberately

No merge, push, install, or deploy. No product source change beyond the
`package.json` bin correction. No claim that any OSS model is capable or safe,
and no release authority granted by seat occupancy.
