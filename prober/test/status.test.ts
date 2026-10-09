import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { tick } from "../src/run.ts";
import { status } from "../src/status.ts";
import { MINUTE, mailbox, makeConfig, reset, respond, T0, web } from "./util.ts";

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

	it("reports uptime, latency and an incident from recorded runs", async () => {
		const { runEnv } = mailbox();
		const config = makeConfig([{ ...web, down_after: 1, up_after: 1 }]);
		await tick(runEnv, config, T0, respond(200));
		await tick(runEnv, config, T0 + MINUTE, respond(500));
		await tick(runEnv, config, T0 + 2 * MINUTE, respond(200));
		await env.DB.batch(
			[100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((ms) =>
				env.DB.prepare(`INSERT INTO samples ("check", at, ms, ok) VALUES ('web', ?1, ?2, 1)`).bind(T0 + ms, ms),
			),
		);
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

	it("turns unknown when no run lands within 3 intervals", async () => {
		const { runEnv } = mailbox();
		await tick(runEnv, makeConfig(), T0, respond(200));
		expect((await status(env.DB, makeConfig(), T0 + 3 * MINUTE)).checks[0].status).toBe("up");
		expect((await status(env.DB, makeConfig(), T0 + 3 * MINUTE + 1)).checks[0].status).toBe("unknown");
	});

	it("flags degraded when the median of recent samples exceeds slow_ms", async () => {
		const { runEnv } = mailbox();
		const config = makeConfig([{ ...web, slow_ms: 5 }]);
		const slow = (async () => {
			await new Promise((r) => setTimeout(r, 30));
			return new Response("", { status: 200 });
		}) as typeof fetch;
		for (let i = 0; i < 3; i++) await tick(runEnv, config, T0 + i * MINUTE, slow);
		await tick(runEnv, config, T0 + 3 * MINUTE, respond(200));
		expect((await status(env.DB, config, T0 + 3 * MINUTE)).checks[0].status).toBe("degraded");
		for (let i = 4; i < 6; i++) await tick(runEnv, config, T0 + i * MINUTE, respond(200));
		expect((await status(env.DB, config, T0 + 5 * MINUTE)).checks[0].status).toBe("up");
	});

	it("omits public:false checks from checks, incidents and stuck", async () => {
		const { runEnv } = mailbox();
		const hidden = { ...web, id: "hid-1", name: "Hidden", public: false, down_after: 1 };
		const config = makeConfig([web, hidden]);
		expect((await status(env.DB, config, T0)).stuck).toBe(1);
		await tick(runEnv, config, T0, respond(500));
		const s = await status(env.DB, config, T0);
		expect(s.checks.map((c) => c.name)).toEqual(["Web"]);
		expect(JSON.stringify(s)).not.toContain("Hidden");
		expect(s.incidents.map((i) => i.checks[0])).toEqual([]);
		expect(s.stuck).toBe(0);
		expect(s.last_run).not.toBeNull();
	});
});
