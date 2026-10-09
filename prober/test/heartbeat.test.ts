import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { recordBeat } from "../src/heartbeat.ts";
import { tick } from "../src/run.ts";
import { all, MINUTE, mailbox, makeConfig, reset, respond, T0, web } from "./util.ts";

beforeEach(reset);

const TOKEN = "correct-horse-battery-staple";
const SAME_LENGTH = "wrongg-horse-battery-staple";

async function sha256(text: string) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const backup = {
	id: "backup",
	type: "heartbeat",
	name: "Backup",
	every: "1h",
	grace: "10m",
	token_sha256: await sha256(TOKEN),
};
const config = makeConfig([backup]);
const DEADLINE = 70 * MINUTE;

const beat = (token: string, ok: boolean, at: number, id = "backup", c = config) =>
	recordBeat(env.DB, c.checks, id, token, ok, at);
const state = () => all("SELECT avail FROM state");
const beats = () => all("SELECT at, ok FROM beats");

describe("heartbeat deadlines", () => {
	it("stays up until every + grace has passed, then goes down and mails at once", async () => {
		const { runEnv, box } = mailbox();
		await tick(runEnv, config, T0);
		await tick(runEnv, config, T0 + DEADLINE);
		expect(await state()).toEqual([{ avail: 1 }]);
		await tick(runEnv, config, T0 + DEADLINE + MINUTE);
		expect(await state()).toEqual([{ avail: 0 }]);
		expect(await all("SELECT reason FROM state")).toEqual([{ reason: "heartbeat missed its deadline" }]);
		expect(box.sends).toBe(1);
	});

	it("measures the deadline from the last ok beat", async () => {
		const { runEnv } = mailbox();
		await tick(runEnv, config, T0);
		await beat(TOKEN, true, T0 + 60 * MINUTE);
		await tick(runEnv, config, T0 + DEADLINE + 5 * MINUTE);
		expect(await state()).toEqual([{ avail: 1 }]);
		await tick(runEnv, config, T0 + 60 * MINUTE + DEADLINE + MINUTE);
		expect(await state()).toEqual([{ avail: 0 }]);
	});

	it("goes down on a fail beat at once and up on an ok beat, bypassing hysteresis", async () => {
		const { runEnv, box } = mailbox();
		await tick(runEnv, config, T0);
		await beat(TOKEN, false, T0 + 5 * MINUTE);
		await tick(runEnv, config, T0 + 6 * MINUTE);
		expect(await all("SELECT avail, reason FROM state")).toEqual([{ avail: 0, reason: "heartbeat reported failure" }]);
		await beat(TOKEN, true, T0 + 7 * MINUTE);
		await tick(runEnv, config, T0 + 8 * MINUTE);
		expect(await state()).toEqual([{ avail: 1 }]);
		expect(box.sends).toBe(2);
		expect(await all("SELECT * FROM samples")).toEqual([]);
	});

	it("keeps a beat that lands mid-run", async () => {
		const { runEnv } = mailbox();
		const both = makeConfig([backup, { ...web, id: "slow", name: "Slow" }]);
		await tick(runEnv, both, T0, respond(200));
		const landing = (async () => {
			await beat(TOKEN, true, T0 + DEADLINE + 2 * MINUTE + 1, "backup", both);
			return new Response("", { status: 200 });
		}) as typeof fetch;
		await tick(runEnv, both, T0 + DEADLINE + 2 * MINUTE, landing);
		expect(await state()).toEqual([{ avail: 0 }, { avail: 1 }]);
		expect(await beats()).toEqual([{ at: T0 + DEADLINE + 2 * MINUTE + 1, ok: 1 }]);
		await tick(runEnv, both, T0 + DEADLINE + 3 * MINUTE, respond(200));
		expect(await state()).toEqual([{ avail: 1 }, { avail: 1 }]);
	});
});

describe("beat()", () => {
	it("records a beat for the right token", async () => {
		const res = await beat(TOKEN, true, T0);
		expect(res.status).toBe(204);
		expect(await beats()).toEqual([{ at: T0, ok: 1 }]);
		await beat(TOKEN, false, T0 + 1);
		expect(await beats()).toEqual([{ at: T0 + 1, ok: 0 }]);
	});

	it("answers every failure with the same 404 and writes nothing", async () => {
		const both = makeConfig([backup, web]);
		const attempts = [
			beat(SAME_LENGTH, true, T0),
			beat("x", true, T0),
			beat("", true, T0),
			beat(TOKEN, true, T0, "unknown"),
			beat(TOKEN, true, T0, "web", both),
			beat(await sha256(TOKEN), true, T0),
		];
		for (const res of await Promise.all(attempts)) {
			expect(res.status).toBe(404);
			expect(await res.text()).toBe("");
		}
		expect(await beats()).toEqual([]);
	});

	it("does not accept an empty token even if the configured hash is of the empty string", async () => {
		const empty = makeConfig([{ ...backup, token_sha256: await sha256("") }]);
		expect((await beat("", true, T0, "backup", empty)).status).toBe(404);
	});
});
