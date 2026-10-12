import type { Instance } from "../../tools/schema.ts";
import { MAX_KEYS } from "./relay.ts";
import { interval, STALE_INTERVALS, STUCK_PREFIX, selfName } from "./status.ts";

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const CRON_SLACK_MS = 60_000;

type Version = { id: string };

const lastRun = `(SELECT MAX(last_run) FROM state)`;
const newest = (t: string) => `${t} >= (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'tick')`;
const allowance = (every: number) => STALE_INTERVALS * every + CRON_SLACK_MS;
const staleWindow = (config: Instance) => allowance(Math.min(...config.checks.map(interval)));
const stallCutoff = (config: Instance, t: number) => t - staleWindow(config);

const queue = (db: D1Database, key: string, kind: string, t: number, guard: string, ...binds: unknown[]) =>
	db
		.prepare(
			`INSERT INTO outbox ("check", "key", at, kind, since, reason) SELECT '', ?1, ?2, ?3, NULL, NULL WHERE ${guard}`,
		)
		.bind(key, t, kind, ...binds);

export async function raiseStall(db: D1Database, config: Instance, t: number): Promise<boolean> {
	const cutoff = stallCutoff(config, t);
	const row = await db.prepare(`SELECT ${lastRun} < ?1 AS stalled`).bind(cutoff).first<{ stalled: number | null }>();
	if (row?.stalled !== 1) return false;
	await db.batch([
		db
			.prepare(
				`INSERT INTO outbox ("check", "key", at, kind, since, reason) SELECT '', 'stall', ?1, 'self-failing', ${lastRun}, NULL WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'stall')`,
			)
			.bind(t),
		db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('stall', ?1)`).bind(String(t)),
	]);
	return true;
}

export function resumedAfter(config: Instance, previous: string | undefined, t: number): boolean {
	return previous !== undefined && t - Number(previous) > staleWindow(config);
}

export async function reportWriteFailure(
	db: D1Database,
	config: Instance,
	send: (subject: string, text: string) => Promise<boolean>,
	t: number,
): Promise<void> {
	let due: boolean;
	try {
		const row = await db.prepare(`SELECT value FROM meta WHERE key = 'tick'`).first<{ value: string }>();
		const gap = t - Number(row?.value);
		const window = staleWindow(config);
		due = window - MINUTE_MS < gap && gap <= window;
	} catch {
		due = t % HOUR_MS < MINUTE_MS;
	}
	if (due) await send("SELF-CHECK FAILING: database writes", `Database writes failed, ${new Date(t).toISOString()}.\n`);
}

export function selfWrites(
	db: D1Database,
	config: Instance,
	t: number,
	version: Version,
	resumed: boolean,
	token: "bad" | "ok" | null,
): D1PreparedStatement[] {
	const writes: D1PreparedStatement[] = [];
	const set = (key: string, value: string | number) =>
		db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)`).bind(key, String(value));

	const stalled = `EXISTS (SELECT 1 FROM meta WHERE key = 'stall')`;
	const recovered = stallCutoff(config, t);
	if (resumed) writes.push(queue(db, "resumed", "resumed", t, `NOT ${stalled}`));
	writes.push(
		queue(db, "stall", "self-ok", t, `${stalled} AND ${lastRun} >= ?4 AND ${newest("?2")}`, recovered),
		db.prepare(`DELETE FROM meta WHERE key = 'stall' AND ${lastRun} >= ?1 AND ${newest("?2")}`).bind(recovered, t),
	);

	writes.push(
		queue(
			db,
			"deployed",
			"deployed",
			t,
			`COALESCE((SELECT value FROM meta WHERE key = 'version'), '') <> ?4`,
			version.id,
		),
		set("version", version.id),
	);

	if (config.digest) {
		const day = new Date(t).toISOString().slice(0, 10);
		const due = Date.parse(`${day}T${config.digest}:00Z`);
		writes.push(
			queue(
				db,
				"digest",
				"digest",
				t,
				`?4 <= ?2 AND COALESCE((SELECT value FROM meta WHERE key = 'digest'), '') <> ?5`,
				due,
				day,
			),
			db.prepare(`INSERT OR REPLACE INTO meta (key, value) SELECT 'digest', ?1 WHERE ?2 <= ?3`).bind(day, due, t),
		);
	}

	if (token === "bad") {
		writes.push(
			queue(db, "self:token", "self-failing", t, `NOT EXISTS (SELECT 1 FROM meta WHERE key = 'self:token')`),
			db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('self:token', ?1)`).bind(String(t)),
		);
	} else if (token === "ok") {
		const raised = `EXISTS (SELECT 1 FROM meta WHERE key = 'self:token')`;
		writes.push(queue(db, "self:token", "self-ok", t, raised), db.prepare(`DELETE FROM meta WHERE key = 'self:token'`));
	}

	for (const r of config.relays) {
		const key = `full:${r.id}`;
		const cleared = `EXISTS (SELECT 1 FROM meta WHERE key = ?4) AND (SELECT count(*) FROM relay_keys WHERE relay = ?5) < ${MAX_KEYS}`;
		writes.push(
			queue(db, key, "self-ok", t, cleared, key, r.id),
			db
				.prepare(`DELETE FROM meta WHERE key = ?1 AND (SELECT count(*) FROM relay_keys WHERE relay = ?2) < ${MAX_KEYS}`)
				.bind(key, r.id),
		);
	}
	return [...writes, ...stuckWrites(db, config, t)];
}

function stuckWrites(db: D1Database, config: Instance, t: number): D1PreparedStatement[] {
	const cutoffs = JSON.stringify(config.checks.map((c) => [c.id, t - allowance(interval(c))]));
	const verdicts = (op: "<=" | ">") =>
		`SELECT s."check" AS id, COALESCE(s.last_conclusive, s.since) AS last, s.reason FROM state s JOIN json_each(?1) j ON s."check" = json_extract(j.value, '$[0]') WHERE COALESCE(s.last_conclusive, s.since) ${op} json_extract(j.value, '$[1]')`;
	const flag = `'${STUCK_PREFIX}' || id`;
	const outbox = `INSERT INTO outbox ("check", "key", at, kind, since, reason)`;
	return [
		db
			.prepare(
				`${outbox} SELECT id, 'stuck', ?2, 'self-failing', last, reason FROM (${verdicts("<=")}) WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = ${flag})`,
			)
			.bind(cutoffs, t),
		db
			.prepare(`INSERT OR IGNORE INTO meta (key, value) SELECT ${flag}, ?2 FROM (${verdicts("<=")})`)
			.bind(cutoffs, String(t)),
		db
			.prepare(
				`${outbox} SELECT id, 'stuck', ?2, 'self-ok', NULL, NULL FROM (${verdicts(">")}) WHERE EXISTS (SELECT 1 FROM meta WHERE key = ${flag}) AND ${newest("?2")}`,
			)
			.bind(cutoffs, t),
		db
			.prepare(`DELETE FROM meta WHERE key IN (SELECT ${flag} FROM (${verdicts(">")})) AND ${newest("?2")}`)
			.bind(cutoffs, t),
	];
}

export async function attention(db: D1Database, config: Instance): Promise<string[]> {
	const [down, open, mail, flags] = await db.batch<Record<string, string | number>>([
		db.prepare(`SELECT "check" AS id FROM state WHERE avail = 0`),
		db.prepare(`SELECT relay AS id, title FROM relay_keys ORDER BY relay, since`),
		db.prepare(
			`SELECT COALESCE(SUM(dead = 0), 0) AS unsent, COALESCE(SUM(dead), 0) AS dead FROM outbox WHERE kind <> 'digest' AND (dead = 1 OR attempts > 0)`,
		),
		db.prepare(`SELECT key FROM meta WHERE key LIKE 'self:%' OR key LIKE 'full:%' ORDER BY key`),
	]);
	const names = new Map<string, string>([
		...config.checks.map((c) => [c.id, c.name] as const),
		...config.relays.map((r) => [r.id, r.name] as const),
	]);
	const lines = [
		...down.results.flatMap((r) => (names.has(String(r.id)) ? [`DOWN: ${names.get(String(r.id))}`] : [])),
		...open.results.flatMap((r) => (names.has(String(r.id)) ? [`OPEN: ${names.get(String(r.id))}: ${r.title}`] : [])),
		...flags.results.flatMap((r) => {
			const key = String(r.key);
			const relay = key.startsWith("full:") ? names.get(key.slice(5)) : undefined;
			const what = relay ? `relay ${relay} is full` : selfName(config, key, false);
			return what ? [`SELF-CHECK: ${what}`] : [];
		}),
	];
	const { unsent, dead } = mail.results[0] as { unsent: number; dead: number };
	if (unsent > 0) lines.push(`MAIL: ${unsent} unsent`);
	if (dead > 0) lines.push(`MAIL: ${dead} dead`);
	return lines;
}
