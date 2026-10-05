# Test-route release receipt

Source commit: 8a1cc88ff784b5eaa7844122775ed233d7c9b8be.
Source tree: 09592f3c97658697cb6e0b19bbf3856d9bf374cd.
Installed-feature base: ea968d82eac49013056834e34843d160b1eea79d.
Integration input: e4efbae2a6f5ee07c6a65ef7177b1d4c12cbaabb.
Post-commit binary: /private/tmp/harness-vertical-release-8a1cc88f.
Binary SHA256: 1be7d94a558322a3cf66171fde938f0316f282e72e6675d7c1f3d2489a878f10.
Installed binary unchanged: ba3671b6a21b21159f5a639103c504a29251385eedcfac8b9932210666abf600.

Activation scope is exactly Run49, one workspace and two seats. Application
PostgreSQL uses pinned postgres17 image in a task-owned container and named volume,
separate from existing Temporal192.168.1.18:7233 namespaceharness. Dedicated worker
queueharness-vertical-control-plane-v1 and loopback API7337. Operational secret
values live only in the private runtime store; no values appear in this receipt.

Rollback: stop this dedicated ingress/worker through its owning PTY, end exact
Run49 through supported Governess lifecycle, reconcile its released workspace,
retire only its owned workflow histories after evidence capture, and remove only
the identity-verified database container/volume and credential store. No shared
binary, route or database needs restoration because none was replaced. The
unchanged installed binary remains the compatibility path; disabling V2 does not
erase its task data or count as accepted result. Temporary test data deletion
is permitted only after durable body-free evidence and artifact preservation.

Live request/result/restart/cleanup acceptance passed. Final cleanup repair
source928bd1db3062d59a23f8eeaca0f8d462490a3c8a, tree
a93e26ac780f9fe4f0b787756e6e3fa9491170d3, compiled SHA256
d0a8aa8ff75ee61ae4e80f2c7b1fb008c1227026ef9b6da210de55bcc5ed07de,
was exercised by fresh Run50. See status.md for exact cleanup postflight.

Run49 original SDK task455c128b-58b2-4101-ac66-a4389bee8cce maps to
supervisor-message-workflow:v2:14f4b9b6f25529487d798aa7ab7a40df502444f1c3684dc7d3fe336757aab76d.
Codex consumed deliveryab87de07-12b8-4503-be1c-2dbd958a46d1. Git result
b1094f29716517c1c6a9827d44eb29a35cd90938:vertical-release-result.md hashes to
96a127b8fcc03e73eb7219dc3e2d2436f6005d7452853142eadee617a1a269c2.
Sonnet acceptance443ae46a-59f4-4dac-8737-7bbdb11dbc52 explicitly relied on
supervisor-verified bytes. Graph task-graph:vertical-run49-result-v1/result-node
succeeded; actual recipient published the distinct result. Original SDK task
state3/completed had one accepted artifact.

Real database restart2026-10-05T09:33:13.041Z preserved9 tables/24 rows, digest
6c9290ab3fe40345f34894961c8aae2f3e082a2705378fdc92d392c4827f1de9,
through fresh connections. Worker restart preserved completed task snapshot
6fb1a87c7e90dc22da0458e60b4ec2d3d33751c76d00b447f86111b3fb340724.
Replay produced no extra canonical provider delivery. Four owned Temporal
histories were terminated after proof; cleanup termination is distinct from
logical completion. Databasecontainerf3d786a131bca16c5026d950cbfb81a36c7cd00dc9d5479cfbe647188accef28,
volumeharness-vertical-15af043b17d3-pgdata and private secret store were removed.
Git result and body-free evidence remain; temporary database data does not.

Correction, 2026-10-05: "Integration input" names source only. This receipt's
PASS evidence binds to the compiled 8a1cc88f and 928bd1db binaries above. The
input's own Run48 evidence binds to neither e4efbae2 nor 53511614: Run48 was
allocated with launcher candidate 28bf864b...0851, whose source the records do
not name, and its dedicated service ran 9904f280...29fa3, built from 99e61b54
plus an uncommitted overlay. The result blob's text is an unproven assertion;
see status.md's October 5 correction. (Revised the same day: an earlier wording
also attributed Run48 evidence to the Slice 1 diagnostic candidate 7980ed8d.)
