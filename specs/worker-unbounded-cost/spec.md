# Worker token and cost policy

## Problem

Loop 47 worker job `4fd7f78a` successfully made three model calls and eight
bounded tool calls, but failed after 16,970 cumulative tokens because the
16,000-token job ceiling was too small for a multi-document extraction. The
worker also retains per-job and per-run dollar caps that the operator no longer
wants.

## Requirements

- Do not send a worker completion-token limit to the provider and do not impose
  a cumulative per-job token ceiling. Provider/model context limits remain the
  only token boundary.
- Raise the default conversation step allowance from 8 to 16 and expose the
  common commit-range changed-file/diff-check operation through the existing
  shell-free `git_diff` broker tool.
- Remove the worker's per-job and per-run dollar routing/runtime guardrails.
- Continue recording token and dollar usage for governess observability.
- Preserve runtime, step, workspace, protected-path, credential, command,
  authority, write-conflict, and tool-output limits.

## Acceptance

- Default runtime configuration contains no worker token-limit fields.
- Worker routing does not reject a request because of estimated, per-job, or
  accumulated run cost.
- Worker conversation execution does not fail because of reported dollar cost.
- Worker execution records token usage without rejecting on token count.
- Focused tests, full tests, build, and live narrow deployment complete without
  restarting either main agent.
