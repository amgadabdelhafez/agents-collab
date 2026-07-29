# Task driver-bootstrap-role

Created: 2026-07-29T20:53:35Z
Mode: planned
Description: Make fresh primary drivers start concrete charter missions while support peers keep waiting

## What I changed

- Added an explicit `primary` or `support` role to launch-charter
  materialization.
- Made primary bootstraps initiate a concrete verified charter mission without
  a second assignment prompt.
- Kept support bootstraps waiting unless the verified charter separately
  assigns work.
- Extended the realistic 10,257-byte charter regression to cover both roles.

## Why

The constant-size pointer bootstrap conveyed authority and hash binding but not
whether the fresh agent should drive or wait. A primary therefore treated a
concrete charter mission as context rather than assigned work.

## Notes

- Both bootstrap variants remain below 1 KiB and contain no charter body.
- Focused tests, full repository verification, Harness preflight, and Harness
  stop-gate pass.
- Deployment remains held pending exact-SHA independent review.
- Harvto run 100 was not mutated.
