#!/usr/bin/env python3
"""Minimal bracketed-paste TUI for compiled loop transport smoke tests."""

import hashlib
import json
import os
from pathlib import Path
import re
import select
import signal
import sys
import termios
import time
import tty


START_PASTE = b"\x1b[200~"
END_PASTE = b"\x1b[201~"
MAX_BOOTSTRAP_BYTES = 1024
MAX_NUDGE_BYTES = 128
FOUNDER_SENTINEL = "BEGIN-LARGE-CHARTER"

role = os.path.basename(sys.argv[0])
prompt = "❯" if role == "claude" else "›"
claude_startup = os.environ.get("LOOP_SMOKE_CLAUDE_STARTUP", "")
trace_path = os.environ.get("LOOP_SMOKE_TRACE_PATH", "")
fd = sys.stdin.fileno()
original = termios.tcgetattr(fd)
signal.alarm(30)


def emit(value: str) -> None:
    sys.stdout.write(f"{value}\r\n")
    sys.stdout.flush()
    if trace_path:
        trace_fd = os.open(trace_path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
        try:
            os.write(trace_fd, f"{role}\t{value}\n".encode("utf-8"))
        finally:
            os.close(trace_fd)


def read_until(suffix: bytes) -> None:
    window = bytearray()
    while not window.endswith(suffix):
        chunk = os.read(fd, 1)
        if not chunk:
            raise SystemExit(3)
        window.extend(chunk)
        if len(window) > len(suffix):
            del window[0]


def read_bracketed_paste() -> bytes:
    read_until(START_PASTE)
    value = bytearray()
    while not value.endswith(END_PASTE):
        chunk = os.read(fd, 1)
        if not chunk:
            raise SystemExit(3)
        value.extend(chunk)
    return bytes(value[: -len(END_PASTE)])


def read_initial_submission() -> bytes:
    """Accept startup bytes queued just before or after bracketed mode."""
    value = bytearray()
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if not ready:
            if value:
                break
            continue
        chunk = os.read(fd, 4096)
        if not chunk:
            raise SystemExit(3)
        value.extend(chunk)
        if END_PASTE in value:
            break
    submitted = bytes(value).rstrip(b"\r\n")
    start = submitted.find(START_PASTE)
    end = submitted.rfind(END_PASTE)
    if start >= 0 and end > start:
        return submitted[start + len(START_PASTE) : end]
    return submitted


def wait_for_gate() -> None:
    gate_dir = Path(".git")
    if role != "gemini" or not (gate_dir / "loop-smoke-hash-gate").exists():
        return
    (gate_dir / f"loop-smoke-{role}.ready").touch()
    deadline = time.monotonic() + 10
    while not (gate_dir / "loop-smoke-continue").exists():
        if time.monotonic() >= deadline:
            emit(f"BOOTSTRAP_GATE_TIMEOUT {role}")
            raise SystemExit(8)
        time.sleep(0.05)


def verify_bootstrap(bootstrap_bytes: bytes) -> None:
    if len(bootstrap_bytes) >= MAX_BOOTSTRAP_BYTES:
        emit(f"BOOTSTRAP_TOO_LARGE {role} bytes={len(bootstrap_bytes)}")
        raise SystemExit(5)
    bootstrap = bootstrap_bytes.decode("utf-8").replace("\r\n", "\n").replace(
        "\r", "\n"
    )
    if FOUNDER_SENTINEL in bootstrap:
        emit(f"BOOTSTRAP_BODY_LEAK {role}")
        raise SystemExit(6)
    path_match = re.search(
        r"^Your complete charter is stored at: (.+)$", bootstrap, re.MULTILINE
    )
    hash_match = re.search(
        r"^Expected SHA-256: ([0-9a-f]{64})$", bootstrap, re.MULTILINE
    )
    if not path_match or not hash_match or "fail closed" not in bootstrap:
        emit(f"BOOTSTRAP_BINDING_MISSING {role}")
        raise SystemExit(7)
    wait_for_gate()
    charter_path = Path(path_match.group(1))
    charter = charter_path.read_bytes()
    actual = hashlib.sha256(charter).hexdigest()
    expected = hash_match.group(1)
    if actual != expected:
        emit(
            f"BOOTSTRAP_HASH_MISMATCH {role} expected={expected} actual={actual}"
        )
        raise SystemExit(9)
    emit(
        " ".join(
            [
                f"BOOTSTRAP_VERIFIED {role}",
                f"bytes={len(bootstrap_bytes)}",
                f"charter_bytes={len(charter)}",
                f"sha256={actual}",
            ]
        )
    )
    emit(f"WORK_STARTED {role}")


def receive_nudge() -> None:
    emit(f"NUDGE_READY {role}")
    sys.stdout.write(f"{prompt} ")
    sys.stdout.flush()
    nudge_bytes = read_bracketed_paste()
    nudge = nudge_bytes.decode("utf-8")
    if len(nudge_bytes) >= MAX_NUDGE_BYTES:
        emit(f"NUDGE_TOO_LARGE {role} bytes={len(nudge_bytes)}")
        raise SystemExit(10)
    if FOUNDER_SENTINEL in nudge or "COMPILED-BRIDGE-SENTINEL" in nudge:
        emit(f"NUDGE_BODY_LEAK {role}")
        raise SystemExit(11)
    emit(
        f"NUDGE_RECEIVED {role} bytes={len(nudge_bytes)} text={json.dumps(nudge)}"
    )
    read_until(b"\r")
    emit(f"NUDGE_SUBMITTED {role}")


def prepare_input_prompt() -> None:
    if role != "claude" or not claude_startup:
        sys.stdout.write("\x1b[?2004h")
        emit(f"READY {role}")
        sys.stdout.write(f"{prompt} ")
        sys.stdout.flush()
        return

    emit("CLAUDE_STARTUP_WARNING Permission deny rule is active")
    if claude_startup == "never-ready":
        while True:
            time.sleep(1)
    if claude_startup != "delayed-dev":
        emit(f"UNKNOWN_CLAUDE_STARTUP_MODE {claude_startup}")
        raise SystemExit(12)

    # Synthetic transport-timing fixture only; it does not certify Claude's
    # producer shape. The producer-derived replay lives under
    # evals/replay/claude-dev-channel-preconnect-warning/. This fake keeps the
    # captured 2.1.220 seam that matters to the compiled-binary smoke: the
    # suggestion is plain pane text while the real input cursor remains at x=2.
    # Stay on a stable nonempty warning long enough that the old negative-
    # readiness launcher would have pasted early. Then require the expected
    # development-channel confirmation before exposing the empty composer.
    time.sleep(1)
    emit("WARNING: Loading development channels")
    emit("--dangerously-load-development-channels is for local channel development only.")
    emit("1. I am using this for local development")
    emit("CLAUDE_DEV_CHANNEL_PROMPT")
    read_until(b"\r")
    emit("CLAUDE_DEV_CHANNEL_CONFIRMED")
    sys.stdout.write("\x1b[?2004h")
    emit(f"READY {role}")

    def render_plain_suggestion() -> None:
        sys.stdout.write("\x1b[?2026h\x1b[2J\x1b[H")
        sys.stdout.write(f'{prompt} Try "inspect this repository"')
        sys.stdout.write("\r\x1b[2C\x1b[?2026l")
        sys.stdout.flush()

    render_plain_suggestion()
    # Loop sends ordered End,C-l. End is a content-preserving no-op for the
    # empty buffer; consuming C-l and redrawing gives tmux a positive
    # window_activity acknowledgment before the bootstrap paste is allowed.
    read_until(b"\x0c")
    emit("CLAUDE_ACTIVITY_PROBE_ACK")
    render_plain_suggestion()
    sys.stdout.flush()


try:
    # TCSANOW preserves bytes that tmux may have queued immediately after pane
    # creation. The default TCSAFLUSH would discard that bootstrap and make the
    # smoke test a race against Python process startup.
    tty.setraw(fd, termios.TCSANOW)
    prepare_input_prompt()
    bootstrap = read_initial_submission()
    verify_bootstrap(bootstrap)
    signal.alarm(30)
    receive_nudge()
    signal.alarm(0)
    time.sleep(60)
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, original)
