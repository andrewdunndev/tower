import type { Instance } from "../../tools/schema.ts";
import type { Attention } from "./mail.ts";
import { MAX_KEYS } from "./relay.ts";
import { allowance, DEPLOY_GRACE_MS, interval, STUCK_PREFIX, selfName } from "./status.ts";

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const TALLY_LINES = 50;

type Version = { id: string; timestamp?: string };

const lastRun = `(SELECT MAX(last_run) FROM state)`;
const newest = (t: string) => `${t} >= (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'tick')`;
const staleWindow = (config: Instance) => allowance(Math.min(...config.checks.map(interval)));
const stallCutoff = (config: Instance, t: number) => t - staleWindow(config);

const queue = (db: D1Database, key: string, kind: string, t: number, guard: string, ...binds: unknown[]) =>
	db
		.prepare(
			`INSERT INTO outbox ("check", "key", at, kind, since, reason) SELECT '', ?1, ?2, ?3, NULL, NULL WHERE ${guard}`,
		)
		.bind(key, t, kind, ...binds);

export function inDeployGrace(version: Version, t: number): boolean {
	const deployed = Date.parse(version.timestamp ?? "");
	return t - deployed < DEPLOY_GRACE_MS;
}

export async function raiseStall(db: D1Database, config: Instance, t: number, version: Version): Promise<boolean> {
	if (inDeployGrace(version, t)) return false;
	const cutoff = stallCutoff(config, t);
	const row = await db.prepare(`SELECT ${lastRun} < ?1 AS stalled`).bind(cutoff).first<{ stalled: number | null }>();
	if (row?.stalled !== 1) return false;
	await db.batch([
		...(config.digest
			? []
			: [
					db
						.prepare(
							`INSERT INTO outbox ("check", "key", at, kind, since, reason) SELECT '', 'stall', ?1, 'self-failing', ${lastRun}, NULL WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'stall')`,
						)
						.bind(t),
				]),
		db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('stall', ?1)`).bind(String(t)),
	]);
	return true;
}

export async function reportWriteFailure(
	db: D1Database,
	config: Instance,
	send: (subject: string, text: string) => Promise<boolean>,
	t: number,
): Promise<void> {
	let due: boolean;
	if (config.digest) {
		const at = Date.parse(`${new Date(t).toISOString().slice(0, 10)}T${config.digest}:00Z`);
		due = t >= at && t - at < MINUTE_MS;
	} else {
		try {
			const row = await db.prepare(`SELECT value FROM meta WHERE key = 'tick'`).first<{ value: string }>();
			const gap = t - Number(row?.value);
			const window = staleWindow(config);
			due = window - MINUTE_MS < gap && gap <= window;
		} catch {
			due = t % HOUR_MS < MINUTE_MS;
		}
	}
	if (due) await send("SELF-CHECK FAILING: database writes", `Database writes failed, ${new Date(t).toISOString()}.\n`);
}

export function digestWrites(db: D1Database, config: Instance, t: number, guard = "1"): D1PreparedStatement[] {
	if (!config.digest) return [];
	const day = new Date(t).toISOString().slice(0, 10);
	const due = Date.parse(`${day}T${config.digest}:00Z`);
	return [
		queue(
			db,
			"digest",
			"digest",
			t,
			`?4 <= ?2 AND COALESCE((SELECT value FROM meta WHERE key = 'digest'), '') <> ?5 AND ${guard}`,
			due,
			day,
		),
		db
			.prepare(`INSERT OR REPLACE INTO meta (key, value) SELECT 'digest', ?1 WHERE ?2 <= ?3 AND ${guard}`)
			.bind(day, due, t),
	];
}

export function selfWrites(
	db: D1Database,
	config: Instance,
	t: number,
	version: Version,
	token: "bad" | "ok" | null,
): D1PreparedStatement[] {
	const writes: D1PreparedStatement[] = [];
	const set = (key: string, value: string | number) =>
		db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)`).bind(key, String(value));

	writes.push(
		db
			.prepare(`DELETE FROM meta WHERE key = 'stall' AND ${lastRun} >= ?1 AND ${newest("?2")}`)
			.bind(stallCutoff(config, t), t),
		set("version", version.id),
	);

	writes.push(...digestWrites(db, config, t));

	if (token === "bad") {
		if (!config.digest) {
			writes.push(
				queue(db, "self:token", "self-failing", t, `NOT EXISTS (SELECT 1 FROM meta WHERE key = 'self:token')`),
			);
		}
		writes.push(db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('self:token', ?1)`).bind(String(t)));
	} else if (token === "ok") {
		writes.push(db.prepare(`DELETE FROM meta WHERE key = 'self:token'`));
	}

	for (const r of config.relays) {
		writes.push(
			db
				.prepare(`DELETE FROM meta WHERE key = ?1 AND (SELECT count(*) FROM relay_keys WHERE relay = ?2) < ${MAX_KEYS}`)
				.bind(`full:${r.id}`, r.id),
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
		...(config.digest
			? []
			: [
					db
						.prepare(
							`${outbox} SELECT id, 'stuck', ?2, 'self-failing', last, reason FROM (${verdicts("<=")}) WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = ${flag})`,
						)
						.bind(cutoffs, t),
				]),
		db
			.prepare(`INSERT OR IGNORE INTO meta (key, value) SELECT ${flag}, ?2 FROM (${verdicts("<=")})`)
			.bind(cutoffs, String(t)),
		db
			.prepare(`DELETE FROM meta WHERE key IN (SELECT ${flag} FROM (${verdicts(">")})) AND ${newest("?2")}`)
			.bind(cutoffs, t),
	];
}

const stamp = (t: number) => new Date(t).toISOString().slice(5, 16).replace("T", " ");

export async function attention(db: D1Database, config: Instance): Promise<Attention> {
	const [down, open, fired, mail, flags, sent] = await db.batch<Record<string, string | number>>([
		db.prepare(`SELECT "check" AS id FROM state WHERE avail = 0`),
		db.prepare(`SELECT relay AS id, title FROM relay_keys ORDER BY relay, since`),
		db.prepare(
			`SELECT f.relay AS id, f.title, f.n, f.first_at, f.last_at, EXISTS (SELECT 1 FROM relay_keys k WHERE k.relay = f.relay AND k."key" = f."key") AS open FROM relay_fired f ORDER BY f.first_at, f.rowid`,
		),
		db.prepare(
			`SELECT COALESCE(SUM(dead = 0), 0) AS unsent, COALESCE(SUM(dead), 0) AS dead FROM outbox WHERE kind <> 'digest' AND (dead = 1 OR attempts > 0)`,
		),
		db.prepare(`SELECT key FROM meta WHERE key LIKE 'self:%' OR key LIKE 'full:%' OR key = 'stall' ORDER BY key`),
		db.prepare(`SELECT COALESCE(CAST((SELECT value FROM meta WHERE key = 'sent') AS INTEGER), 0) AS n`),
	]);
	const names = new Map<string, string>([
		...config.checks.map((c) => [c.id, c.name] as const),
		...config.relays.map((r) => [r.id, r.name] as const),
	]);
	const pushed = new Set(config.relays.filter((r) => !r.digest_only && !r.maintenance).map((r) => r.id));
	const downChecks = down.results.filter((r) => config.checks.some((c) => c.id === r.id));
	const tally = fired.results.filter((r) => names.has(String(r.id)));
	const tallied = tally
		.slice(0, TALLY_LINES)
		.map(
			(r) =>
				`${r.title}: fired ${r.n}, first ${stamp(Number(r.first_at))}Z, last ${stamp(Number(r.last_at))}Z, ${r.open ? "open" : "resolved"}`,
		);
	const more = tally.length - tallied.length;
	const standing = tally.filter((r) => r.open === 1).length;
	const lines = [
		...down.results.flatMap((r) => (names.has(String(r.id)) ? [`DOWN: ${names.get(String(r.id))}`] : [])),
		...open.results.flatMap((r) => (pushed.has(String(r.id)) ? [`OPEN: ${names.get(String(r.id))}: ${r.title}`] : [])),
		...tallied,
		...(more > 0 ? [`and ${more} more`] : []),
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
	return {
		lines,
		need: lines.length - tallied.length - (more > 0 ? 1 : 0) + standing,
		up: config.checks.length - downChecks.length,
		total: config.checks.length,
		resolved: tally.length - standing,
		sent: Number(sent.results[0].n),
		dead,
	};
}
