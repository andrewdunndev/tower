![hero](hero.svg)

# tower

[![pipeline](https://gitlab.com/dunn.dev/tower/badges/main/pipeline.svg)](https://gitlab.com/dunn.dev/tower/-/pipelines)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![built with GitLab](https://img.shields.io/badge/built_with-GitLab-FC6D26?logo=gitlab)](https://gitlab.com/dunn.dev)

tower is a status page that runs as a Cloudflare Worker. A cron checks each service from outside every minute, keeps `history_days` of history (90 by default) in D1, mails you once on every change and serves a server-rendered page and `/api/status`. It needs no server, only a Cloudflare account.

Shared as-is: no roadmap, no support promise. Report security problems as [SECURITY.md](SECURITY.md) describes.

## Security model

The checker sees your health URLs; visitors must not.

- The page and `/api/status` carry service display names, status, uptime and the time of each change. They never carry a URL, hostname, address, port or failure reason.
- Failure reasons (`HTTP 522`, `timeout`, a wrong issuer) go only to the alert mail and the Worker log, and an alert whose send fails is retried on the next run.
- Alert mail is sent only to the verified destination of the `send_email` binding. Without the binding, changes are logged as not mailed.
- `services.json` is gitignored. Keep health URLs you would not publish out of any repository you push, including your `wrangler.toml` edits.
- A service with no check in five minutes shows as not checked, so a stopped cron cannot leave a stale green page.

## Services

`services.json` holds the thresholds and every service: `id`, display `name`, `url`, and an optional `issuer` or `json`. Start from [`services.example.json`](services.example.json).

A check passes on a 200 that Cloudflare did not serve from cache (`cf-cache-status` HIT, STALE or UPDATING fails). With `json` the body must parse; with `issuer` it must carry exactly that issuer. A service goes down after `down_after` failed checks in a row and comes back after `up_after` passes. `id` keys the history, so renaming one starts its history fresh.

## Setup

[docs/setup.md](docs/setup.md) covers Cloudflare prerequisites, deploy, alerts and adding a service. `npm test` runs the suite.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The GitHub copy is a mirror.
