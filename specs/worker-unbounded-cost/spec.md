# Worker token and cost policy

## Problem

Loop 47 worker job `4fd7f78a` successfully made three model calls and eight
bounded tool calls, but failed after 16,970 cumulative tokens because the
16,000-token job ceiling was too small for a multi-document extraction. The
worker also retains per-job and per-run dollar caps that the operator no longer
wants.

## Requirements

- Raise the default completion allowance to 8,000 tokens per model call and
  the cumulative job allowance to 64,000 tokens.
- Raise the default conversation step allowance from 8 to 16 and expose the
  common commit-range changed-file/diff-check operation through the existing
  shell-free `git_diff` broker tool.
- Remove the worker's per-job and per-run dollar routing/runtime guardrails.
- Continue recording token and dollar usage for governess observability.
- Preserve runtime, step, workspace, protected-path, credential, command,
  authority, write-conflict, and tool-output limits.
- Keep token limits configurable through the existing environment variables.

## Acceptance

- Default runtime configuration reports `maxTokens=8000` and
  `maxTotalTokens=64000`.
- Worker routing does not reject a request because of estimated, per-job, or
  accumulated run cost.
- Worker conversation execution does not fail because of reported dollar cost.
- Worker execution still fails closed above the cumulative token limit.
- Focused tests, full tests, build, and live narrow deployment complete without
  restarting either main agent.
