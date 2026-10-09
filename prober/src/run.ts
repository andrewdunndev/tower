import { connect } from "cloudflare:sockets";
import type { Check, Instance } from "../../tools/schema.ts";
import { judgeBeat } from "./heartbeat.ts";
import { message, type Pending, sendMail } from "./mail.ts";
import { type Outcome, probe } from "./probe.ts";

export type RunEnv = Pick<Env, "DB"> & { EMAIL: Pick<SendEmail, "send">; CF_API_TOKEN?: string };

interface Track {
	avail: boolean;
	fails: number;
	passes: number;
	since: number;
}

interface StateRow {
	check: string;
	avail: number;
	degraded: number;
	fails: number;
	passes: number;
	since: number;
	slot: number;
}

const TIMED = new Set<Check["type"]>(["http", "tcp", "dns"]);
const interval = (c: Check) => (c.type === "heartbeat" ? MINUTE_MS : c.every);

const SKEW_MS = 2000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const CONCURRENCY = 6;
const MAX_ATTEMPTS = 10;
const RECENT_SAMPLES = 5;
const OWNED_TABLES = ["state", "samples", "daily", "beats", "events", "outbox"];

export function step(
	s: Track,
	ok: boolean,
	now: number,
	limits: { down_after: number; up_after: number },
): { next: Track; transition: "down" | "up" | null } {
	if (ok) {
		if (s.avail) return { next: { ...s, fails: 0, passes: 0 }, transition: null };
		const passes = s.passes + 1;
		if (passes < limits.up_after) return { next: { ...s, passes }, transition: null };
		return { next: { avail: true, fails: 0, passes: 0, since: now }, transition: "up" };
	}
	if (!s.avail) return { next: { ...s, passes: 0 }, transition: null };
	const fails = s.fails + 1;
	if (fails < limits.down_after) return { next: { ...s, fails }, transition: null };
	return { next: { avail: false, fails: 0, passes: 0, since: now }, transition: "down" };
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
	return out;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];

async function claim(db: D1Database, config: Instance, t: number) {
	const seeds = config.checks.flatMap((c) => [
		db
			.prepare(
				`INSERT OR IGNORE INTO state ("check", avail, degraded, fails, passes, since, slot) VALUES (?1, 1, 0, 0, 0, ?2, -1)`,
			)
			.bind(c.id, t),
	]);
	const claims = config.checks.map((c) =>
		db
			.prepare(
				`UPDATE state SET slot = ?2 WHERE "check" = ?1 AND slot < ?2 RETURNING "check", avail, degraded, fails, passes, since, slot`,
			)
			.bind(c.id, Math.floor((t + SKEW_MS) / interval(c))),
	);
	const results = await db.batch<StateRow>([...seeds, ...claims]);
	return config.checks.flatMap((check, i) => {
		const row = results[seeds.length + i].results[0];
		return row ? [{ check, row }] : [];
	});
}

