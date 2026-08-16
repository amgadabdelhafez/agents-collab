# D16 Observed False-Negative Evidence

Read-only source: loop run 60 under
`/Users/amgad/.loop/runs/agents-collab-fa87e8608224/60/`. No historical file was modified and no
new utility job was routed.

## Scope-audit omission

Utility job `3466ccae-7ca4-4eb9-be18-b645a77aa019` requested a `kind=review`,
`reviewMode=utility-audit`, `executionProfile=git-status` audit of repository root at
`6cdb9ad60e7c2b18926a70e25debf877302bc014`. Its acceptance criteria required every uncommitted
path verbatim with its Git status.

The broker recorded one successful `git_status` call with exit code 0. The terminal utility result
was nevertheless `status=completed` and listed only these eight collapsed status entries:

```text
 M PLAN.md
 M loop-fork/.harness/parked-ideas.jsonl
 M loop-fork/.harness/tasks.json
 M loop-fork/agents/coordination.jsonl
 M status.md
?? .loop/
?? loop-fork/.harness/current-task
?? loop-fork/runs/harvto-d5-silent-completion/
```

Native Git and Claude's later zero-write verification established a ninth entry:

```text
?? loop-fork/specs/harvto-d5-silent-completion/
```

The completed result omitted that entry, reported eight paths as complete, and concluded that no
production or test path existed. The result had no machine-readable authoritative path count/hash
for a consumer to reconcile.

## Existence inversion

Utility job `6747f5a7-f35a-446d-9690-3b7f64feed42` requested inspection of the omitted D5 spec
bundle. Its broker `list_files` call succeeded, but the terminal result said the directory was empty
and all of `spec.md`, `plan.md`, `tasks.md`, and `verify.md` were absent. Native inspection found all
four files; Claude recorded sizes 2589, 3505, 1482, and 2342 bytes respectively.

This second result is supporting evidence that a successful broker call does not make synthesized
prose complete. D16 remains scoped to authoritative scope-audit evidence and its consumer.

## Provenance hashes

```text
4e0a97756dad5c89893472df4328aa764709bcc06d6190c296f7b4db6178e08a  utility/jobs.jsonl
b5d71b73689c85c04db743b4972678d8b61934289193192cf2e0d82b8f205bc7  utility/contexts/3466ccae-7ca4-4eb9-be18-b645a77aa019.json
b54a334f509bbb95223f1280ff7db03951ea899a671f750efc5759acbde44a4b  utility/contexts/6747f5a7-f35a-446d-9690-3b7f64feed42.json
499246e0d1b279ac2dea10688882658696ff7de742bd6a3b006a394850a1969d  utility/tool-events.jsonl
842e6603960f5b63081405fb574316165ba53deb1555d6e193f1cedafa46a6f3  utility/usage.jsonl
```

The usage ledger records the first job on OpenRouter `z-ai/glm-5.2` at `$0.003881967` and the
second on local Nanny at `$0`. That earlier unauthorized result is discarded; this D16 run performs
no utility routing or spend.
