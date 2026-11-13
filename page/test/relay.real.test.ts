import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEPLOY_GRACE_MS, status } from "../../prober/src/status.ts";
import { all, reset } from "../../prober/test/util.ts";
import { hyperdx } from "../../test/fixture/hyperdx-incidentio.ts";
import example from "../../test/fixture/tower.json";
import { instanceSchema } from "../../tools/schema.ts";

const page = (env as unknown as { PAGE_REAL: Fetcher }).PAGE_REAL;
const TOKEN = "relay-secret";

const post = (body: string, init: { path?: string; token?: string; type?: string } = {}) =>
	page.fetch(`https://status.example.com${init.path ?? "/relay/incident"}`, {
		method: "POST",
		body,
		redirect: "manual",
		headers: {
			"Content-Type": init.type ?? "application/json",
			Authorization: `Bearer ${init.token ?? TOKEN}`,
		},
	});

beforeEach(reset);

describe("the relay through the page and the real prober", () => {
	it("takes HyperDX's incident.io body end to end", async () => {
		const res = await post(hyperdx("ALERT"), { type: "application/json; charset=utf-8" });
		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ result: "transition" });
		expect(await all("SELECT relay, key FROM relay_keys")).toEqual([{ relay: "alerts", key: "evt-1" }]);
		const resolved = await post(hyperdx("OK"));
		expect(await resolved.json()).toEqual({ result: "transition" });
		expect(await all("SELECT relay FROM relay_keys")).toEqual([]);
	});

	it("serves a maintenance relay's firing keys to a GET with its bearer token", async () => {
		const body = JSON.stringify({
			title: "Disk full",
			description: "act now",
			deduplication_key: "k1",
			status: "firing",
		});
		expect((await post(body, { token: "maint-secret" })).status).toBe(202);
		const kept = (token: string) =>
			page.fetch("https://status.example.com/relay/kept", { headers: { Authorization: `Bearer ${token}` } });
		const res = await kept("maint-secret");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject([{ key: "k1", title: "Disk full", description: "act now" }]);
		expect((await kept("wrong")).status).toBe(404);
		expect((await kept(TOKEN)).status).toBe(404);
	});

	it("404s a bad token, a trailing slash and a query-string token without writing", async () => {
		expect((await post(hyperdx("ALERT"), { token: "wrong" })).status).toBe(404);
		expect((await post(hyperdx("ALERT"), { path: "/relay/incident/" })).status).toBe(404);
		const query = await page.fetch(`https://status.example.com/relay/incident?token=${TOKEN}`, {
			method: "POST",
			body: hyperdx("ALERT"),
			redirect: "manual",
			headers: { "Content-Type": "application/json" },
		});
		expect(query.status).toBe(404);
		expect(await all("SELECT relay FROM relay_keys")).toEqual([]);
	});

	it("rejects other media types and oversized bodies", async () => {
		expect((await post(hyperdx("ALERT"), { type: "text/plain" })).status).toBe(415);
		expect((await post("x".repeat(70_000))).status).toBe(413);
	});

	it("never caches a relay answer and refuses other methods", async () => {
		const res = await post(hyperdx("ALERT"));
		expect(res.headers.get("cache-control")).toBeNull();
		const get = await page.fetch("https://status.example.com/relay/incident");
		expect(get.status).toBe(405);
		expect(get.headers.get("allow")).toBe("POST");
	});

	it("keeps a relay's title, description, source_url and key off status and the page", async () => {
		const secrets = ["leak-title", "leak-description", "https://leak.example/source", "leak-key"];
		const body = JSON.stringify({
			title: secrets[0],
			description: secrets[1],
			source_url: secrets[2],
			deduplication_key: secrets[3],
			status: "firing",
		});
		expect((await post(body)).status).toBe(202);
		const config = { ...instanceSchema.parse(example), maintenance: [] };
		const data = await status(env.DB, config, Date.now());
		const { STUB, PAGE } = env as unknown as { STUB: Fetcher; PAGE: Fetcher };
		await STUB.fetch("https://stub.test/", { method: "POST", body: JSON.stringify(data) });
		const html = await (await PAGE.fetch("https://leak.example.com/")).text();
		for (const secret of secrets) {
			expect(JSON.stringify(data)).not.toContain(secret);
			expect(html).not.toContain(secret);
		}
	});
});

describe("the page's cron through the real prober", () => {
	const scheduled = (scheduledTime: number) =>
		(page as Fetcher & { scheduled(options: { scheduledTime: number }): Promise<unknown> }).scheduled({
			scheduledTime,
		});
	const staleRun = async (now: number) =>
		env.DB.prepare(
			`INSERT INTO state ("check", avail, degraded, fails, passes, since, slot, last_run) VALUES ('any', 1, 0, 0, 0, 0, -1, ?1)`,
		)
			.bind(now - 10 * 60_000)
			.run();

	it("raises the stall flag and drains its mail when the prober's last run is stale", async () => {
		const now = Date.now();
		await staleRun(now);
		await scheduled(now + DEPLOY_GRACE_MS);
		expect(await all("SELECT key FROM meta WHERE key = 'stall'")).toEqual([{ key: "stall" }]);
		expect(await all("SELECT * FROM outbox")).toEqual([]);
	});

	it("holds the stall flag while the prober's version is freshly deployed", async () => {
		const now = Date.now();
		await staleRun(now);
		await scheduled(now);
		expect(await all("SELECT key FROM meta WHERE key = 'stall'")).toEqual([]);
	});
});

describe("/healthz through the real prober", () => {
	const healthz = () => page.fetch("https://status.example.com/healthz", { redirect: "manual" });

	it("answers ok for a fresh run and 503 dead for a dead mail row", async () => {
		await env.DB.prepare(
			`INSERT INTO state ("check", avail, degraded, fails, passes, since, slot, last_run) VALUES ('any', 1, 0, 0, 0, 0, -1, ?1)`,
		)
			.bind(Date.now())
			.run();
		const ok = await healthz();
		expect([ok.status, await ok.text()]).toEqual([200, "ok"]);
		await env.DB.prepare(`INSERT INTO outbox ("check", at, kind, dead) VALUES ('any', ?1, 'up', 1)`)
			.bind(Date.now())
			.run();
		const dead = await healthz();
		expect([dead.status, await dead.text()]).toEqual([503, "dead"]);
	});
});
