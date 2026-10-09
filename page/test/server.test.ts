import type { connect } from "cloudflare:sockets";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import example from "../../example/tower.json";
import { tick } from "../../prober/src/run.ts";
import { status } from "../../prober/src/status.ts";
import { mailbox, reset, T0 } from "../../prober/test/util.ts";
import { instanceSchema } from "../../tools/schema.ts";
import { beat, cached, refuse, statusResponse } from "../src/server.ts";

const request = (method: string, path: string, headers: Record<string, string> = {}) =>
	new Request(`https://status.example.com${path}`, { method, headers });

describe("/api/status", () => {
	it("carries no urls, hosts, ids or probe errors of the example instance", async () => {
		await reset();
		const config = instanceSchema.parse(example);
		const leaky = (async (input: RequestInfo | URL) => {
			throw new Error(`connect ECONNREFUSED ${String(input)}`);
		}) as typeof fetch;
		const leakyConnect = ((address: { hostname: string; port: number }) => {
			throw new Error(`connect ECONNREFUSED ${address.hostname}:${address.port}`);
		}) as unknown as typeof connect;
		for (let i = 0; i < 3; i++) await tick(mailbox().runEnv, config, T0 + i * 60_000, leaky, leakyConnect);
		const tower = { status: () => status(env.DB, config, T0 + 180_000) };

		const res = await statusResponse(tower);
		const body = await res.text();
		expect(res.status).toBe(200);
		expect(JSON.parse(body).incidents).toHaveLength(3);
		const forbidden = config.checks.flatMap((c) => {
			const fields = ["url", "host", "query", "zone", "token_sha256"] as const;
			const values = fields.flatMap((f) => (f in c ? [String((c as Record<string, unknown>)[f])] : []));
			return [`"${c.id}"`, ...values, ...(c.type === "http" ? [new URL(c.url).host] : [])];
		});
		expect(forbidden).toContain("https://www.example.com/");
		for (const needle of forbidden) expect(body).not.toContain(needle);
		expect(body).not.toContain("ECONNREFUSED");
	});

	it("answers 503 when the prober RPC fails", async () => {
		const res = await statusResponse({
			status: async () => {
				throw new Error("down");
			},
		});
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ error: "status unavailable" });
	});
});

describe("cache", () => {
	it("serves one entry for any query string and never caches a failure", async () => {
		let renders = 0;
		const render = (status = 200) => async () => {
			renders++;
			return new Response(`render ${renders}`, { status });
		};
		const first = await cached(request("GET", "/api/status?a=1"), render());
		const second = await cached(request("GET", "/api/status?b=2"), render());
		expect(await first.text()).toBe("render 1");
		expect(await second.text()).toBe("render 1");
		expect(renders).toBe(1);

		await cached(request("GET", "/missing"), render(404));
		await cached(request("GET", "/missing"), render(404));
		expect(renders).toBe(3);
	});
});

describe("beat", () => {
	const setup = (allow: boolean) => {
		const calls: unknown[][] = [];
		const keys: string[] = [];
		return {
			calls,
			keys,
			env: {
				TOWER: {
					beat: async (...args: [string, string, boolean]) => {
						calls.push(args);
						return new Response("ok", { status: 202 });
					},
				},
				BEAT_LIMIT: {
					limit: async ({ key }: { key: string }) => {
						keys.push(key);
						return { success: allow };
					},
				},
			},
		};
	};

	it("forwards id, bearer token and outcome and returns the prober's response", async () => {
		const { calls, keys, env } = setup(true);
		const ok = await beat(request("POST", "/beat/db", { Authorization: "Bearer s3cret", "CF-Connecting-IP": "198.51.100.7" }), env);
		const fail = await beat(request("POST", "/beat/db/fail", { Authorization: "Bearer s3cret" }), env);
		expect(ok.status).toBe(202);
		expect(fail.status).toBe(202);
		expect(calls).toEqual([
			["db", "s3cret", true],
			["db", "s3cret", false],
		]);
		expect(keys[0]).toBe("198.51.100.7");
	});

	it("is refused before the prober when rate limited", async () => {
		const { calls, env } = setup(false);
		const res = await beat(request("POST", "/beat/db", { Authorization: "Bearer s3cret" }), env);
		expect(res.status).toBe(429);
		expect(calls).toEqual([]);
	});

	it("404s any other path", async () => {
		const { calls, env } = setup(true);
		for (const path of ["/beat/", "/beat/a/b/fail", "/beat/a/ok"]) {
			expect((await beat(request("POST", path), env)).status).toBe(404);
		}
		expect(calls).toEqual([]);
	});
});

describe("methods", () => {
	it("allows only POST on /beat and GET or HEAD elsewhere", () => {
		for (const [method, path] of [
			["GET", "/"],
			["HEAD", "/"],
			["GET", "/api/status"],
			["POST", "/beat/db"],
		]) {
			expect(refuse(request(method, path))).toBeNull();
		}
		for (const [method, path] of [
			["POST", "/"],
			["PUT", "/api/status"],
			["DELETE", "/"],
			["GET", "/beat/db"],
			["PUT", "/beat/db/fail"],
		]) {
			expect(refuse(request(method, path))?.status).toBe(405);
		}
	});
});
