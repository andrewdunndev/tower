import { test, expect } from 'vitest';
import config from './services.json';
import { probe, step } from '../src/check.js';

const SIGNIN = config.services.find((s) => s.id === 'sign-in');
const RECIPES = config.services.find((s) => s.id === 'recipes');
const MOVIES = config.services.find((s) => s.id === 'movies');

const reply = (status, body, headers = {}) => async () =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

test('the services file carries the thresholds and the issuer', () => {
  expect(config.down_after).toBe(3);
  expect(config.up_after).toBe(2);
  expect(config.history_days).toBe(90);
  expect(SIGNIN.issuer).toBe('https://login.example.com/');
  for (const s of config.services) expect(Object.keys(s).sort()).toEqual(expect.arrayContaining(['id', 'name', 'url']));
  expect(new Set(config.services.map((s) => s.id)).size).toBe(config.services.length);
});

test('probe passes a 200 with the right issuer, JSON or plain body', async () => {
  expect(await probe(SIGNIN, reply(200, { issuer: SIGNIN.issuer }))).toBeNull();
  expect(await probe(RECIPES, reply(200, { version: '1' }))).toBeNull();
  expect(await probe(MOVIES, reply(200, 'Healthy'))).toBeNull();
});

test('probe rejects a response served from cache', async () => {
  for (const s of ['HIT', 'STALE', 'UPDATING', 'hit', 'stale', 'updating']) {
    expect(await probe(SIGNIN, reply(200, { issuer: SIGNIN.issuer }, { 'cf-cache-status': s }))).toBe('served from cache');
    expect(await probe(MOVIES, reply(200, 'Healthy', { 'cf-cache-status': s }))).toBe('served from cache');
  }
  for (const s of ['DYNAMIC', 'MISS', 'EXPIRED', 'REVALIDATED', 'BYPASS']) {
    expect(await probe(SIGNIN, reply(200, { issuer: SIGNIN.issuer }, { 'cf-cache-status': s }))).toBeNull();
  }
});

test('probe checks the issuer exactly', async () => {
  expect(await probe(SIGNIN, reply(200, { issuer: 'https://login.example.com' }))).toBe('issuer "https://login.example.com", want "https://login.example.com/"');
  expect(await probe(SIGNIN, reply(200, { issuer: 'https://evil.example/' }))).toMatch(/^issuer /);
  expect(await probe(SIGNIN, reply(200, {}))).toBe('issuer undefined, want "https://login.example.com/"');
  expect(await probe(SIGNIN, reply(200, '<html>'))).toBe('body is not JSON');
  expect(await probe(RECIPES, reply(200, '<html>'))).toBe('body is not JSON');
});

test('probe names each other way to fail', async () => {
  expect(await probe(SIGNIN, reply(522, 'x'))).toBe('HTTP 522');
  expect(await probe(MOVIES, reply(503, 'Unhealthy'))).toBe('HTTP 503');
  expect(await probe(SIGNIN, reply(302, ''))).toBe('HTTP 302');
  expect(await probe(SIGNIN, async () => { throw new DOMException('t', 'TimeoutError'); })).toBe('timeout');
  expect(await probe(SIGNIN, async () => { throw new Error('boom'); })).toBe('fetch failed: boom');
});

test('probe never follows redirects and sets a timeout', async () => {
  let init;
  await probe(SIGNIN, async (_url, i) => { init = i; return new Response(JSON.stringify({ issuer: SIGNIN.issuer })); });
  expect(init.redirect).toBe('manual');
  expect(init.signal).toBeInstanceOf(AbortSignal);
});

const fresh = { down: false, fails: 0, passes: 0, since: 0 };

test('step goes DOWN on the third failure and UP on the second pass, once each', () => {
  let s = fresh;
  const seen = [];
  [false, false, false, false, false, true, false, true, true, true].forEach((ok, i) => {
    const r = step(s, ok, i);
    s = r.state;
    seen.push(r.transition);
  });
  expect(seen).toEqual([null, null, 'down', null, null, null, null, null, 'up', null]);
  expect(s.down).toBe(false);
  expect(s.since).toBe(8);
});

test('step: a pass between failures resets the count', () => {
  let s = fresh;
  for (const ok of [false, false, true, false, false]) s = step(s, ok, 1).state;
  expect(s).toMatchObject({ down: false, fails: 2 });
});

test('step: a failure while recovering resets the pass count', () => {
  let s = { down: true, fails: 0, passes: 0, since: 5 };
  for (const ok of [true, false, true]) s = step(s, ok, 9).state;
  expect(s).toEqual({ down: true, fails: 0, passes: 1, since: 5 });
});

test('a body that stalls past the timeout counts as a timeout', async () => {
  const stall = async (_url, init) => new Response(new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('{'));
      init.signal.addEventListener('abort', () => c.error(init.signal.reason));
    },
  }));
  expect(await probe(RECIPES, stall, 50)).toBe('timeout');
});

test('services.example.json is a valid config', async () => {
  const example = (await import('../services.example.json')).default;
  expect(Object.keys(example).sort()).toEqual(Object.keys(config).sort());
  for (const s of example.services) expect(Object.keys(s)).toEqual(expect.arrayContaining(['id', 'name', 'url']));
  expect(new Set(example.services.map((s) => s.id)).size).toBe(example.services.length);
});
