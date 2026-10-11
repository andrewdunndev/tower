import type { Instance } from "../../tools/schema.ts";
import { MAX_KEYS } from "./relay.ts";
import { SELF_NAMES } from "./status.ts";

const RESUME_AFTER_MS = 90_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

type Version = { id: string };

const queue = (db: D1Database, key: string, kind: string, t: number, guard: string, ...binds: unknown[]) =>
	db
		.prepare(
			`INSERT INTO outbox ("check", "key", at, kind, since, reason) SELECT '', ?1, ?2, ?3, NULL, NULL WHERE ${guard}`,
		)
		.bind(key, t, kind, ...binds);

export function resumedAfter(previous: string | undefined, t: number): boolean {
	return previous !== undefined && t - Number(previous) > RESUME_AFTER_MS;
}

export async function reportWriteFailure(
	db: D1Database,
	send: (subject: string, text: string) => Promise<boolean>,
	t: number,
): Promise<void> {
	let recent: boolean;
	try {
		const row = await db.prepare(`SELECT value FROM meta WHERE key = 'tick'`).first<{ value: string }>();
		recent = row !== null && t - Number(row.value) < RESUME_AFTER_MS;
	} catch {
		recent = t % HOUR_MS < MINUTE_MS;
	}
	if (recent)
		await send("SELF-CHECK FAILING: database writes", `Database writes failed, ${new Date(t).toISOString()}.\n`);
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

	if (resumed) writes.push(queue(db, "resumed", "resumed", t, "1"));

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
	return writes;
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
			const what = relay ? `relay ${relay} is full` : SELF_NAMES[key];
			return what ? [`SELF-CHECK: ${what}`] : [];
		}),
	];
	const { unsent, dead } = mail.results[0] as { unsent: number; dead: number };
	if (unsent > 0) lines.push(`MAIL: ${unsent} unsent`);
	if (dead > 0) lines.push(`MAIL: ${dead} dead`);
	return lines;
}
