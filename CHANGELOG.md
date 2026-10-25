# Changelog

## 0.7.0 (2026-10-25)

- Self-failures mail at onset and every 3 hours while they hold, nothing on recovery: `probing stalled` (from the prober, or from the page Worker when the prober does not answer) and the new `database writes`. A bad Cloudflare API token, `results for <check>` and a full relay are digest-only, with or without `digest`; the `SELF-CHECK` mail for them is gone, so set `digest` to see them. The page Worker's hourly mail and the exact-minute digest window are gone.
- `digest` defaults to `12:00` UTC: an instance that never set it now receives a daily mail. `digest_only` no longer needs it.
- New optional `outside` Worker (`"outside": true`) polls `GET /healthz` every minute from its own Worker and database and mails `OUTSIDE CHECK FAILING` after two failing minutes, every 3 hours while it fails, and `OUTSIDE CHECK RECOVERED` once. Turning `outside` off leaves the deployed Worker running: `wrangler delete` it and its database.
- Mail is retried with backoff, 1 minute doubling to 15, and goes dead after 24 hours instead of 10 tries. A rejected recipient or sender goes dead after 3 tries. A `DOWN` whose check is still down is never dead.
- `GET /healthz` answers `200 ok` while the prober's last run is recent and no mail is dead, otherwise `503` with `stale`, `dead` or `unavailable`.
- A relay with 200 mails waiting answers `503` to a new key, so senders retry; `rejected` now means 100 open keys.
- A config whose probes cannot finish inside the shortest interval at `timeout_ms` fails validation. A config that no longer parses must be fixed before deploy.
- History of a check id missing from the config is kept for 7 days.
- `token_sha256` takes a list of up to 2 hashes, so a token rotates without a gap.
- Migration `0005_outbox_retry` adds `outbox.next_at` and drops queued legacy mail. Rolling back to 0.6.0 ignores the column, retries by attempt count again and deletes absent check ids at once.

## 0.6.0 (2026-10-24)

- Relay mail is verbatim. The subject is the sender's `title` and the body its `description`, with no label, relay name or key; the mail transport reduces the text to printable ASCII. A resolve mails under the title the key last fired with. A blank title answers `400`; titles clip at 900 characters. `STOPPED REPORTING` and `ALERTS` keep their own format.
- A `digest_only` relay tallies every key fired since the last digest, so a key that fired and resolved between digests is listed: `<title>: fired <n>, first ..., last ..., open|closed`. Migration `0004_fired` adds the tally table and a `description` column.
- A relay takes `maintenance`: keys are recorded, nothing is mailed or digested, and `GET /relay/kept` with the relay's token returns the keys firing now with their title and description.
- The `DIGEST` body always ends with a summary line: checks up, relay keys fired and closed, mail sent and dead. An all-up day is no longer blank. Rolling back to 0.5.0 ignores migration `0004_fired` and leaves `relay_fired` unpruned.

## 0.5.0 (2026-10-17)

- Mail is for outages. Self-checks no longer mail when they fail: the `DIGEST` lists a failing Cloudflare API token, `results for <check>`, `probing stalled` and a full relay while it lasts. Where the digest cannot be produced, one `SELF-CHECK FAILING` mail goes out at the digest time instead: from the page Worker when the prober does not answer (was hourly), from the prober when D1 writes fail. An instance without `digest` keeps `SELF-CHECK FAILING` as push.
- `DEPLOYED` and every `SELF-CHECK OK` mail (`probing resumed`, token, `results for <check>`, relay has room) are gone. Queued ones are dropped.
- Checks that go down or recover in the same run share one `DOWN` or `UP` mail per address, with a line per check. A single check keeps its subject.
- A relay takes `digest_only`: its keys are recorded and listed in the `DIGEST`, and nothing is mailed for them.

## 0.4.2 (2026-10-12)

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
