![hero](hero.svg)

# dunn.dev/tower

[![pipeline](https://gitlab.com/dunn.dev/tower/badges/main/pipeline.svg)](https://gitlab.com/dunn.dev/tower/-/pipelines)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![built with GitLab](https://img.shields.io/badge/built_with-GitLab-FC6D26?logo=gitlab)](https://gitlab.com/dunn.dev)

tower is a status page that runs on Cloudflare Workers. A prober Worker checks each service from outside on a cron, keeps the history in D1 and mails one alert per change. A page Worker renders the status page and `/api/status` through Workers RPC. It needs no server, only a Cloudflare account.

A relay turns an incident.io-format webhook, such as HyperDX's, into one mail per transition.

Shared as-is: no roadmap, no support promise. Design after [herdr.dev](https://herdr.dev).

## Cloudflare, product by job

| Product | Job |
|---|---|
| Cron Triggers | run due checks each minute, each on its own `every` |
| D1 | check history, state, alert outbox and heartbeats |
| Workers RPC | the page reads status from the prober; no shared storage |
| Sockets | tcp checks |
| 1.1.1.1 DoH | dns checks |
| Certificate packs API | tls checks |
| Email | alert mail through the `send_email` binding |
| Static assets | the page's CSS and favicon |

## Security model

- The page and `/api/status` carry check names, status, uptime and times. They never carry a URL, hostname, address, port or failure reason.
- The page holds no secrets and no storage. The prober is the only owner of D1.
- Failure reasons go only to the alert mail and the Worker log.
- Heartbeat tokens are stored as sha256 hashes; the plaintext never enters your config.
- A check that has not run recently reads as unknown, so a stopped cron cannot leave a stale green page.

Report vulnerabilities as [SECURITY.md](SECURITY.md) describes.

## Instance

An instance is a directory holding `tower.json`, optional `notes/*.md` for maintenance windows and incident write-ups, and optional `theme.css` and `favicon.svg`. [`example/`](example) is a complete one; each field's validation message states its rule. Keep your instance outside this repository. [docs/setup.md](docs/setup.md) covers deploying and running it.

## Limits

- A tcp check against a Cloudflare-proxied address, or one Cloudflare blocks, reads as down with its reason.
- A tcp check is up when the connection opens and down on a connect error or at the timeout. It sends no data, so a service that accepts and then fails reads as up.
- A tls check covers the edge certificates Cloudflare serves. An origin certificate failure shows as http 526.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). A GitHub mirror follows each release.
