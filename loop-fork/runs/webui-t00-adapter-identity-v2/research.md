# webui-t00-adapter-identity-v2 Research

## Research Question

Which existing Loop contracts and installed tmux/OS primitives can provide a
durable, server-instance-specific adapter identity and a redacted resolved
configuration without adding another authority or dependency?

## Candidates Reviewed

- **Existing Loop manifest writer and paired launch path.** `run-state.ts`
  already owns manifest schema, atomic temporary-file plus rename writes, and
  legacy reads. `paired-options.ts` owns the point after CLI options are
  resolved. `tmux.ts` owns both existing-session and cold-launch paths. These
  are the narrow producer boundaries to extend rather than adding a Web-owned
  registry.
- **Installed tmux format variables.** An isolated tmux 3.7c server confirmed
  that `display-message -p -t <session> '#{socket_path}\t#{pid}'`, when invoked
  with the exact `-S <socket>`, returns the server socket and server PID. The
  observed socket was the exact launched socket and the PID was a live positive
  process ID.
- **Native process-birth evidence.** On this macOS host,
  `ps -p <pid> -o lstart=` returned the tmux server's full start time. On Linux,
  `/proc/<pid>/stat` field 22 is the kernel process start time in clock ticks.
  Both can be normalized into platform-tagged positive birth identities and
  tested with injected readers.
- **Existing Web control-plane research.** The parent
  `webui-control-plane-spec` research establishes the adapter rule: authoritative
  run state comes from durable Loop records, while tmux probes are bounded
  diagnostics. T-00 therefore persists producer-owned identity and gives future
  diagnostics an explicit socket/server context.

## Open-Source Patterns

- Bind a diagnostic handle to multiple independent identity components. A PID
  alone can be reused; a socket pathname alone can be reincarnated. Socket,
  PID, and positive OS birth identity must all match.
- Query the running server for socket provenance. Canonicalize the socket's
  parent directory and append the basename; never resolve the live socket inode.
- Treat persisted bytes as the revision boundary. Decode UTF-8 strictly,
  validate schema, then hash the exact accepted bytes. Do not hash a reserialized
  object.
- Snapshot only an explicit configuration allowlist after defaults and paired
  options are applied. Derive booleans explicitly, reduce proof to a configured
  boolean, freeze the snapshot, and never serialize raw options or environment.
- Keep legacy absence as unknown. Migration-by-reading would invent evidence
  and blur whether an old run ever recorded an identity or configuration.

## Reuse Decision

Adapt the four existing producer/adapter modules. Reuse the manifest atomic
writer and paired launch boundaries; add strict byte validation and derived
revision in `run-state.ts`, construct the redacted resolved snapshot in
`paired-options.ts`, capture identity only after a server is live in `tmux.ts`,
and add an exact-socket diagnostic context in `tmux-control.ts`. No package,
daemon, database, Web route, or alternate runtime authority is justified.

## Sources

- `runs/webui-control-plane-spec/research.md`
- `src/loop/run-state.ts`
- `src/loop/paired-options.ts`
- `src/loop/tmux.ts`
- `src/loop/tmux-control.ts`
- Installed `tmux 3.7c`, isolated exact-socket format probe on 2026-08-25
- macOS `ps(1)` process start output and Linux `proc_pid_stat(5)` field 22
- https://github.com/tmux/tmux/wiki/Advanced-Use
- https://github.com/tmux/tmux/wiki/Formats
- https://www.kernel.org/pub/linux/docs/man-pages/book/man-pages-6.17.pdf
