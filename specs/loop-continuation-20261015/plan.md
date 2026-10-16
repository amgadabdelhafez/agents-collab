# Plan

1. Preserve the pinned landing base and the full retained dirty candidate. Use one
   isolated source/test writer for app-server ownership and lifecycle repairs;
   keep documentation with the current-session writer and every reviewer
   read-only.
2. Establish the exact spawned child as listener before connection and prove
   that the exact returned client socket is connected to an established server
   socket owned by that child. Fence every wait, connection, callback, close,
   release, and cleanup by immutable generation and exact handles.
3. Add deterministic fake controls for foreign pre-connect ownership,
   listener replacement and ABA during connection, immediate post-connect
   ownership loss, exact-child success, failed-start cleanup, stale close/exit,
   normal close, and detached release.
4. Run the focused commands in `verify.md` subject to the 4 GiB free-swap gate.
   Record each actual command result and every named failure or skip.
5. Validate explicitly selected GitHub remotes through one strict positive
   owner/repository parser for SCP and URL forms, shell-quote the validated
   `gh --repo` argument, and prove unsafe inputs return the local handoff
   without calling the publication agent.
6. Freeze source, tests, docs, eval, tasks, and handoff; create an immutable
   snapshot without modifying the user's normal index; obtain a new independent
   project-scoped review over the complete landing-base-to-final diff. Resolve
   actionable findings and repeat review if any candidate file changes.
7. Preserve exact final reviewer output out of tree with reviewer, session,
   thread, turn, and message identifiers. End with a read-only no-publication
   handoff; no push, PR, remote, merge, install, deploy, or hosting action.
