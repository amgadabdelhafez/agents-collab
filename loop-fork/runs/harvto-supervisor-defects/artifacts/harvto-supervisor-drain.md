# Harvto Supervisor Defect Drain

Drained at: 2026-08-13T05:00:00Z

This receipt records a read-only import from the Harvto supervisor estate into the Harness
Engineering campaign. The Harvto repository was not modified. "Drained" means every
control-plane incident visible at the exact source revisions below is represented in the
defect matrix and, when unresolved, in the parked Harness backlog. It does not mean every
defect is fixed.

## Exact source cursor

| Source | SHA-256 | Contribution |
|---|---|---|
| `/Users/amgad/harvto/docs/team/weeks/2026-W33.md` | `58e1ea1f28075e3c0634b7f4e1e51983a421ff9ae53dfaa37a4f4bac08399a90` | D1-D12 incident evidence |
| `/Users/amgad/harvto/docs/team/backlog.md` | `091581bfdcd4f4d2dd5faa795d6c9505f57651f3bffe512d3def58ea23baa11c` | No additional control-plane incident |
| `/Users/amgad/harvto/STATUS.md` | `f90b4b1e5b2a6a798e01f4d89833ec287cb3e9fd42b1e88ce6f20da87912d5d3` | No additional control-plane incident |

A future drain must recompute these hashes. A changed hash is new input and invalidates only
the claim that this receipt covers the later version.

## Incident census and durable disposition

| Id | Harvto supervisor incident | Disposition |
|---|---|---|
| D1 | TTL expiry/dead-letter ignores live-peer delivery opportunity | Confirmed P0; parked as `harvto-d1-live-peer-expiry` |
| D2 | Dead manifests and crashed starts retain workspace ownership by prose | Fixed and peer-PASSED at `267c14b3059e87bcc34e81179e1c31c7b01135ca` |
| D3 | `route_task` remains `pending-route` forever without eligible capacity | Confirmed P1; parked as `harvto-d3-pending-route` |
| D4 | Routed peer message remains unconsumed while peer is live | Open P0; parked as `harvto-d4-live-peer-unconsumed` |
| D5 | Runs complete without a durable supervisor close signal | Open P1; parked as `harvto-d5-silent-completion` |
| D6 | Read-only tmux attachment prevents targeted recovery delivery | Open P2; parked as `harvto-d6-readonly-attach` |
| D7 | Handoff changes Codex model/effort without command | Open P2; parked as `harvto-d7-handoff-identity` |
| D8 | Stale utility lease routes a write after authority is dead | Open P2; parked as `harvto-d8-stale-write-lease` |
| D9 | One resolved acknowledgement is emitted four times | Open P2; parked as `harvto-d9-duplicate-emission` |
| D10 | Guarded patch apply targets an absent/non-applicable file | Open P2; parked as `harvto-d10-guarded-apply` |
| D11 | Recovery nudges type into two non-empty composers | Open P2; parked as `harvto-d11-composer-nudge` |
| D12 | Discovery globs miss the Harvto tmux socket and report no live run | Open P2; parked as `harvto-d12-socket-discovery` |

Campaign-found D13 and D14 are recorded in the matrix but are not counted as Harvto
supervisor imports. External provider HTTP 402 exhaustion and Harvto product findings remain
explicitly excluded for the reasons in the matrix.

## Completeness check

The W33 control-plane record was swept across courier/dead-letter, delivery, route, liveness,
manifest, tmux/attach/socket, handoff/model, lease/write, duplicate, patch/apply, composer,
and completion/close terms. All resulting incident groups map to D1-D12 above. The Harvto
backlog and STATUS sources added no distinct incident at their recorded hashes. Therefore the
undrained count at this cursor is **zero**; the unresolved count is **eleven**.
