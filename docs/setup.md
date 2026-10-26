# Setup

## Prerequisites

- A Cloudflare account on the Workers Paid plan, and a zone on it for the status hostname. tower is not tested against the Free plan's per-invocation CPU and subrequest limits.
- Node (the version in `mise.toml`) and `npm ci` in this repository.
- For alerts: the `alert.from` domain onboarded to Cloudflare Email Service, and `alert.to` and every `to` on a check or relay verified as destination addresses in the account.

## Instance

`tower.json` ([`example/`](../example) is a starter) names the instance with a required `name`, a slug of lowercase letters, digits and hyphens, at most 54 characters. It derives every Cloudflare resource: Workers `<name>-prober` and `<name>-page`, the service binding between them and the D1 database `<name>`. With `"outside": true` also the Worker `<name>-outside` and the D1 database `<name>-outside`. Two instances with different names can share an account. Renaming deploys a new, empty instance and leaves the old Workers and D1 database in place to delete by hand.

Notes are Markdown files in `notes/` with this frontmatter:

```md
---
title: Database upgrade
kind: maintenance
start: 2026-11-01T02:00:00Z
end: 2026-11-01T04:00:00Z
checks: [api]
---
Shown on the page under the title.
```

`kind` is `incident` or `maintenance`. A maintenance note needs `end`, at most seven days after `start`, and suppresses alerts for its checks inside the window. `checks` lists check ids; the page shows their names, and only for public checks.

## Look

The page renders `title` in the header and the tab. Two optional instance files change the rest:

- `favicon.svg` is the tab icon and the header logo. Without it the repository's `favicon.svg` is used.
- `theme.css` is loaded after the built-in theme. Override any of these custom properties on `:root`, most of them with `light-dark(light, dark)`:
  - surfaces and text: `--bg`, `--panel`, `--ink`, `--dim`, `--faint`, `--line`, `--line2`
  - accent: `--spot`
  - states: `--up`, `--degraded`, `--down`, `--maintenance`, `--unknown`
  - charts: `--spark`, `--day-ok`, `--day-none`
  - fonts: `--disp`, `--body`, `--mono`

## Deploy

```sh
export CLOUDFLARE_ACCOUNT_ID=<account id>
npm run deploy -- path/to/instance
```

Authenticate wrangler with `npx wrangler login` or `CLOUDFLARE_API_TOKEN`. An API token needs Account Workers Scripts Edit and D1 Edit, and Zone Workers Routes Edit on the zone.

The command validates the instance, applies D1 migrations, deploys the prober, builds the page and deploys it on the instance `domain`. On the first deploy the prober creates the D1 database and the migrations follow. A `SELF-CHECK FAILING: database writes` mail in that minute is spurious. `--dry-run` validates, builds and bundles without deploying, and needs no account id or credentials. Services show as unknown until the first round. The page Worker also carries a minute cron.

The `domain/*` route needs a proxied DNS record in the zone to receive traffic. If the hostname has no record, add a placeholder such as `AAAA` `100::` with the proxy on.

## tls checks

A tls check reads certificate packs through the API. Give the prober a token as the `CF_API_TOKEN` secret with a policy scoped to the checked zones only: Zone Read and SSL and Certificates Read.

```sh
npx wrangler secret put CF_API_TOKEN --name <name>-prober
```

Without it, tls checks report a configuration error and never alert.

## Alerts

tower mails when checks go down and when they recover: one `DOWN` mail per run for every check that went down, one `UP` mail for every check that recovered, per address. A single check keeps its own subject, `DOWN: <name>`; several share one subject listing them, with a line per check. A failed send is retried with backoff, 1 minute doubling to 15.

Mail goes to `alert.to` unless a check or relay names its own `to`: one address, or a list of up to 5. `to` replaces `alert.to`, so list `alert.to` as well to keep a copy. For a larger team, use a group address.

```json
{ "id": "api", "type": "http", "name": "API", "url": "https://api.example.com/health", "to": ["api@example.com", "oncall@example.com"] }
```

`to` routes `DOWN`, `UP`, the firing and resolved mails, `STOPPED REPORTING` and `ALERTS`. Each address gets its own mail, retried on its own, so one failing address never repeats a mail to the others. A mail is retried for 24 hours, then goes dead and shows in the digest and in `dead_outbox`. A rejected recipient or sender (`E_RECIPIENT_NOT_ALLOWED`, `E_SENDER_NOT_VERIFIED` and the other non-transient codes) goes dead after 3 tries. A `DOWN` whose check is still down is never dead. Unsent mail to an address you remove or correct moves to the current `to`, or to `alert.to` once `to` is gone, and skips an address that already has it. Mail already dead stays dead.

## Heartbeats

A heartbeat check expects a request within `every` plus `grace`. Make a token and put its hash in `token_sha256`:

```sh
openssl rand -hex 32 | tee token | tr -d '\n' | openssl dgst -sha256 -r | cut -d' ' -f1
```

To rotate a token, list two hashes, `"token_sha256": ["<old>", "<new>"]`, deploy, move the senders to the new token, then drop the old hash and deploy again. A relay rotates the same way. At most 2 hashes are accepted.

