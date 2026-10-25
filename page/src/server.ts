import { type Latch, selfAlert } from '../../prober/src/latch.ts';
import { sendMail } from '../../prober/src/mail.ts';
import type { StatusResponse } from './lib.ts';

const CACHE_SECONDS = 30;
const CACHED_ROUTES = ['/', '/api/status'];
const MAX_BODY = 64 * 1024;
const BEAT_PATH = /^\/beat\/([^/]+)(\/fail)?$/;

type Tower = {
  status(): Promise<StatusResponse>;
  health(): Promise<'ok' | 'stale' | 'dead'>;
  beat(id: string, token: string, ok: boolean): Promise<Response>;
  watch(now: number): Promise<void>;
  incident(token: string, body: string): Promise<Response>;
  kept(token: string): Promise<Response>;
};

export async function load(tower: Pick<Tower, 'status'>): Promise<StatusResponse | null> {
  try {
    return await tower.status();
  } catch (e) {
    console.error('tower-page: status unavailable:', e);
    return null;
  }
}

export async function statusResponse(tower: Pick<Tower, 'status'>): Promise<Response> {
  const data = await load(tower);
  return data ? Response.json(data) : Response.json({ error: 'status unavailable' }, { status: 503 });
}

export async function healthResponse(tower: Pick<Tower, 'health'>): Promise<Response> {
  let state: string;
  try {
    state = await tower.health();
  } catch (e) {
    console.error('tower-page: health unavailable:', e);
    state = 'unavailable';
  }
  return new Response(state, {
    status: state === 'ok' ? 200 : 503,
    headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
  });
}

export function refuse(request: Request): Response | null {
  const { pathname } = new URL(request.url);
  const allowed =
    pathname === '/relay/kept' ? ['GET'] : pathname.startsWith('/beat/') || pathname.startsWith('/relay/') ? ['POST'] : ['GET', 'HEAD'];
  if (allowed.includes(request.method)) return null;
  return new Response(null, { status: 405, headers: { Allow: allowed.join(', ') } });
}

// One fixed key per route: neither the request path nor its method can mint another cache entry.
export function cacheKey(routePattern: string, origin: string): Request | null {
  return CACHED_ROUTES.includes(routePattern) ? new Request(new URL(routePattern, origin)) : null;
}

export async function cached(key: Request, render: () => Promise<Response>): Promise<Response> {
  const cache = await caches.open('tower');
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await render();
  if (res.status !== 200) return res;
  const fresh = new Response(res.body, res);
  fresh.headers.set('Cache-Control', `public, max-age=${CACHE_SECONDS}`);
  await cache.put(key, fresh.clone());
  return fresh;
}

export async function beat(request: Request, env: { TOWER: Pick<Tower, 'beat'> }): Promise<Response> {
  const match = BEAT_PATH.exec(new URL(request.url).pathname);
  if (!match) return new Response(null, { status: 404 });
  return env.TOWER.beat(match[1], bearer(request), match[2] === undefined);
}

const bearer = (request: Request) => /^Bearer (.+)$/.exec(request.headers.get('Authorization') ?? '')?.[1] ?? '';

async function readCapped(request: Request): Promise<string | null> {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && Number(declared) > MAX_BODY) return null;
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export async function kept(request: Request, env: { TOWER: Pick<Tower, 'kept'> }): Promise<Response> {
  try {
    return await env.TOWER.kept(bearer(request));
  } catch (e) {
    console.error('tower-page: relay unavailable:', e);
    return new Response(null, { status: 503 });
  }
}

export async function relay(request: Request, env: { TOWER: Pick<Tower, 'incident'> }): Promise<Response> {
  if (new URL(request.url).pathname !== '/relay/incident') return new Response(null, { status: 404 });
  const type = (request.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return new Response(null, { status: 415 });
  const body = await readCapped(request);
  if (body === null) return new Response(null, { status: 413 });
  try {
    return await env.TOWER.incident(bearer(request), body);
  } catch (e) {
    console.error('tower-page: relay unavailable:', e);
    return new Response(null, { status: 503 });
  }
}

export async function watch(
  env: { TOWER: Pick<Tower, 'watch'>; EMAIL: Pick<SendEmail, 'send'> },
  alert: { from: string; to: string },
  t: number,
  latch: Latch,
): Promise<void> {
  try {
    await env.TOWER.watch(t);
    await latch.release('prober', t);
  } catch (e) {
    console.error('tower-page: prober did not answer:', e);
    await selfAlert(
      latch,
      'prober',
      t,
      async () =>
        (await sendMail(
          env.EMAIL,
          alert,
          'SELF-CHECK FAILING: probing stalled',
          `The prober did not answer, ${new Date(t).toISOString()}. This repeats every 3 hours until it answers.\n`,
        )) === 'sent',
    );
  }
}
