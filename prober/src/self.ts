import { allowance } from "../../tools/budget.ts";
import type { Instance } from "../../tools/schema.ts";
import { d1Latch, type Latch, memoryLatch, REPEAT_HOURS, selfAlert } from "./latch.ts";
import type { Attention } from "./mail.ts";
import { MAX_KEYS } from "./relay.ts";
import { DEPLOY_GRACE_MS, interval, STUCK_PREFIX, selfName } from "./status.ts";

const HEALTH_FLOOR_MS = 5 * 60_000;
const TALLY_LINES = 50;
const TITLE_CLIP = 120;

type Version = { id: string; timestamp?: string };

const lastRun = `(SELECT MAX(last_run) FROM state)`;
const newest = (t: string) => `${t} >= (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'tick')`;
const staleWindow = (config: Instance) => config.stall_after ?? allowance(Math.min(...config.checks.map(interval)));
const stallCutoff = (config: Instance, t: number) => t - staleWindow(config);

export function inDeployGrace(version: Version, t: number): boolean {
	const deployed = Date.parse(version.timestamp ?? "");
	return t - deployed < DEPLOY_GRACE_MS;
}

type Send = (subject: string, text: string) => Promise<boolean>;

export async function raiseStall(
	db: D1Database,
	config: Instance,
	t: number,
	version: Version,
	send: Send,
): Promise<boolean> {
	if (inDeployGrace(version, t)) return false;
	const row = await db
		.prepare(`SELECT ${lastRun} AS run, ${lastRun} < ?1 AS stalled`)
		.bind(stallCutoff(config, t))
		.first<{ run: number; stalled: number | null }>();
	if (row?.stalled !== 1) return false;
	await selfAlert(d1Latch(db), "stall", t, () =>
		send(
			"SELF-CHECK FAILING: probing stalled",
			`No probe run has written results since ${new Date(row.run).toISOString()}; detected ${new Date(t).toISOString()}. The prober's alarm or its runs are failing; its Worker log says which. This repeats every ${REPEAT_HOURS} hours until probing resumes.\n`,
		),
	);
	return true;
}

export async function health(
	db: D1Database,
	config: Instance,
	t: number,
	version: Version,
): Promise<"ok" | "stale" | "dead"> {
	const row = await db
		.prepare(`SELECT MAX(last_run) AS run, EXISTS (SELECT 1 FROM outbox WHERE dead = 1) AS dead FROM state`)
		.first<{ run: number | null; dead: number }>();
	if (row?.dead) return "dead";
	const fresh = row?.run != null && row.run >= t - Math.max(HEALTH_FLOOR_MS, staleWindow(config));
	return fresh || inDeployGrace(version, t) ? "ok" : "stale";
}

const fallback = memoryLatch();

export async function reportWriteFailure(db: D1Database, send: Send, t: number): Promise<void> {
	const alert = (latch: Latch) =>
		selfAlert(latch, "writes", t, () =>
			send(
				"SELF-CHECK FAILING: database writes",
				`Database writes failed, ${new Date(t).toISOString()}. This repeats every ${REPEAT_HOURS} hours until a run writes.\n`,
			),
		);
	try {
		await alert(d1Latch(db));
	} catch (e) {
		console.error("tower: write-failure latch unavailable:", e);
		await alert(fallback);
	}
}

export function digestWrites(db: D1Database, config: Instance, t: number, guard = "1"): D1PreparedStatement[] {
	const day = new Date(t).toISOString().slice(0, 10);
	const due = Date.parse(`${day}T${config.digest}:00Z`);
	return [
		db
			.prepare(
				`INSERT INTO outbox ("check", "key", at, kind, since, reason) SELECT '', 'digest', ?1, 'digest', NULL, NULL WHERE ?2 <= ?1 AND COALESCE((SELECT value FROM meta WHERE key = 'digest'), '') <> ?3 AND ${guard}`,
			)
			.bind(t, due, day),
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
		db.prepare(`DELETE FROM meta WHERE key = 'writes'`),
	);

	writes.push(...digestWrites(db, config, t));

	if (token === "bad") {
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
		`SELECT s."check" AS id FROM state s JOIN json_each(?1) j ON s."check" = json_extract(j.value, '$[0]') WHERE COALESCE(s.last_conclusive, s.since) ${op} json_extract(j.value, '$[1]')`;
	const flag = `'${STUCK_PREFIX}' || id`;
	return [
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
		db.prepare(
			`SELECT k.relay AS id, k.title FROM relay_keys k WHERE NOT EXISTS (SELECT 1 FROM relay_fired f WHERE f.relay = k.relay AND f."key" = k."key") ORDER BY k.relay, k.since`,
		),
		db.prepare(
			`SELECT f.relay AS id, f.title, f.n, f.first_at, f.last_at, EXISTS (SELECT 1 FROM relay_keys k WHERE k.relay = f.relay AND k."key" = f."key") AS open FROM relay_fired f ORDER BY f.first_at, f.rowid`,
		),
		db.prepare(
			`SELECT COALESCE(SUM(dead = 0), 0) AS unsent, COALESCE(SUM(dead), 0) AS dead FROM outbox WHERE kind <> 'digest' AND (dead = 1 OR attempts > 0)`,
		),
		db.prepare(
			`SELECT key FROM meta WHERE key LIKE 'self:%' OR key LIKE 'full:%' OR key IN ('stall', 'writes') ORDER BY key`,
		),
		db.prepare(`SELECT COALESCE(CAST((SELECT value FROM meta WHERE key = 'sent') AS INTEGER), 0) AS n`),
	]);
	const names = new Map<string, string>([
		...config.checks.map((c) => [c.id, c.name] as const),
		...config.relays.map((r) => [r.id, r.name] as const),
	]);
	const listed = new Set(config.relays.filter((r) => !r.maintenance).map((r) => r.id));
	const downChecks = down.results.filter((r) => config.checks.some((c) => c.id === r.id));
	const tally = fired.results.filter((r) => names.has(String(r.id)));
	const tallied = tally
		.slice(0, TALLY_LINES)
		.map(
			(r) =>
				`${String(r.title).slice(0, TITLE_CLIP)}: fired ${r.n}, first ${stamp(Number(r.first_at))}Z, last ${stamp(Number(r.last_at))}Z, ${r.open ? "open" : "closed"}`,
		);
	const more = tally.length - tallied.length;
	const standing = tally.filter((r) => r.open === 1).length;
	const before = [
		...down.results.flatMap((r) => (names.has(String(r.id)) ? [`DOWN: ${names.get(String(r.id))}`] : [])),
		...open.results.flatMap((r) => (listed.has(String(r.id)) ? [`OPEN: ${names.get(String(r.id))}: ${r.title}`] : [])),
	];
	const after = flags.results.flatMap((r) => {
		const key = String(r.key);
		const relay = key.startsWith("full:") ? names.get(key.slice(5)) : undefined;
		const what = relay ? `relay ${relay} is full` : selfName(config, key, false);
		return what ? [`SELF-CHECK: ${what}`] : [];
	});
	const { unsent, dead } = mail.results[0] as { unsent: number; dead: number };
	if (unsent > 0) after.push(`MAIL: ${unsent} unsent`);
	if (dead > 0) after.push(`MAIL: ${dead} dead`);
	return {
		lines: [...before, ...tallied, ...(more > 0 ? [`and ${more} more`] : []), ...after],
		need: before.length + after.length + standing,
		up: config.checks.length - downChecks.length,
		total: config.checks.length,
		closed: tally.length - standing,
		sent: Number(sent.results[0].n),
		dead,
	};
}
