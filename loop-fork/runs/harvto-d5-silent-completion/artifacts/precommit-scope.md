# D5 Pre-commit Scope Proof

Exact base/HEAD:
`6cdb9ad60e7c2b18926a70e25debf877302bc014`.

Git-derived candidate commit scope contains these 36 exact files:

1. `PLAN.md`
2. `status.md`
3. `loop-fork/.harness/current-task`
4. `loop-fork/.harness/parked-ideas.jsonl`
5. `loop-fork/.harness/tasks.json`
6. `loop-fork/agents/coordination.jsonl`
7. `loop-fork/src/loop/paired-loop.ts`
8. `loop-fork/tests/loop/00-paired-loop.integration.test.ts`
9. `loop-fork/tests/loop/paired-loop.test.ts`
10. `loop-fork/runs/harvto-d5-silent-completion/artifacts/debt/baseline-loc.json`
11. `loop-fork/runs/harvto-d5-silent-completion/artifacts/fix-verification.md`
12. `loop-fork/runs/harvto-d5-silent-completion/artifacts/precommit-scope.md`
13. `loop-fork/runs/harvto-d5-silent-completion/artifacts/pre-task/10-current-task.sh.log`
14. `loop-fork/runs/harvto-d5-silent-completion/artifacts/pre-task/state-invariants.jsonl`
15. `loop-fork/runs/harvto-d5-silent-completion/artifacts/pre-task/state-invariants.log`
16. `loop-fork/runs/harvto-d5-silent-completion/artifacts/red-reproduction.md`
17. `loop-fork/runs/harvto-d5-silent-completion/artifacts/red/home/.loop/runs/agents-collab-fa87e8608224/d5-supervisor-close/bridge.jsonl`
18. `loop-fork/runs/harvto-d5-silent-completion/artifacts/red/home/.loop/runs/agents-collab-fa87e8608224/d5-supervisor-close/claude-mcp.json`
19. `loop-fork/runs/harvto-d5-silent-completion/artifacts/red/home/.loop/runs/agents-collab-fa87e8608224/d5-supervisor-close/codex-home/config.toml`
20. `loop-fork/runs/harvto-d5-silent-completion/artifacts/red/home/.loop/runs/agents-collab-fa87e8608224/d5-supervisor-close/copilot-mcp.json`
21. `loop-fork/runs/harvto-d5-silent-completion/artifacts/red/home/.loop/runs/agents-collab-fa87e8608224/d5-supervisor-close/cursor-mcp.json`
22. `loop-fork/runs/harvto-d5-silent-completion/artifacts/red/home/.loop/runs/agents-collab-fa87e8608224/d5-supervisor-close/gemini-mcp.json`
23. `loop-fork/runs/harvto-d5-silent-completion/artifacts/red/home/.loop/runs/agents-collab-fa87e8608224/d5-supervisor-close/manifest.json`
24. `loop-fork/runs/harvto-d5-silent-completion/artifacts/red/home/.loop/runs/agents-collab-fa87e8608224/d5-supervisor-close/transcript.jsonl`
25. `loop-fork/runs/harvto-d5-silent-completion/eval.json`
26. `loop-fork/runs/harvto-d5-silent-completion/memory/001-initial.md`
27. `loop-fork/runs/harvto-d5-silent-completion/memory/002-promoted-parked-idea.md`
28. `loop-fork/runs/harvto-d5-silent-completion/meta.json`
29. `loop-fork/runs/harvto-d5-silent-completion/parked-idea.md`
30. `loop-fork/runs/harvto-d5-silent-completion/plan.md`
31. `loop-fork/runs/harvto-d5-silent-completion/task-log.md`
32. `loop-fork/specs/harvto-d5-silent-completion/plan.md`
33. `loop-fork/specs/harvto-d5-silent-completion/spec.md`
34. `loop-fork/specs/harvto-d5-silent-completion/tasks.md`
35. `loop-fork/specs/harvto-d5-silent-completion/verify.md`
36. `runs/harvto-d5-silent-completion/eval.json`

Proof:

- The only production file is `loop-fork/src/loop/paired-loop.ts`.
- Test changes are limited to the two paired-loop files listed above.
- `git diff --check` passes.
- Normal and ignore-all-space tracked numstats are identical.
- Git path queries return no Harvto, D6-D12, D15, or D16 changes.
- Secret-pattern scan of D5 run/spec evidence returns no match.
- Generic `PLAN.md` ignore rules hide exact files 30 and 32. They must be force-staged by exact
  path; no other ignored file is in scope.
- Root `.loop/` remains untracked, preserved, and excluded.

No file is staged at this handover boundary.
