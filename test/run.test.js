import { test, expect, beforeEach, afterEach, vi } from 'vitest';
import config from './services.json';
import { run, assertUnique } from '../src/check.js';
import { status, html } from '../src/page.js';
import { fresh } from './d1.js';

const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 8, 12, 0);
const SIGNIN = config.services.find((s) => s.id === 'sign-in');

const healthy = async (url) => {
  const s = config.services.find((x) => x.url === url);
  if (s.issuer) return new Response(JSON.stringify({ issuer: s.issuer }));
  return new Response(s.json ? '{}' : 'OK');
};
const signinDown = async (url) => (url === SIGNIN.url ? new Response('x', { status: 522 }) : healthy(url));

let mf;
let db;
let sent;
let env;

beforeEach(async () => {
  ({ mf, db } = await fresh());
  sent = [];
  env = { DB: db, ALERT_FROM: 'alerts@alerts.example', ALERT_TO: 'op@example', ALERT: { send: async (m) => { sent.push(m); } } };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await mf.dispose();
});

const rows = async (sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;

test('a round writes state and daily history for every service', async () => {
  await run(env, T0, healthy);
  await run(env, T0 + MIN, healthy);
  const state = await rows('SELECT service, down, checked FROM state ORDER BY service');
  expect(state.map((r) => r.service).sort()).toEqual(config.services.map((s) => s.id).sort());
  expect(state.every((r) => r.down === 0 && r.checked === T0 + MIN)).toBe(true);
  const daily = await rows('SELECT checks, down FROM daily WHERE service = ?1', 'sign-in');
  expect(daily).toEqual([{ checks: 2, down: 0 }]);
  expect(await rows('SELECT * FROM events')).toEqual([]);
  expect(sent).toEqual([]);
});

test('three failed rounds mail DOWN once; two passes mail UP once', async () => {
  for (let i = 0; i < 6; i++) await run(env, T0 + i * MIN, signinDown);
  expect(sent).toHaveLength(1);
  expect(sent[0].raw).toMatch(/Subject: DOWN: Sign-in\r\n/);
  expect(sent[0].raw).toMatch(/HTTP 522: the origin or its uplink is dark/);
  expect(sent[0].to).toBe('op@example');
  expect(sent[0].from).toBe('alerts@alerts.example');
  expect(await rows('SELECT down, since FROM state WHERE service = ?1', 'sign-in')).toEqual([{ down: 1, since: T0 + 2 * MIN }]);

  await run(env, T0 + 6 * MIN, healthy);
  expect(sent).toHaveLength(1);
  await run(env, T0 + 7 * MIN, healthy);
  await run(env, T0 + 8 * MIN, healthy);
  expect(sent).toHaveLength(2);
  expect(sent[1].raw).toMatch(/Subject: UP: Sign-in\r\n/);
  expect(sent[1].raw).toMatch(/Down since 2026-10-08T12:02/);

  expect(await rows('SELECT service, at, kind FROM events ORDER BY at')).toEqual([
    { service: 'sign-in', at: T0 + 2 * MIN, kind: 'down' },
    { service: 'sign-in', at: T0 + 7 * MIN, kind: 'up' },
  ]);
  expect(await rows('SELECT checks, down FROM daily WHERE service = ?1', 'sign-in')).toEqual([{ checks: 9, down: 5 }]);
});

test('an unbound ALERT logs and the state still moves', async () => {
  delete env.ALERT;
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  for (let i = 0; i < 3; i++) await run(env, T0 + i * MIN, signinDown);
  expect(log).toHaveBeenCalledTimes(1);
  expect(log.mock.calls[0][0]).toMatch(/ALERT not set, not mailed: DOWN: Sign-in: HTTP 522/);
  expect(await rows('SELECT down FROM state WHERE service = ?1', 'sign-in')).toEqual([{ down: 1 }]);
  expect(await rows('SELECT kind FROM events')).toEqual([{ kind: 'down' }]);
});

test('a failed send is logged with its reason, keeps the alert pending and does not undo the transition', async () => {
  env.ALERT.send = async () => { throw new Error('refused'); };
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  for (let i = 0; i < 3; i++) await run(env, T0 + i * MIN, signinDown);
  expect(err).toHaveBeenCalledTimes(1);
  expect(err.mock.calls[0].join(' ')).toMatch(/HTTP 522/);
  expect(await rows('SELECT down FROM state WHERE service = ?1', 'sign-in')).toEqual([{ down: 1 }]);
  expect(await rows('SELECT service, kind FROM pending')).toEqual([{ service: 'sign-in', kind: 'down' }]);
});

test('an unsent alert is retried on the next round and sent exactly once', async () => {
  let fail = true;
  env.ALERT.send = async (m) => {
    if (fail) throw new Error('refused');
    sent.push(m);
  };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (let i = 0; i < 3; i++) await run(env, T0 + i * MIN, signinDown);
  expect(sent).toEqual([]);
  fail = false;
  await run(env, T0 + 3 * MIN, signinDown);
  expect(sent).toHaveLength(1);
  expect(sent[0].raw).toMatch(/Subject: DOWN: Sign-in\r\n/);
  expect(sent[0].raw).toMatch(/detected 2026-10-08T12:02/);
  expect(sent[0].raw).toMatch(/HTTP 522/);
  expect(await rows('SELECT * FROM pending')).toEqual([]);
  for (let i = 4; i < 7; i++) await run(env, T0 + i * MIN, signinDown);
  expect(sent).toHaveLength(1);
});

test('a successful send leaves nothing pending and never repeats', async () => {
  for (let i = 0; i < 6; i++) await run(env, T0 + i * MIN, signinDown);
  expect(sent).toHaveLength(1);
  expect(await rows('SELECT * FROM pending')).toEqual([]);
});

test('a duplicate service id fails at load', () => {
  expect(() => assertUnique([{ id: 'a' }, { id: 'b' }, { id: 'a' }])).toThrow(/duplicate service id "a"/);
  expect(() => assertUnique(config.services)).not.toThrow();
});

test('history past 90 days is pruned, newer history kept', async () => {
  const old = T0 - 91 * DAY;
  const edge = T0 - 89 * DAY;
  await db.batch([
    db.prepare('INSERT INTO daily VALUES (?1, ?2, 10, 0)').bind('recipes', new Date(old).toISOString().slice(0, 10)),
    db.prepare('INSERT INTO daily VALUES (?1, ?2, 10, 0)').bind('recipes', new Date(edge).toISOString().slice(0, 10)),
    db.prepare("INSERT INTO events VALUES ('recipes', ?1, 'down')").bind(old),
    db.prepare("INSERT INTO events VALUES ('recipes', ?1, 'up')").bind(edge),
  ]);
  await run(env, T0, healthy);
  const days = (await rows('SELECT day FROM daily WHERE service = ?1 ORDER BY day', 'recipes')).map((r) => r.day);
  expect(days).toEqual([new Date(edge).toISOString().slice(0, 10), '2026-10-08']);
  expect(await rows('SELECT at FROM events')).toEqual([{ at: edge }]);
});

test('a page whose checks stopped says so instead of showing the last state', async () => {
  for (let i = 0; i < 3; i++) await run(env, T0 + i * MIN, signinDown);
  const live = await status(db, T0 + 3 * MIN);
  expect(live.services.find((s) => s.name === 'Sign-in').status).toBe('down');
  expect(html(live)).toMatch(/<h1>Sign-in is down<\/h1>/);
  const stale = await status(db, T0 + 8 * MIN);
  expect(stale.services.every((s) => s.status === 'unknown' && s.since === null)).toBe(true);
  expect(html(stale)).toMatch(/<h1>Checks are not running<\/h1>/);
});
