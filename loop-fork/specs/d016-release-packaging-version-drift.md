---
kind: parked-idea
id: d016-release-packaging-version-drift
status: parked
created_at: 2026-08-09T18:13:34Z
source_task: d015-paired-attach-terminal
---

# d016-release-packaging-version-drift

Idea captured 2026-08-09T18:13:34Z.

## Capture

Installed Harness v1.0.38 full test sweep fails tests/release-packaging.test.ts because expected package version remains 1.0.35; update release packaging assertion to derive or match committed release metadata, then independently rerun the exact test.

## Source

- Active task: d015-paired-attach-terminal

## Promotion

Run:

```bash
./harness promote d016-release-packaging-version-drift
```