export async function tick(
	env: RunEnv,
	config: Instance,
	t: number,
	doFetch: typeof fetch = fetch,
	doConnect: typeof connect = connect,
) {
	const claimed = await claim(env.DB, config, t);

	const ran = await pool(claimed, CONCURRENCY, async ({ check, row }) => {
		const started = Date.now();
		const outcome: Outcome =
			check.type === "heartbeat"
				? await judgeBeat(env.DB, check, t, row.since)
				: await probe(check, {
						db: env.DB,
						fetch: doFetch,
						connect: doConnect,
						token: env.CF_API_TOKEN,
						timeoutMs: config.timeout_ms,
						now: t,
					});
		return { check, row, outcome, ms: Date.now() - started };
	});

	const recent = await Promise.all(
		ran.map(({ check }) =>
			check.type === "http" && check.slow_ms !== undefined
				? env.DB.prepare(`SELECT ms FROM samples WHERE "check" = ?1 AND ok = 1 ORDER BY at DESC LIMIT ?2`)
						.bind(check.id, RECENT_SAMPLES)
						.all<{ ms: number }>()
				: null,
		),
	);

	const day = new Date(t).toISOString().slice(0, 10);
	const writes: D1PreparedStatement[] = [];
	for (const [i, { check, row, outcome, ms }] of ran.entries()) {
		const conclusive = outcome.verdict === "ok" || outcome.verdict === "down";
		const before = { avail: row.avail === 1, fails: row.fails, passes: row.passes, since: row.since };
		const limits = check.type === "heartbeat" ? { down_after: 1, up_after: 1 } : check;
		const { next, transition } = conclusive
			? step(before, outcome.verdict === "ok", t, limits)
			: { next: before, transition: null };
		const samples = recent[i]?.results.map((r) => r.ms) ?? [];
		const window = (outcome.verdict === "ok" ? [ms] : []).concat(samples).slice(0, RECENT_SAMPLES);
		const slow =
			check.type === "http" && check.slow_ms !== undefined && window.length > 0 && median(window) > check.slow_ms;
		const degraded = conclusive ? (check.type === "http" ? slow : outcome.degraded === true) : row.degraded === 1;
		const current = `EXISTS (SELECT 1 FROM state WHERE "check" = ?1 AND slot = ?2)`;
		writes.push(
			env.DB.prepare(
				`UPDATE state SET avail = ?3, degraded = ?4, fails = ?5, passes = ?6, since = ?7, last_ok = COALESCE(?8, last_ok), last_run = ?9, reason = ?10, config_error = ?11 WHERE "check" = ?1 AND slot = ?2`,
			).bind(
				check.id,
				row.slot,
				next.avail ? 1 : 0,
				degraded ? 1 : 0,
				next.fails,
				next.passes,
				next.since,
				conclusive ? t : null,
				t,
				outcome.reason,
				outcome.verdict === "config-error" ? 1 : 0,
			),
		);
		if (!conclusive) continue;
		if (TIMED.has(check.type)) {
			writes.push(
				env.DB.prepare(`INSERT INTO samples ("check", at, ms, ok) SELECT ?1, ?3, ?4, ?5 WHERE ${current}`).bind(
					check.id,
					row.slot,
					t,
					ms,
					outcome.verdict === "ok" ? 1 : 0,
				),
			);
		}
		writes.push(
			env.DB.prepare(
				`INSERT INTO daily ("check", day, runs, down, maint) SELECT ?1, ?3, 1, ?4, 0 WHERE ${current}
					 ON CONFLICT ("check", day) DO UPDATE SET runs = runs + 1, down = down + ?4`,
			).bind(check.id, row.slot, day, next.avail ? 0 : 1),
		);
		if (transition) {
			writes.push(
				env.DB.prepare(`INSERT INTO events ("check", at, "from", "to") SELECT ?1, ?3, ?4, ?5 WHERE ${current}`).bind(
					check.id,
					row.slot,
					t,
					transition === "down" ? "up" : "down",
					transition,
				),
				env.DB.prepare(
					`INSERT INTO outbox ("check", at, kind, since, reason) SELECT ?1, ?3, ?4, ?5, ?6 WHERE ${current}`,
				).bind(check.id, row.slot, t, transition, before.since, outcome.reason),
			);
		}
	}
	writes.push(...prune(env.DB, config, t));
	await env.DB.batch(writes);

	await drain(env, config);
}

function prune(db: D1Database, config: Instance, t: number): D1PreparedStatement[] {
	const ids = JSON.stringify(config.checks.map((c) => c.id));
	const cutoff = t - config.history_days * DAY_MS;
	return [
		db.prepare(`DELETE FROM samples WHERE at < ?1`).bind(t - DAY_MS),
		db.prepare(`DELETE FROM daily WHERE day < ?1`).bind(new Date(cutoff).toISOString().slice(0, 10)),
		db.prepare(`DELETE FROM events WHERE at < ?1`).bind(cutoff),
		...OWNED_TABLES.map((table) =>
			db.prepare(`DELETE FROM ${table} WHERE "check" NOT IN (SELECT value FROM json_each(?1))`).bind(ids),
		),
	];
}

async function drain(env: RunEnv, config: Instance) {
	const { results } = await env.DB.prepare(
		`SELECT "check", at, kind, since, reason FROM outbox WHERE dead = 0 ORDER BY at`,
	).all<Pending & { check: string }>();
	const byCheck = Map.groupBy(results, (r) => r.check);
	for (const [id, rows] of byCheck) {
		const check = config.checks.find((c) => c.id === id);
		if (!check) continue;
		const latest = rows[rows.length - 1];
		const [subject, text] = message(check, latest);
		const sent = await sendMail(env.EMAIL, config.alert, subject, text);
		const update = sent
			? env.DB.prepare(`DELETE FROM outbox WHERE "check" = ?1 AND dead = 0 AND at <= ?2`).bind(id, latest.at)
			: env.DB.prepare(
					`UPDATE outbox SET attempts = attempts + 1, dead = attempts + 1 >= ?3 WHERE "check" = ?1 AND dead = 0 AND at <= ?2`,
				).bind(id, latest.at, MAX_ATTEMPTS);
		await update.run();
	}
}
