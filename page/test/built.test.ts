import type { connect } from "cloudflare:sockets";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import example from "../../example/tower.json";
import { tick } from "../../prober/src/run.ts";
import { status } from "../../prober/src/status.ts";
import { mailbox, reset, T0 } from "../../prober/test/util.ts";
import { instanceSchema } from "../../tools/schema.ts";

const pages = env as unknown as { PAGE: Fetcher; STUB: Fetcher };
const answer = (body: string) => pages.STUB.fetch("https://stub.test/", { method: "POST", body });
// The page caches 200s per origin, so each test gets its own host.
const get = (path: string, host: string) => pages.PAGE.fetch(`https://${host}.example.com${path}`);

describe("the built page", () => {
	it("answers 503 and says so when the prober is unavailable", async () => {
		await answer("");
		const res = await get("/", "unavailable");
		expect(res.status).toBe(503);
		expect(await res.text()).toContain("status unavailable");
		const api = await get("/api/status", "unavailable");
		expect(api.status).toBe(503);
		expect(await api.json()).toEqual({ error: "status unavailable" });
	});

	describe("with a healthy prober", () => {
		it("shows a note's text and none of its raw HTML, under a CSP", async () => {
			await reset();
			const config = { ...instanceSchema.parse(example), maintenance: [] };
			await answer(JSON.stringify(await status(env.DB, config, Date.parse("2026-09-10T00:00:00Z"))));
			const res = await get("/", "note");
			const body = await res.text();
			expect(res.status).toBe(200);
			expect(body).toContain("A bad release was rolled back.");
			expect(body).not.toContain("alert('note')");
			expect(body).not.toContain("onerror");
			expect(body).not.toMatch(/<script[^>]*>[^<]*alert/);
			expect(res.headers.get("content-security-policy")).toBeTruthy();
		});

		it("serves /api/status with names only", async () => {
			await reset();
			const window = { title: "Database upgrade", start: new Date(T0).toISOString(), end: new Date(T0 + 3600_000).toISOString(), checks: ["api"] };
			const config = { ...instanceSchema.parse(example), maintenance: [window] };
			const leaky = (async (input: RequestInfo | URL) => {
				throw new Error(`connect ECONNREFUSED ${String(input)}`);
			}) as typeof fetch;
			const leakyConnect = ((address: { hostname: string; port: number }) => {
				throw new Error(`connect ECONNREFUSED ${address.hostname}:${address.port}`);
			}) as unknown as typeof connect;
			for (let i = 0; i < 3; i++) await tick(mailbox().runEnv, config, T0 + i * 60_000, leaky, leakyConnect);
			await answer(JSON.stringify(await status(env.DB, config, T0 + 180_000)));

			const res = await get("/api/status", "api");
			const body = await res.text();
			expect(res.status).toBe(200);
			expect(JSON.parse(body).incidents).toHaveLength(2);
			expect(JSON.parse(body).maintenance).toEqual([
				{ title: "Database upgrade", checks: ["API"], starts: window.start, ends: window.end },
			]);
			const forbidden = config.checks.flatMap((c) => {
				const fields = ["url", "host", "query", "zone", "token_sha256"] as const;
				const values = fields.flatMap((f) => (f in c ? [String((c as Record<string, unknown>)[f])] : []));
				return [`"${c.id}"`, ...values, ...(c.type === "http" ? [new URL(c.url).host] : [])];
			});
			expect(forbidden).toContain("https://www.example.com/");
			for (const needle of forbidden) expect(body).not.toContain(needle);
			expect(body).not.toContain("ECONNREFUSED");
		});
	});
});
