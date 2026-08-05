# Spec: Handover Effort Fidelity and Governess Restart Reconciliation

## Problem

The graceful-handover launcher recreates the agent pair without carrying the
predecessor run's driver and reviewer effort settings. Separately, restarting
the Governess renderer in the same tmux pane can leave the predecessor frame
in pane history, making the new live agent and helper rows appear duplicated
even though the persisted model and live process topology each contain one
entity.

## Goal

Freeze run-defining effort values and the continuation artifact into the
verified handover transaction, relaunch with those exact values, and reconcile
the first post-restart Governess frame so stale predecessor rows cannot remain
visible or capturable.

## Requirements

1. The handover manifest must contain exact driver and reviewer effort values.
2. The manifest digest must bind both effort values, every agent bundle digest,
   and the continuation-file digest.
3. Handover manifest validation must fail closed when a bound bundle,
   continuation file, or run-defining effort field is missing, malformed, or
   changed.
4. Replacement launch arguments must use the validated manifest's exact
   driver and reviewer effort values.
5. The first rendered Governess frame after process startup must erase stale
   viewport and scrollback content once before drawing the live snapshot.
6. Subsequent frames must retain the existing changed-lines-only delta path;
   no continuous full-screen redraw is allowed.
7. The persisted Governess state must not be treated as a second agent/helper
   row producer. Decisions, quota, cost, balance, pressure, and enforcement
   continue to consume only the freshly constructed current tick rows.
8. The standing handover model is teardown-first. Old-run teardown is lawful
   only after both agent bundles, the manifest, and continuation exist and all
   bound hashes validate. The retired crisis commit `1e04e5fb` is not reused.

## Non-goals

- Installing or deploying a binary.
- Mutating or restarting healthy run 132.
- Implementing context-pressure automation; its reviewed restack is the next
  slice after this one clears.
- Reviving replacement-before-teardown logic.
