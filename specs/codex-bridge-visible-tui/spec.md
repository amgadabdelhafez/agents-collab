# Spec: Bridge activity visible in the agent TUIs

## Problem

In a paired tmux loop, the Codex proxy starts an idle bridge request directly
on app-server. The app-server accepts and processes that turn, but the Codex TUI
did not initiate it and can remain visibly idle. The bridge ledger then records
delivery even though the operator cannot see the request or the work in the
Codex pane. A later pane nudge can start a second, duplicate turn after the
first headless turn already consumed the request.

Claude has a related false-delivery failure: its MCP channel implementation
marks a message delivered immediately after writing an unacknowledged channel
notification. In live run 38 the MCP process remained alive across a Claude
session transition, but the active conversation stopped receiving those
notifications after 03:11. The ledger accumulated successful delivery rows
while Claude did not see 31 unique inbound messages and continued past
supervisor stop rulings.

The first visible-tmux repair still left Codex-to-Claude sends dependent on the
detached polling worker. Live run 38 showed a message queued at 05:37:41Z but
not submitted to Claude until 05:38:55Z. Claude was idle from 05:35:37Z, so the
74-second gap was transport latency rather than intentional busy-pane deferral.

## Goal

Every incoming bridge request in a live tmux loop is submitted by the target's
visible TUI and appears in that pane and transcript. The Codex proxy never
injects bridge work directly with app-server `turn/start` or `turn/steer`.
Claude channel notifications remain available only for headless runs, where no
visible tmux pane exists.

## Non-goals

- Replacing the Codex app-server transport used by the TUI.
- Changing Gemini, Cursor, or Copilot bridge delivery.
- Restarting either live main-agent pane.
- Treating a bridge acknowledgement alone as proof that Codex finished work.

## Background

The live run-38 incident showed a request marked `sent to codex tmux proxy`, an
empty later `receive_messages` result, and a completed Codex response in the
durable thread while the pane appeared idle. The proxy consumed its own
`turn/start` response; app-server notifications were insufficient to make the
TUI adopt and render that externally-started turn.

## User journeys

1. Codex is idle: a Claude bridge request is typed and submitted through the
   Codex TUI, where the request and ensuing turn are visible.
2. Codex already has a visible active turn: the request is still submitted
   through the TUI so Codex's own UI chooses whether to steer or queue it and
   renders that activity.
3. The pane is unavailable or not ready: the request stays pending and is not
   acknowledged or silently started headlessly.
4. Claude is running in tmux: inbound messages are submitted through its visible
   composer instead of being acknowledged on an unverified channel write.
5. Claude is headless: channel notifications continue to provide delivery.

## Acceptance criteria

- [x] Every incoming Codex bridge request uses the visible tmux pane; the proxy
      never sends app-server `turn/start` or `turn/steer` for bridge delivery.
- [x] A successful pane submission acknowledges the durable bridge request
      exactly once; failed submission leaves it pending.
- [x] With an active visible Codex turn, submission still goes through the TUI
      and remains visible rather than using a proxy-originated steer.
- [x] Focused proxy and bridge tests cover visible submission, failure, and
      reconnect paths.
- [x] A live canary shows an idle Codex pane visibly receive and process one
      bridge message, with matching ledger and pane evidence.
- [x] In live tmux mode, Claude channel flush does not consume pending messages;
      the bridge worker submits them through the Claude pane and acknowledges
      only after the tmux submission succeeds.
- [x] In headless mode, Claude channel notification behavior is unchanged.
- [x] The worker continues draining Claude/non-Codex messages while Codex uses
      the visible tmux proxy.
- [x] A live canary is visibly received in Claude after its session transition,
      without restarting the Claude pane or losing its context.
- [x] Codex-to-Claude `send_message` attempts guarded visible-pane delivery
      synchronously before falling back to the worker queue.
- [x] A non-empty Claude draft still prevents immediate injection and leaves the
      durable message pending for a later worker attempt.

## Out-of-scope risks

Typing into a non-empty TUI composer could overwrite or concatenate a draft.
The existing Codex pane readiness guard remains mandatory; failed readiness
must leave the durable request queued. It must recognize both the legacy
`Ctrl+J newline` footer and the current `›` composer plus model/cwd footer.

## Open questions

None. The user's invariant resolves the delivery-surface choice: visibility in
the Codex pane takes precedence over direct proxy injection.
