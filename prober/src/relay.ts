import type { Instance } from "../../tools/schema.ts";
import { sameHex, sha256Hex } from "./heartbeat.ts";
import { drain, type RunEnv } from "./run.ts";

export const MAX_KEYS = 100;
export const BURST_INLINE = 5;
export const BURST_WINDOW_MS = 60_000;

const TITLE_MAX = 1000;
const DESCRIPTION_MAX = 4000;
const SOURCE_URL_MAX = 2000;
const KEY_MAX = 256;

const reply = (status: number, body?: object) =>
	new Response(body ? JSON.stringify(body) : null, {
		status,
		headers: body ? { "Content-Type": "application/json" } : undefined,
	});

interface Incident {
	title: string;
	description?: string;
	source_url?: string;
	key: string;
	status: "firing" | "resolved";
}

function parse(text: string): Incident | null {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof body !== "object" || body === null) return null;
	const b = body as Record<string, unknown>;
	if (typeof b.title !== "string" || b.title === "") return null;
	const key = b.deduplication_key;
	if (typeof key !== "string" || key.length < 1 || key.length > KEY_MAX) return null;
	if (b.status !== "firing" && b.status !== "resolved") return null;
	const optional = (v: unknown, n: number) => (typeof v === "string" && v !== "" ? v.slice(0, n) : undefined);
	return {
		title: b.title.slice(0, TITLE_MAX),
		description: optional(b.description, DESCRIPTION_MAX),
		source_url: optional(b.source_url, SOURCE_URL_MAX),
		key,
		status: b.status,
	};
}

// Counts a transition against the relay's rolling minute; written only when the statement before it changed a row.
const BURST = `INSERT INTO meta (key, value) SELECT 'burst:' || ?1, CAST(?3 AS INTEGER) || ':1' WHERE changes() > 0
	ON CONFLICT (key) DO UPDATE SET value = CASE
		WHEN CAST(?3 AS INTEGER) - CAST(substr(value, 1, instr(value, ':') - 1) AS INTEGER) >= ${BURST_WINDOW_MS}
		THEN CAST(?3 AS INTEGER) || ':1'
		ELSE substr(value, 1, instr(value, ':')) || (CAST(substr(value, instr(value, ':') + 1) AS INTEGER) + 1)
	END
	RETURNING CAST(substr(value, instr(value, ':') + 1) AS INTEGER) AS n`;

export async function incident(env: RunEnv, config: Instance, token: string, text: string, now: number) {
	const hash = await sha256Hex(token);
	let relay: Instance["relays"][number] | undefined;
	for (const r of config.relays) if (sameHex(hash, r.token_sha256) && !relay) relay = r;
	if (!relay || token === "") return reply(404);
	const body = parse(text);
	if (!body) return reply(400);

	const { id } = relay;
	const { key } = body;
	const detail = JSON.stringify({ title: body.title, description: body.description, source_url: body.source_url });
	const absent = `NOT EXISTS (SELECT 1 FROM relay_keys WHERE relay = ?1 AND "key" = ?2)`;
	const room = `(SELECT count(*) FROM relay_keys WHERE relay = ?1) < ${MAX_KEYS}`;
	const full = `${absent} AND NOT ${room}`;
	const db = env.DB;

	let result: "transition" | "duplicate" | "rejected";
	let burst: number | undefined;
	if (body.status === "firing") {
		const [, counted, kept] = await db.batch<{ n: number } & { kept: number }>([
			db
				.prepare(
					`INSERT INTO outbox ("check", "key", at, kind, since, reason) SELECT ?1, ?2, ?3, 'firing', NULL, ?4 WHERE ${absent} AND ${room}`,
				)
				.bind(id, key, now, detail),
			db.prepare(BURST).bind(id, key, now),
			db
				.prepare(
					`INSERT INTO relay_keys (relay, "key", title, since, seen) SELECT ?1, ?2, ?3, ?4, ?4 WHERE NOT (${full})
					 ON CONFLICT (relay, "key") DO UPDATE SET seen = excluded.seen, title = excluded.title RETURNING 1 AS kept`,
				)
				.bind(id, key, body.title, now),
			db
				.prepare(
					`INSERT INTO outbox ("check", "key", at, kind, since, reason) SELECT '', ?4, ?3, 'self-failing', NULL, NULL WHERE ${full} AND NOT EXISTS (SELECT 1 FROM meta WHERE key = ?4)`,
				)
				.bind(id, key, now, `full:${id}`),
			db
				.prepare(`INSERT OR IGNORE INTO meta (key, value) SELECT ?4, ?3 WHERE ${full}`)
				.bind(id, key, now, `full:${id}`),
		]);
		burst = counted.results[0]?.n;
		result = burst !== undefined ? "transition" : kept.results.length > 0 ? "duplicate" : "rejected";
	} else {
		const [, counted] = await db.batch<{ n: number }>([
			db
				.prepare(
					`INSERT INTO outbox ("check", "key", at, kind, since, reason) SELECT ?1, ?2, ?3, 'resolved', since, ?4 FROM relay_keys WHERE relay = ?1 AND "key" = ?2`,
				)
				.bind(id, key, now, detail),
			db.prepare(BURST).bind(id, key, now),
			db.prepare(`DELETE FROM relay_keys WHERE relay = ?1 AND "key" = ?2`).bind(id, key),
		]);
		burst = counted.results[0]?.n;
		result = burst !== undefined ? "transition" : "duplicate";
	}

	if (burst !== undefined && burst <= BURST_INLINE) {
		try {
			await drain(env, config, { relay: id });
		} catch (e) {
			console.error("tower: relay drain failed:", e);
		}
	}
	return reply(202, { result });
}
