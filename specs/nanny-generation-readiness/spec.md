# Spec: Nanny Generation Readiness

## Problem

The local MLX server can keep serving `/health` and `/v1/models` while its
generation path is unusable. Pi also registers the local Qwen model as
`reasoning: false` while selecting the `qwen-chat-template` compatibility mode.
That combination prevents Pi from sending
`chat_template_kwargs.enable_thinking=false`; Qwen then reasons by default and
can consume the entire five-minute request timeout before producing a tool call.

## Goal

Make every Pi-backed Nanny and Governess request explicitly disable Qwen
thinking at the server boundary, and bound Nanny's per-call output budget.
Health claims must be backed by a real generation request rather than a catalog
or listener response.

## Requirements

1. The Pi model registered for Nanny advertises reasoning compatibility so Pi
   emits Qwen chat-template controls.
2. Nanny and Governess sessions select thinking level `off`, producing
   `chat_template_kwargs: { enable_thinking: false, preserve_thinking: true }`.
3. Au Pair behavior remains unchanged.
4. Nanny's registered maximum output is bounded to 3,200 tokens instead of the
   Pi custom-provider default of 32,768.
5. A producer-backed fake-provider test inspects the actual HTTP request body
   and fails if the server control is absent or true.
6. A live recovery check uses a real completion response; `/health` and
   `/v1/models` alone never certify generation.

## Safety

- No running Claude, Codex, or tmux pane is restarted.
- The change does not widen tools, scopes, authority, concurrency, or routing.
- Au Pair and OpenRouter requests do not receive Qwen-local controls.
- Deployment remains held for exact-SHA review and the changed-binary gate.
