import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { tick } from "../src/run.ts";
import { step } from "../src/state.ts";
import { all, MINUTE, mailbox, makeConfig, reset, respond, T0, web } from "./util.ts";

beforeEach(reset);

function counting(status = 200) {
	const calls = { n: 0 };
	const fetch = (async () => {
		calls.n++;
		return new Response("", { status });
	}) as typeof globalThis.fetch;
	return { calls, fetch };
}

describe("slot claims", () => {
	it("runs a check once for overlapping ticks", async () => {
		const { runEnv } = mailbox();
		const { calls, fetch } = counting();
		await Promise.all([tick(runEnv, makeConfig(), T0, fetch), tick(runEnv, makeConfig(), T0, fetch)]);
		expect(calls.n).toBe(1);
	});

	it("keeps one run per slot under +-2 s scheduler skew", async () => {
		const { runEnv } = mailbox();
		const { calls, fetch } = counting();
		const config = makeConfig();
		for (const t of [T0 - 2000, T0 + 1900, T0 + MINUTE - 1999, T0 + MINUTE + 1999, T0 + 2 * MINUTE]) {
			await tick(runEnv, config, t, fetch);
		}
		expect(calls.n).toBe(3);
	});

	it("honours each check's own interval", async () => {
		const { runEnv } = mailbox();
		const { calls, fetch } = counting();
		const config = makeConfig([{ ...web, every: "5m" }]);
		const start = Math.ceil(T0 / (5 * MINUTE)) * 5 * MINUTE;
		for (let i = 0; i < 10; i++) await tick(runEnv, config, start + i * MINUTE, fetch);
		expect(calls.n).toBe(2);
	});
});

describe("hysteresis", () => {
	const limits = { down_after: 3, up_after: 2 };
	const up = { avail: true, fails: 0, passes: 0, since: 0 };

	it("goes down only after down_after consecutive failures", () => {
		let s = up;
		for (const n of [1, 2]) {
			const r = step(s, false, n, limits);
			expect(r.transition).toBeNull();
			s = r.next;
		}
		expect(step(s, false, 3, limits)).toMatchObject({ transition: "down", next: { avail: false, since: 3 } });
	});

	it("resets the failure count on a success", () => {
		const a = step(up, false, 1, limits).next;
		const b = step(a, true, 2, limits).next;
		expect(step(b, false, 3, limits).next.fails).toBe(1);
	});

	it("recovers only after up_after consecutive successes", () => {
		const down = { avail: false, fails: 0, passes: 0, since: 0 };
		const a = step(down, true, 1, limits);
		expect(a.transition).toBeNull();
		expect(step(step(a.next, false, 2, limits).next, true, 3, limits).transition).toBeNull();
		expect(step(a.next, true, 2, limits)).toMatchObject({ transition: "up", next: { avail: true, since: 2 } });
	});

	it("records the transition, event and mail in one tick", async () => {
		const { runEnv, box } = mailbox();
		const config = makeConfig();
		for (const i of [0, 1]) await tick(runEnv, config, T0 + i * MINUTE, respond(500));
		expect(await all("SELECT avail FROM state")).toEqual([{ avail: 1 }]);
		expect(box.sends).toBe(0);
		await tick(runEnv, config, T0 + 2 * MINUTE, respond(500));
		expect(await all("SELECT avail, reason FROM state")).toEqual([{ avail: 0, reason: "HTTP 500" }]);
		expect(await all(`SELECT "from", "to" FROM events`)).toEqual([{ from: "up", to: "down" }]);
		expect(box.sends).toBe(1);
		expect(await all("SELECT * FROM outbox")).toEqual([]);
	});
});

