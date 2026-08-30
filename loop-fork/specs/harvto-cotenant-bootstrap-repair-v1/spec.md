# Harvto co-tenant paired bootstrap repair

Paired tmux startup must address exactly the socket selected at launch for every
pane create, capture, key, layout, liveness, and cleanup command. A failed
startup must remove only its owned session before requesting shutdown of its
owned Codex proxy. Foreign sessions on the same server must remain untouched.

