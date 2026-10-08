import { test, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import config from './services.json';
import { migrate } from './d1.js';

const root = new URL('..', import.meta.url).pathname;
const SIGNIN = config.services.find((s) => s.id === 'sign-in');
const RECIPES = config.services.find((s) => s.id === 'recipes');

const internal = [
  ...new Set(config.services.flatMap((s) => {
    const u = new URL(s.url);
    return [u.hostname, u.hostname.split('.')[0], u.pathname];
  })),
  'originhost', 'proxy', 'backend', 'appserver', 'mediaserver', 'issuer',
];

function leaks(body) {
  const found = [];
  for (const m of body.matchAll(/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.example\.com/gi)) {
    if (!['status.example.com', 'tower.example.com'].includes(m[0].toLowerCase())) found.push(m[0]);
  }
  for (const m of body.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b|\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}:[0-9a-f]{1,4}\b/gi)) found.push(m[0]);
  for (const m of body.matchAll(/(?:localhost|\]|[a-z0-9-]+\.[a-z]{2,}|\d+\.\d+\.\d+\.\d+):\d{1,5}\b/gi)) found.push(m[0]);
  for (const word of internal) {
    const re = new RegExp(`(?<![a-z0-9])${word.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?![a-z0-9])`, 'i');
    if (re.test(body)) found.push(word);
  }
  return found;
}

let out;
let work;
let mf;
let failing = true;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'tower-src-'));
  for (const f of ['src', 'public', 'migrations', 'wrangler.toml']) cpSync(join(root, f), join(work, f), { recursive: true });
  cpSync(join(root, 'test/services.json'), join(work, 'services.json'));
  out = mkdtempSync(join(tmpdir(), 'tower-bundle-'));
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_ACCOUNT_ID;
  execFileSync(join(root, 'node_modules/.bin/wrangler'), ['deploy', '--dry-run', '--outdir', out], { cwd: work, env, stdio: 'pipe' });
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: readFileSync(join(out, 'index.js'), 'utf8'),
    compatibilityDate: '2026-09-01',
    d1Databases: ['DB'],
    bindings: { ALERT_FROM: 'alerts@alerts.example.com', ALERT_TO: 'op@example.com' },
    outboundService: async (req) => {
      if (req.url === SIGNIN.url) return failing ? new Response('origin unreachable at 10.0.0.5:8443', { status: 522 }) : new Response(JSON.stringify({ issuer: SIGNIN.issuer }));
      if (req.url === RECIPES.url) return new Response('{}', { headers: { 'cf-cache-status': 'HIT' } });
      return new Response('{}');
    },
  }));
  await migrate(await mf.getD1Database('DB'));
});

afterAll(async () => {
  await mf?.dispose();
  if (out) rmSync(out, { recursive: true, force: true });
  if (work) rmSync(work, { recursive: true, force: true });
});

const tick = async () => (await mf.getWorker()).scheduled({ cron: '* * * * *' });

test('the bundled worker runs its cron and serves the page', async () => {
  for (let i = 0; i < 3; i++) await tick();
  const page = await mf.dispatchFetch('https://status.example.com/');
  expect(page.status).toBe(200);
  expect(page.headers.get('content-type')).toMatch(/^text\/html/);
  const body = await page.text();
  for (const s of config.services) expect(body).toContain(s.name.replace('&', '&#38;'));
  expect(body).toMatch(/2 services are down/);
  expect(body).toMatch(/Sign-in went down/);
});

test('no public response names a host, an address, a port or an internal name', async () => {
  failing = false;
  for (let i = 0; i < 2; i++) await tick();
  const bodies = [];
  for (const [path, method] of [['/', 'GET'], ['/api/status', 'GET'], ['/nope', 'GET'], ['/', 'POST'], ['/api/status?x=1', 'GET']]) {
    for (const host of ['status.example.com', 'tower.example.com']) {
      const res = await mf.dispatchFetch(`https://${host}${path}`, { method });
      bodies.push([`${method} ${host}${path}`, `${[...res.headers].map((h) => h.join(': ')).join('\n')}\n\n${await res.text()}`]);
    }
  }
  const json = JSON.parse(bodies.find(([k]) => k === 'GET status.example.com/api/status')[1].split('\n\n').slice(1).join('\n\n'));
  expect(json.services.map((s) => s.name)).toEqual(config.services.map((s) => s.name));
  expect(json.events.map((e) => [e.name, e.kind])).toEqual([['Sign-in', 'up'], ['Recipes', 'down'], ['Sign-in', 'down']]);
  for (const s of json.services) expect(Object.keys(s).sort()).toEqual(['days', 'name', 'since', 'status', 'uptime']);
  for (const [where, text] of bodies) expect(leaks(text), where).toEqual([]);
});

test('the leak check itself catches each class', () => {
  expect(leaks('see pantry.example.com')).toContain('pantry.example.com');
  expect(leaks('at 10.0.0.5')).toContain('10.0.0.5');
  expect(leaks('host.example:8443')).toContain('host.example:8443');
  expect(leaks('runs on originhost')).toContain('originhost');
  expect(leaks('GET /api/app/about')).toContain('/api/app/about');
  expect(leaks('status.example.com at 2026-10-08 14:03 UTC')).toEqual([]);
});
