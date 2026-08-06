# Bridge worker watch lifecycle

## Problem

A detached bridge worker from a synthetic topology review survived its parent
and retried an undeliverable message every five seconds. After roughly four
hours it held more than 3,000 read-only descriptors for the run directory.
The worker created and closed a new `fs.watch` handle for every retry; on the
deployed Bun runtime, closing those short-lived watchers did not release their
directory descriptors.

## Requirements

- One bridge worker owns at most one run-directory watcher for its lifetime.
- Retry, settle, event, and reconciliation wake cycles reuse that watcher.
- The metadata version probe remains authoritative when watch events are
  missed or the watcher errors.
- Worker exit closes the watcher and version probe exactly once.
- The inspect-to-watch race and five-minute reconciliation contract remain
  unchanged.

## Out of scope

- Changing bridge delivery authority or acknowledgement semantics.
- Restarting a healthy live loop or deploying the candidate.
