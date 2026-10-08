# Changelog

## Unreleased

First public version. tower is a status page that runs as a Cloudflare Worker.

- Cron checks every service from outside each minute, with `down_after` and `up_after` thresholds, and keeps `history_days` of daily uptime in D1.
- Server-rendered page and `/api/status` carry display names, status and uptime only.
- One alert mail per change through the `send_email` binding. An alert whose send fails stays in the `pending` table (migration `0002_pending.sql`) and is retried on the next run.
- Duplicate service ids in `services.json` fail at load.
