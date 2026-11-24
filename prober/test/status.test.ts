import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { tick } from "../src/run.ts";
import { health } from "../src/self.ts";
import { DEPLOY_GRACE_MS, status } from "../src/status.ts";
import { all, MINUTE, mailbox, makeConfig, reset, respond, T0, VERSION, web } from "./util.ts";

beforeEach(reset);

describe("status", () => {
	it("shows empty history as unknown with no data", async () => {
		const s = await status(env.DB, makeConfig(), T0);
		expect(s.checks).toHaveLength(1);
		expect(s.checks[0]).toMatchObject({ name: "Web", status: "unknown", uptime90: null, p50: null, p95: null });
		expect(s.checks[0].days).toHaveLength(90);
		expect(s.checks[0].days.every((d) => d === null)).toBe(true);
		expect(s.checks[0].latency).toHaveLength(288);
		expect(s.checks[0].latency.every((v) => v === null)).toBe(true);
		expect(s).toMatchObject({
			v: 1,
			last_run: null,
			outbox_oldest_unsent_at: null,
			dead_outbox: 0,
			stuck: 1,
			incidents: [],
		});
	});

	it("lists a failing token flag but not the mail-latched self-checks", async () => {
		await env.DB.batch(
			["self:token", "stall", "writes"].map((key) =>
				env.DB.prepare(`INSERT INTO meta (key, value) VALUES (?1, ?2)`).bind(key, String(T0)),
			),
		);
		const s = await status(env.DB, makeConfig(), T0);
		expect(s.self.map((f) => f.name)).toEqual(["Cloudflare API token"]);
	});

	it("reports uptime, latency and an incident from recorded runs", async () => {
		const { runEnv } = mailbox();
		const config = makeConfig([{ ...web, down_after: 1, up_after: 1 }]);
		await env.DB.batch(
			[100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((ms) =>
				env.DB.prepare(`INSERT INTO samples ("check", at, ms, ok) VALUES ('web', ?1, ?2, 1)`).bind(T0 - ms, ms),
			),
		);
		await tick(runEnv, config, T0, T0, respond(200));
		await tick(runEnv, config, T0 + MINUTE, T0 + MINUTE, respond(500));
		await tick(runEnv, config, T0 + 2 * MINUTE, T0 + 2 * MINUTE, respond(200));
		const s = await status(env.DB, config, T0 + 2 * MINUTE);
		expect(s.checks[0]).toMatchObject({ status: "up" });
		expect(s.checks[0].p95).toBeGreaterThan(s.checks[0].p50 as number);
		expect(s.checks[0].uptime90).toBeCloseTo(2 / 3);
		expect(s.checks[0].days.at(-1)).toBeCloseTo(2 / 3);
		expect(s.checks[0].p50).not.toBeNull();
		expect(s.checks[0].latency.at(-1)).not.toBeNull();
		expect(s.incidents).toEqual([
			{
				checks: ["Web"],
				started: new Date(T0 + MINUTE).toISOString(),
				resolved: new Date(T0 + 2 * MINUTE).toISOString(),
			},
		]);
		expect(s.last_run).toBe(new Date(T0 + 2 * MINUTE).toISOString());
	});

	it("serves the same p50, p95 and latency from the rollups as a query over samples", async () => {
		const { runEnv } = mailbox();
		const config = makeConfig([web]);
		const DAY = 24 * 60 * MINUTE;
		await env.DB.batch(
			Array.from({ length: 220 }, (_, i) =>
				env.DB.prepare(`INSERT INTO samples ("check", at, ms, ok) VALUES ('web', ?1, ?2, ?3)`).bind(
					T0 - DAY + 30_000 + (i - 20) * 7 * MINUTE,
					((i * 37) % 97) + (i % 5) * 50,
					i % 9 === 0 ? 0 : 1,
				),
			),
		);
		for (const t of [T0, T0 + 90 * MINUTE, T0 + 91 * MINUTE]) {
			await tick(runEnv, config, t, t, respond(200));
			const [p] = await all<{ p50: number; p95: number }>(
				`SELECT MAX(CASE WHEN rank = CAST(0.5 * (n - 1) AS INTEGER) THEN ms END) AS p50,
				        MAX(CASE WHEN rank = CAST(0.95 * (n - 1) AS INTEGER) THEN ms END) AS p95
				 FROM (SELECT ms, ROW_NUMBER() OVER (ORDER BY ms) - 1 AS rank, COUNT(*) OVER () AS n
				       FROM samples WHERE ok = 1 AND at > ?1)`,
				t - DAY,
			);
			const first = Math.floor(t / 300_000) * 300_000 - 287 * 300_000;
			const points = await all<{ bucket: number; ms: number }>(
				`SELECT CAST((at - ?1) / 300000 AS INTEGER) AS bucket, AVG(ms) AS ms FROM samples WHERE ok = 1 AND at >= ?1 GROUP BY bucket`,
				first,
			);
			const latency = Array.from({ length: 288 }, () => null as number | null);
			for (const r of points) latency[r.bucket] = Math.round(r.ms);
			expect(p.p95).toBeGreaterThan(p.p50);
			expect(latency.filter((v) => v !== null).length).toBeGreaterThan(150);
			const s = await status(env.DB, config, t);
			expect(s.checks[0]).toMatchObject({ p50: p.p50, p95: p.p95, latency });
			expect(await all(`SELECT SUM(n) AS n FROM histogram`)).toEqual(
				await all(`SELECT COUNT(*) AS n FROM samples WHERE ok = 1`),
			);
			expect(await all(`SELECT * FROM histogram WHERE n <= 0`)).toEqual([]);
		}
	});

	it("turns unknown and stuck when no run lands within 3 intervals plus a minute", async () => {
		const { runEnv } = mailbox();
		await tick(runEnv, makeConfig(), T0, T0, respond(200));
		for (const gap of [182_000, 4 * MINUTE]) {
			const s = await status(env.DB, makeConfig(), T0 + gap);
			expect([s.checks[0].status, s.stuck]).toEqual(["up", 0]);
		}
		const s = await status(env.DB, makeConfig(), T0 + 4 * MINUTE + 1);
		expect([s.checks[0].status, s.stuck]).toEqual(["unknown", 1]);
	});

	it("flags degraded when the median of recent samples exceeds slow_ms", async () => {
		const { runEnv } = mailbox();
		const config = makeConfig([{ ...web, slow_ms: 5 }]);
		const slow = (async () => {
			await new Promise((r) => setTimeout(r, 30));
			return new Response("", { status: 200 });
		}) as typeof fetch;
		for (let i = 0; i < 3; i++) await tick(runEnv, config, T0 + i * MINUTE, T0 + i * MINUTE, slow);
		await tick(runEnv, config, T0 + 3 * MINUTE, T0 + 3 * MINUTE, respond(200));
		expect((await status(env.DB, config, T0 + 3 * MINUTE)).checks[0].status).toBe("degraded");
		for (let i = 4; i < 6; i++) await tick(runEnv, config, T0 + i * MINUTE, T0 + i * MINUTE, respond(200));
		expect((await status(env.DB, config, T0 + 5 * MINUTE)).checks[0].status).toBe("up");
	});

	it("omits public:false checks from checks, incidents and stuck", async () => {
		const { runEnv } = mailbox();
		const hidden = { ...web, id: "hid-1", name: "Hidden", public: false, down_after: 1 };
		const config = makeConfig([web, hidden]);
		expect((await status(env.DB, config, T0)).stuck).toBe(1);
		await tick(runEnv, config, T0, T0, respond(500));
		const s = await status(env.DB, config, T0);
		expect(s.checks.map((c) => c.name)).toEqual(["Web"]);
		expect(JSON.stringify(s)).not.toContain("Hidden");
		expect(s.incidents.map((i) => i.checks[0])).toEqual([]);
		expect(s.stuck).toBe(0);
		expect(s.last_run).not.toBeNull();
	});
});

describe("health", () => {
	const lastRun = (at: number) =>
		env.DB.prepare(
			`INSERT INTO state ("check", avail, degraded, fails, passes, since, slot, last_run) VALUES ('web', 1, 0, 0, 0, 0, -1, ?1)`,
		)
			.bind(at)
			.run();
	const check = (
		config: ReturnType<typeof makeConfig>,
		at: number,
		version: { id: string; timestamp?: string } = VERSION,
	) => health(env.DB, config, at, version);

	it("is ok up to 5 minutes after the last run and stale after", async () => {
		await lastRun(T0);
		const config = makeConfig();
		expect(await check(config, T0 + 4 * MINUTE)).toBe("ok");
		expect(await check(config, T0 + 5 * MINUTE)).toBe("ok");
		expect(await check(config, T0 + 6 * MINUTE)).toBe("stale");
	});

	it("is stale with no run at all, unless the prober was just deployed", async () => {
		const config = makeConfig();
		expect(await check(config, T0)).toBe("stale");
		const fresh = { id: "v2", timestamp: new Date(T0 - MINUTE).toISOString() };
		expect(await check(config, T0, fresh)).toBe("ok");
		expect(await check(config, T0 - MINUTE + DEPLOY_GRACE_MS, fresh)).toBe("stale");
	});

	it("is dead for a dead mail row even when the last run is fresh", async () => {
		await lastRun(T0);
		await env.DB.prepare(`INSERT INTO outbox ("check", at, kind, dead) VALUES ('web', ?1, 'up', 1)`).bind(T0).run();
		expect(await check(makeConfig(), T0)).toBe("dead");
	});

	it("stays ok through stall_after, so it never reads stale while the stall alarm is quiet", async () => {
		await lastRun(T0);
		const patient = makeConfig([web], { stall_after: "15m" });
		expect(await check(patient, T0 + 15 * MINUTE)).toBe("ok");
		expect(await check(patient, T0 + 16 * MINUTE)).toBe("stale");
	});

	it("waits three of the shortest interval plus a minute for a slow fleet", async () => {
		await lastRun(T0);
		const slow = makeConfig([{ ...web, every: "5m" }]);
		expect(await check(slow, T0 + 15 * MINUTE)).toBe("ok");
		expect(await check(slow, T0 + 16 * MINUTE)).toBe("ok");
		expect(await check(slow, T0 + 17 * MINUTE)).toBe("stale");
	});
});
