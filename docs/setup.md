# Setup

## Prerequisites

- A Cloudflare account on the Workers Paid plan, and a zone on it for the status hostname. tower is not tested against the Free plan's per-invocation CPU and subrequest limits.
- Node (the version in `mise.toml`) and `npm ci` in this repository.
- For alerts: the `alert.from` domain onboarded to Cloudflare Email Service, and `alert.to` and every `to` on a check or relay verified as destination addresses in the account.

## Instance

`tower.json` ([`example/`](../example) is a starter) names the instance with a required `name`, a slug of lowercase letters, digits and hyphens, at most 54 characters. It derives every Cloudflare resource: Workers `<name>-prober` and `<name>-page`, the service binding between them and the D1 database `<name>`. Two instances with different names can share an account. Renaming deploys a new, empty instance and leaves the old Workers and D1 database in place to delete by hand.

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

The command validates the instance, applies D1 migrations, deploys the prober, builds the page and deploys it on the instance `domain`. On the first deploy the prober creates the D1 database and the migrations follow, so a `SELF-CHECK FAILING: database writes` mail in that minute is spurious. `--dry-run` validates, builds and bundles without deploying, and needs no account id or credentials. Services show as unknown until the first cron round. The page Worker also carries a minute cron and the `send_email` binding.

The `domain/*` route needs a proxied DNS record in the zone to receive traffic. If the hostname has no record, add a placeholder such as `AAAA` `100::` with the proxy on.

## tls checks

A tls check reads certificate packs through the API. Give the prober a token as the `CF_API_TOKEN` secret with a policy scoped to the checked zones only: Zone Read and SSL and Certificates Read.

```sh
npx wrangler secret put CF_API_TOKEN --name <name>-prober
```

Without it, tls checks report a configuration error and never alert.

## Alerts

tower mails once when a check goes down and once when it recovers. A failed send is retried on the next run.

Mail goes to `alert.to` unless a check or relay names its own `to`: one address, or a list of up to 5. `to` replaces `alert.to`, so list `alert.to` as well to keep a copy. For a larger team, use a group address.

```json
{ "id": "api", "type": "http", "name": "API", "url": "https://api.example.com/health", "to": ["api@example.com", "oncall@example.com"] }
```

`to` routes `DOWN`, `UP`, `FIRING`, `RESOLVED`, `STOPPED REPORTING` and `ALERTS`. Each address gets its own mail, retried on its own, so one failing address never repeats a mail to the others. An address that is not a verified destination fails 10 times, then shows as dead in the digest and in `dead_outbox`. Unsent mail to an address you remove or correct moves to the current `to`, or to `alert.to` once `to` is gone, and skips an address that already has it. Mail already dead stays dead.

## Heartbeats

A heartbeat check expects a request within `every` plus `grace`. Make a token and put its hash in `token_sha256`:

```sh
openssl rand -hex 32 | tee token | tr -d '\n' | openssl dgst -sha256 -r | cut -d' ' -f1
```

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

