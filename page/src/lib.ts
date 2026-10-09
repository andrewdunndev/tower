import type { CheckStatus, Status } from './fixtures';

export const statusLabel: Record<Status, string> = {
  up: 'Operational',
  degraded: 'Degraded',
  down: 'Down',
  maintenance: 'Maintenance',
  unknown: 'No data',
};

const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dateTimeFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
});

export const fmtDate = (iso: string) => dateFmt.format(new Date(iso));
export const fmtDateTime = (iso: string) => `${dateTimeFmt.format(new Date(iso))} UTC`;

export function fmtDuration(fromIso: string, toIso: string): string {
  const mins = Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60_000);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `${h} h ${mins % 60} min`;
  return `${Math.floor(h / 24)} d`;
}

export function fmtPct(f: number | null): string {
  if (f === null) return 'n/a';
  const p = f * 100;
  return `${p >= 99.995 ? '100' : p.toFixed(2)}%`;
}

export function dayLabel(generatedAt: string, index: number): string {
  const d = new Date(Date.parse(generatedAt) - (89 - index) * 86_400_000);
  return dateFmt.format(d);
}

export function dayLevel(f: number | null): 'none' | 'ok' | 'minor' | 'major' {
  if (f === null) return 'none';
  if (f >= 0.999) return 'ok';
  if (f >= 0.99) return 'minor';
  return 'major';
}

export interface Spark {
  paths: string[];
  min: number;
  max: number;
  summary: string;
}

export function spark(c: CheckStatus, w = 160, h = 36): Spark {
  const vals = c.latency.filter((v): v is number => v !== null);
  if (!vals.length) return { paths: [], min: 0, max: 0, summary: 'No latency data in the last 24 hours.' };
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = Math.max(1, max - min);
  const pad = 2;
  const x = (i: number) => (i / (c.latency.length - 1)) * w;
  const y = (v: number) => pad + (1 - (v - min) / span) * (h - pad * 2);
  const paths: string[] = [];
  let cur: string[] = [];
  c.latency.forEach((v, i) => {
    if (v === null) {
      if (cur.length) paths.push(cur.join(' '));
      cur = [];
    } else {
      cur.push(`${cur.length ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`);
    }
  });
  if (cur.length) paths.push(cur.join(' '));
  const missing = c.latency.length - vals.length;
  const summary = `Latency over the last 24 hours: median ${c.p50} ms, 95th percentile ${c.p95} ms, range ${min} to ${max} ms` + (missing ? `, ${missing * 5} minutes without data.` : '.');
  return { paths, min, max, summary };
}
