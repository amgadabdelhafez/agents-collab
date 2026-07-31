#!/bin/bash
set -euo pipefail
umask 077

resolve_executable() {
  local override_name=$1
  local override_value=$2
  local default_name=$3
  local resolved=""

  if [[ -n "$override_value" ]]; then
    if [[ "$override_value" == */* ]]; then
      resolved=$override_value
    else
      resolved=$(command -v "$override_value" 2>/dev/null || true)
    fi
  else
    resolved=$(command -v "$default_name" 2>/dev/null || true)
  fi

  if [[ -z "$resolved" || ! -f "$resolved" || ! -x "$resolved" ]]; then
    echo "unable to resolve executable for $override_name (default: $default_name)" >&2
    exit 69
  fi
  if [[ "$resolved" != /* ]]; then
    resolved="$(cd "$(dirname "$resolved")" && pwd -P)/$(basename "$resolved")"
  fi
  printf '%s\n' "$resolved"
}

is_uint() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo "neither shasum nor sha256sum is available" >&2
    exit 69
  fi
}

sha256_text() {
  local text=$1
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$text" | shasum -a 256 | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$text" | sha256sum | awk '{print $1}'
  else
    echo "neither shasum nor sha256sum is available" >&2
    exit 69
  fi
}

if [[ $# -ne 1 ]]; then
  echo "usage: $0 /absolute/new/raw-capture-directory" >&2
  exit 64
fi

raw_root=$1
home_dir=${HOME:?HOME must be set}
evidence_root="$home_dir/.loop/evidence/claude-warning-producer-fixture"
temp_root=${TMPDIR:-/tmp}
temp_root=${temp_root%/}
case "$raw_root" in
  "$evidence_root"/* | "$temp_root"/* | /private/tmp/* | /tmp/*) ;;
  *)
    echo "capture directory must be a narrow temp or Loop evidence path" >&2
    exit 64
    ;;
esac
if [[ -e "$raw_root" ]]; then
  echo "capture directory already exists: $raw_root" >&2
  exit 73
fi

claude_bin=$(resolve_executable \
  CLAUDE_CAPTURE_BIN "${CLAUDE_CAPTURE_BIN:-}" claude)
loop_bin=$(resolve_executable LOOP_CAPTURE_BIN "${LOOP_CAPTURE_BIN:-}" loop)
tmux_bin=$(resolve_executable TMUX_CAPTURE_BIN "${TMUX_CAPTURE_BIN:-}" tmux)
node_bin=$(resolve_executable NODE_CAPTURE_BIN "${NODE_CAPTURE_BIN:-}" node)
seed_config=${CLAUDE_SEED_CONFIG:-"$home_dir/.claude.json"}
if [[ ! -f "$seed_config" ]]; then
  echo "Claude seed config is not a regular file: $seed_config" >&2
  exit 66
fi

server_name=loop-bridge-fixture-capture
session_id=$(
  "$node_bin" --input-type=module -e \
    'import { randomUUID } from "node:crypto"; console.log(randomUUID())'
)
session_name=claude-warning-capture
pane_target="$session_name:0.0"
config_dir=$(mktemp -d "$temp_root/loop-claude-warning-config.XXXXXX")
socket_path="$config_dir/tmux.sock"
after_ready=false

enforce_private_permissions() {
  if [[ -d "$raw_root" ]]; then
    find "$raw_root" -type d -exec chmod 0700 {} +
    find "$raw_root" -type f -exec chmod 0600 {} +
  fi
}

cleanup() {
  local status=$1
  trap - EXIT
  "$tmux_bin" -S "$socket_path" kill-server >/dev/null 2>&1 || true
  enforce_private_permissions
  case "$config_dir" in
    "$temp_root"/*) rm -rf "$config_dir" ;;
  esac
  exit "$status"
}
trap 'cleanup $?' EXIT

mkdir -p "$raw_root/frames" "$raw_root/selected" "$raw_root/bridge-run"
cp "$seed_config" "$config_dir/.claude.json"

"$node_bin" --input-type=module -e '
  import { writeFileSync } from "node:fs";
  const [path, command, runDir, server] = process.argv.slice(1);
  writeFileSync(path, `${JSON.stringify({
    mcpServers: {
      [server]: {
        args: ["__bridge-mcp", runDir, "claude"],
        command,
        type: "stdio",
      },
    },
  }, null, 2)}\n`, { mode: 0o600 });
' "$raw_root/claude-mcp.json" "$loop_bin" "$raw_root/bridge-run" "$server_name"

case "$raw_root" in
  "$home_dir"/*) public_raw_reference="~${raw_root#"$home_dir"}" ;;
  *) public_raw_reference="<PRIVATE_RAW_CAPTURE>" ;;
esac

capture_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
{
  echo "capture_started_at=$capture_started_at"
  echo "claude_bin=$claude_bin"
  "$claude_bin" --version | sed 's/^/claude_version=/'
  echo "claude_sha256=$(sha256_file "$claude_bin")"
  "$loop_bin" --version | sed 's/^/loop_version=/'
  echo "loop_sha256=$(sha256_file "$loop_bin")"
  "$tmux_bin" -V | sed 's/^/tmux_version=/'
  echo "geometry=220x60"
  echo "capture_command=tmux -S <EPHEMERAL_SOCKET> capture-pane -p -e -t $pane_target"
  echo "metrics_command=tmux -S <EPHEMERAL_SOCKET> capture-pane -p -e -t $pane_target ; display-message -p -t $pane_target <BOUND_FORMAT>"
  echo "config_dir=<EPHEMERAL_DEDICATED_CLAUDE_CONFIG_DIR>"
  echo "raw_reference=$public_raw_reference"
  echo "server_name=$server_name"
  echo "session_id=$session_id"
  echo "prompt_submitted=false"
  echo "model_request_made=false"
  echo "pane_pipe_requested=false"
} >"$raw_root/environment.txt"

printf '%s\n' \
  $'captured_at_utc\tstate\traw_file\tplain_file\tsource_frame\tpane_target\tpane_id\tcursor_x\tcursor_y\twindow_activity\tactive_clients\tpane_pipe\tpane_width\tpane_height' \
  >"$raw_root/selected-states.tsv"
printf '%s\n' $'at_utc\tphase\taction\tprompt_submission' \
  >"$raw_root/actions.tsv"

record_action() {
  local phase=$1
  local action=$2
  printf '%s\t%s\t%s\tfalse\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$phase" "$action" \
    >>"$raw_root/actions.tsv"
}

send_key() {
  local phase=$1
  local key=$2
  if [[ "$after_ready" == true && ("$key" == Enter || "$key" == C-m) ]]; then
    echo "refusing prompt-submitting key after ready: $key" >&2
    exit 70
  fi
  record_action "$phase" "$key"
  "$tmux_bin" -S "$socket_path" send-keys -t "$pane_target" "$key"
}

capture_selected_state() {
  local selected_state=$1
  local source_frame=$2
  local raw_file="selected/$selected_state.ansi"
  local plain_file="selected/$selected_state.txt"
  local bound_output="$config_dir/bound-$selected_state"
  local bound_marker="__LOOP_BOUND_STATE__ "
  local metrics
  local pane_id cursor_x cursor_y window_activity active_clients pane_pipe
  local pane_width pane_height value

  "$tmux_bin" -S "$socket_path" \
    capture-pane -p -e -t "$pane_target" \; \
    display-message -p -t "$pane_target" \
    "${bound_marker}#{pane_id} #{cursor_x} #{cursor_y} #{window_activity} #{session_attached} #{pane_pipe} #{pane_width} #{pane_height}" \
    >"$bound_output"
  metrics=$(
    "$node_bin" --input-type=module -e '
      import { readFileSync, writeFileSync } from "node:fs";
      const [source, destination, marker] = process.argv.slice(1);
      const bytes = readFileSync(source);
      const markerOffset = bytes.lastIndexOf(Buffer.from(marker));
      if (markerOffset < 0) {
        throw new Error("bound tmux state marker is missing");
      }
      writeFileSync(destination, bytes.subarray(0, markerOffset), { mode: 0o600 });
      process.stdout.write(
        bytes.subarray(markerOffset + Buffer.byteLength(marker)).toString("utf8").trim()
      );
    ' "$bound_output" "$raw_root/$raw_file" "$bound_marker"
  )
  "$tmux_bin" -S "$socket_path" capture-pane -p -t "$pane_target" \
    >"$raw_root/$plain_file"
  read -r pane_id cursor_x cursor_y window_activity active_clients pane_pipe \
    pane_width pane_height <<<"$metrics"
  if [[ ! "$pane_id" =~ ^%[0-9]+$ ]]; then
    echo "non-numeric pane binding for $selected_state: $pane_id" >&2
    exit 1
  fi
  for value in "$cursor_x" "$cursor_y" "$window_activity" "$active_clients" \
    "$pane_pipe" "$pane_width" "$pane_height"; do
    if ! is_uint "$value"; then
      echo "non-numeric tmux evidence for $selected_state: $metrics" >&2
      exit 1
    fi
  done
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$selected_state" "$raw_file" \
    "$plain_file" "$source_frame" "$pane_target" "$pane_id" "$cursor_x" \
    "$cursor_y" "$window_activity" "$active_clients" "$pane_pipe" \
    "$pane_width" "$pane_height" >>"$raw_root/selected-states.tsv"
}

state_metric() {
  local selected_state=$1
  local column=$2
  awk -F '\t' -v state="$selected_state" -v column="$column" \
    '$2 == state { value = $column } END { print value }' \
    "$raw_root/selected-states.tsv"
}

wait_past_activity_second() {
  local baseline=$1
  local attempt
  for attempt in $(seq 1 100); do
    if (( $(date +%s) > baseline )); then
      return 0
    fi
    sleep 0.05
  done
  echo "wall clock did not advance beyond tmux activity second $baseline" >&2
  exit 1
}

wait_for_draft_state() {
  local expected=$1
  local attempt pane_text
  for attempt in $(seq 1 100); do
    pane_text=$(
      "$tmux_bin" -S "$socket_path" capture-pane -p -t "$pane_target"
    )
    if [[ "$expected" == present && "$pane_text" == *"$unsent_draft"* ]]; then
      return 0
    fi
    if [[ "$expected" == absent && "$pane_text" != *"$unsent_draft"* ]]; then
      return 0
    fi
    sleep 0.05
  done
  echo "draft did not become $expected without submission" >&2
  exit 1
}

"$tmux_bin" -S "$socket_path" new-session -d -x 220 -y 60 \
  -s "$session_name" -c /private/tmp \
  env "CLAUDE_CONFIG_DIR=$config_dir" TERM=xterm-256color \
  "$claude_bin" \
  --session-id "$session_id" \
  --model opus \
  --effort max \
  --mcp-config "$raw_root/claude-mcp.json" \
  --strict-mcp-config \
  --dangerously-load-development-channels "server:$server_name" \
  --dangerously-skip-permissions

state=waiting-startup-prompts
handled_dev_channel=false
handled_bypass=false
bypass_down_sent=false
selected_bypass_default=false
selected_bypass_accepted=false
selected_dev_channel=false
ready=false
printf '%s\n' \
  $'captured_at_utc\tframe\tstate\tcursor_x\tcursor_y\tpane_width\tpane_height' \
  >"$raw_root/frames.tsv"
for poll in $(seq 0 599); do
  frame=$(printf '%04d' "$poll")
  styled="$raw_root/frames/frame-$frame.ansi"
  plain="$raw_root/frames/frame-$frame.txt"
  "$tmux_bin" -S "$socket_path" capture-pane -p -e -t "$pane_target" >"$styled"
  "$tmux_bin" -S "$socket_path" capture-pane -p -t "$pane_target" >"$plain"
  cursor=$(
    "$tmux_bin" -S "$socket_path" display-message -p -t "$pane_target" \
      '#{cursor_x} #{cursor_y} #{pane_width} #{pane_height}'
  )
  read -r cursor_x cursor_y pane_width pane_height <<<"$cursor"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$frame" "$state" \
    "$cursor_x" "$cursor_y" "$pane_width" "$pane_height" \
    >>"$raw_root/frames.tsv"

  if [[ "$handled_bypass" == false && "$bypass_down_sent" == false ]] && \
    grep -Fq "WARNING: Claude Code running in Bypass Permissions mode" "$plain"; then
    if [[ "$selected_bypass_default" == false ]]; then
      capture_selected_state bypass-default "$frame"
      selected_bypass_default=true
    fi
    send_key startup-bypass Down
    bypass_down_sent=true
    state=bypass-selection-sent
  elif [[ "$handled_bypass" == false && "$bypass_down_sent" == true ]] && \
    grep -Fq "❯ 2. Yes, I accept" "$plain"; then
    if [[ "$selected_bypass_accepted" == false ]]; then
      capture_selected_state bypass-accepted "$frame"
      selected_bypass_accepted=true
    fi
    send_key startup-bypass Enter
    handled_bypass=true
    state=bypass-confirmed
  elif [[ "$handled_dev_channel" == false ]] && \
    grep -Fq "WARNING: Loading development channels" "$plain" && \
    grep -Fq "I am using this for local development" "$plain"; then
    if [[ "$selected_dev_channel" == false ]]; then
      capture_selected_state development-channel "$frame"
      selected_dev_channel=true
    fi
    send_key startup-development-channel Enter
    handled_dev_channel=true
    state=development-channel-confirmed
  elif grep -Fq "Do you trust the files in this folder?" "$plain"; then
    send_key startup-trust Enter
  elif [[ "$handled_dev_channel" == true && "$handled_bypass" == true ]] && \
    grep -Fq "no MCP server configured with that name" "$plain" && \
    grep -Fq "❯" "$plain" && \
    ! grep -Fq "WARNING: Loading development channels" "$plain" && \
    ! grep -Fq "WARNING: Claude Code running in Bypass Permissions mode" "$plain"; then
    capture_selected_state ready-before-end-clear "$frame"
    ready=true
    after_ready=true
    state=ready
    break
  fi
  sleep 0.05
done

if [[ "$ready" != true || "$selected_bypass_default" != true || \
  "$selected_bypass_accepted" != true || "$selected_dev_channel" != true ]]; then
  echo "Claude did not expose the complete selected startup sequence" >&2
  exit 1
fi

ready_before_activity=$(state_metric ready-before-end-clear 10)
wait_past_activity_second "$ready_before_activity"
send_key ready-activity-probe End
send_key ready-activity-probe C-l
sleep 0.15
capture_selected_state ready-after-end-clear post-ready
ready_after_activity=$(state_metric ready-after-end-clear 10)
if (( ready_after_activity <= ready_before_activity )); then
  echo "ready activity did not advance: $ready_before_activity -> $ready_after_activity" >&2
  exit 1
fi

unsent_draft='Try "do not overwrite this human draft"'
draft_sha256=$(sha256_text "$unsent_draft")
record_action draft-input "literal-sha256:$draft_sha256"
"$tmux_bin" -S "$socket_path" send-keys -l -t "$pane_target" "$unsent_draft"
wait_for_draft_state present
send_key draft-home Home
sleep 0.1
capture_selected_state draft-home post-ready

draft_home_activity=$(state_metric draft-home 10)
wait_past_activity_second "$draft_home_activity"
send_key draft-activity-probe End
send_key draft-activity-probe C-l
sleep 0.15
capture_selected_state draft-after-end-clear post-ready
draft_after_activity=$(state_metric draft-after-end-clear 10)
if (( draft_after_activity <= draft_home_activity )); then
  echo "draft activity did not advance: $draft_home_activity -> $draft_after_activity" >&2
  exit 1
fi

wait_past_activity_second "$draft_after_activity"
send_key draft-restore Home
send_key draft-restore C-l
sleep 0.15
capture_selected_state draft-home-restored post-ready
draft_restore_activity=$(state_metric draft-home-restored 10)
if (( draft_restore_activity <= draft_after_activity )); then
  echo "draft restoration activity did not advance: $draft_after_activity -> $draft_restore_activity" >&2
  exit 1
fi

send_key draft-clear Home
send_key draft-clear C-k
send_key draft-clear C-l
wait_for_draft_state absent
sleep 0.15
capture_selected_state draft-cleared post-ready

capture_ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
{
  echo "capture_ended_at=$capture_ended_at"
  echo "terminal_state=$state"
  echo "handled_dev_channel=$handled_dev_channel"
  echo "handled_bypass=$handled_bypass"
  echo "bypass_down_sent=$bypass_down_sent"
  echo "ready=$ready"
  echo "ready_activity_before=$ready_before_activity"
  echo "ready_activity_after=$ready_after_activity"
  echo "draft_sha256=$draft_sha256"
  echo "draft_activity_before=$draft_home_activity"
  echo "draft_activity_after=$draft_after_activity"
  echo "draft_restore_activity_before=$draft_after_activity"
  echo "draft_restore_activity_after=$draft_restore_activity"
  echo "draft_cleared=true"
  echo "prompt_submitted=false"
  echo "model_request_made=false"
  echo "pane_pipe_requested=false"
} >>"$raw_root/environment.txt"

enforce_private_permissions
echo "$raw_root"
