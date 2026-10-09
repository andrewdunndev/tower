export type Status = 'up' | 'degraded' | 'down' | 'maintenance' | 'unknown';
export type CheckType = 'http' | 'tcp' | 'dns' | 'tls' | 'heartbeat';

export interface CheckStatus {
  name: string;
  type: CheckType;
  status: Status;
  since: string;
  uptime90: number | null;
  p50: number | null;
  p95: number | null;
  days: (number | null)[];
  latency: (number | null)[];
}

export interface Incident {
  kind: 'auto' | 'note';
  title: string;
  checks: string[];
  severity: 'down' | 'degraded' | 'info';
  started: string;
  resolved: string | null;
  bodyHtml: string | null;
}

export interface Maintenance {
  title: string;
  checks: string[];
  starts: string;
  ends: string;
  bodyHtml: string | null;
}

export interface StatusResponse {
  generatedAt: string;
  checks: CheckStatus[];
  incidents: Incident[];
  maintenance: Maintenance[];
}

export const NOW = Date.parse('2026-10-08T14:30:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Spec {
  name: string;
  type: CheckType;
  status: Status;
  since: number;
  base: number;
  jitter: number;
  seed: number;
  dips: Record<number, number>;
  noData?: number[];
  latencyGap?: [number, number];
  spike?: [number, number];
}

function build(s: Spec): CheckStatus {
  const r = rng(s.seed);
  const days = Array.from({ length: 90 }, (_, i) => {
    if (s.noData?.includes(i)) return null;
    if (i in s.dips) return s.dips[i];
    return r() < 0.06 ? 0.995 + r() * 0.004 : 1;
  });
  const latency = Array.from({ length: 288 }, (_, i) => {
    if (s.latencyGap && i >= s.latencyGap[0] && i < s.latencyGap[1]) return null;
    let v = s.base + (r() - 0.5) * s.jitter + Math.sin(i / 46) * s.jitter * 0.25;
    if (s.spike && i >= s.spike[0] && i < s.spike[1]) v *= 3.2;
    return Math.round(Math.max(1, v));
  });
  const known = days.filter((d): d is number => d !== null);
  const uptime90 = known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
  const sorted = latency.filter((v): v is number => v !== null).sort((a, b) => a - b);
  const q = (p: number) => (sorted.length ? sorted[Math.floor(p * (sorted.length - 1))] : null);
  return {
    name: s.name,
    type: s.type,
    status: s.status,
    since: iso(-s.since),
    uptime90,
    p50: s.status === 'unknown' ? null : q(0.5),
    p95: s.status === 'unknown' ? null : q(0.95),
    days,
    latency,
  };
}

export const fixture: StatusResponse = {
  generatedAt: iso(0),
  checks: [
    build({ name: 'Website', type: 'http', status: 'up', since: 41 * DAY, base: 84, jitter: 30, seed: 11, dips: { 62: 0.9931 } }),
    build({ name: 'API', type: 'http', status: 'degraded', since: 47 * MIN, base: 142, jitter: 50, seed: 22, dips: { 89: 0.9812, 33: 0.9958 }, spike: [262, 288] }),
    build({ name: 'Authentication', type: 'http', status: 'up', since: 12 * DAY, base: 118, jitter: 40, seed: 33, dips: { 78: 0.9604, 79: 0.9917 } }),
    build({ name: 'Mail delivery', type: 'tcp', status: 'down', since: 19 * MIN, base: 36, jitter: 14, seed: 44, dips: { 89: 0.9667, 51: 0.9986 }, latencyGap: [269, 288] }),
    build({ name: 'DNS resolution', type: 'dns', status: 'up', since: 88 * DAY, base: 12, jitter: 6, seed: 55, dips: {} }),
    build({ name: 'TLS certificate', type: 'tls', status: 'up', since: 63 * DAY, base: 58, jitter: 18, seed: 66, dips: {} }),
    build({ name: 'Nightly backup', type: 'heartbeat', status: 'maintenance', since: 25 * MIN, base: 0, jitter: 0, seed: 77, dips: { 5: 0.9167 }, latencyGap: [276, 288] }),
    build({
      name: 'Media storage',
      type: 'http',
      status: 'unknown',
      since: 2 * HOUR,
      base: 210,
      jitter: 70,
      seed: 88,
      dips: {},
      noData: [
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49,
        50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63,
      ],
      latencyGap: [240, 288],
    }),
  ],
  incidents: [
    { kind: 'auto', title: 'Mail delivery is not responding', checks: ['Mail delivery'], severity: 'down', started: iso(-19 * MIN), resolved: null, bodyHtml: null },
    {
      kind: 'note',
      title: 'Elevated API latency',
      checks: ['API'],
      severity: 'degraded',
      started: iso(-47 * MIN),
      resolved: null,
      bodyHtml:
        '<p>Responses are slower than usual. We are looking at a <strong>database connection pool</strong> that stopped recycling.</p><p>Reads still succeed; writes may take several seconds.</p>',
    },
    {
      kind: 'auto',
      title: 'Authentication check failed',
      checks: ['Authentication'],
      severity: 'down',
      started: iso(-11 * DAY - 3 * HOUR),
      resolved: iso(-11 * DAY - 2 * HOUR - 18 * MIN),
      bodyHtml: null,
    },
    {
      kind: 'note',
      title: 'Sign-in outage after key rotation',
      checks: ['Authentication'],
      severity: 'down',
      started: iso(-11 * DAY - 3 * HOUR),
      resolved: iso(-11 * DAY - 2 * HOUR - 18 * MIN),
      bodyHtml:
        '<p>A signing key rotated before every service had the new public key.</p><ul><li>Sign-in failed for 42 minutes.</li><li>Existing sessions were unaffected.</li></ul><p>Rotation now waits for acknowledgement from each consumer.</p>',
    },
    { kind: 'auto', title: 'Website returned errors', checks: ['Website'], severity: 'degraded', started: iso(-28 * DAY - 5 * HOUR), resolved: iso(-28 * DAY - 4 * HOUR - 40 * MIN), bodyHtml: null },
  ],
  maintenance: [
    {
      title: 'Database version upgrade',
      checks: ['API', 'Authentication'],
      starts: iso(2 * DAY + 3 * HOUR),
      ends: iso(2 * DAY + 4 * HOUR),
      bodyHtml: '<p>Writes pause for about ten minutes while the primary restarts.</p>',
    },
    { title: 'Mail relay migration', checks: ['Mail delivery'], starts: iso(9 * DAY), ends: iso(9 * DAY + 2 * HOUR), bodyHtml: null },
  ],
};
