#!/usr/bin/env python3
import os
import select
import signal
import sys
import termios
import time
import tty


if "app-server" in sys.argv:
    raise SystemExit(2)

role = os.path.basename(sys.argv[0])
marker = (
    "[Pasted text #21]" if role == "claude" else "[Pasted Content 22083 chars]"
)
prompt = "❯" if role == "claude" else "›"
fd = sys.stdin.fileno()
original = termios.tcgetattr(fd)
signal.alarm(20)


def read_until(suffix: bytes) -> None:
    window = bytearray()
    while not window.endswith(suffix):
        chunk = os.read(fd, 1)
        if not chunk:
            raise SystemExit(3)
        window.extend(chunk)
        if len(window) > len(suffix):
            del window[0]


try:
    tty.setraw(fd)
    sys.stdout.write("\x1b[?2004h")
    sys.stdout.write(f"READY {role}\r\n{prompt} ")
    sys.stdout.flush()
    read_until(b"\x1b[201~")

    if role in ("claude", "codex"):
        early, _, _ = select.select([fd], [], [], 1.0)
        if early:
            os.read(fd, 4096)
            sys.stdout.write(f"\r\nEARLY_ENTER {role}\r\n")
            sys.stdout.flush()
            raise SystemExit(4)

    sys.stdout.write(f"{marker}\r\n")
    sys.stdout.flush()
    read_until(b"\r")
    signal.alarm(0)
    sys.stdout.write(f"SUBMITTED {role}\r\n")
    sys.stdout.flush()
    if role == "gemini":
        signal.alarm(20)
        sys.stdout.write(f"BRIDGE_READY {role}\r\n{prompt} ")
        sys.stdout.flush()
        read_until(b"\x1b[201~")
        early, _, _ = select.select([fd], [], [], 1.0)
        if early:
            os.read(fd, 4096)
            sys.stdout.write(f"\r\nEARLY_BRIDGE_ENTER {role}\r\n")
            sys.stdout.flush()
            raise SystemExit(5)
        sys.stdout.write("[Pasted Content 9279 chars]\r\n")
        sys.stdout.flush()
        read_until(b"\r")
        signal.alarm(0)
        sys.stdout.write(f"BRIDGE_SUBMITTED {role}\r\n")
        sys.stdout.flush()
    time.sleep(60)
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, original)
