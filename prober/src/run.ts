import { connect } from "cloudflare:sockets";
import { CONCURRENCY, DB_MARGIN_MS, SKEW_MS } from "../../tools/budget.ts";
import type { Check, Instance } from "../../tools/schema.ts";
import { judgeBeat } from "./heartbeat.ts";
import { compose, NONE, type Pending, SEND_TIMEOUT_MS, sendMail } from "./mail.ts";
import { type Outcome, probe } from "./probe.ts";
import { attention, digestWrites, raiseStall, reportWriteFailure, selfWrites } from "./self.ts";
import { DAYS, interval, inWindow, STUCK_PREFIX } from "./status.ts";

export type RunEnv = Pick<Env, "DB"> & {
	EMAIL: Pick<SendEmail, "send">;
	VERSION: Pick<WorkerVersionMetadata, "id"> & Partial<Pick<WorkerVersionMetadata, "timestamp">>;
	CF_API_TOKEN?: string;
};

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
	mailed: number;
}

const TIMED = new Set<Check["type"]>(["http", "tcp", "dns"]);

const DAY_MS = 86_400_000;
const FIRED_DAYS = 7;
const ABSENT_DAYS = 7;
const GIVE_UP_MS = DAY_MS;
const RETRY_CAP_MS = 15 * 60_000;
const BACKOFF_MS = 60_000;
const PERMANENT_ATTEMPTS = 3;
const LEASE_MS = 50_000;
const MIN_BUDGET_MS = 20_000;
const RECENT_SAMPLES = 5;
const GONE_PREFIX = "gone:";
const OWNED_TABLES = ["state", "samples", "daily", "beats", "events"];

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

function pool<T, R>(items: T[], size: number, open: () => boolean, fn: (item: T) => Promise<R>) {
	const out: (R | undefined)[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length && open()) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	};
	const done = Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
	return { out, done };
}

const OUTLIVED: Outcome = { verdict: "inconclusive", reason: "probe outlived the run" };

export function clockAt(t: number): () => number {
	const offset = t - Date.now();
	return () => Date.now() + offset;
}

export const route = (o: { to?: string[] }) => JSON.stringify(o.to ?? [""]);

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];

async function claim(db: D1Database, config: Instance, t: number) {
	const seeds = config.checks.map((c) =>
		db
			.prepare(
				`INSERT OR IGNORE INTO state ("check", avail, degraded, fails, passes, since, slot) VALUES (?1, 1, 0, 0, 0, ?2, -1)`,
			)
			.bind(c.id, t),
	);
	const ticks = [
		db
			.prepare(
				`INSERT INTO meta (key, value) VALUES ('tick', ?1) ON CONFLICT (key) DO UPDATE SET value = MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER))`,
			)
			.bind(String(t)),
	];
	const claims = config.checks.map((c) =>
		db
			.prepare(
				`UPDATE state SET slot = ?2 WHERE "check" = ?1 AND slot < ?2 RETURNING "check", avail, degraded, fails, passes, since, slot, mailed`,
			)
			.bind(c.id, Math.floor((t + SKEW_MS) / interval(c)) * interval(c)),
	);
	const results = await db.batch<StateRow>([...ticks, ...seeds, ...claims]);
	const offset = ticks.length + seeds.length;
	const claimed = config.checks.flatMap((check, i) => {
		const row = results[offset + i].results[0];
		return row ? [{ check, row }] : [];
	});
	return claimed;
}

