# Dependency Map
> Machine-readable overview of the build graph and cross-service/cross-module dependencies.
> Refreshed by `scripts/refresh-dependency-map.sh` on any build-graph change.
> Agents must read this before reasoning about cross-module impact.

Last updated: <!-- YYYY-MM-DD by refresh-dependency-map.sh -->

---

## Services / modules

```
[service-a]
  owns: [paths or domains it is responsible for]
  exposes: [APIs, events, interfaces it publishes]
  consumes: [APIs, events, interfaces it depends on]
  test-command: [how to run its tests]
  observability: [where its logs/metrics/traces live]

[service-b]
  owns: ...
  exposes: ...
  consumes: ...
  test-command: ...
  observability: ...
```

---

## Dependency graph (text)

```
[service-a] ──► [service-b]  (REST /api/v1/resource)
[service-a] ──► [service-c]  (event: user.created)
[service-b] ──► [data-store] (Postgres, schema: db/schema.sql)
[service-c] ──► [data-store] (read replica)
[service-c] ──► [external-payment-api] (HTTPS, retries: 3)
```

---

## Cross-cutting concerns

| Concern | Owner module | Notes |
|---|---|---|
| Auth / session | [module] | JWT via [service]. Token refresh: [location]. |
| Secrets | [module] | Proxied via [secrets-layer]. Agents never see raw creds. |
| Feature flags | [module] | [Where flags are defined and read] |
| Background jobs | [module] | [Queue type, visibility timeout, DLQ location] |

---

## Blast-radius guide

Use this before estimating the impact of a change.

| If you touch… | Also check… | Why |
|---|---|---|
| Auth module | All services (session validation) | Every service verifies tokens |
| Data-store schema | All services that read that table | Schema change = potential breakage |
| Shared event types | All consumers of that event | Interface contract |
| [Other critical path] | [Downstream] | [Reason] |

---

## How to update

```bash
scripts/refresh-dependency-map.sh
```

The script:
1. Parses import graphs and OpenAPI specs.
2. Queries the service registry for active consumers.
3. Rewrites the "Dependency graph" section above.
4. Stamps the "Last updated" header.

Run it whenever: a new service is added, a public interface changes, or a cross-service dependency is added or removed.