Beat from the job:

```sh
curl -fsS -X POST -H "Authorization: Bearer $(cat token)" https://<domain>/beat/<check id>
```

Report failure by posting to `/beat/<check id>/fail`. Or from systemd, on the unit that does the work:

```ini
[Unit]
OnSuccess=beat@ok.service
OnFailure=beat@fail.service
```

where `beat@.service` runs the curl above, posting to `/fail` when the instance is `fail`.

Add a WAF rate limiting rule on `/beat/*` for the zone: a request that reaches the Worker is billed whether or not it is refused.

## Relays

A relay accepts an incident.io alert-event body at `POST /relay/incident` and mails on transitions only: when a key opens and when it closes. The mail is the sender's own: the subject is the `title` and the body is the `description`, as sent. A resolve mails under the title the key last fired with, so a firing mail and its resolve share one subject and only the sender's `description` tells them apart. [HyperDX](https://www.hyperdx.io) is the intended sender. Name the relay in `tower.json` and give it a token hash as for a heartbeat:

```json
"relays": [{ "id": "alerts", "name": "Alerts", "token_sha256": "<hash>", "grace": "15m", "to": "oncall@example.com" }],
"digest": "07:30"
```

In HyperDX add a webhook with service `incident.io`, URL `https://<domain>/relay/incident`, header `Authorization: Bearer <token>` and an empty body template. tower reads `title`, `description`, `deduplication_key` and `status` (`firing` or `resolved`) and ignores the rest, `source_url` included.

- A request answers `202` with `{"result": "transition"}` (mailed), `"duplicate"` (the key was already in that state; a firing renews its lease) or `"rejected"` (the relay holds 100 open keys). A relay with 200 mails waiting answers `503` to a new key and stores nothing, so senders retry. A bad or missing token answers `404`, a body without a title, key or valid status `400`, another media type than `application/json` `415`, and a body over 64 KiB `413`.
- Set `"digest_only": true` on a relay to keep its keys out of the mail: nothing is sent for a firing, a resolve or a key that stops reporting. The `DIGEST` instead lists every key that fired since the last digest, one line each: `<title>: fired <n>, first <MM-DD HH:MM>Z, last <MM-DD HH:MM>Z, open` (or `closed`: resolved, or expired without a resolve). `<title>` is the latest firing title, `fired` counts firings of a closed key (a repeat of an open key is not one), and a key still open counts toward the digest's "need attention". An open key whose tally was already sent is listed as `OPEN` until it closes. A relay tallies at most 100 keys per digest.
- Set `"maintenance": true` for work an agent picks up rather than mail a person reads. It records like `digest_only`, mails nothing, even when full, and never appears in the `DIGEST`. `GET https://<domain>/relay/kept` with the relay's bearer token answers `200` with `[{"key","title","description","since","seen"}]`, the keys firing now ordered by `since`, and `404` for a bad token or a relay that is not `maintenance`. A key that resolves or stops reporting leaves the list, and no history is kept. A relay is `digest_only` or `maintenance`, not both.
- A key left open for `grace` without another firing closes with one `STOPPED REPORTING` mail, which also covers a lost resolved. A later firing of the key mails again. Set `grace` above the sender's re-notify gap, at most 7 days.
- At most 5 transitions per relay per minute mail at once; the rest wait for the next run and, when more than one is waiting, arrive as one `ALERTS: <relay>: <n> changed` mail per address with a line per key. 100 open keys can therefore send up to 100 changes in a burst. A rejected key makes a digest flag (see Self-checks).
- There are no silences on relays.
- `/relay/*` needs no rate limiting rule, because a bad token is refused before any write. Keep it out of any rule shared with `/beat/*`: a sender's burst would answer `429` to the beats, and senders do not retry `4xx`.
- Titles and descriptions reach the alert mail, keys reach `STOPPED REPORTING`, and a maintenance relay's `/relay/kept`, never the page or `/api/status`.

## Self-checks

Two conditions mail when they start and again every 3 hours while they hold. Recovery never mails, and tower never mails `DEPLOYED` or `OK`. These mails go to `alert.to`, even for a check or relay with its own `to`, and the `DIGEST` lists each while it holds.

- `SELF-CHECK FAILING: probing stalled`: no run has written results for three of the shortest `every` plus a minute, or for `stall_after` (a duration such as `"15m"`, at least that default and at most `"1d"`) when set. A Durable Object alarm drives probing; the cron re-arms it. Raise `stall_after` if gaps of a few minutes mail. `/healthz` reports `stale` on the same window. The page Worker's minute cron asks the prober, so a dead prober cron is caught, and the digest due while the cron is stalled is still queued and lists it. A prober that does not answer shows as `unavailable` at `/healthz`, which only `outside` mails. A deploy re-registers the cron, so the stall check holds for 15 minutes after the prober's version is uploaded.
- `SELF-CHECK FAILING: database writes`: D1 rejected a run's writes.

Three more appear in the `DIGEST` only:

- Cloudflare API token: a tls check gets a `401` or `403`, or the secret is unset. A token that expires is not warned about ahead of time.
- `results for <check>`: any check, public or not, with no conclusive result for three of its intervals plus a minute. A probe that stays inconclusive or misconfigured, such as a tls check with an unset token, counts as no result. A probe that has not answered shortly before the next run of the shortest interval, or never started, counts as no result for that run. A check added later gets the same from when it was added.
- A relay at its limit of open keys, which refused a new one.

`DIGEST` once a day at `digest` (`HH:MM` UTC, default `12:00`). The body always ends with a summary line, `Checked <up>/<total> checks up. Relay keys fired and closed: <n>. Mail: <sent> sent, <dead> dead.`. A normal day is the subject `all up` and that line, preceded by a line for each `digest_only` key that fired. Otherwise the subject counts the items and the body lists down checks, open relay keys, `digest_only` keys that fired, unsent or dead mail and failing self-checks. A day missed to an outage is not backfilled.

## Backup

```sh
npx wrangler d1 export <name> --remote --output tower.sql
```

D1 time travel also restores the database to any minute inside your plan's retention window (`wrangler d1 time-travel restore`).

## External monitoring

tower reports a stalled prober and failing database writes itself, so polling is optional. If both Workers are dead, an account or platform failure, nothing can mail: treat a missing digest as the alarm, or poll from outside. [Outside watcher](#outside-watcher) does the polling.

`GET https://<domain>/healthz` answers `200` with body `ok` only when the prober's last run is within `max(5 min, 3 x shortest interval + 1 min)` (ignored for 15 minutes after a deploy) and no outbox row is dead. Otherwise it answers `503` with `stale`, `dead` or `unavailable`. It sends `Cache-Control: no-store`, never redirects and carries no data. Each request reads D1, so give it its own per-IP WAF rate limiting rule that blocks, never challenges, scoped to `/healthz` alone: not shared with `/beat/*` or any global count. A dead row keeps it `503` for the 24 hours dead rows are kept.

A Cloudflare Health Check on it: GET, port 443, `expected_codes` 200, `expected_body` `ok`, `follow_redirects` off, two or three regions, `consecutive_fails` 2 or 3. Health Checks need a Pro zone or above (Free has none); any external poller works. The check runs on Cloudflare's edge, so a Cloudflare-wide outage is not caught.

`/api/status` is the detail source; its JSON carries:

- `v` is the response-shape version, `1` today. It changes only on a breaking change.
- `generatedAt`, `checks`, `incidents` and `maintenance` are what the page renders, by check name.
- `last_run` is when the last probe ran.
- `outbox_oldest_unsent_at` is when the oldest unsent mail was queued, or null.
- `dead_outbox` counts mails that gave up in the last 24 h, one per address.
- `stuck` counts public checks with no conclusive run inside three intervals plus a minute.
- `self` lists failing self-checks by name with the time the flag was set. `probing stalled` and `database writes` are mail-only and never listed.

## Outside watcher

`"outside": true` in `tower.json` deploys a third Worker, `<name>-outside`, with its own D1 database `<name>-outside`. It has no binding to the prober, the page or their database. Each minute it runs `GET https://<domain>/healthz` without following redirects and allows 10 seconds. Only `200` with body `ok` is healthy. Anything else fails: `503` with `stale`, `dead` or `unavailable`, any other status, a timeout or a network error. It mails `alert.from` to `alert.to`; interval, timeout and thresholds are fixed.

| Mail | When |
|---|---|
| `OUTSIDE CHECK FAILING: <domain>` | the second consecutive failing minute, so 1 to 2 minutes after the route starts failing; then every 3 hours while it fails |
| `OUTSIDE CHECK RECOVERED: <domain>` | the first healthy minute after a failing mail; a failure that clears before its mail sends nothing |

The mail names the reason, `<status> <body>`, `no answer within 10 s` or `network error`, and when the failure began. A mail that does not send is retried on the next minute.

It catches a dark route, a stalled or dead prober, a dead mail row, `unavailable`, a dead page Worker, and a certificate or DNS fault on the route. A challenge or Access rule on `/healthz` reads as failing. It runs on Cloudflare, as does its mail, so a Cloudflare-wide outage silences it too; the missing digest remains the alarm for that.

Turning `outside` off stops deploying the Worker but leaves the deployed one running. Remove it with `npx wrangler delete --name <name>-outside` and `npx wrangler d1 delete <name>-outside`.

## Upgrade

Check out the release tag you want, then run the deploy command again. [CHANGELOG.md](../CHANGELOG.md) lists what changed.

## Rollback

A Worker version rollback restores code, not D1. Migrations are additive, so an older version runs on a newer schema: 0.6.0 ignores `outbox.next_at` from migration `0005_outbox_retry`. Versions before 0.7.0 delete the history of a check id missing from the config at once; 0.7.0 keeps it for 7 days. A Cloudflare Worker rollback re-serves any secret deleted since that version, such as `CF_API_TOKEN`, and does not show it in `secret list`. Never roll back below 0.2.0.
