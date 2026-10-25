# Contributing

Issues and merge requests go to GitLab at https://gitlab.com/dunn.dev/tower. There is no DCO and no CLA.

Use the Node version in `mise.toml`, then:

```sh
npm ci
npm run check
```

`check` stages `test/fixture/`, lints, typechecks and runs the tests: unit tests for the schema, the prober and the page, and a test that no public response names a host, address, port or failure reason. Dependency versions are exact pins.

Keep instance details out of code, tests and docs; use `example.com`.

## CI

These jobs gate a merge request:

- `test` runs `npm run check`.
- `lab` runs `bash scripts/lab.sh`: the Workers under `wrangler dev` with a local D1, through a slow check and a cron gap.
- `page-visual` runs `node tools/stage.ts test/fixture`, `npm run build -w page`, then `npx playwright test -c test/visual`, which needs Chromium (`npx playwright install chromium`). It runs only when the page, its fixture, staging or CI changes.
- `worker-dry-run` runs `npm run deploy -- example --dry-run`.
- `osv-verdict` records OSV advisories new in the change and `automerge-gate` fails on them; `secret-verdict` fails on a committed secret, `pin-audit` on an image pin Renovate cannot track.

`reference-check` is the maintainer's own conformance job against their repository standards, `.deviations.yaml` records its waivers, and neither applies to contributions.
