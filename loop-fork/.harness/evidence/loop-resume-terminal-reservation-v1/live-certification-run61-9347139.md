# Live certification of the installed 9347139 binary — Run 42 cleared, Run 61 blocked

Recorded by the Run 130 Claude writer. The certification itself was performed by
the supervisor with separately held installation and tmux authorities; this
writer performed **no install and no live tmux operation of any kind**, and the
facts below are transcribed, not produced here.

## Outcome

- Run 42: the installed binary **correctly cleared** the reservation.
- Run 61: explicit tmux certification **failed**. The reservation could not be
  released.

## Read-only truth for the exact legacy run

`/Users/amgad/.loop/runs/agents-collab-fa87e8608224/61/manifest.json`
- SHA-256 `8222eaada187aae0a18e0bb3f68884c5b7402aac8df1e28f792e6dc5bba20569`
- 2636 bytes
- `state` and `status` both `stopped`
- `workspaceReleasedAt` `2026-08-18T18:27:00.000Z`
- `pid` `38844`, dead
- `launchAttemptPid` key absent
- tmux session `agents-collab-loop-61` absent
- `cwd` `/Users/amgad/dev_projects/agents-collab-harvto-supervisor-defects` absent
- `tmuxSocket` `/private/tmp/tmux-501/default` **present**, because it is the
  shared default socket held by other live sessions

Run 61 is never edited.

## The defect

`terminalReleaseGranted` required endpoint `absent` **and** liveness `unknown`.
Endpoint absence was only ever a **proxy** for "the server that owned this
session is gone", and Run 42 made the proxy look exact because its socket file
happened to be gone as well. Run 61 falsifies the generalisation: a positively
absent exact session sitting on a live shared socket can never satisfy conjunct
2, so it is blocked permanently on evidence that in fact proves the runtime is
gone.

## The fix — runtime absence as a two-branch disjunction

Evaluated last, only after every existing provenance, terminal state/status,
release-marker, and PID check has passed positively:

```
runtimeAbsent = (endpoint absent  AND tmux unknown)
             OR (endpoint present AND tmux dead)
```

Exhaustive over the 3x3 product, so nothing is left to inference:

| endpoint \ tmux | live | dead | unknown |
|---|---|---|---|
| absent | block | block | **release** |
| present | block | **release** | block |
| unknown | block | block | block |

- `unknown` endpoint always blocks; unknown is never absence.
- `live` tmux always blocks.
- `present` + `unknown`: a reachable socket that will not answer about this
  session, so we learned nothing.
- `absent` + `dead`/`live`: with no socket the verdict cannot have been obtained
  through the bound endpoint, so it is not evidence about this run.

Both accepted cells are positive proof, and the `present` + `dead` branch is the
stronger fact the endpoint proxy was standing in for.

## Tests

Fixture `run-61-manifest.json.fixture`, byte-exact, 2636 bytes, hash asserted
before any other fixture-derived claim.

Positive: exact Run 61 on the live shared socket with the exact target dead
releases, creating run `62`, with Run 61 bytes and hash unchanged. The test
asserts `existsSync("/private/tmp/tmux-501/default")` as an explicit
precondition, so the shared-socket premise is checked rather than assumed.

Negative controls, each asserting unchanged manifest bytes and a run-directory
listing still exactly `["61"]`, so no counter step or run write precedes the
refusal: present + unknown; present + live; unknown endpoint + dead; absent
endpoint + dead.

RED evidence, recorded rather than rounded up: only the **positive** case failed
against `9347139` (`40 pass, 1 fail`). All four negative controls already passed
there, which is expected — they are guard rails proving the new disjunction did
not widen release beyond its two branches, not defects the change repairs.

No live tmux was created, contacted, or probed by any test. Endpoint states are
driven by a real temp file (present), a nonexistent path (absent), and a
`chmod 000` directory (unknown).

## Risk

Release is genuinely widened: a reachable shared socket plus a dead exact
session now releases where it previously blocked forever. `tmuxLiveness`
correctness is therefore load-bearing for cleanup authority on live sockets. The
four negative controls pin exactly that boundary.
