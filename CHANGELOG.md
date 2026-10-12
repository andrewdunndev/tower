# Changelog

## Unreleased

- The stall alarm holds for 15 minutes after the prober is deployed: Cloudflare re-registers the cron on deploy, and the gap no longer mails `probing stalled` or `probing resumed`. A deploy that never ticks is still caught once the 15 minutes pass.

## 0.4.1 (2026-10-12)

- A slow probe no longer costs the run: checks that finished before the next tick keep their results, and a probe still running counts as no result.

## 0.4.0 (2026-10-12)

- Checks and relays take an optional `to`, one address or up to 5, in place of `alert.to`. It routes `DOWN`, `UP`, `FIRING`, `RESOLVED`, `STOPPED REPORTING` and `ALERTS`, one mail per address, each retried on its own. Deploy, digest and self-check mail stay on `alert.to`. Unsent mail to a removed address moves to the current route.
- Migration 0003 adds `outbox.to`. Rolling back to 0.3.2 ignores it and sends pending routed alerts to `alert.to`.

## 0.3.3 (2026-10-12)

- Self-checks allow a minute of cron slack: an uneven or skipped Cloudflare cron tick no longer mails `SELF-CHECK OK: probing resumed`, and stalled, stuck and database-writes alarms wait three intervals plus a minute.

## 0.3.2 (2026-10-11)

- Relay and alert mail drop emoji and other non-ASCII (accented letters keep their base letter) instead of printing `?`.

## 0.3.1 (2026-10-11)

- The check name column has a fixed width. A name that does not fit is cut with an ellipsis and shows in full as a tooltip, instead of breaking mid-word and doubling the row.

## 0.3.0 (2026-10-11)

- Self-checks mail `SELF-CHECK FAILING: results for <check>` when a check has no conclusive result for three of its intervals, and an OK when it recovers. `/api/status` `self` and the page banner list a stuck public check.
- The page Worker has its own minute cron and `send_email` binding. It asks the prober to `watch` its last run and mails `SELF-CHECK FAILING: probing stalled` once, so the alert survives a dead prober cron.
- No migration. Roll back both Workers together: 0.2.0 mails a pending stuck row as `DOWN`.

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
