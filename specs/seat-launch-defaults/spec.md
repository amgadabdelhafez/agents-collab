# Seat launch defaults

Founder addendum 2026-10-04: new runs launch Codex driver with gpt-6.1-sol/low and Claude reviewer with claude-sonnet-5-5/medium. Explicit flags/env retain precedence. Keep Claude driver opus/low and Codex reviewer gpt-5.6-sol/high. Shared existing role defaults are low driver/high reviewer; keep them and specialize only Claude reviewer. Keep generic/headless Claude SDK default opus.

Existing runs must retain saved models or old defaults when model fields are absent. Apply only at launch-option preparation, with narrowly validated model persistence in the manifest constructor/loader. Separate compatibility commit from new defaults and session-pressure removal.

Acceptance: both tmux and headless model resolution; no-flag paired argv for each new seat; flags/env including explicit values matching defaults; per-role/global effort override precedence; fresh and existing manifest/no-model scenarios. Same full baseline comparison, check, candidate binary and final gate as remove-session-pressure.