export async function tick(
	env: RunEnv,
	config: Instance,
	t: number,
	startedAt: number,
	doFetch: typeof fetch = fetch,
	doConnect: typeof connect = connect,
) {
	const now = clockAt(startedAt);
	let claimed: Awaited<ReturnType<typeof claim>>;
	try {
		claimed = await claim(env.DB, config, t);
	} catch (e) {
		await reportWriteFailure(
			env.DB,
			config,
			async (subject, text) => (await sendMail(env.EMAIL, config.alert, subject, text)) === "sent",
			t,
		);
		throw e;
	}

	const deadline = Math.max(
		t + Math.min(...claimed.map(({ check }) => interval(check))) - SKEW_MS - DB_MARGIN_MS,
		startedAt + MIN_BUDGET_MS,
	);
	const open = () => now() < deadline;
	const probes = pool(claimed, CONCURRENCY, open, async ({ check, row }) => {
		const started = Date.now();
		const outcome: Outcome =
			check.type === "heartbeat"
				? await judgeBeat(env.DB, check, t, row)
				: await probe(check, {
						db: env.DB,
						fetch: (input, init) => doFetch(input, init),
						connect: doConnect,
						token: env.CF_API_TOKEN,
						timeoutMs: config.timeout_ms,
						now: t,
					});
		return { check, row, outcome, ms: Date.now() - started };
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([probes.done, new Promise((r) => (timer = setTimeout(r, deadline - now())))]);
	} finally {
		clearTimeout(timer);
	}
	probes.done.catch(() => {});
	const ran = claimed.map(({ check, row }, i) => probes.out[i] ?? { check, row, outcome: OUTLIVED, ms: 0 });

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
		const limits = "down_after" in check ? check : { down_after: 1, up_after: 1 };
		const { next, transition } = conclusive
			? step(before, outcome.verdict === "ok", t, limits)
			: { next: before, transition: null };
		const samples = recent[i]?.results.map((r) => r.ms) ?? [];
		const window = (outcome.verdict === "ok" ? [ms] : []).concat(samples).slice(0, RECENT_SAMPLES);
		const slow =
			check.type === "http" && check.slow_ms !== undefined && window.length > 0 && median(window) > check.slow_ms;
		const degraded = conclusive ? (check.type === "http" ? slow : outcome.degraded === true) : row.degraded === 1;
		const quiet = inWindow(config, check.id, t);
		const mail = conclusive && !quiet && (next.avail ? 1 : 0) !== row.mailed;
		const current = `EXISTS (SELECT 1 FROM state WHERE "check" = ?1 AND slot = ?2)`;
		writes.push(
			env.DB.prepare(
				`UPDATE state SET avail = ?3, degraded = ?4, fails = ?5, passes = ?6, since = ?7, last_conclusive = COALESCE(?8, last_conclusive), last_run = ?9, reason = ?10, config_error = ?11, mailed = ?12 WHERE "check" = ?1 AND slot = ?2`,
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
				mail ? (next.avail ? 1 : 0) : row.mailed,
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
				`INSERT INTO daily ("check", day, runs, down, maint) SELECT ?1, ?3, 1, ?4, ?5 WHERE ${current}
					 ON CONFLICT ("check", day) DO UPDATE SET runs = runs + 1, down = down + ?4, maint = maint + ?5`,
			).bind(check.id, row.slot, day, next.avail || quiet ? 0 : 1, !next.avail && quiet ? 1 : 0),
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
			);
		}
		if (mail) {
			writes.push(
				env.DB.prepare(
					`INSERT INTO outbox ("check", at, kind, since, reason, "to") SELECT ?1, ?3, ?4, ?5, ?6, value FROM json_each(?7) WHERE ${current}`,
				).bind(
					check.id,
					row.slot,
					t,
					next.avail ? "up" : "down",
					transition ? before.since : null,
					outcome.reason,
					route(check),
				),
			);
		}
	}
	const tokens = ran.flatMap(({ outcome }) => (outcome.token ? [outcome.token] : []));
	const token = tokens.includes("bad") ? "bad" : tokens.includes("ok") ? "ok" : null;
	writes.push(
		...expire(env.DB, config, t),
		...prune(env.DB, config, t),
		...selfWrites(env.DB, config, t, env.VERSION, token),
	);
	await env.DB.batch(writes);

	await drain(env, config, { now });
}

export async function watch(env: RunEnv, config: Instance, now: number) {
	if (!(await raiseStall(env.DB, config, now, env.VERSION))) return;
	const queued = digestWrites(env.DB, config, now, `EXISTS (SELECT 1 FROM meta WHERE key = 'stall')`);
	if (queued.length > 0) await env.DB.batch(queued);
	await drain(env, config, { now: clockAt(now) });
}

function expire(db: D1Database, config: Instance, t: number): D1PreparedStatement[] {
	return config.relays.flatMap((r) => [
		db
			.prepare(
				`INSERT INTO outbox ("check", "key", at, kind, since, reason, "to") SELECT r.relay, r."key", ?2, 'stale', r.since, json_object('title', r.title), j.value FROM relay_keys r, json_each(?4) j WHERE r.relay = ?1 AND r.seen < ?3 AND ?5 = 0`,
			)
			.bind(r.id, t, t - r.grace, route(r), r.digest_only || r.maintenance ? 1 : 0),
		db.prepare(`DELETE FROM relay_keys WHERE relay = ?1 AND seen < ?2`).bind(r.id, t - r.grace),
	]);
}

