import type { Instance } from "../../tools/schema.ts";
import { matches, sha256Hex } from "./heartbeat.ts";
import { drain, type RunEnv, route } from "./run.ts";

export const MAX_KEYS = 100;
const MAX_PENDING = 200;
const BURST_INLINE = 5;
const BURST_WINDOW_MS = 60_000;

const TITLE_MAX = 900;
const DESCRIPTION_MAX = 4000;
const KEY_MAX = 256;

const reply = (status: number, body?: object) =>
	new Response(body ? JSON.stringify(body) : null, {
		status,
		headers: body ? { "Content-Type": "application/json" } : undefined,
	});

interface Incident {
	title: string;
	description?: string;
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
	if (typeof b.title !== "string" || b.title.trim() === "") return null;
	const key = b.deduplication_key;
	if (typeof key !== "string" || key.length < 1 || key.length > KEY_MAX) return null;
	if (b.status !== "firing" && b.status !== "resolved") return null;
	const clip = (v: string, n: number) => [...v].slice(0, n).join("");
	return {
		title: clip(b.title, TITLE_MAX),
		description:
			typeof b.description === "string" && b.description !== "" ? clip(b.description, DESCRIPTION_MAX) : undefined,
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

async function find(config: Instance, token: string) {
	const hash = await sha256Hex(token);
	const found = config.relays.filter((r) => matches(hash, r.token_sha256));
	return token === "" ? undefined : found[0];
}

export async function kept(env: RunEnv, config: Instance, token: string) {
	const relay = await find(config, token);
	if (!relay?.maintenance) return reply(404);
	const { results } = await env.DB.prepare(
		`SELECT "key", title, description, since, seen FROM relay_keys WHERE relay = ?1 ORDER BY since`,
	)
		.bind(relay.id)
		.all();
	return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json" } });
}

export async function incident(env: RunEnv, config: Instance, token: string, text: string, now: number) {
	const relay = await find(config, token);
	if (!relay) return reply(404);
	const body = parse(text);
	if (!body) return reply(400);

	const { id } = relay;
	const { key } = body;
	const detail = JSON.stringify({ title: body.title, description: body.description });
	const absent = `NOT EXISTS (SELECT 1 FROM relay_keys WHERE relay = ?1 AND "key" = ?2)`;
	const room = `(SELECT count(*) FROM relay_keys WHERE relay = ?1) < ${MAX_KEYS}`;
	const full = `${absent} AND NOT ${room}`;
	const backlog = `(SELECT count(*) FROM (SELECT DISTINCT "key", at, kind FROM outbox WHERE "check" = ?1 AND dead = 0)) < ${MAX_PENDING}`;
	const db = env.DB;

	const keep = (also = "") =>
		db
			.prepare(
				`INSERT INTO relay_keys (relay, "key", title, since, seen, description) SELECT ?1, ?2, ?3, ?4, ?4, ?5 WHERE NOT (${full})${also}
				 ON CONFLICT (relay, "key") DO UPDATE SET seen = excluded.seen, title = excluded.title, description = excluded.description RETURNING 1 AS kept`,
			)
			.bind(id, key, body.title, now, body.description ?? null);
	const tally = () =>
		db
			.prepare(
				`INSERT INTO relay_fired (relay, "key", title, n, first_at, last_at) SELECT ?1, ?2, ?3, CASE WHEN ${absent} THEN 1 ELSE 0 END, ?4, ?4
				 WHERE NOT (${full}) AND ((SELECT count(*) FROM relay_fired WHERE relay = ?1) < ${MAX_KEYS} OR EXISTS (SELECT 1 FROM relay_fired WHERE relay = ?1 AND "key" = ?2))
				 ON CONFLICT (relay, "key") DO UPDATE SET title = excluded.title, last_at = excluded.last_at, n = n + (CASE WHEN ${absent} THEN 1 ELSE 0 END)`,
			)
			.bind(id, key, body.title, now);

	const fullFlag = (): D1PreparedStatement[] =>
		relay.maintenance
			? []
			: [
					...(config.digest
						? []
						: [
								db
									.prepare(
										`INSERT INTO outbox ("check", "key", at, kind, since, reason) SELECT '', ?4, ?3, 'self-failing', NULL, NULL WHERE ${full} AND NOT EXISTS (SELECT 1 FROM meta WHERE key = ?4)`,
									)
									.bind(id, key, now, `full:${id}`),
							]),
					db
						.prepare(`INSERT OR IGNORE INTO meta (key, value) SELECT ?4, ?3 WHERE ${full}`)
						.bind(id, key, now, `full:${id}`),
				];

	let result: "transition" | "duplicate" | "rejected";
	let burst: number | undefined;
	if (relay.digest_only || relay.maintenance) {
		const had = db.prepare(`SELECT 1 AS had FROM relay_keys WHERE relay = ?1 AND "key" = ?2`).bind(id, key);
		if (body.status === "firing") {
			const write = keep();
			const writes = [had, ...(relay.digest_only ? [tally()] : []), write, ...fullFlag()];
			const rows = await db.batch<{ had: number } & { kept: number }>(writes);
			const seen = rows[0];
			const stored = rows[writes.indexOf(write)];
			result = stored.results.length === 0 ? "rejected" : seen.results.length > 0 ? "duplicate" : "transition";
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
		const [, counted, stored] = await db.batch<{ n: number } & { kept: number }>([
			db
				.prepare(
					`INSERT INTO outbox ("check", "key", at, kind, since, reason, "to") SELECT ?1, ?2, ?3, 'firing', NULL, ?4, value FROM json_each(?5) WHERE ${absent} AND ${room} AND ${backlog}`,
				)
				.bind(id, key, now, detail, route(relay)),
			db.prepare(BURST).bind(id, key, now),
			keep(` AND (NOT ${absent} OR ${backlog})`),
			...fullFlag(),
		]);
		burst = counted.results[0]?.n;
		result = burst !== undefined ? "transition" : stored.results.length > 0 ? "duplicate" : "rejected";
	} else {
		const [, counted] = await db.batch<{ n: number }>([
			db
				.prepare(
					`INSERT INTO outbox ("check", "key", at, kind, since, reason, "to") SELECT ?1, ?2, ?3, 'resolved', r.since, json_set(?4, '$.title', r.title), j.value FROM relay_keys r, json_each(?5) j WHERE r.relay = ?1 AND r."key" = ?2`,
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
