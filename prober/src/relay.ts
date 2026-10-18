import type { Instance } from "../../tools/schema.ts";
import { sameHex, sha256Hex } from "./heartbeat.ts";
import { plain } from "./mail.ts";
import { drain, type RunEnv, route } from "./run.ts";

export const MAX_KEYS = 100;
const MAX_PENDING = 200;
const BURST_INLINE = 5;
const BURST_WINDOW_MS = 60_000;

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
	const description = optional(b.description, DESCRIPTION_MAX);
	return {
		title: plain(b.title.slice(0, TITLE_MAX)) || plain(key),
		description: description && plain(description, true) !== "" ? plain(description, true) : undefined,
		source_url: optional(b.source_url, SOURCE_URL_MAX),
		key,
		status: b.status,
	};
}

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
	const backlog = `(SELECT count(*) FROM (SELECT DISTINCT "key", at, kind FROM outbox WHERE "check" = ?1 AND dead = 0)) < ${MAX_PENDING}`;
	const db = env.DB;

	const fullMail = (): D1PreparedStatement[] =>
		config.digest
			? []
			: [
					db
						.prepare(
							`INSERT INTO outbox ("check", "key", at, kind, since, reason) SELECT '', ?4, ?3, 'self-failing', NULL, NULL WHERE ${full} AND NOT EXISTS (SELECT 1 FROM meta WHERE key = ?4)`,
						)
						.bind(id, key, now, `full:${id}`),
				];

	let result: "transition" | "duplicate" | "rejected";
	let burst: number | undefined;
	if (relay.digest_only) {
		const had = db.prepare(`SELECT 1 AS had FROM relay_keys WHERE relay = ?1 AND "key" = ?2`).bind(id, key);
		if (body.status === "firing") {
			const [seen, kept] = await db.batch<{ had: number } & { kept: number }>([
				had,
				db
					.prepare(
						`INSERT INTO relay_keys (relay, "key", title, since, seen) SELECT ?1, ?2, ?3, ?4, ?4 WHERE NOT (${full})
						 ON CONFLICT (relay, "key") DO UPDATE SET seen = excluded.seen, title = excluded.title RETURNING 1 AS kept`,
					)
					.bind(id, key, body.title, now),
				...fullMail(),
				db
					.prepare(`INSERT OR IGNORE INTO meta (key, value) SELECT ?4, ?3 WHERE ${full}`)
					.bind(id, key, now, `full:${id}`),
			]);
			result = kept.results.length === 0 ? "rejected" : seen.results.length > 0 ? "duplicate" : "transition";
		} else {
			const [seen] = await db.batch<{ had: number }>([
				had,
				db.prepare(`DELETE FROM relay_keys WHERE relay = ?1 AND "key" = ?2`).bind(id, key),
			]);
			result = seen.results.length > 0 ? "transition" : "duplicate";
		}
		return reply(202, { result });
	}
	if (body.status === "firing") {
		const [, counted, kept] = await db.batch<{ n: number } & { kept: number }>([
			db
				.prepare(
					`INSERT INTO outbox ("check", "key", at, kind, since, reason, "to") SELECT ?1, ?2, ?3, 'firing', NULL, ?4, value FROM json_each(?5) WHERE ${absent} AND ${room} AND ${backlog}`,
				)
				.bind(id, key, now, detail, route(relay)),
			db.prepare(BURST).bind(id, key, now),
			db
				.prepare(
					`INSERT INTO relay_keys (relay, "key", title, since, seen) SELECT ?1, ?2, ?3, ?4, ?4 WHERE NOT (${full}) AND (NOT ${absent} OR ${backlog})
					 ON CONFLICT (relay, "key") DO UPDATE SET seen = excluded.seen, title = excluded.title RETURNING 1 AS kept`,
				)
				.bind(id, key, body.title, now),
			...fullMail(),
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
					`INSERT INTO outbox ("check", "key", at, kind, since, reason, "to") SELECT ?1, ?2, ?3, 'resolved', r.since, ?4, j.value FROM relay_keys r, json_each(?5) j WHERE r.relay = ?1 AND r."key" = ?2`,
				)
				.bind(id, key, now, detail, route(relay)),
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
