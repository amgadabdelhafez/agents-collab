# D6 implementation verification

- Implementation SHA: `254e1749ca67ad1d81cd434ef01db0aeabae5827`
- Parent/base SHA: `ee1e7736d876d4b387f13580ec25ddf1c606e873`
- Commit paths: `src/loop/tmux.ts`, `tests/loop/tmux.test.ts`
- Normal and ignore-all-space numstats matched exactly: source `299/51`, test `511/2`.
- Source SHA-256: `e9fdabb8c367bfbec9998bb3601e9d35183173f472a994e5922c905b895d009e`
- Test SHA-256: `5e11287a399647fb516d5d3fdbdcb609273ce9d59409b49076ed1e5335971db1`

## Red-before

The first and only exact-base named run exited `1`: expected `empty`, received `indeterminate` at
the unchanged blanket active-client gate with zero key calls. Current file SHA-256 values:

- README: `5fee6e797037c3a078fd6d36824baaee4c7cb08ac0720fc145125b1f2c25d8ed`
- command: `b80df25d87d06408fe45a5e4a7f1dec14f21d5f61d0ae0c5bcc4ed49f994883e`
- fixture: `a1585cccf9f57a1806a75f59ef5fdafc5ee17f5e5205c25fdb24c4d6aa389aca`
- output: `8103e398ecb891565fcd4b4fa3c93b35fa28c099cc3b358d1273d216fe766c03`

`fixture.json` was overwritten by canonical formatting at approximately `2026-08-16T08:07Z`, after
its recorded `preserved_at` value `2026-08-16T07:48:38Z`. Because the red directory was untracked,
the original fixture bytes are unrecoverable. Its current sorted semantic SHA-256 is
`49b146cfe996fc0c06e7a4ea0970277628bfd83e63cf405bb38860b9e01dad0a`, but that self-produced value
cannot restore or independently prove the lost byte provenance. The decisive semantics are
corroborated only by the untouched `command.txt` and `output.txt`; those files were never modified
or recaptured. Nothing under `artifacts/red/` will be edited again.

## Valid passing gates

- Named D6 regression: `1 pass`, `0 fail`.
- `bun run test:file -- tests/loop/tmux.test.ts`: `111 pass`, `0 fail`, `573` assertions.
- Canonical TypeScript command: pass.
- `bun run build`: pass, `3051` modules.
- `LOOP_TEST_CERTIFICATION_MODE=single-file bun run test:ci`: all `79` serial files pass.

## Blocked inherited gate

- Claude exact-SHA decision `903ea1ff-acc3-4968-ba7d-70151b01bc04` is literal `FAIL` on evidence
  integrity only. It independently found the implementation correct and directed no code change.
- The two D15 close-lifecycle artifacts were restored byte-for-byte from implementation HEAD:
  pre-close `66666865793bc34d117e7f5a82d03e10b5482aa454dbe79bce8fb697f81e9d7e` and post-close
  `fb0b63c017dea91d60fad622242b0fd7bd3f9eab14ce2fa48c23afdb41ba7a71`.
- On that restored tree, `bun run check` fails only because the committed D15 evidence is inside
  formatter scope. This failure exists at base `ee1e7736d876d4b387f13580ec25ddf1c606e873`; D6 did not
  introduce it.
- The earlier 906-file formatter pass and root verifier pass were obtained only after rewriting
  frozen evidence and are invalidated. Both evals are pending/failed, Harness remains active, and no
  close is authorized.
- Claude escalated the correct repository-level remedy—a scoped generated-evidence exclusion in
  `biome.jsonc` outside D6's two-file contract—to the supervisor. No exclusion will be added without
  that decision.

## Compatibility and governance

- Local documented bound: `tmux 3.7b`; its manual documents `client_readonly`,
  `window_active_clients`, `window_active_clients_list`, and session-targeted `list-clients`.
- Tests inject deterministic command output and assert exact query construction; they do not claim
  deployed-output certification. Unsupported output fails closed before a recovery key.
- No live pane was attached to, typed into, or inspected by the D6 tests.
- Utility remained `0/off/0`; no helper route, provider call, model change, or spend occurred.
- Root `.loop/` remains untracked with `60` preserved files.

