# D5 exact-base red reproduction

## Boundary

- Git HEAD: `6cdb9ad60e7c2b18926a70e25debf877302bc014`
- Production diff before and after: empty under `src/`
- Named regression: `runPairedLoop durably closes a completed run to the supervisor with exact identity`
- Utility environment: `LOOP_UTILITY_ENABLED=0`, `LOOP_UTILITY_DELEGATION_MODE=off`,
  `LOOP_AU_PAIR_ENABLED=0`

## Exact command

```bash
LOOP_UTILITY_ENABLED=0 LOOP_UTILITY_DELEGATION_MODE=off LOOP_AU_PAIR_ENABLED=0 LOOP_D5_REPRO_HOME="$PWD/runs/harvto-d5-silent-completion/artifacts/red/home" bun run test:file -- tests/loop/00-paired-loop.integration.test.ts --test-name-pattern "durably closes a completed run to the supervisor with exact identity"
```

Exit code: `1`.

Decisive output:

```text
expect(received).toHaveLength(expected)

Expected length: 1
Received length: 0

(fail) runPairedLoop durably closes a completed run to the supervisor with exact identity

0 pass
1 filtered out
1 fail
```

## Preserved raw evidence

Run directory:
`artifacts/red/home/.loop/runs/agents-collab-fa87e8608224/d5-supervisor-close/`

- `manifest.json` SHA-256:
  `39153a5dabb8f7fcdc7c18f1373b34124f4cf277c1104a81f33d1282c888e295`
- `transcript.jsonl` SHA-256:
  `66f3e794df0e1c8ee7812ca6e6f07050e28a3039b1d97b821157b5a2b638d98d`
- `bridge.jsonl` SHA-256:
  `2294db91943e7cf8c66ce95dfd2acdf7cecf442a4c40b9bc973e24cca54d4f15`

Manifest terminal facts:

```json
{
  "sourceTaskSha256": "5555555555555555555555555555555555555555555555555555555555555555",
  "workspaceBinding": {
    "repoId": "agents-collab-fa87e8608224",
    "root": "/Users/amgad/dev_projects/agents-collab-harvto-supervisor-defects/loop-fork"
  },
  "repoId": "agents-collab-fa87e8608224",
  "runId": "d5-supervisor-close",
  "state": "completed",
  "status": "done"
}
```

Transcript contains `done-signal-detected`, review `pass`, then status `completed`. Bridge journal
contains only the Codex-to-Claude test message and its `delivered` resolution. It contains zero
`target: "supervisor"` rows and zero `paired-run-completed` payloads.
