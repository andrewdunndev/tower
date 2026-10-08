import config from '../services.json';

const DAY = 86_400_000;
const STALE = 5 * 60_000;
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

export async function status(db, now = Date.now(), services = config.services) {
  const days = Array.from({ length: config.history_days }, (_, i) => dayOf(now - (config.history_days - 1 - i) * DAY));
  const [state, daily, events] = await db.batch([
    db.prepare('SELECT service, down, since, checked FROM state'),
    db.prepare('SELECT service, day, checks, down FROM daily WHERE day >= ?1').bind(days[0]),
    db.prepare('SELECT service, at, kind FROM events WHERE at >= ?1 ORDER BY at DESC, rowid DESC LIMIT 100').bind(now - config.history_days * DAY),
  ]);
  const names = new Map(services.map((s) => [s.id, s.name]));
  const current = new Map(state.results.map((r) => [r.service, r]));
  const history = new Map();
  for (const r of daily.results) history.set(`${r.service} ${r.day}`, r);
  const checked = state.results.filter((r) => names.has(r.service)).map((r) => r.checked);
  return {
    updated: checked.length ? iso(Math.max(...checked)) : null,
    services: services.map((s) => {
      const cur = current.get(s.id);
      let checks = 0;
      let down = 0;
      const row = days.map((day) => {
        const d = history.get(`${s.id} ${day}`);
        if (!d) return { day, uptime: null };
        checks += d.checks;
        down += d.down;
        return { day, uptime: 1 - d.down / d.checks };
      });
      return {
        name: s.name,
        status: !cur || now - cur.checked > STALE ? 'unknown' : cur.down ? 'down' : 'up',
        since: cur && now - cur.checked <= STALE ? iso(cur.since) : null,
        uptime: checks ? 1 - down / checks : null,
        days: row,
      };
    }),
    events: events.results
      .filter((e) => names.has(e.service))
      .slice(0, 20)
      .map((e) => ({ name: names.get(e.service), kind: e.kind, at: iso(e.at) })),
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const when = (s) => `${s.slice(0, 10)} ${s.slice(11, 16)} UTC`;
const pct = (u) => `${(Math.floor(u * 10000) / 100).toFixed(2)}%`;
const shade = (u) => (u === null ? 'none' : u === 1 ? 'up' : u >= 0.95 ? 'partial' : 'down');
const LABEL = { up: 'Up', down: 'Down', unknown: 'Not checked' };

function service(s) {
  const bars = s.days
    .map((d) => `<i class="${shade(d.uptime)}" title="${d.day}: ${d.uptime === null ? 'no data' : pct(d.uptime)}"></i>`)
    .join('');
  return `<li>
<div class="row"><h2>${esc(s.name)}</h2><span class="pill ${s.status}">${LABEL[s.status]}</span></div>
<p class="meta">${s.since ? `${s.status === 'down' ? 'Down' : 'Up'} since ${when(s.since)}` : ''}${s.uptime === null ? '' : ` &middot; ${pct(s.uptime)} over ${config.history_days} days`}</p>
<div class="bars" aria-hidden="true">${bars}</div>
</li>`;
}

export function html(data) {
  const down = data.services.filter((s) => s.status === 'down');
  const unchecked = data.services.some((s) => s.status === 'unknown');
  const headline = down.length === 1 ? `${down[0].name} is down`
    : down.length ? `${down.length} services are down`
    : unchecked ? 'Checks are not running'
    : 'Everything is working';
  const events = data.events.length
    ? `<ul class="events">${data.events.map((e) => `<li><time datetime="${e.at}">${when(e.at)}</time> ${esc(e.name)} ${e.kind === 'down' ? 'went down' : 'came back'}</li>`).join('')}</ul>`
    : '<p class="meta">Nothing has gone down recently.</p>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>${esc(config.title ?? 'Status')}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root{--bg:#f7f6f3;--fg:#1d1c1a;--muted:#6b6862;--card:#fff;--line:#e4e1da;--up:#2f8f5b;--partial:#d39a1c;--down:#c8402f;--none:#d9d6cf}
@media (prefers-color-scheme:dark){:root{--bg:#151513;--fg:#ecebe7;--muted:#a19d95;--card:#1f1e1c;--line:#2f2e2b;--up:#3fae70;--partial:#e0ab35;--down:#e2614f;--none:#3a3935}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:44rem;margin:0 auto;padding:2rem 1rem 3rem}
h1{font-size:1.6rem;margin:0 0 .25rem}
h2{font-size:1.05rem;margin:0}
.meta{color:var(--muted);font-size:.875rem;margin:.25rem 0 0}
ul{list-style:none;margin:0;padding:0}
.services>li{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:1rem;margin-top:1rem}
.row{display:flex;justify-content:space-between;align-items:center;gap:1rem}
.pill{font-size:.8rem;font-weight:600;padding:.15rem .6rem;border-radius:999px;color:#fff;background:var(--none)}
.pill.up{background:var(--up)}.pill.down{background:var(--down)}.pill.unknown{color:var(--fg)}
.bars{display:flex;gap:1px;height:1.75rem;margin-top:.75rem}
.bars i{flex:1;border-radius:2px;background:var(--none)}
.bars .up{background:var(--up)}.bars .partial{background:var(--partial)}.bars .down{background:var(--down)}
h3{font-size:1rem;margin:2rem 0 .5rem}
.events li{padding:.35rem 0;border-top:1px solid var(--line)}
.events time{color:var(--muted);font-size:.875rem;margin-right:.5rem}
</style>
</head>
<body>
<main>
<h1>${esc(headline)}</h1>
<p class="meta">${data.updated ? `Checked every minute. Last check ${when(data.updated)}.` : 'Waiting for the first check.'}</p>
<ul class="services">
${data.services.map(service).join('\n')}
</ul>
<h3>Recent changes</h3>
${events}
</main>
</body>
</html>
`;
}

const BASE = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'public, max-age=30' };
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const text = (status, body, extra = {}) =>
  new Response(body, { status, headers: { ...BASE, 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8', ...extra } });

export async function respond(request, env, now = Date.now()) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return text(405, 'Method not allowed\n', { allow: 'GET, HEAD' });
  const { pathname } = new URL(request.url);
  if (pathname !== '/' && pathname !== '/api/status') return text(404, 'Not found\n');
  let data;
  try {
    data = await status(env.DB, now);
  } catch (e) {
    console.error('tower: status read failed:', e?.message ?? e);
    return text(503, 'Status unavailable\n');
  }
  if (pathname === '/api/status') {
    return new Response(`${JSON.stringify(data)}\n`, { headers: { ...BASE, 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
  }
  return new Response(html(data), { headers: { ...BASE, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP } });
}
