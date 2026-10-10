import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { drain, type RunEnv, step, tick } from "../src/run.ts";
import { status } from "../src/status.ts";
import { all, MINUTE, mailbox, makeConfig, reset, respond, T0, web } from "./util.ts";

beforeEach(reset);

function counting(status = 200) {
	const calls = { n: 0 };
	const fetch = async () => {
		calls.n++;
		return new Response("", { status });
	};
	return { calls, fetch };
}

const ids = ["c1", "c2", "c3"].map((id) => ({ ...web, id, name: id }));
const [one, two, three] = [ids.slice(0, 1), ids.slice(0, 2), ids];

function before(runEnv: RunEnv, hook: () => unknown) {
	const send = runEnv.EMAIL.send;
	runEnv.EMAIL.send = (async (m: Parameters<typeof send>[0]) => {
		await hook();
		return send(m);
	}) as typeof send;
}

async function seed(n: number) {
	await env.DB.batch(
		ids
			.slice(0, n)
			.map((c) =>
				env.DB.prepare(`INSERT INTO outbox ("check", at, kind, since, reason) VALUES (?1, 1, 'down', 0, 'x')`).bind(
					c.id,
				),
			),
	);
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

	it("runs at the next boundary after every is lengthened", async () => {
		const { runEnv } = mailbox();
		const { calls, fetch } = counting();
		await tick(runEnv, makeConfig(), T0, fetch);
		await tick(runEnv, makeConfig(), T0 + MINUTE, fetch);
		const longer = makeConfig([{ ...web, every: "5m" }]);
		for (const m of [2, 3, 4]) await tick(runEnv, longer, T0 + m * MINUTE, fetch);
		expect(calls.n).toBe(2);
		await tick(runEnv, longer, T0 + 5 * MINUTE, fetch);
		expect(calls.n).toBe(3);
	});

	it("keeps a superseded run from overwriting newer state", async () => {
		const { runEnv } = mailbox();
		const config = makeConfig([{ ...web, down_after: 1 }]);
		let release = () => {};
		let started = () => {};
		const hasStarted = new Promise<void>((r) => {
			started = r;
		});
		const slow = (async () => {
			started();
			await new Promise<void>((r) => {
				release = r;
			});
			return new Response("", { status: 200 });
		}) as typeof fetch;
		const late = tick(runEnv, config, T0, slow);
		await hasStarted;
		await tick(runEnv, config, T0 + MINUTE, respond(500));
		release();
		await late;
		expect(await all("SELECT avail FROM state")).toEqual([{ avail: 0 }]);
	});

	it("writes no sample, event or outbox row from a superseded run", async () => {
		const { runEnv, box } = mailbox();
		const config = makeConfig([{ ...web, down_after: 1 }]);
		let release = () => {};
		let started = () => {};
		const hasStarted = new Promise<void>((r) => {
			started = r;
		});
		const slowFailure = (async () => {
			started();
			await new Promise<void>((r) => {
				release = r;
			});
			return new Response("", { status: 500 });
		}) as typeof fetch;
		const late = tick(runEnv, config, T0, slowFailure);
		await hasStarted;
		await tick(runEnv, config, T0 + MINUTE, respond(200));
		release();
		await late;
		expect(box.sends).toBe(0);
		const rows = () =>
			all<{ n: number }>(
				"SELECT (SELECT COUNT(*) FROM samples) + (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM outbox) + (SELECT COUNT(*) FROM daily WHERE runs > 1) AS n",
			);
		expect(await rows()).toEqual([{ n: 1 }]);

		await tick(runEnv, config, T0 + 2 * MINUTE, respond(500));
		expect(await all('SELECT "to" FROM events')).toEqual([{ to: "down" }]);
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

	it("sends once when two ticks drain at the same time", async () => {
		const { runEnv, box } = mailbox();
		await env.DB.prepare(
			`INSERT INTO outbox ("check", at, kind, since, reason) VALUES ('web', 1, 'down', 0, 'HTTP 500')`,
		).run();
		await Promise.all([tick(runEnv, makeConfig(), T0, respond(200)), tick(runEnv, makeConfig(), T0, respond(200))]);
		expect(box.sends).toBe(1);
	});

	it("sends each pending mail once when two drains overlap and the send is slow", async () => {
		const { runEnv, box } = mailbox();
		before(runEnv, () => new Promise((r) => setTimeout(r, 50)));
		await seed(2);
		await Promise.all([drain(runEnv, makeConfig(two)), drain(runEnv, makeConfig(two))]);
		expect(box.sends).toBe(2);
		expect(await all("SELECT * FROM outbox")).toEqual([]);
		expect(await all("SELECT value FROM meta WHERE key = 'drain'")).toEqual([{ value: "0" }]);
	});

	it("stops starting sends before the lease ends and the next tick sends the rest", async () => {
		const { runEnv, box } = mailbox();
		await seed(3);
		let clock = T0;
		before(runEnv, () => {
			clock += 25_000;
		});
		await drain(runEnv, makeConfig(three), () => clock);
		expect(box.sends).toBe(2);
		expect(await all('SELECT "check" FROM outbox')).toEqual([{ check: "c3" }]);
		await drain(runEnv, makeConfig(three), () => T0 + MINUTE);
		expect(box.sends).toBe(3);
		expect(await all("SELECT * FROM outbox")).toEqual([]);
	});

	it("skips the drain while the lease is live and takes over once it expires", async () => {
		const { runEnv, box } = mailbox();
		await seed(1);
		await env.DB.prepare(`INSERT INTO meta (key, value) VALUES ('drain', ?1)`)
			.bind(String(T0 + 30_000))
			.run();
		await drain(runEnv, makeConfig(one), () => T0);
		expect(box.sends).toBe(0);
		await drain(runEnv, makeConfig(one), () => T0 + 30_000);
		expect(box.sends).toBe(1);
	});

	it("retries a failed send and marks the row dead after 10 attempts", async () => {
		const { runEnv, box } = mailbox();
		box.failing = true;
		const config = makeConfig();
		await tick(runEnv, config, T0, respond(200));
		await env.DB.prepare(
			`INSERT INTO outbox ("check", at, kind, since, reason) VALUES ('web', ${T0}, 'down', 0, 'x')`,
		).run();
		for (let i = 1; i <= 9; i++) await tick(runEnv, config, T0 + i * MINUTE, respond(200));
		expect(await all("SELECT attempts, dead FROM outbox")).toEqual([{ attempts: 9, dead: 0 }]);
		const alive = await status(env.DB, config, T0 + 9 * MINUTE);
		expect(alive).toMatchObject({ outbox_oldest_unsent_at: new Date(T0).toISOString(), dead_outbox: 0 });
		await tick(runEnv, config, T0 + 10 * MINUTE, respond(200));
		expect(await all("SELECT attempts, dead FROM outbox")).toEqual([{ attempts: 10, dead: 1 }]);
		const dead = await status(env.DB, config, T0 + 10 * MINUTE);
		expect(dead).toMatchObject({ outbox_oldest_unsent_at: null, dead_outbox: 1 });
		await tick(runEnv, config, T0 + 11 * MINUTE, respond(200));
		expect(box.sends).toBe(10);
		expect(await status(env.DB, config, T0 + 11 * MINUTE)).toMatchObject({ dead_outbox: 1 });
		await tick(runEnv, config, T0 + 24 * 60 * MINUTE + MINUTE, respond(200));
		expect(await status(env.DB, config, T0 + 24 * 60 * MINUTE + MINUTE)).toMatchObject({ dead_outbox: 0 });
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

	it("keeps samples for 24 hours and daily rows and events for 90 days", async () => {
		const { runEnv } = mailbox();
		const config = makeConfig([web]);
		await tick(runEnv, config, T0, respond(200));
		await env.DB.prepare(`INSERT INTO events ("check", at, "from", "to") VALUES ('web', ?1, 'up', 'down')`)
			.bind(T0)
			.run();
		await tick(runEnv, config, T0 + 25 * 3_600_000, respond(200));
		expect(await all("SELECT at FROM samples")).toEqual([{ at: T0 + 25 * 3_600_000 }]);
		await tick(runEnv, config, T0 + 91 * 86_400_000, respond(200));
		expect(await all("SELECT day FROM daily")).toEqual([{ day: "2026-10-09" }, { day: "2027-01-07" }]);
		expect(await all("SELECT * FROM events")).toEqual([]);
	});
});