function prune(db: D1Database, config: Instance, t: number): D1PreparedStatement[] {
	const ids = JSON.stringify(config.checks.map((c) => c.id));
	const owners = JSON.stringify([...config.checks.map((c) => c.id), ...config.relays.map((r) => r.id), ""]);
	const relays = JSON.stringify(config.relays.map((r) => r.id));
	const routes = JSON.stringify(
		Object.fromEntries([...config.checks, ...config.relays].map((o) => [o.id, o.to ?? [""]])),
	);
	const cutoff = t - DAYS * DAY_MS;
	const absentCutoff = t - ABSENT_DAYS * DAY_MS;
	const lapsed = `key LIKE '${GONE_PREFIX}%' AND CAST(value AS INTEGER) < ?1`;
	return [
		db.prepare(`DELETE FROM samples WHERE at < ?1`).bind(t - DAY_MS),
		db.prepare(`DELETE FROM daily WHERE day < ?1`).bind(new Date(cutoff).toISOString().slice(0, 10)),
		db.prepare(`DELETE FROM events WHERE at < ?1`).bind(cutoff),
		db.prepare(`DELETE FROM outbox WHERE dead = 1 AND next_at < ?1`).bind(t - DAY_MS),
		db
			.prepare(
				`INSERT OR IGNORE INTO meta (key, value) SELECT '${GONE_PREFIX}' || "check", ?2 FROM state WHERE "check" NOT IN (SELECT value FROM json_each(?1))`,
			)
			.bind(ids, String(t)),
		db
			.prepare(
				`DELETE FROM meta WHERE key LIKE '${GONE_PREFIX}%' AND substr(key, ${GONE_PREFIX.length + 1}) IN (SELECT value FROM json_each(?1))`,
			)
			.bind(ids),
		...OWNED_TABLES.map((table) =>
			db
				.prepare(
					`DELETE FROM ${table} WHERE "check" IN (SELECT substr(key, ${GONE_PREFIX.length + 1}) FROM meta WHERE ${lapsed})`,
				)
				.bind(absentCutoff),
		),
		db.prepare(`DELETE FROM meta WHERE ${lapsed}`).bind(absentCutoff),
		db.prepare(`DELETE FROM outbox WHERE "check" NOT IN (SELECT value FROM json_each(?1))`).bind(owners),
		db
			.prepare(
				`INSERT INTO outbox ("check", "key", at, kind, since, reason, "to") SELECT DISTINCT o."check", o."key", o.at, o.kind, o.since, o.reason, r.value FROM outbox o JOIN json_each(?1) c ON c.key = o."check", json_each(c.value) r WHERE o.dead = 0 AND o."to" <> '' AND o."to" NOT IN (SELECT value FROM json_each(c.value)) AND NOT EXISTS (SELECT 1 FROM outbox d WHERE d."check" = o."check" AND d."key" = o."key" AND d.at = o.at AND d.kind = o.kind AND d."to" = r.value)`,
			)
			.bind(routes),
		db
			.prepare(
				`DELETE FROM outbox WHERE dead = 0 AND "to" <> '' AND NOT EXISTS (SELECT 1 FROM json_each(?1) c, json_each(c.value) r WHERE c.key = outbox."check" AND r.value = outbox."to")`,
			)
			.bind(routes),
		db
			.prepare(
				`DELETE FROM meta WHERE key LIKE '${STUCK_PREFIX}%' AND substr(key, ${STUCK_PREFIX.length + 1}) NOT IN (SELECT value FROM json_each(?1))`,
			)
			.bind(ids),
		db.prepare(`DELETE FROM relay_keys WHERE relay NOT IN (SELECT value FROM json_each(?1))`).bind(relays),
		db
			.prepare(`DELETE FROM relay_fired WHERE relay NOT IN (SELECT value FROM json_each(?1)) OR last_at < ?2`)
			.bind(relays, t - FIRED_DAYS * DAY_MS),
		db
			.prepare(
				`DELETE FROM meta WHERE (key LIKE 'burst:%' OR key LIKE 'full:%') AND substr(key, instr(key, ':') + 1) NOT IN (SELECT value FROM json_each(?1))`,
			)
			.bind(relays),
	];
}

