# Verification

- `separable` eligible work reaches the existing tier-selection rules.
- `sequential`, `unknown`, and legacy requests with no work shape stay with the driver as `work-not-separable`.
- Peer-verdict review and authority or safety violations retain their older refusal reasons even when work shape is unknown.
- Explicit `route_task` rejects missing or invalid `work_shape` without creating a job.
- Accepted jobs persist `workShape: "separable"`.
- Trusted automatic hook routes persist `workShape: "separable"`.
- Tool schema and guidance define separability and forbid relabeling dependent work.
