# D-001 implementation note

v1.0.35 launches the replacement in
`defaultGovernessDeps.launchReplacementLoop` before `driveHandoverControl`
calls `stopGovernessLoop`. That later stop cannot prevent the successor's
reservation check: `manifestCanStillOwnWorkspace` treats the predecessor's live
`tmuxSession` as owning even when lifecycle state is terminal.

Runs 14-32 and 34-37 provide repeated producer evidence. Each has validated
Claude and Codex bundles, then the replacement command fails because the same
run still owns the same workspace.

Smallest seam is inside the default replacement launcher, after handoff-manifest
validation and immediately before process spawn. Persist the predecessor as
stopped and remove its active tmux session target. This releases ownership while
retaining workspace binding, socket metadata, handoff artifacts, and retry
state. If a configured predecessor manifest cannot be updated, return a launch
error without spawning.
