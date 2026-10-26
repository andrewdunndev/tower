import { allowance } from "../../tools/budget.ts";
import type { Check, Instance } from "../../tools/schema.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const BUCKET_MS = 300_000;
const POINTS = 288;
export const DAYS = 90;
export const DEPLOY_GRACE_MS = 15 * MINUTE_MS;
export const STUCK_PREFIX = "self:stuck:";
const SELF_NAMES: Record<string, string> = {
	"self:token": "Cloudflare API token",
	writes: "database writes",
	stall: "probing stalled",
};

const iso = (t: number) => new Date(t).toISOString();

export const interval = (c: Check) => (c.type === "heartbeat" ? MINUTE_MS : c.every);

export function selfName(config: Instance, key: string, publicOnly: boolean): string | undefined {
	if (!key.startsWith(STUCK_PREFIX)) return SELF_NAMES[key];
	const check = config.checks.find((c) => c.id === key.slice(STUCK_PREFIX.length));
	return check && (check.public || !publicOnly) ? `results for ${check.name}` : undefined;
}

const windowEnd = (config: Instance, id: string, t: number): number | null => {
	const ends = config.maintenance
		.filter((w) => w.checks.includes(id) && Date.parse(w.start) <= t && t < Date.parse(w.end))
		.map((w) => Date.parse(w.end));
	return ends.length ? Math.max(...ends) : null;
};

export const inWindow = (config: Instance, id: string, t: number) => windowEnd(config, id, t) !== null;

