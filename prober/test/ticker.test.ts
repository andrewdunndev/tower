import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { record } from "../src/latency.ts";
import { MINUTE, reset } from "./util.ts";

const ticker = () => env.TICKER.getByName("tower");
const nextMinute = () => (Math.floor(Date.now() / MINUTE) + 1) * MINUTE;
const armed = () => runInDurableObject(ticker(), (_o, state) => state.storage.getAlarm());

const arm = () => runInDurableObject(ticker(), (_o, state) => state.storage.setAlarm(Date.now() + 10 * MINUTE));

let calls: number;

beforeEach(async () => {
	await reset();
	await runInDurableObject(ticker(), (_o, state) => state.storage.deleteAlarm());
	calls = 0;
	vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
		calls++;
		return new Response("", { status: 200 });
	});
});

afterEach(() => vi.restoreAllMocks());

describe("alarm", () => {
	it("re-arms for the next minute after a run", async () => {
		await arm();
		expect(await runDurableObjectAlarm(ticker())).toBe(true);
		expect(calls).toBeGreaterThan(0);
		expect(await armed()).toBe(nextMinute());
	});

	it("re-arms when the run throws", async () => {
		await env.DB.prepare(`CREATE TRIGGER boom BEFORE UPDATE ON state BEGIN SELECT RAISE(ABORT, 'boom'); END`).run();
		await arm();
		await expect(runDurableObjectAlarm(ticker())).rejects.toThrow();
		expect(await armed()).toBe(nextMinute());
	});

	it("probes once when the same minute alarms twice", async () => {
		if (nextMinute() - Date.now() < 3000) await new Promise((r) => setTimeout(r, 3000));
		await arm();
		await runDurableObjectAlarm(ticker());
		const first = calls;
		const slot = nextMinute();
		await runDurableObjectAlarm(ticker());
		expect(first).toBeGreaterThan(0);
		expect(nextMinute()).toBe(slot);
		expect(calls).toBe(first);
	});
});

describe("latency", () => {
	const at = Date.now();

	it("answers for public checks only", async () => {
		await runInDurableObject(ticker(), (_o, state) => {
			state.storage.sql.exec("DELETE FROM samples");
			record(
				state.storage,
				["web", "backup"].map((check) => ({ check, at, ms: 50, ok: true })),
				at,
			);
		});
		const got = await ticker().latency(at);
		expect(Object.keys(got)).toContain("web");
		expect(Object.keys(got)).not.toContain("backup");
		expect(got.web.p50).toBe(50);
	});

	it("does not fail the tick when recording throws", async () => {
		await runInDurableObject(ticker(), (_o, state) => state.storage.sql.exec("DROP TABLE samples"));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await arm();
		expect(await runDurableObjectAlarm(ticker())).toBe(true);
		expect(calls).toBeGreaterThan(0);
		expect(error).toHaveBeenCalledWith("tower: latency write failed:", expect.anything());
		expect(
			await env.DB.prepare(`SELECT COUNT(*) AS n FROM state WHERE last_conclusive IS NOT NULL`).first("n"),
		).toBeGreaterThan(0);
	});
});

describe("kick", () => {
	it("arms a missing alarm, which then runs", async () => {
		expect(await armed()).toBeNull();
		await ticker().kick();
		await vi.waitFor(() => expect(calls).toBeGreaterThan(0));
	});

	it("leaves an armed alarm alone", async () => {
		const at = Date.now() + 10 * MINUTE;
		await runInDurableObject(ticker(), (_o, state) => state.storage.setAlarm(at));
		await ticker().kick();
		expect(await armed()).toBe(at);
		expect(calls).toBe(0);
	});
});