describe("outbox", () => {
	const downAfterOne = makeConfig([{ ...web, down_after: 1 }]);

	it("commits state, event and outbox row together or not at all", async () => {
		const { runEnv, box } = mailbox();
		box.failing = true;
		await env.DB.prepare(`CREATE TRIGGER boom BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'boom'); END`).run();
		await expect(tick(runEnv, downAfterOne, T0, respond(500))).rejects.toThrow();
		expect(await all("SELECT avail FROM state")).toEqual([{ avail: 1 }]);
		expect(await all("SELECT * FROM samples")).toEqual([]);
		expect(await all("SELECT * FROM outbox")).toEqual([]);

		await env.DB.prepare(`DROP TRIGGER boom`).run();
		await tick(runEnv, downAfterOne, T0 + MINUTE, respond(500));
		expect(await all("SELECT avail FROM state")).toEqual([{ avail: 0 }]);
		expect(await all("SELECT kind FROM outbox")).toEqual([{ kind: "down" }]);
	});

	it("coalesces a backlog into one mail", async () => {
		const { runEnv, box } = mailbox();
		await tick(runEnv, downAfterOne, T0, respond(200));
		await env.DB.batch([
			env.DB.prepare(`INSERT INTO outbox ("check", at, kind, since, reason) VALUES ('web', 1, 'down', 0, 'HTTP 500')`),
			env.DB.prepare(`INSERT INTO outbox ("check", at, kind, since, reason) VALUES ('web', 2, 'up', 1, NULL)`),
		]);
		await tick(runEnv, downAfterOne, T0 + MINUTE, respond(200));
		expect(box.sends).toBe(1);
		expect(await all("SELECT * FROM outbox")).toEqual([]);
	});

	it("retries a failed send and marks the row dead after 10 attempts", async () => {
		const { runEnv, box } = mailbox();
		box.failing = true;
		const config = makeConfig();
		await tick(runEnv, config, T0, respond(200));
		await env.DB.prepare(
			`INSERT INTO outbox ("check", at, kind, since, reason) VALUES ('web', 1, 'down', 0, 'x')`,
		).run();
		for (let i = 1; i <= 9; i++) await tick(runEnv, config, T0 + i * MINUTE, respond(200));
		expect(await all("SELECT attempts, dead FROM outbox")).toEqual([{ attempts: 9, dead: 0 }]);
		await tick(runEnv, config, T0 + 10 * MINUTE, respond(200));
		expect(await all("SELECT attempts, dead FROM outbox")).toEqual([{ attempts: 10, dead: 1 }]);
		await tick(runEnv, config, T0 + 11 * MINUTE, respond(200));
		expect(box.sends).toBe(10);
	});
});

describe("pruning", () => {
	it("drops every row of a check removed from the config", async () => {
		const { runEnv } = mailbox();
		const gone = { ...web, id: "gone", name: "Gone", down_after: 1 };
		await tick(runEnv, makeConfig([web, gone]), T0, respond(500));
		for (const table of ["state", "samples", "daily"]) {
			expect(await all(`SELECT * FROM ${table} WHERE "check" = 'gone'`)).toHaveLength(1);
		}
		await env.DB.prepare(
			`INSERT INTO outbox ("check", at, kind, since, reason) VALUES ('gone', 1, 'down', 0, 'x')`,
		).run();
		await tick(runEnv, makeConfig([web]), T0 + MINUTE, respond(200));
		for (const table of ["state", "samples", "daily", "events", "outbox"]) {
			expect(await all(`SELECT * FROM ${table} WHERE "check" = 'gone'`)).toEqual([]);
		}
		expect(await all(`SELECT "check" FROM state`)).toEqual([{ check: "web" }]);
	});

	it("keeps samples for 24 hours and daily rows for history_days", async () => {
		const { runEnv } = mailbox();
		const config = makeConfig([web], { history_days: 2 });
		await tick(runEnv, config, T0, respond(200));
		await tick(runEnv, config, T0 + 25 * 3_600_000, respond(200));
		expect(await all("SELECT at FROM samples")).toEqual([{ at: T0 + 25 * 3_600_000 }]);
		await tick(runEnv, config, T0 + 3 * 86_400_000, respond(200));
		expect(await all("SELECT day FROM daily")).toEqual([{ day: "2026-10-09" }, { day: "2026-10-11" }]);
	});
});
