# Setup

## Prerequisites

- A Cloudflare account and a zone on it for the status hostname.
- Node (the version in `mise.toml`) and `npm ci` in this repository.
- An instance directory (see [`example/`](../example)).
- For alerts: Email Routing enabled on a zone in the account, and the receiving address verified as a destination.

## Deploy

```sh
export CLOUDFLARE_ACCOUNT_ID=<account id>
npm run deploy -- path/to/instance
```

Authenticate wrangler with `wrangler login` or `CLOUDFLARE_API_TOKEN`. The command validates the instance, deploys the prober, applies D1 migrations, builds the page and deploys it on the instance `domain`. `--dry-run` validates and builds without deploying. Services show as unknown until the first cron round.

## tls checks

A tls check reads certificate packs through the API. Give the prober a token as the `CF_API_TOKEN` secret (`wrangler secret put CF_API_TOKEN` in `prober/`) with a policy scoped to the checked zones only: Zone Read and SSL and Certificates Read. Without it, tls checks report a configuration error and never alert.

## Alerts

tower mails once when a check goes down and once when it recovers. The destination in `alert.to` must be a verified Email Routing destination, and `alert.from` an address on a routed zone. A failed send is retried on the next run.

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

Add a WAF rate limiting rule on `/beat/*` for the zone. The page Worker also rate limits beats, as a second layer.

## Backup

```sh
npx wrangler d1 export DB --remote --output tower.sql
```

Run it from `prober/`. D1 time travel also restores the database to any minute inside your plan's retention window (`wrangler d1 time-travel restore`).

## External monitoring

tower cannot report its own death. Poll `/api/status` from outside and alert when:

- `last_run` is more than three minutes old;
- `outbox_oldest_unsent_at` is not null and older than a few minutes;
- `dead_outbox` is above 0 (alerts that gave up in the last 24 h);
- `stuck` is above 0 (public checks with no conclusive run inside three intervals).

## Update

Pull, then run the deploy command again. Migrations apply in the same step.
