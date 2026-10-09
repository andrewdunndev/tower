import { describe, expect, it } from "vitest";
import { hint, probeHttp } from "../src/http.ts";
import { message } from "../src/mail.ts";
import type { Deps } from "../src/probe.ts";
import { makeConfig, respond, web } from "./util.ts";

const check = (extra: object = {}) => makeConfig([{ ...web, ...extra }]).checks[0] as Parameters<typeof probeHttp>[0];
const run = async (extra: object, doFetch: typeof fetch, timeoutMs = 1000) =>
	(await probeHttp(check(extra), { fetch: doFetch, timeoutMs } as Deps)).reason;
const probe = (extra: object, doFetch: typeof fetch) => run(extra, doFetch);

describe("tunnel classifier", () => {
	it("reads 530 as Cloudflare failing to reach the origin, whatever the body", async () => {
		const reason = await probe({}, respond(530, "<h1>Error 1033</h1>"));
		expect(reason).toBe("HTTP 530");
		expect(hint(reason)).toBe("Cloudflare cannot reach the origin (tunnel connector down or origin DNS error)");
	});

	it("reads 502 as the origin behind the tunnel", async () => {
		const reason = await probe({}, respond(502));
		expect(hint(reason)).toBe("the origin behind the tunnel is down");
	});

	it("puts the hint in the alert body", () => {
		const [subject, text] = message(check(), { at: 0, kind: "down", since: 0, reason: "HTTP 530" });
		expect(subject).toBe("DOWN: Web");
		expect(text).toContain("tunnel connector down or origin DNS error");
		expect(text).toContain(check().url);
	});
});

describe("http probe", () => {
	const ok = (body = "", headers = {}) => respond(200, body, headers);

	it("passes a healthy response", async () => {
		expect(await probe({}, ok())).toBeNull();
	});

	it("does not follow redirects", async () => {
		let redirect: RequestRedirect | undefined;
		await probe({}, (async (_url: unknown, init?: RequestInit) => {
			redirect = init?.redirect;
			return new Response("");
		}) as typeof fetch);
		expect(redirect).toBe("manual");
	});

	it("fails on a cache hit unless allow_cache is set", async () => {
		const cached = ok("", { "cf-cache-status": "HIT" });
		expect(await probe({}, cached)).toBe("served from cache");
		expect(await probe({ allow_cache: true }, cached)).toBeNull();
	});

	it("checks contains and absent", async () => {
		expect(await probe({ contains: "hello" }, ok("hello world"))).toBeNull();
		expect(await probe({ contains: "hello" }, ok("nope"))).toBe("missing expected text");
		expect(await probe({ absent: "error" }, ok("fine"))).toBeNull();
		expect(await probe({ absent: "error" }, ok("an error"))).toBe("found forbidden text");
	});

	it("checks a json path", async () => {
		const json = { path: "data.status", equals: "ok" };
		expect(await probe({ json }, ok('{"data":{"status":"ok"}}'))).toBeNull();
		expect(await probe({ json }, ok('{"data":{"status":"bad"}}'))).toBe("json data.status mismatch");
		expect(await probe({ json }, ok("<html>"))).toBe("body is not JSON");
	});

	it("reports a timeout and a transport failure", async () => {
		const hang = ((_url: string, init: RequestInit) =>
			new Promise((_, reject) =>
				init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
			)) as unknown as typeof fetch;
		expect(await run({}, hang, 20)).toBe("timeout");
		const refuse = async () => {
			throw new Error("connection refused");
		};
		expect(await probe({}, refuse)).toBe("fetch failed: connection refused");
	});
});
