/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { beat, cached, cacheKey, refuse } from "../src/server.ts";

const request = (method: string, path: string, headers: Record<string, string> = {}) =>
	new Request(`https://status.example.com${path}`, { method, headers });

describe("cache", () => {
	const render = (counter: { n: number }, status = 200) => async () => {
		counter.n++;
		return new Response(`render ${counter.n}`, { status });
	};

	it("keys the two cached routes by pattern, whatever the path, query or method", async () => {
		const origin = "https://status.example.com";
		expect(cacheKey("/api/status", origin)?.url).toBe(`${origin}/api/status`);
		expect(cacheKey("/", origin)?.url).toBe(`${origin}/`);
		expect(cacheKey("/beat/[...path]", origin)).toBeNull();
		expect(cacheKey("/missing", origin)).toBeNull();

		const calls = { n: 0 };
		const key = cacheKey("/api/status", origin) as Request;
		const first = await cached(key, render(calls));
		const second = await cached(key, render(calls));
		expect(await first.text()).toBe("render 1");
		expect(await second.text()).toBe("render 1");
		expect(calls.n).toBe(1);
	});

	it("never caches a failure", async () => {
		const calls = { n: 0 };
		const key = new Request("https://status.example.com/missing");
		await cached(key, render(calls, 404));
		await cached(key, render(calls, 404));
		expect(calls.n).toBe(2);
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
			["HEAD", "/api/status"],
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
