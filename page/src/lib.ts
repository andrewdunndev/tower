import type { StatusResponse } from '../../prober/src/status.ts';
import type { Note as NoteFrontmatter } from '../../tools/schema.ts';

export type { StatusResponse };
export type CheckStatus = StatusResponse['checks'][number];
export type Maintenance = StatusResponse['maintenance'][number] & { bodyHtml: string | null };
export type Status = CheckStatus['status'];

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

export interface Incident {
  kind: 'auto' | 'note';
  title: string;
  checks: string[];
  severity: 'down';
  started: string;
  resolved: string | null;
  bodyHtml: string | null;
}

export interface NoteModule {
  frontmatter: NoteFrontmatter;
  compiledContent(): Promise<string>;
}

export type Note = NoteFrontmatter & { bodyHtml: string | null };

export function mergeIncidents(auto: StatusResponse['incidents'], notes: Note[], now: string): Incident[] {
  const cutoff = Date.parse(now) - 90 * 86_400_000;
  const fromNotes: Incident[] = notes
    .filter((n) => n.kind === 'incident' && Date.parse(n.start) >= cutoff)
    .map((n) => ({
      kind: 'note',
      title: n.title,
      checks: n.checks,
      severity: 'down',
      started: new Date(n.start).toISOString(),
      resolved: n.end ? new Date(n.end).toISOString() : null,
      bodyHtml: n.bodyHtml,
    }));
  return [...auto, ...fromNotes].sort((a, b) => b.started.localeCompare(a.started));
}

export function maintenanceWithBodies(windows: StatusResponse['maintenance'], notes: Note[]): Maintenance[] {
  return windows.map((w) => ({
    ...w,
    bodyHtml:
      notes.find((n) => n.kind === 'maintenance' && n.title === w.title && Date.parse(n.start) === Date.parse(w.starts))
        ?.bodyHtml ?? null,
  }));
}
