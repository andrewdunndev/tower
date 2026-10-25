import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { REPEAT_MS } from "../../prober/src/latch.ts";
import { all, MINUTE, mailbox, respond, T0 } from "../../prober/test/util.ts";
import { outside } from "../src/index.ts";

const cfg = {
	url: "https://status.example.com/healthz",
	alert: { from: "tower@example.com", to: "oncall@example.com" },
};
const FAILING = "OUTSIDE CHECK FAILING: status.example.com";
const RECOVERED = "OUTSIDE CHECK RECOVERED: status.example.com";

const down = respond(503, "stale");
const up = respond(200, "ok");
const rows = () => all<{ since: number; mailed: number | null }>("SELECT since, mailed FROM outside");

beforeEach(async () => {
	await env.DB.prepare("DROP TABLE IF EXISTS outside").run();
});

const tick = (box: ReturnType<typeof mailbox>, t: number, get: typeof fetch) => outside(box.runEnv, cfg, t, get);

describe("outside", () => {
	it("stays silent for one failing tick, mails at the second, then not again", async () => {
		const m = mailbox();
		await tick(m, T0, down);
		expect(m.box.subjects).toEqual([]);
		expect(await rows()).toEqual([{ since: T0, mailed: null }]);
		await tick(m, T0 + MINUTE, down);
		expect(m.box.subjects).toEqual([FAILING]);
		expect(m.box.bodies[0]).toContain(
			"did not answer 200 ok: 503 stale.\r\nFailing since 2026-10-08T12:00:00.000Z, detected 2026-10-08T12:01:00.000Z.",
		);
		expect(m.box.to).toEqual([cfg.alert.to]);
		await tick(m, T0 + 2 * MINUTE, down);
		await tick(m, T0 + 3 * MINUTE, down);
		expect(m.box.subjects).toEqual([FAILING]);
		expect(await rows()).toEqual([{ since: T0, mailed: T0 + MINUTE }]);
	});

	it("repeats once REPEAT_MS has passed since the last mail, not a minute before", async () => {
		const m = mailbox();
		await tick(m, T0, down);
		await tick(m, T0 + MINUTE, down);
		await tick(m, T0 + MINUTE + REPEAT_MS - MINUTE, down);
		expect(m.box.subjects).toEqual([FAILING]);
		await tick(m, T0 + MINUTE + REPEAT_MS, down);
		expect(m.box.subjects).toEqual([FAILING, FAILING]);
		expect(await rows()).toEqual([{ since: T0, mailed: T0 + MINUTE + REPEAT_MS }]);
	});

	it("mails recovery once after a mailed failure and clears the row", async () => {
		const m = mailbox();
		await tick(m, T0, down);
		await tick(m, T0 + MINUTE, down);
		await tick(m, T0 + 2 * MINUTE, up);
		expect(m.box.subjects).toEqual([FAILING, RECOVERED]);
		expect(m.box.bodies[1]).toContain(
			"answers 200 ok again.\r\nFailing since 2026-10-08T12:00:00.000Z, recovered 2026-10-08T12:02:00.000Z.",
		);
		expect(await rows()).toEqual([]);
		await tick(m, T0 + 3 * MINUTE, up);
		expect(m.box.subjects).toEqual([FAILING, RECOVERED]);
	});

	it("mails nothing for a blip", async () => {
		const m = mailbox();
		await tick(m, T0, down);
		await tick(m, T0 + MINUTE, up);
		expect(m.box.sends).toBe(0);
		expect(await rows()).toEqual([]);
	});

	it("keeps the row when the recovery mail fails, and retries it", async () => {
		const m = mailbox();
		await tick(m, T0, down);
		await tick(m, T0 + MINUTE, down);
		m.box.failing = true;
		await tick(m, T0 + 2 * MINUTE, up);
		expect(await rows()).toHaveLength(1);
		m.box.failing = false;
		await tick(m, T0 + 3 * MINUTE, up);
		expect(m.box.subjects.at(-1)).toBe(RECOVERED);
		expect(await rows()).toEqual([]);
	});

	it("retries an onset mail that did not send", async () => {
		const m = mailbox();
		m.box.failing = true;
		await tick(m, T0, down);
		await tick(m, T0 + MINUTE, down);
		expect(await rows()).toEqual([{ since: T0, mailed: null }]);
		m.box.failing = false;
		await tick(m, T0 + 2 * MINUTE, down);
		expect(m.box.subjects.at(-1)).toBe(FAILING);
		expect(await rows()).toEqual([{ since: T0, mailed: T0 + 2 * MINUTE }]);
	});

	const timedOut: typeof fetch = async () => {
		throw new DOMException("timed out", "TimeoutError");
	};
	const refuse: typeof fetch = async () => {
		throw new TypeError("fetch failed");
	};

	it.each([
		["503 stale", down, "503 stale"],
		["a redirect", respond(302, "", { location: "https://elsewhere.example/" }), "302"],
		["a wrong body", respond(200, "nope"), "200 nope"],
		["a long body, clipped", respond(503, "x".repeat(30)), `503 ${"x".repeat(20)}`],
		["a timeout", timedOut, "no answer within 10 s"],
		["a network error", refuse, "network error"],
	])("fails on %s with the reason", async (_, get, reason) => {
		const m = mailbox();
		await tick(m, T0, get);
		await tick(m, T0 + MINUTE, get);
		expect(m.box.bodies[0]).toContain(`did not answer 200 ok: ${reason}.\r\n`);
	});

	it("asks for the healthz URL without following redirects, under a timeout", async () => {
		const m = mailbox();
		const seen: [unknown, RequestInit | undefined][] = [];
		await tick(m, T0, (async (url, init) => {
			seen.push([url, init]);
			return new Response("ok");
		}) as typeof fetch);
		expect(seen[0][0]).toBe(cfg.url);
		expect(seen[0][1]?.redirect).toBe("manual");
		expect(seen[0][1]?.signal).toBeInstanceOf(AbortSignal);
	});
});