export async function status(db: D1Database, config: Instance, now: number) {
	const firstDay = iso(now - (DAYS - 1) * DAY_MS).slice(0, 10);
	const firstBucket = Math.floor(now / BUCKET_MS) * BUCKET_MS - (POINTS - 1) * BUCKET_MS;
	const sets = await db.batch([
		db.prepare(`SELECT "check", avail, degraded, config_error, since, last_conclusive, last_run FROM state`),
		db.prepare(`SELECT "check", day, runs, down FROM daily WHERE day >= ?1`).bind(firstDay),
		db
			.prepare(
				`SELECT "check", CAST((at - ?1) / ?2 AS INTEGER) AS bucket, AVG(ms) AS ms
				 FROM samples WHERE ok = 1 AND at >= ?1 GROUP BY "check", bucket`,
			)
			.bind(firstBucket, BUCKET_MS),
		db
			.prepare(
				`SELECT "check",
				   MAX(CASE WHEN rank = CAST(0.5 * (n - 1) AS INTEGER) THEN ms END) AS p50,
				   MAX(CASE WHEN rank = CAST(0.95 * (n - 1) AS INTEGER) THEN ms END) AS p95
				 FROM (SELECT "check", ms,
				         ROW_NUMBER() OVER (PARTITION BY "check" ORDER BY ms) - 1 AS rank,
				         COUNT(*) OVER (PARTITION BY "check") AS n
				       FROM samples WHERE ok = 1 AND at > ?1)
				 GROUP BY "check"`,
			)
			.bind(now - DAY_MS),
		db.prepare(`SELECT "check", at, "to" FROM events ORDER BY at`),
		db.prepare(`SELECT MIN(CASE WHEN dead = 0 THEN at END) AS oldest, COALESCE(SUM(dead), 0) AS dead FROM outbox`),
		db.prepare(`SELECT key, value FROM meta WHERE key LIKE 'self:%'`),
	]);
	const [states, daily, buckets, quantiles, events, [queue], selves] = sets.map((s) => s.results) as [
		{
			check: string;
			avail: number;
			degraded: number;
			config_error: number;
			since: number;
			last_conclusive: number | null;
			last_run: number | null;
		}[],
		{ check: string; day: string; runs: number; down: number }[],
		{ check: string; bucket: number; ms: number }[],
		{ check: string; p50: number | null; p95: number | null }[],
		{ check: string; at: number; to: "up" | "down" }[],
		{ oldest: number | null; dead: number }[],
		{ key: string; value: string }[],
	];

	const stateOf = new Map(states.map((s) => [s.check, s]));
	const dailyOf = Map.groupBy(daily, (r) => r.check);
	const bucketsOf = Map.groupBy(buckets, (r) => r.check);
	const quantilesOf = new Map(quantiles.map((q) => [q.check, q]));
	const eventsOf = Map.groupBy(events, (e) => e.check);
	const dayKeys = Array.from({ length: DAYS }, (_, i) => iso(now - (DAYS - 1 - i) * DAY_MS).slice(0, 10));

	const all = config.checks.map((check) => {
		const state = stateOf.get(check.id);
		const stale = state?.last_conclusive == null || now - state.last_conclusive > allowance(interval(check));
		const level = inWindow(config, check.id, now)
			? "maintenance"
			: state?.config_error
				? "config-error"
				: stale
					? "unknown"
					: state.avail === 0
						? "down"
						: state.degraded === 1
							? "degraded"
							: "up";
		return { check, state, level, stale };
	});

	const checks = all
		.filter(({ check }) => check.public)
		.map(({ check, state, level }) => {
			const rows = dailyOf.get(check.id) ?? [];
			const runs = rows.reduce((a, r) => a + r.runs, 0);
			const down = rows.reduce((a, r) => a + r.down, 0);
			const byDay = new Map(rows.map((r) => [r.day, r]));
			const byBucket = new Map((bucketsOf.get(check.id) ?? []).map((r) => [r.bucket, r.ms]));
			const q = quantilesOf.get(check.id);
			return {
				name: check.name,
				status: level === "config-error" ? "unknown" : level,
				since: iso(state?.since ?? now),
				uptime90: runs ? 1 - down / runs : null,
				p50: q?.p50 ?? null,
				p95: q?.p95 ?? null,
				days: dayKeys.map((d) => {
					const r = byDay.get(d);
					return r ? 1 - r.down / r.runs : null;
				}),
				latency: Array.from({ length: POINTS }, (_, i) => {
					const ms = byBucket.get(i);
					return ms === undefined ? null : Math.round(ms);
				}),
			};
		});

	const incidents: { checks: string[]; started: string; resolved: string | null }[] = [];
	for (const { check } of all.filter(({ check }) => check.public)) {
		const incident = (from: number, to: number | null) => ({
			checks: [check.name],
			started: iso(from),
			resolved: to === null ? null : iso(to),
		});
		let open: ReturnType<typeof incident> | undefined;
		let held: number | null = null;
		for (const e of eventsOf.get(check.id) ?? []) {
			if (e.to === "down" && !open && held === null) {
				held = windowEnd(config, check.id, e.at);
				if (held === null) {
					open = incident(e.at, null);
					incidents.push(open);
				}
			} else if (e.to === "up") {
				if (open) open.resolved = iso(e.at);
				else if (held !== null && e.at > held) incidents.push(incident(held, e.at));
				open = undefined;
				held = null;
			}
		}
		if (held !== null && held <= now) incidents.push(incident(held, null));
	}
	incidents.sort((a, b) => b.started.localeCompare(a.started));

	const names = new Map(config.checks.filter((c) => c.public).map((c) => [c.id, c.name]));
	const maintenance = config.maintenance
		.filter((w) => now < Date.parse(w.end))
		.map((w) => ({
			title: w.title,
			checks: w.checks.flatMap((id) => names.get(id) ?? []),
			starts: iso(Date.parse(w.start)),
			ends: iso(Date.parse(w.end)),
		}))
		.filter((w) => w.checks.length)
		.sort((a, b) => a.starts.localeCompare(b.starts));

	const lastRun = Math.max(0, ...states.map((s) => s.last_run ?? 0));
	return {
		v: 1 as const,
		generatedAt: iso(now),
		checks,
		incidents,
		maintenance,
		last_run: lastRun ? iso(lastRun) : null,
		outbox_oldest_unsent_at: queue.oldest === null ? null : iso(queue.oldest),
		dead_outbox: queue.dead,
		self: selves.flatMap((r) => {
			const name = selfName(config, r.key, true);
			return name ? [{ name, since: iso(Number(r.value)) }] : [];
		}),
		stuck: all.filter(({ check, stale }) => check.public && stale).length,
	};
}

export type StatusResponse = Awaited<ReturnType<typeof status>>;
