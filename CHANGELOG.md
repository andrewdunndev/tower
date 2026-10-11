# Changelog

## 0.2.0 (2026-10-11)

- Relays: `POST /relay/incident` takes the incident.io alert-event body (HyperDX sends it) and mails `FIRING`, `RESOLVED` and, after `grace` without a report, `STOPPED REPORTING`.
- Self-checks mail a deploy notice, an optional daily `digest`, a failing Cloudflare API token and failing database writes. `/api/status` gains `self`, and the page shows a banner for a failing self-check or delayed alert mail.
- `npm run deploy` migrates the database before deploying when it exists. Never roll back below 0.2.0: 0.1.0 prunes relay and self-check mail and answers `405` on `/relay/*`.

## 0.1.0 (2026-10-11)

- A required instance `name` derives the Worker, service binding and D1 names, so instances share an account without colliding. `title`, `favicon.svg` and `theme.css` shape the page.
- Two Workers: a prober that checks on a cron and owns the D1 database, and a page that renders the status page and `/api/status` through Workers RPC. The page holds no secrets and no storage.
- Five check types: http, tcp, dns, tls and heartbeat, each with its own interval and `down_after` and `up_after` thresholds.
- One config file per instance, `tower.json`, validated with plain-language messages. Maintenance windows and incident write-ups are Markdown notes.
- One alert mail per change through Email, retried up to 10 times.
- `npm run deploy -- <instance>` stages, deploys both Workers and applies migrations.
- `/api/status` reports `last_run`, `outbox_oldest_unsent_at`, `dead_outbox` and `stuck` for external monitoring.
- Public surfaces carry names only, never URLs, hosts, ports or failure reasons.