export async function drain(
	env: RunEnv,
	config: Instance,
	{ now = Date.now, relay = null }: { now?: () => number; relay?: string | null } = {},
) {
	const until = now() + LEASE_MS;
	const lock = await env.DB.prepare(
		`INSERT INTO meta (key, value) VALUES ('drain', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE CAST(meta.value AS INTEGER) <= ?2`,
	)
		.bind(String(until), now())
		.run();
	if (lock.meta.changes === 0) return;
	try {
		await send(env, config, until, now, relay);
	} finally {
		await env.DB.prepare(`UPDATE meta SET value = '0' WHERE key = 'drain' AND value = ?1`).bind(String(until)).run();
	}
}

type Row = Pending & { rowid: number; check: string; to: string; next_at: number };

async function send(env: RunEnv, config: Instance, until: number, now: () => number, only: string | null) {
	const { results } = await env.DB.prepare(
		`SELECT rowid, "check", "key", at, kind, since, reason, "to", next_at FROM outbox WHERE dead = 0 AND (?1 IS NULL OR "check" = ?1) ORDER BY at, rowid`,
	)
		.bind(only)
		.all<Row>();
	const relayIds = new Set(config.relays.map((r) => r.id));
	const checkIds = new Set(config.checks.map((c) => c.id));
	const transition = (r: Row) => checkIds.has(r.check) && (r.kind === "down" || r.kind === "up");
	const addr = (r: Row) => (r.to || config.alert.to).toLowerCase();
	const latestKind = new Map<string, string>();
	for (const r of results) if (transition(r)) latestKind.set(JSON.stringify([r.check, addr(r)]), r.kind);
	const groups = Map.groupBy(results, (r) =>
		transition(r)
			? JSON.stringify(["transition", latestKind.get(JSON.stringify([r.check, addr(r)])), addr(r)])
			: JSON.stringify([r.check, relayIds.has(r.check) ? null : r.key, addr(r)]),
	);
	for (const rows of groups.values()) {
		if (rows.every((r) => r.next_at > now() + SKEW_MS)) continue;
		const digest = rows[0].kind === "digest";
		const cut = digest ? now() : 0;
		const composed = compose(config, rows, digest ? await attention(env.DB, config) : NONE);
		if (!composed) continue;
		if (now() + SEND_TIMEOUT_MS + DB_MARGIN_MS > until) return;
		const rowids = JSON.stringify(rows.map((r) => r.rowid));
		await env.DB.prepare(`UPDATE outbox SET attempts = attempts + 1 WHERE rowid IN (SELECT value FROM json_each(?1))`)
			.bind(rowids)
			.run();
		const [subject, text] = composed;
		const sent = await sendMail(env.EMAIL, { from: config.alert.from, to: addr(rows[0]) }, subject, text);
		if (sent !== "sent") {
			const t = now();
			const mine = `rowid IN (SELECT value FROM json_each(?1))`;
			await env.DB.batch([
				env.DB.prepare(
					`UPDATE outbox SET next_at = ?2 + MIN(?3, ${BACKOFF_MS} * (1 << MIN(attempts - 1, 10))) WHERE ${mine}`,
				).bind(rowids, t, RETRY_CAP_MS),
				env.DB.prepare(
					`UPDATE outbox SET dead = 1, next_at = ?2 WHERE ${mine} AND (?3 AND attempts >= ?4 OR ?2 - at >= ?5) AND NOT (kind = 'down' AND EXISTS (SELECT 1 FROM state s WHERE s."check" = outbox."check" AND s.avail = 0))`,
				).bind(rowids, t, sent === "permanent" ? 1 : 0, PERMANENT_ATTEMPTS, GIVE_UP_MS),
			]);
			continue;
		}
		await env.DB.batch([
			env.DB.prepare(`DELETE FROM outbox WHERE rowid IN (SELECT value FROM json_each(?1))`).bind(rowids),
			...(digest
				? [
						env.DB.prepare(`DELETE FROM relay_fired WHERE last_at <= ?1`).bind(cut),
						env.DB.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('sent', '0')`),
					]
				: [
						env.DB.prepare(
							`INSERT INTO meta (key, value) VALUES ('sent', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`,
						),
					]),
		]);
	}
}
