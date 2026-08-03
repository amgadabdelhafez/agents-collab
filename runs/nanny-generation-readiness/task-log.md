# Nanny Generation Readiness Task Log

## Live failure

- MLX LaunchAgent remained running and `/v1/models` returned HTTP 200.
- Real `/v1/chat/completions` requests returned zero bytes and timed out.
- Loop 114 Nanny job `8c30dc3c-8180-4eac-a780-4d455b9cab9f`
  made one request, produced zero tokens/tools, and timed out after 300 seconds.
- The server log continued accepting shallow `/health` probes while recording no
  completed generation for more than an hour.

## Recovery

- Restarted only `gui/501/com.homelab.mlx-lm`.
- Listener moved from PID 60243 to PID 48052.
- A real Qwen completion returned HTTP 200 in 0.53 seconds.
- The interrupted loop-115 job failed closed with `Connection error`; no worker
  remained running.

## Root correction

Pi selected `qwen-chat-template` compatibility but registered Nanny as
`reasoning: false`, so Pi did not emit the Qwen chat-template control. A raw
live comparison proved the effect:

- default request: 32 output tokens were entirely reasoning, no content;
- `chat_template_kwargs.enable_thinking=false`: exact `READY`, two output
  tokens, HTTP 200 in 0.70 seconds.

The patch registers Nanny as reasoning-compatible, fixes Nanny session thinking
to `off`, and caps its registered output at 3,200 tokens. Pi therefore emits the
server control on every Nanny and Governess call while leaving Au Pair intact.

## Verification

- Patched live Pi call: `NANNY_READY`, 856 ms, zero reasoning tokens.
- Pi runtime: 5 pass, 0 fail.
- Utility Pi harness: 9 pass, 0 fail.
- Governess LLM: 19 pass, 0 fail.
- Certified full suite: exit 0, no tolerated baseline failures.
- Ultracite: 738 files checked, no fixes.
- Compiled build and `git diff --check`: pass.
