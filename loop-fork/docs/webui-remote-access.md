# Web UI phone and Tailscale access

The Web UI automatically switches to its phone layout at widths of 760px and
below. No view toggle is required.

## Local access

```bash
bun run web:dev
```

Open `http://127.0.0.1:46327/`.

## Private Tailscale access

Make sure Tailscale is connected on this Mac and on the phone or other device,
then run:

```bash
bun run web:tailscale
```

The command prints the exact private URLs to open. When MagicDNS is available,
it prints both a `100.x.y.z` address and the device's tailnet DNS name.

The Tailscale launcher fails before starting the server unless it can verify a
healthy node and an address in Tailscale's `100.64.0.0/10` range. It binds only
to that exact address, never `0.0.0.0`, and does not change Tailscale ACLs,
Tailscale Serve configuration, macOS firewall rules, or the Web UI's read-only
data boundary.

Keep the command running while using the UI. Stop it with `Ctrl-C`.
