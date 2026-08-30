# Run log

- Bound incident: bridge message `6f365287-682f-4295-aeeb-db92c51e9c87`.
- Preserved Harvto Run 1 reservation and runtime evidence; no Harvto mutation.
- Repair base: accepted source `a88472f8a32ffa969e52b76ee583e6fec1756c97`.
- Dependency proof: package.json SHA-256
  `c79cf0a69fb14de061c190c6bda5a93b8fdd5342d06e396d68c807cd6c302588`
  and bun.lock SHA-256
  `31d0bdb8a54bae9fd4dc29d287013e2a1821041072839b9859c6c9362273c321`
  matched the existing shared tree used for gates; no dependency install.
- Candidate `f70fda7801e40b94eefa55a765c51e594dee0ef7` received a literal
  zero-write REFUSE. The verdict is preserved in `review-001.md`.
- Bounded repair rejects foreign `-S`/`-L` overrides in the production spawn
  seam, rejects foreign attach sockets, restores exact-source qualification,
  and directly tests the production qualifier.
- Candidate `6ed5b84608ff53b26c3ee5efbd052ac33abe36d0` also received a
  literal zero-write REFUSE. `review-002.md` preserves it. The successor scans
  every tmux argv position for overrides, directly exercises the production
  command-spawner seam with an injected runner, and carries one resolved socket
  in the paired launch context through attach guidance.
- Focused gates after repair: tmux-socket 52/0; tmux 107/0.
- Full gates: `bun run test:ci`, `bun run check`, `bun run build`, and
  `git diff --check` PASS; named failure set empty.
- Harvto Run 1 was not read, edited, resumed, released, or retried by this task.
