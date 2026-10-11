import { env } from "cloudflare:workers";
import { type Instance, instanceSchema } from "../../tools/schema.ts";
import type { RunEnv } from "../src/run.ts";

export const MINUTE = 60_000;
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
	const box = { sends: 0, failing: false };
	const runEnv: RunEnv = {
		DB: env.DB,
		EMAIL: {
			send: async () => {
				box.sends++;
				if (box.failing) throw new Error("send failed");
				return { messageId: "test" };
			},
		},
	};
	return { box, runEnv };
}

export async function reset() {
	const tables = ["state", "samples", "daily", "beats", "events", "outbox", "meta", "relay_keys"];
	await env.DB.batch(tables.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
	await env.DB.prepare(`DROP TRIGGER IF EXISTS boom`).run();
}

export async function all<T = Record<string, unknown>>(sql: string, ...binds: unknown[]) {
	return (
		await env.DB.prepare(sql)
			.bind(...binds)
			.all<T>()
	).results;
}
