import type { StatusResponse } from '../../prober/src/status.ts';

export type { StatusResponse };
export type CheckStatus = StatusResponse['checks'][number];
export interface Maintenance {
  title: string;
  checks: string[];
  starts: string;
  ends: string;
  bodyHtml: string | null;
}
export type Status = CheckStatus['status'] | 'maintenance';

export const statusLabel: Record<Status, string> = {
  up: 'Operational',
  degraded: 'Degraded',
  down: 'Down',
  maintenance: 'Maintenance',
  unknown: 'No data',
};

const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dateTimeFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
});

export const fmtDateTime = (iso: string) => `${dateTimeFmt.format(new Date(iso))} UTC`;

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

export function sparkSummary(c: CheckStatus): string {
  const vals = c.latency.filter((v): v is number => v !== null);
  if (!vals.length) return 'No latency data in the last 24 hours.';
  const missing = c.latency.length - vals.length;
  return (
    `Latency over the last 24 hours: median ${c.p50} ms, 95th percentile ${c.p95} ms, range ${Math.min(...vals)} to ${Math.max(...vals)} ms` +
    (missing ? `, ${missing * 5} minutes without data.` : '.')
  );
}
