# Setup

## Prerequisites

- A Cloudflare account and a zone on it for the status hostname.
- Node 22.15 or later.
- For alerts: Email Routing enabled on a zone in the same account, with the address that should receive alerts verified as a destination.

## Quickstart

1. Install and write your config:

   ```sh
   git clone https://gitlab.com/dunn.dev/tower && cd tower
   npm ci
   cp services.example.json services.json
   ```

   Edit `services.json`. Both it and your `wrangler.toml` edits stay local unless you commit them.

2. In `wrangler.toml`, uncomment `[[routes]]` and set your hostname and zone. Repeat the block for more hostnames. `custom_domain = true` makes wrangler create the DNS record.

3. Deploy, authenticated with `wrangler login` or `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`:

   ```sh
   npx wrangler deploy
   ```

   The first deploy creates the `tower` D1 database and the custom domains.

4. Create the tables. The cron logs errors until this runs; later migrations go the same way, before the deploy that needs them:

   ```sh
   npx wrangler d1 migrations apply tower --remote
   ```

5. Open your hostname. Services show as not checked until the first cron round.

## Alerts

tower mails once when a service goes down and once when it comes back. A failed send is logged and never affects checks.

1. Enable Email Routing on a zone in the account and verify the destination address.
2. In `wrangler.toml`, uncomment `[vars]` and `[[send_email]]`. `ALERT_FROM` must be an address on the Email Routing zone; `ALERT_TO` and `destination_address` are the verified destination.
3. Redeploy.

## Add a service

Add an entry to `services.json` and redeploy:

| field | meaning |
|---|---|
| `id` | stable key for the history; renaming starts it fresh |
| `name` | what the public page shows |
| `url` | health URL, fetched with redirects off |
| `json` | optional; the body must parse as JSON |
| `issuer` | optional; the JSON body must carry exactly this `issuer` |

Point `url` at a path that answers 200 uncached and reflects the service's real health, not only the proxy in front of it. `down_after`, `up_after`, `history_days`, `timeout_ms` and `title` sit at the top level of the file.

## Update

Pull, run any new files in `migrations/` with the `d1 migrations apply` command above, then deploy.
