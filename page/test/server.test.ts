/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { beat, cached, cacheKey, healthResponse, kept, refuse, relay } from "../src/server.ts";

const request = (method: string, path: string, headers: Record<string, string> = {}) =>
	new Request(`https://status.example.com${path}`, { method, headers });

describe("cache", () => {
	const render =
		(counter: { n: number }, status = 200) =>
		async () => {
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
	const setup = () => {
		const calls: unknown[][] = [];
		return {
			calls,
			env: {
				TOWER: {
					beat: async (...args: [string, string, boolean]) => {
						calls.push(args);
						return new Response("ok", { status: 202 });
					},
				},
			},
		};
	};

	it("forwards id, bearer token and outcome and returns the prober's response", async () => {
		const { calls, env } = setup();
		const ok = await beat(request("POST", "/beat/db", { Authorization: "Bearer s3cret" }), env);
		const fail = await beat(request("POST", "/beat/db/fail", { Authorization: "Bearer s3cret" }), env);
		expect(ok.status).toBe(202);
		expect(fail.status).toBe(202);
		expect(calls).toEqual([
			["db", "s3cret", true],
			["db", "s3cret", false],
		]);
	});

	it("404s any other path", async () => {
		const { calls, env } = setup();
		for (const path of ["/beat/", "/beat/a/b/fail", "/beat/a/ok"]) {
			expect((await beat(request("POST", path), env)).status).toBe(404);
		}
		expect(calls).toEqual([]);
	});

	it("answers 503 with an empty body when the prober throws", async () => {
		const res = await beat(request("POST", "/beat/db"), {
			TOWER: {
				beat: async () => {
					throw new Error("down");
				},
			},
		});
		expect(res.status).toBe(503);
		expect(await res.text()).toBe("");
	});
});

describe("relay", () => {
	const setup = () => {
		const calls: unknown[][] = [];
		return {
			calls,
			env: {
				TOWER: {
					incident: async (...args: [string, string]) => {
						calls.push(args);
						return new Response('{"result":"transition"}', { status: 202 });
					},
				},
			},
		};
	};
	const post = (path: string, body: BodyInit | null, headers: Record<string, string> = {}) =>
		new Request(`https://status.example.com${path}`, {
			method: "POST",
			body,
			headers: { "Content-Type": "application/json", ...headers },
		});

	it("forwards the bearer token and body and returns the prober's response", async () => {
		const { calls, env } = setup();
		const res = await relay(post("/relay/incident?token=nope", '{"a":1}', { Authorization: "Bearer s3cret" }), env);
		expect(res.status).toBe(202);
		expect(calls).toEqual([["s3cret", '{"a":1}']]);
	});

	it("accepts a charset parameter and any case in the media type", async () => {
		const { calls, env } = setup();
		for (const type of ["application/json; charset=utf-8", "Application/JSON"]) {
			expect((await relay(post("/relay/incident", "{}", { "Content-Type": type }), env)).status).toBe(202);
		}
		expect(calls).toHaveLength(2);
	});

	it("refuses before any RPC: other paths 404, other media types 415, big bodies 413", async () => {
		const { calls, env } = setup();
		for (const path of ["/relay/incident/", "/relay", "/relay/other"]) {
			expect((await relay(post(path, "{}"), env)).status).toBe(404);
		}
		expect((await relay(post("/relay/incident", "{}", { "Content-Type": "text/plain" }), env)).status).toBe(415);
		expect((await relay(post("/relay/incident", "{}", { "Content-Type": "" }), env)).status).toBe(415);
		expect((await relay(post("/relay/incident", "x", { "Content-Length": "65537" }), env)).status).toBe(413);
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new Uint8Array(40_000));
				controller.enqueue(new Uint8Array(40_000));
				controller.close();
			},
		});
		const streamed = new Request("https://status.example.com/relay/incident", {
			method: "POST",
			body: stream,
			headers: { "Content-Type": "application/json" },
			duplex: "half",
		} as RequestInit);
		expect((await relay(streamed, env)).status).toBe(413);
		expect(calls).toEqual([]);
	});

	it("answers 503 with an empty body when the prober throws", async () => {
		const res = await relay(post("/relay/incident", "{}"), {
			TOWER: {
				incident: async () => {
					throw new Error("down");
				},
			},
		});
		expect(res.status).toBe(503);
		expect(await res.text()).toBe("");
	});
});

describe("kept", () => {
	const get = (path = "/relay/kept", headers: Record<string, string> = {}) =>
		new Request(`https://status.example.com${path}`, { headers });

	it("forwards the bearer token and returns the prober's response", async () => {
		const calls: string[] = [];
		const env = {
			TOWER: {
				kept: async (token: string) => {
					calls.push(token);
					return Response.json([{ key: "k1" }]);
				},
			},
		};
		const res = await kept(get("/relay/kept", { Authorization: "Bearer s3cret" }), env);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([{ key: "k1" }]);
		expect(calls).toEqual(["s3cret"]);
		await kept(get(), env);
		expect(calls).toEqual(["s3cret", ""]);
	});

	it("answers 503 with an empty body when the prober throws", async () => {
		const res = await kept(get(), {
			TOWER: {
				kept: async () => {
					throw new Error("down");
				},
			},
		});
		expect(res.status).toBe(503);
		expect(await res.text()).toBe("");
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
			["POST", "/relay/incident"],
			["GET", "/relay/kept"],
		]) {
			expect(refuse(request(method, path))).toBeNull();
		}
		for (const [method, path] of [
			["POST", "/"],
			["PUT", "/api/status"],
			["DELETE", "/"],
			["GET", "/beat/db"],
			["PUT", "/beat/db/fail"],
			["GET", "/relay/incident"],
			["PUT", "/relay/incident"],
			["POST", "/relay/kept"],
		]) {
			expect(refuse(request(method, path))?.status).toBe(405);
		}
	});
});

describe("healthResponse", () => {
	const answering = (state: "ok" | "stale" | "dead") => ({ health: async () => state });

	it("answers 200 ok only for a healthy prober", async () => {
		const res = await healthResponse(answering("ok"));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("ok");
	});

	it("answers 503 with a body that never contains ok for every other state", async () => {
		const down = { health: async () => Promise.reject(new Error("prober unavailable")) };
		for (const [tower, body] of [
			[answering("stale"), "stale"],
			[answering("dead"), "dead"],
			[down, "unavailable"],
		] as const) {
			const res = await healthResponse(tower);
			expect(res.status).toBe(503);
			expect(await res.text()).toBe(body);
			expect(body).not.toMatch(/ok/i);
		}
	});

	it("is never cached, never a redirect, and plain text", async () => {
		for (const tower of [answering("ok"), answering("dead")]) {
			const res = await healthResponse(tower);
			expect(res.headers.get("Cache-Control")).toBe("no-store");
			expect(res.headers.get("Content-Type")).toBe("text/plain");
			expect(res.redirected).toBe(false);
			expect(res.headers.get("Location")).toBeNull();
		}
	});

	it("is not one of the cached routes", () => {
		expect(cacheKey("/healthz", "https://status.example.com")).toBeNull();
	});
});
