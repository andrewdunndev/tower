/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { beat, cached, cacheKey, refuse, relay, watch } from "../src/server.ts";

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

describe("methods", () => {
	it("allows only POST on /beat and GET or HEAD elsewhere", () => {
		for (const [method, path] of [
			["GET", "/"],
			["HEAD", "/"],
			["HEAD", "/api/status"],
			["GET", "/api/status"],
			["POST", "/beat/db"],
			["POST", "/relay/incident"],
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
		]) {
			expect(refuse(request(method, path))?.status).toBe(405);
		}
	});
});

describe('watch', () => {
  const alert = { from: 'tower@example.com', to: 'oncall@example.com' };
  const HOUR = 3_600_000;
  const setup = (answers: boolean) => {
    const calls = { watched: [] as number[], subjects: [] as string[] };
    const env = {
      TOWER: {
        watch: async (now: number) => {
          calls.watched.push(now);
          if (!answers) throw new Error('prober unavailable');
        },
      },
      EMAIL: {
        send: async (message: unknown) => {
          calls.subjects.push(/^Subject: (.*)$/m.exec(String((message as Record<string, unknown>)['EmailMessage::raw']))?.[1] ?? '');
          return { messageId: 'test' };
        },
      },
    };
    return { calls, env };
  };

  it('asks the prober with the scheduled time and sends no mail when it answers', async () => {
    const { calls, env } = setup(true);
    await watch(env, alert, HOUR);
    expect(calls.watched).toEqual([HOUR]);
    expect(calls.subjects).toEqual([]);
  });

  it('mails in the first minute of an hour when the prober does not answer, and not after', async () => {
    const { calls, env } = setup(false);
    await watch(env, alert, 5 * HOUR);
    await watch(env, alert, 5 * HOUR + 60_000);
    await watch(env, alert, 5 * HOUR + 1800_000);
    expect(calls.subjects).toEqual(['SELF-CHECK FAILING: probing stalled']);
  });
});
