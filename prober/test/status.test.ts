import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { tick } from "../src/run.ts";
import { status } from "../src/status.ts";
import { all, MINUTE, mailbox, makeConfig, reset, respond, T0, web } from "./util.ts";

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
		const s = await status(env.DB, config, T0 + 2 * MINUTE);
		expect(s.checks[0]).toMatchObject({ status: "up" });
		expect(s.checks[0].uptime90).toBeCloseTo(2 / 3);
		expect(s.checks[0].days.at(-1)).toBeCloseTo(2 / 3);
		expect(s.checks[0].p50).not.toBeNull();
		expect(s.checks[0].latency.at(-1)).not.toBeNull();
		expect(s.incidents).toEqual([
			{
				kind: "auto",
				title: "Web is not responding",
				checks: ["Web"],
				severity: "down",
				started: new Date(T0 + MINUTE).toISOString(),
				resolved: new Date(T0 + 2 * MINUTE).toISOString(),
				bodyHtml: null,
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
		expect((await status(env.DB, config, T0 + 2 * MINUTE)).checks[0].status).toBe("degraded");
		for (let i = 3; i < 9; i++) await tick(runEnv, config, T0 + i * MINUTE, respond(200));
		expect((await status(env.DB, config, T0 + 8 * MINUTE)).checks[0].status).toBe("up");
	});

	it("omits public:false checks from checks and incidents but still counts them", async () => {
		const { runEnv } = mailbox();
		const hidden = { ...web, id: "hid-1", name: "Hidden", public: false, down_after: 1 };
		const config = makeConfig([web, hidden]);
		await tick(runEnv, config, T0, respond(500));
		const s = await status(env.DB, config, T0);
		expect(s.checks.map((c) => c.name)).toEqual(["Web"]);
		expect(JSON.stringify(s)).not.toContain("Hidden");
		expect(s.incidents.map((i) => i.checks[0])).toEqual([]);
		expect(s.last_run).not.toBeNull();
	});

	it("never carries urls, hosts, ips, ids or reasons", async () => {
		const { runEnv } = mailbox();
		const secret = {
			id: "id-zq7",
			type: "http",
			name: "Public name",
			url: "https://internal-zq7.example.net:8443/health",
			down_after: 1,
		};
		const leaky = (async () => {
			throw new Error("connect ECONNREFUSED 203.0.113.77:8443 internal-zq7.example.net");
		}) as typeof fetch;
		const config = makeConfig([secret]);
		await tick(runEnv, config, T0, leaky);
		const [row] = await all<{ reason: string }>("SELECT reason FROM state");
		expect(row.reason).toContain("203.0.113.77");
		const s = JSON.stringify(await status(env.DB, config, T0));
		expect(s).toContain("Public name");
		for (const needle of ["zq7", "203.0.113", "8443", "ECONNREFUSED", "example.net", "https://"]) {
			expect(s).not.toContain(needle);
		}
	});
});
