import type { StatusResponse } from './lib.ts';

const CACHE_SECONDS = 30;
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

export async function cached(request: Request, render: () => Promise<Response>): Promise<Response> {
  const url = new URL(request.url);
  url.search = '';
  const key = new Request(url);
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

export async function beat(
  request: Request,
  env: { TOWER: Pick<Tower, 'beat'>; BEAT_LIMIT: Pick<RateLimit, 'limit'> },
): Promise<Response> {
  const match = BEAT_PATH.exec(new URL(request.url).pathname);
  if (!match) return new Response(null, { status: 404 });
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (!(await env.BEAT_LIMIT.limit({ key: ip })).success) return new Response(null, { status: 429 });
  const token = /^Bearer (.+)$/.exec(request.headers.get('Authorization') ?? '')?.[1] ?? '';
  return env.TOWER.beat(match[1], token, match[2] === undefined);
}
