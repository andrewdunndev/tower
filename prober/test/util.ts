import { env } from "cloudflare:workers";
import { type Instance, instanceSchema } from "../../tools/schema.ts";
import { type RunEnv, tick } from "../src/run.ts";

export const MINUTE = 60_000;
export const VERSION = { id: "v1" };
export const T0 = Math.floor(Date.UTC(2026, 9, 8, 12) / MINUTE) * MINUTE;

export const web = { id: "web", type: "http", name: "Web", url: "https://www.example.com/" };

export function makeConfig(
	checks: object[] = [web],
	extra: object = {},
	maintenance: Instance["maintenance"] = [],
): Instance {
	return {
		...instanceSchema.parse({
			name: "example",
			title: "Example",
			domain: "status.example.com",
			alert: { from: "tower@example.com", to: "oncall@example.com" },
			checks,
			...extra,
		}),
		maintenance,
	};
}

export function respond(status: number, body = "", headers: Record<string, string> = {}) {
	return async () => new Response(body, { status, headers });
}

export function mailbox() {
	const box = {
		sends: 0,
		failing: false,
		failFor: new Set<string>(),
		subjects: [] as string[],
		bodies: [] as string[],
		to: [] as string[],
	};
	const runEnv: RunEnv = {
		DB: env.DB,
		VERSION,
		EMAIL: {
			send: async (message) => {
				const raw = String((message as unknown as Record<string, unknown>)["EmailMessage::raw"]);
				const to = (message as unknown as { to: string }).to;
				box.sends++;
				box.subjects.push(/^Subject: (.*)$/m.exec(raw)?.[1] ?? "");
				box.bodies.push(raw.split("\r\n\r\n")[1] ?? "");
				box.to.push(/^To: (.*)$/m.exec(raw)?.[1] === to ? to : `mismatch: ${to}`);
				if (box.failing || box.failFor.has(to)) throw new Error("send failed");
				return { messageId: "test" };
			},
		},
	};
	return { box, runEnv };
}

export async function reset() {
	const tables = ["state", "samples", "daily", "beats", "events", "outbox", "meta", "relay_keys", "relay_fired"];
	await env.DB.batch(tables.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
	await env.DB.prepare(`DROP TRIGGER IF EXISTS boom`).run();
	await env.DB.prepare(`INSERT INTO meta (key, value) VALUES ('version', ?1)`).bind(VERSION.id).run();
}

export async function all<T = Record<string, unknown>>(sql: string, ...binds: unknown[]) {
	return (
		await env.DB.prepare(sql)
			.bind(...binds)
			.all<T>()
	).results;
}

export async function steadyTick(runEnv: RunEnv, config: Instance, t: number, doFetch?: typeof fetch) {
	await env.DB.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('tick', ?1)`)
		.bind(String(t - MINUTE))
		.run();
	await tick(runEnv, config, t, t, doFetch);
}

export async function sha256(text: string) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
