import config from '../services.json';
import { notify } from './mail.js';

export function assertUnique(services) {
  const seen = new Set();
  for (const { id } of services) {
    if (seen.has(id)) throw new Error(`services.json: duplicate service id "${id}"`);
    seen.add(id);
  }
}

assertUnique(config.services);

const FROM_CACHE = new Set(['HIT', 'STALE', 'UPDATING']);
const DAY = 86_400_000;

export async function probe(service, doFetch, timeout = config.timeout_ms) {
  let res;
  try {
    res = await doFetch(service.url, { redirect: 'manual', signal: AbortSignal.timeout(timeout), headers: { 'user-agent': 'tower' } });
  } catch (e) {
    return e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : `fetch failed: ${e.message}`;
  }
  const discard = async (reason) => {
    await res.body?.cancel();
    return reason;
  };
  if (res.status !== 200) return discard(`HTTP ${res.status}`);
  if (FROM_CACHE.has((res.headers.get('cf-cache-status') ?? '').toUpperCase())) return discard('served from cache');
  if (!service.json && service.issuer === undefined) return discard(null);
  let body;
  try {
    body = await res.json();
  } catch (e) {
    return e.name === 'TimeoutError' ? 'timeout' : 'body is not JSON';
  }
  if (service.issuer !== undefined && body?.issuer !== service.issuer) {
    return `issuer ${JSON.stringify(body?.issuer)}, want ${JSON.stringify(service.issuer)}`;
  }
  return null;
}

export function step(s, ok, now, t = config) {
  if (ok) {
    if (!s.down) return { state: { ...s, fails: 0, passes: 0 }, transition: null };
    const passes = s.passes + 1;
    if (passes < t.up_after) return { state: { ...s, passes }, transition: null };
    return { state: { down: false, fails: 0, passes: 0, since: now }, transition: 'up' };
  }
  if (s.down) return { state: { ...s, passes: 0 }, transition: null };
  const fails = s.fails + 1;
  if (fails < t.down_after) return { state: { ...s, fails }, transition: null };
  return { state: { down: true, fails: 0, passes: 0, since: now }, transition: 'down' };
}

export async function run(env, now = Date.now(), doFetch = fetch, services = config.services) {
  const reasons = await Promise.all(services.map((s) => probe(s, doFetch)));
  const { results } = await env.DB.prepare('SELECT service, down, fails, passes, since FROM state').all();
  const prior = new Map(results.map((r) => [r.service, { down: r.down === 1, fails: r.fails, passes: r.passes, since: r.since }]));
  const day = new Date(now).toISOString().slice(0, 10);
  const stmts = [];
  services.forEach((service, i) => {
    const before = prior.get(service.id) ?? { down: false, fails: 0, passes: 0, since: now };
    const { state, transition } = step(before, reasons[i] === null, now);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO state (service, down, fails, passes, since, checked) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (service) DO UPDATE SET down = ?2, fails = ?3, passes = ?4, since = ?5, checked = ?6`,
      ).bind(service.id, state.down ? 1 : 0, state.fails, state.passes, state.since, now),
      env.DB.prepare(
        `INSERT INTO daily (service, day, checks, down) VALUES (?1, ?2, 1, ?3)
         ON CONFLICT (service, day) DO UPDATE SET checks = checks + 1, down = down + ?3`,
      ).bind(service.id, day, state.down ? 1 : 0),
    );
    if (transition) {
      stmts.push(env.DB.prepare('INSERT INTO events (service, at, kind) VALUES (?1, ?2, ?3)').bind(service.id, now, transition));
      stmts.push(
        env.DB.prepare('INSERT INTO pending (service, at, kind, since, reason) VALUES (?1, ?2, ?3, ?4, ?5)')
          .bind(service.id, now, transition, before.since, reasons[i]),
      );
    }
  });
  const cutoff = now - config.history_days * DAY;
  stmts.push(
    env.DB.prepare('DELETE FROM daily WHERE day < ?1').bind(new Date(cutoff).toISOString().slice(0, 10)),
    env.DB.prepare('DELETE FROM events WHERE at < ?1').bind(cutoff),
  );
  await env.DB.batch(stmts);
  await flush(env, services);
}

async function flush(env, services) {
  const { results } = await env.DB.prepare('SELECT service, at, kind, since, reason FROM pending ORDER BY at, service').all();
  for (const p of results) {
    const service = services.find((s) => s.id === p.service);
    const sent = service ? await notify(env, p.kind, service, p.reason, { since: p.since }, p.at) : true;
    if (sent) await env.DB.prepare('DELETE FROM pending WHERE service = ?1 AND at = ?2').bind(p.service, p.at).run();
  }
}
