# Plan

1. Derive the configured agent set from the run manifest.
2. Fail closed in `send_message` before enqueueing an absent target.
3. Cover the observed Claude/Codex run targeting Gemini and preserve legacy topology-free behavior.
