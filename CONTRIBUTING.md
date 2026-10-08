# Contributing

Issues and merge requests go to GitLab at https://gitlab.com/dunn.dev/tower. There is no DCO and no CLA.

## Tests

Node 22.15 or later. The suite runs against an `example.com` fixture in `test/services.json`, never your `services.json`: unit tests, then the bundled Worker under Miniflare, which asserts that no public response names a host, address, port or internal name.

```sh
npm ci
npm test
```

Keep instance details out of code, tests and docs; use `example.com`.
