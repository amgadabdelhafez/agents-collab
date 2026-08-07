# Verify: Claude kickoff submit guard

1. Assert the launcher captures kickoff evidence from `<runDir>/hooks/claude.jsonl`
   and the Claude project session transcript version **before** the paste, and
   that a pre-existing hook line alone never counts as confirmation.
2. Assert `<runDir>/transcript.jsonl` is never consulted as kickoff evidence:
   growth of that file alone must not confirm a turn, because Codex, OSS, and
   bridge writes grow it independently of Claude.
3. Assert hook parsing ignores blank, trailing partial, and malformed lines, and
   that a truncated or rotated hook file never reads as progression.
   Assert `PreToolUse` and `PostToolUse` count as turn progress and that
   `Notification` and `Stop` do not, because `hooks/emit.ts::lifecycleState`
   maps those two to `input-required`.
3b. Assert the Claude project transcript version never confirms alone: a moved
   version with the launcher kickoff still in the composer must not confirm, and
   the same moved version with a cleared composer must confirm.
4. Assert a normal kickoff is confirmed from hook progression and that no
   recovery key is sent on the happy path.
5. Replay the checked-in run-147 producer hook stream (`SessionStart` only) with
   the stranded v2.1.223 composer capture and assert exactly one additional
   `Enter` is sent, then confirmation succeeds once evidence advances.
6. Assert recovery requires the full positively captured launcher provenance
   chain: the composer is verified empty immediately before the paste; the body
   captured between the launcher's own `paste-buffer` and its first `Enter` is
   non-empty and determinate; the live composer matches that capture exactly;
   and the evidence is re-read immediately before the single recovery `Enter`.
   Assert a composer holding the same generic `[Pasted text #N +M lines]` marker
   but a different captured body is refused, that a missing or indeterminate
   post-paste capture refuses recovery and fails closed, and that a composer not
   provably empty before the paste yields no ownership claim.
7. Assert a composer holding an unrelated human draft is never mutated: zero
   recovery keys, and the launch fails closed.
8. Assert the kickoff is never submitted twice: once evidence shows the turn
   started, no further keys are sent, and the buffer is never re-pasted.
9. Assert that when no hook progression and no Claude transcript version change
   ever arrive, the launch throws `ClaudeKickoffUnconfirmedError`, exits nonzero,
   and runs the existing failed-start cleanup with zero survivors.
10. Assert `resolveKickoffCapability` requires confirmation on every version,
    disallows recovery only on an **exact** member of the producer-proven-healthy
    set, and keeps unknown, unparseable, and every non-member version guarded.
    Assert no `<=` version range and no permanent blacklist is consulted.
11. Assert Codex, OSS, and non-Claude panes are unaffected: no evidence read, no
    confirmation poll, no recovery key, and both panes still submit in the
    current order before any confirmation is awaited, so a Claude confirmation
    never delays the peer pane's kickoff.
12. Assert the observed CLI version round-trips through `RunManifest`.
13. Assert the fixture is producer-derived: `fixture-index.json` per-file SHA-256
    values match the checked-in bytes, and the normalizer reproduces them.
14. Run the affected test files, all bridge/launcher/governess suites,
    `bun run check`, `bun run build`, the isolated zero-survivor smoke, and
    `scripts/verify.sh claude-kickoff-submit-guard`. No skipped or tolerated
    failures.
