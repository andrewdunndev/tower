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

`test` is the project gate and runs `npm run check`. `reference-check` is the maintainer's own conformance job against their repository standards, `.deviations.yaml` records its waivers, and neither applies to contributions.
