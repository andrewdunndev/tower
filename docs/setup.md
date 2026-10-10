# Setup

## Prerequisites

- A Cloudflare account on the Workers Paid plan, and a zone on it for the status hostname. tower is not tested against the Free plan's per-invocation CPU and subrequest limits.
- Node (the version in `mise.toml`) and `npm ci` in this repository.
- For alerts: the `alert.from` domain onboarded to Cloudflare Email Service, and `alert.to` verified as a destination address in the account.

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

The command validates the instance, deploys the prober, applies D1 migrations, builds the page and deploys it on the instance `domain`. The first deploy creates the D1 database. `--dry-run` validates, builds and bundles without deploying, and needs no account id or credentials. Services show as unknown until the first cron round.

The `domain/*` route needs a proxied DNS record in the zone to receive traffic. If the hostname has no record, add a placeholder such as `AAAA` `100::` with the proxy on.

## tls checks

A tls check reads certificate packs through the API. Give the prober a token as the `CF_API_TOKEN` secret with a policy scoped to the checked zones only: Zone Read and SSL and Certificates Read.

```sh
npx wrangler secret put CF_API_TOKEN --name <name>-prober
```

Without it, tls checks report a configuration error and never alert.

## Alerts

tower mails once when a check goes down and once when it recovers. A failed send is retried on the next run.

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

## Backup

```sh
npx wrangler d1 export <name> --remote --output tower.sql
```

D1 time travel also restores the database to any minute inside your plan's retention window (`wrangler d1 time-travel restore`).

## External monitoring

tower cannot report its own death. Poll `/api/status` from outside; its JSON carries:

- `v` is the response-shape version, `1` today. It changes only on a breaking change.
- `generatedAt`, `checks`, `incidents` and `maintenance` are what the page renders, by check name.
- `last_run` is when the last probe ran.
- `outbox_oldest_unsent_at` is when the oldest unsent alert was queued, or null.
- `dead_outbox` counts alerts that gave up in the last 24 h.
- `stuck` counts public checks with no conclusive run inside three intervals.

Alert when:

- `last_run` is more than three minutes old;
- `outbox_oldest_unsent_at` is not null and older than a few minutes;
- `dead_outbox` is above 0;
- `stuck` is above 0.

## Upgrade

Check out the release tag you want, then run the deploy command again. [CHANGELOG.md](../CHANGELOG.md) lists what changed.
