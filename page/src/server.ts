import type { StatusResponse } from './lib.ts';

const CACHE_SECONDS = 30;
const CACHED_ROUTES = ['/', '/api/status'];
const BEAT_PATH = /^\/beat\/([^/]+)(\/fail)?$/;

type Tower = {
  status(): Promise<StatusResponse>;
  beat(id: string, token: string, ok: boolean): Promise<Response>;
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

export function refuse(request: Request): Response | null {
  const { pathname } = new URL(request.url);
  const allowed = pathname.startsWith('/beat/') ? ['POST'] : ['GET', 'HEAD'];
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
  const token = /^Bearer (.+)$/.exec(request.headers.get('Authorization') ?? '')?.[1] ?? '';
  return env.TOWER.beat(match[1], token, match[2] === undefined);
}
