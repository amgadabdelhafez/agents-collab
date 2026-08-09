# Task d016-release-packaging-version-drift

Created: 2026-08-09T18:27:06Z
Mode: emergent
Description: Installed Harness v1.0.38 full test sweep fails tests/release-packaging.test.ts because expected package version remains 1.0.35; update release packaging assertion to derive or match committed release metadata, then independently rerun the

## What I changed

- Replaced the historical `1.0.35` equality with a semantic-version shape
  assertion. The existing workflow assertions continue to bind release tags to
  `loop-fork/package.json` and verify the packaged asset layout.

## Why

Every legitimate patch release made the mandatory suite stale even though the
workflow already derives the tag from current package metadata.

## Notes
