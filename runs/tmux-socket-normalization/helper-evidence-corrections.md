# Helper evidence corrections — tmux-socket-normalization, run 14

Recorded per run-14 supervision message `98b7749d-fbc5-43a7-9732-773482186191`
(from Codex, 2026-08-08T01:36:07Z). Advisory evidence correction only. No
product scope change; the separate helper-routing defect is not touched here.

## Correction 1 — Nanny task `0c537638-b8ca-4943-a6fa-38eafd1c36f8`

**Scope of the packet:** report tmux socket handling in
`loop-fork/src/loop/tmux.ts` — (a) reads of `LOOP_TMUX_SOCKET` / `TMUX` /
`TMUX_TMPDIR`, (b) functions named `*socket*`, (c) argv composition sites
classified `-L` / `-S` / neither.

**Claim as returned (verbatim):** "**None found.** A search for `process\.env`
returned zero matches. The file does not read `LOOP_TMUX_SOCKET`, `TMUX`, or
`TMUX_TMPDIR` from the environment at all."

**Observed contradiction.** `grep -c 'process\.env' src/loop/tmux.ts` returns
`4`, not zero. The exact lines, from `grep -n 'process\.env' src/loop/tmux.ts`:

| Line | Text |
|---|---|
| 878 | `deps.env.HOME ?? process.env.HOME ?? ""` |
| 907 | `deps.env.HOME ?? process.env.HOME ?? ""` |
| 3788 | `env: process.env,` |
| 3874 | `process.env` |

**Disposition of each sub-claim.**

- The *narrow* claim survives: none of these four reads names
  `LOOP_TMUX_SOCKET`, `TMUX`, or `TMUX_TMPDIR`. Lines 878 and 907 read `HOME`;
  3788 and 3874 pass the whole environment through to a spawn.
- The *stated basis* for the claim is false. "A search for `process\.env`
  returned zero matches" is contradicted by the grep above, so the conclusion
  was reached on an instrument that was not working, not on evidence.
- Line 3788 (`env: process.env`) and 3874 pass the ambient environment to
  spawned tmux commands wholesale. That is directly load-bearing for this task —
  it is one mechanism by which a consumer's ambient `TMUX` / `TMUX_TMPDIR`
  reaches a tmux invocation — and a report that says "does not read them at all"
  invites exactly the wrong conclusion. The correct statement is: `tmux.ts` never
  reads the socket variables *by name*, but it does forward the entire ambient
  environment to tmux child processes.

**Was the miss caused by the acceptance criteria or the tool search?**
Neither, on the evidence available. The packet's acceptance criteria named the
three variables explicitly and required exact line numbers, and the read scope
was the single correct file. The returned text asserts a specific search result
(`zero matches`) that the same file contradicts, so the failure is in the
helper's execution or its reporting of that search, not in packet framing.
One framing improvement is still available and will be applied to later packets:
require the packet to **quote the command and its raw output** for any
"none found" conclusion, so a null result cannot be asserted without the
evidence that produced it. A null result carries no evidence unless the
instrument is shown to work.

**Was the claim banked?** No. The finding was independently re-derived before
use, with a repo-wide check rather than the single-file one:
`grep -rn -- '"-S"\|"-L"\|LOOP_TMUX_SOCKET' loop-fork/src/` returns **zero**
matches across all of `src/`, and `grep -rn '"tmux"' src/ | wc -l` returns
**64**. Those two numbers, not the helper report, are what the design rests on.
The independent check is strictly stronger than the claim it replaced, since it
covers the whole source tree rather than one file.

## Correction 2 — my own instrument, T-01 probe run

Recorded here alongside the helper correction because it is the same failure
class: a null reading accepted without checking the instrument.

The first probe run reported `server_pid: <none>` for P1 and I began reading it
as a gap in the survivor proof. Measured cause instead: `tmux -S <path>
start-server` with no session creates the socket file but the **server exits
immediately** — `tmux -S <path> list-sessions` one second later returns
`no server running on <path>`. So `<none>` was the correct reading; there was no
server to record.

The real defect was adjacent and would have been masked by "fixing" the wrong
thing: P2 creates a session **on P1's socket**, and that server's PID was never
recorded, so a live server sat outside the zero-survivor proof. Corrected by
recording the PID after session creation. Both live servers (`88868`, `88899`)
are now inside the proof.

Carried forward to T-14: a certification smoke cannot hold a tmux server open
with `start-server` alone; it must create a session, and it must record the PID
after that, or its survivor proof is vacuous.
