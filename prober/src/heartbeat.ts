import type { Check } from "../../tools/schema.ts";
import type { Outcome } from "./probe.ts";

type HeartbeatCheck = Extract<Check, { type: "heartbeat" }>;

const NOT_FOUND = () => new Response(null, { status: 404 });
const encoder = new TextEncoder();

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function sameHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export async function recordBeat(
	db: D1Database,
	checks: Check[],
	id: string,
	token: string,
	ok: boolean,
	now: number,
): Promise<Response> {
	const check = checks.find((c): c is HeartbeatCheck => c.id === id && c.type === "heartbeat");
	const matches = sameHex(await sha256Hex(token), check?.token_sha256 ?? "0".repeat(64));
	if (!check || token === "" || !matches) return NOT_FOUND();
	await db
		.prepare(`INSERT OR REPLACE INTO beats ("check", at, ok) VALUES (?1, ?2, ?3)`)
		.bind(id, now, ok ? 1 : 0)
		.run();
	return new Response(null, { status: 204 });
}

export async function judgeBeat(db: D1Database, c: HeartbeatCheck, now: number): Promise<Outcome> {
	const beat = await db
		.prepare(`SELECT at, ok FROM beats WHERE "check" = ?1`)
		.bind(c.id)
		.first<{ at: number; ok: number }>();
	if (!beat) return { verdict: "inconclusive", reason: "no beat record" };
	if (beat.ok === 0) return { verdict: "down", reason: "heartbeat reported failure" };
	if (now > beat.at + c.every + c.grace) return { verdict: "down", reason: "heartbeat missed its deadline" };
	return { verdict: "ok", reason: null };
}