## Run 83 correction-loop verification

Verification ID: `run83-d6-4e293d78-44d3-4451-b942-0b92fab3aa0c`; frozen timestamp:
`2026-08-17T04:28:25Z`.

- `bun run check`: exit 0, 189 files, no fixes.
- Canonical TypeScript: exit 0.
- `bun run build`: exit 0, 3051 modules. Ignored `loop-fork/loop` retained SHA-256
  `2a2737437668ad008d008d25020a0fc23febf6a22798714461d3e5da6070368a`; only mtime changed.
- Certified `test:ci`: exit 0, all 79 serial files.
- Explicit loop-fork and root eval baseline checks: exit 0, both by-name allowlists empty.
- Harness preflight: exit 0, active task D6, eval pass, required dimension `unit`.
- Harness stop-gate: exit 0, required dimension `unit` resolved pass.
- Root verifier: exit 0 after fresh lint, typecheck, build, all 79 serial files, and root baseline
  gate.

### Raw output inventory

- `run-83-01-check.txt`: 215 bytes,
  `261c3087237d978a84b4a6ca070696b0552134e8556fdde27ef9fba269a97b0b`.
- `run-83-02-typecheck.txt`: 288 bytes,
  `18dfd8da1aaa6bd86ce9eaa930c9cd0556ed5bfab6987e4a69db2376349866e8`.
- `run-83-03-build.txt`: 650 bytes,
  `bcbcb5a20a53256ee801810f884f2b5269465c3dc3c050c6712738bd36a9052d`.
- `run-83-04-test-ci.txt`: 158503 bytes,
  `5d15cc7904707dfede265d1a6573ca17545b624365fef83bb2d4381d8af28b0d`.
- `run-83-05-loop-eval-baseline.txt`: 315 bytes,
  `533179f7525bcc4d0e1f2258309c8d692af7b68dba8fde790ce325d744936f16`.
- `run-83-06-root-eval-baseline.txt`: 295 bytes,
  `d5fb6110ec8e34348f2e43a42920cd4b27a7d73f2613266083463eb618a672be`.
- `run-83-07-harness-preflight.json`: 333 bytes,
  `21076d50fc822ee97fcf77a431d676a8153fd43cef0bf2c4a73b5b1d811d0f93`.
- `run-83-08-harness-stop-gate.json`: 261 bytes,
  `16759817eb077f5a03b4c4b6b898480d6fc0287cb5550c62ecc4a8beff610871`.
- `run-83-09-root-verify.txt`: 157644 bytes,
  `90b2922ae556527b5bf6e22ac709912774df0c554c5adeb4f4b62a97d2410e56`.

Loop-fork eval SHA-256 is
`1a39c272dfe2f1a5698c26ceefdf4b1558c1c0b7c337de1f77835e6b780ea233`; root eval SHA-256 is
`3756b01bf2de35b95d304e38d25499dab5b70ffc348b104ac01b3739a1af6652`. Both read pass with
`baseline_failures: []` and empty by-name allowlists.

### Zero-change and authority proof

- HEAD remains `ef17eb08139a7300316a3564782c216e7f19cfaf`; index remains empty.
- D6 implementation is unchanged SHA `254e1749ca67ad1d81cd434ef01db0aeabae5827`; source SHA-256
  remains `e9fdabb8c367bfbec9998bb3601e9d35183173f472a994e5922c905b895d009e`; test SHA-256 remains
  `5e11287a399647fb516d5d3fdbdcb609273ce9d59409b49076ed1e5335971db1`.
- All five frozen contract hashes and all four frozen red hashes match. Complete D15, formatter,
  Harness-file, and root `.loop/` inventories compare byte-identical to preflight.
- Harness remains active on D6 with eval pass; `tasks.json` and `current-task` hashes remain
  `42b30be61071b60a8e9d6838565d25a2abf36d7a2d8fc35499516f5f415f214d` and
  `f15fd0c0490dece3829ff14cb75706c5f696cca66d3bae8485b4a30a632a4e4e`.
- Both run-82 handover bundle hashes match. Root `.loop/` remains 60 files and zero tracked; utility
  remains `0/off/0`. No review request, Harness close, staging, commit, or D7 action occurred while
  producing this evidence.
