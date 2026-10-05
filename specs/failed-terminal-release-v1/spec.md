# Failed terminal reservation release

Run 39 is failed/failed but its absent runtime still reserves the workspace.
Add explicit `reconcile failed-terminal <id>` using the stopped-run ownership
checks. Preserve failed state and failure evidence. Refuse live processes,
surviving runtime, invalid ownership and concurrent identity changes. Do not
launch successors or modify product/container state. Base: installed source
2781c13b plus release documentation at 22957bdc.
