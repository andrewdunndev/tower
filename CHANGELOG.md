# Changelog

## Unreleased

v0.1.0, a rewrite of the old single-Worker tool.

- Two Workers: a prober that checks on a cron and owns the D1 database, and a page that renders the status page and `/api/status` through Workers RPC. The page holds no secrets and no storage.
- Five check types: http, tcp, dns, tls and heartbeat, each with its own interval and `down_after` and `up_after` thresholds.
- One config file per instance, `tower.json`, validated with plain-language messages. Maintenance windows and incident write-ups are Markdown notes.
- One alert mail per change through Email, retried until delivered.
- `npm run deploy -- <instance>` stages, deploys both Workers and applies migrations.
- `/api/status` reports `last_run`, `outbox_oldest_unsent_at`, `dead_outbox` and `stuck` for external monitoring.
- Public surfaces carry names only, never URLs, hosts, ports or failure reasons.
- Upgrading from the old tool is a fresh deploy: the config format and database changed.