A relay accepts an incident.io alert-event body at `POST /relay/incident` and mails on transitions only: `FIRING` when a key opens, `RESOLVED` when it closes. [HyperDX](https://www.hyperdx.io) is the intended sender. Name the relay in `tower.json` and give it a token hash as for a heartbeat:

```json
"relays": [{ "id": "alerts", "name": "Alerts", "token_sha256": "<hash>", "grace": "15m", "to": "oncall@example.com" }],
"digest": "07:30"
```

In HyperDX add a webhook with service `incident.io`, URL `https://<domain>/relay/incident`, header `Authorization: Bearer <token>` and an empty body template. tower reads `title`, `description`, `source_url`, `deduplication_key` and `status` (`firing` or `resolved`) and ignores the rest.

- A request answers `202` with `{"result": "transition"}` (mailed), `"duplicate"` (the key was already in that state; a firing renews its lease) or `"rejected"` (the relay holds 100 open keys). A bad or missing token answers `404`, a body without a title, key or valid status `400`, another media type than `application/json` `415`, and a body over 64 KiB `413`.
- A key left open for `grace` without another firing closes with one `STOPPED REPORTING` mail, which also covers a lost resolved. A later firing of the key mails again. Set `grace` above the sender's re-notify gap, at most 7 days.
- At most 5 transitions per relay per minute mail at once; the rest wait for the next cron run and, when more than one is waiting, arrive as one `ALERTS: <relay>: <n> changed` mail per address with a line per key. 100 open keys can therefore send up to 100 changes in a burst. A rejected key sends one `SELF-CHECK FAILING` mail, and one `SELF-CHECK OK` follows once the relay has room.
- There are no silences or maintenance windows on relays.
- `/relay/*` needs no rate limiting rule, because a bad token is refused before any write. Keep it out of any rule shared with `/beat/*`: a sender's burst would answer `429` to the beats, and senders do not retry `4xx`.
- Titles, descriptions, URLs and keys reach the alert mail only, never the page or `/api/status`.

## Self-checks

tower mails about itself to `alert.to`, even for a check or relay with its own `to`:

- `DEPLOYED: tower <version>` after every deploy that reaches 100% of traffic, and after `wrangler secret put`, which also creates a version.
- `DIGEST` once a day at `digest` (`HH:MM` UTC). A normal day is the subject `all up` with no body; otherwise the subject counts the items and the body lists down checks, open relay keys, unsent or dead mail and failing self-checks. A day missed to an outage is not backfilled.
- `SELF-CHECK FAILING: Cloudflare API token` when a tls check gets a `401` or `403`, or the secret is unset; `SELF-CHECK OK` when a later tls check authenticates. A token that expires is not warned about ahead of time.
- `SELF-CHECK FAILING: results for <check>` for any check, public or not, with no conclusive result for three of its intervals plus a minute, then `SELF-CHECK OK: results for <check>` at the next one. A probe that stays inconclusive or misconfigured, such as a tls check with an unset token, counts as no result. A probe that has not answered shortly before the next run of the shortest interval, or never started, counts as no result for that run. A check added later gets the same from when it was added.
- `SELF-CHECK FAILING: probing stalled` when no run has written results for three of the shortest `every` plus a minute, then `SELF-CHECK OK: probing resumed` once. The page Worker's minute cron asks the prober, so the mail survives a dead prober cron. A deploy re-registers the cron, so the alarm holds for 15 minutes after the prober's version is uploaded. If the prober does not answer at all, the page mails `probing stalled … did not answer` at the top of each hour until it does.
- `SELF-CHECK FAILING: database writes` once when D1 has rejected the run's writes for three of the shortest `every` plus a minute, then `SELF-CHECK OK: probing resumed` after any gap in the cron longer than that. The minute is slack for Cloudflare's cron, which fires late and unevenly, so an uneven or skipped tick mails nothing.

## Backup

```sh
npx wrangler d1 export <name> --remote --output tower.sql
```

D1 time travel also restores the database to any minute inside your plan's retention window (`wrangler d1 time-travel restore`).

## External monitoring

tower reports a stuck check and a stalled prober itself, so polling is optional. If both Workers are dead, an account or platform failure, nothing can mail: set `digest` and treat a missing digest as the alarm. Otherwise poll `/api/status` from outside; its JSON carries:

- `v` is the response-shape version, `1` today. It changes only on a breaking change.
- `generatedAt`, `checks`, `incidents` and `maintenance` are what the page renders, by check name.
- `last_run` is when the last probe ran.
- `outbox_oldest_unsent_at` is when the oldest unsent mail was queued, or null.
- `dead_outbox` counts mails that gave up in the last 24 h, one per address.
- `stuck` counts public checks with no conclusive run inside three intervals plus a minute.
- `self` lists failing self-checks by name with their start time: the Cloudflare API token and `results for <check>` for a stuck public check.

Alert when:

- `last_run` is more than four minutes old;
- `outbox_oldest_unsent_at` is not null and older than a few minutes;
- `dead_outbox` is above 0;
- `stuck` is above 0;
- `self` is not empty.

## Upgrade

Check out the release tag you want, then run the deploy command again. Never roll back below 0.2.0. [CHANGELOG.md](../CHANGELOG.md) lists what changed.
