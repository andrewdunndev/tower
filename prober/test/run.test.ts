import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import pkg from "../../package.json";
import { drain, type RunEnv, step, tick, watch } from "../src/run.ts";
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

	it("mails each key of one check separately", async () => {
		const { runEnv, box } = mailbox();
		await tick(runEnv, downAfterOne, T0, respond(200));
		await env.DB.batch(
			["a", "b"].map((k) =>
				env.DB.prepare(
					`INSERT INTO outbox ("check", "key", at, kind, since, reason) VALUES ('web', ?1, 1, 'down', 0, 'x')`,
				).bind(k),
			),
		);
		await tick(runEnv, downAfterOne, T0 + MINUTE, respond(200));
		expect(box.sends).toBe(2);
		expect(await all("SELECT * FROM outbox")).toEqual([]);
	});

	it("drains a row inserted without a key, as v0.1.0 wrote it", async () => {
		const { runEnv, box } = mailbox();
		await tick(runEnv, downAfterOne, T0, respond(200));
		await env.DB.prepare(
			`INSERT INTO outbox ("check", at, kind, since, reason) VALUES ('web', 1, 'down', 0, 'HTTP 500')`,
		).run();
		expect(await all(`SELECT "key" FROM outbox`)).toEqual([{ key: "" }]);
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
		await drain(runEnv, makeConfig(three), { now: () => clock });
		expect(box.sends).toBe(2);
		expect(await all('SELECT "check" FROM outbox')).toEqual([{ check: "c3" }]);
		await drain(runEnv, makeConfig(three), { now: () => T0 + MINUTE });
		expect(box.sends).toBe(3);
		expect(await all("SELECT * FROM outbox")).toEqual([]);
	});

	it("skips the drain while the lease is live and takes over once it expires", async () => {
		const { runEnv, box } = mailbox();
		await seed(1);
		await env.DB.prepare(`INSERT INTO meta (key, value) VALUES ('drain', ?1)`)
			.bind(String(T0 + 30_000))
			.run();
		await drain(runEnv, makeConfig(one), { now: () => T0 });
		expect(box.sends).toBe(0);
		await drain(runEnv, makeConfig(one), { now: () => T0 + 30_000 });
		expect(box.sends).toBe(1);
	});

	it("leaves a lock taken over mid-drain to its new holder", async () => {
		const { runEnv } = mailbox();
		await seed(1);
		before(runEnv, async () => {
			await env.DB.prepare(`UPDATE meta SET value = '999' WHERE key = 'drain'`).run();
		});
		await drain(runEnv, makeConfig(one), { now: () => T0 });
		expect(await all("SELECT value FROM meta WHERE key = 'drain'")).toEqual([{ value: "999" }]);
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

describe("routing", () => {
	const team = ["a@example.com", "b@example.com"];
	const routed = { ...web, down_after: 1, up_after: 1, to: team };
	const rows = () => all(`SELECT "to", kind FROM outbox ORDER BY rowid`);

	it("writes one row per address and mails each of them DOWN and UP", async () => {
		const { runEnv, box } = mailbox();
		box.failing = true;
		const config = makeConfig([routed]);
		await tick(runEnv, config, T0, respond(500));
		expect(await rows()).toEqual(team.map((to) => ({ to, kind: "down" })));
		box.failing = false;
		box.to.length = 0;
		box.subjects.length = 0;
		await tick(runEnv, config, T0 + MINUTE, respond(500));
		await tick(runEnv, config, T0 + 2 * MINUTE, respond(200));
		expect(box.to).toEqual([...team, ...team]);
		expect(box.subjects).toEqual(["DOWN: Web", "DOWN: Web", "UP: Web", "UP: Web"]);
		expect(await rows()).toEqual([]);
	});

	it("takes one address as a string", async () => {
		const { runEnv, box } = mailbox();
		await tick(runEnv, makeConfig([{ ...routed, to: "ops@example.com" }]), T0, respond(500));
		expect(box.to).toEqual(["ops@example.com"]);
	});

	it("writes one row for an unrouted check and mails alert.to", async () => {
		const { runEnv, box } = mailbox();
		box.failing = true;
		const config = makeConfig([{ ...web, down_after: 1 }]);
		await tick(runEnv, config, T0, respond(500));
		expect(await rows()).toEqual([{ to: "", kind: "down" }]);
		box.failing = false;
		await tick(runEnv, config, T0 + MINUTE, respond(500));
		expect(box.to).toEqual(["oncall@example.com", "oncall@example.com"]);
		expect(await rows()).toEqual([]);
	});

	it("routes each check to its own addresses", async () => {
		const { runEnv, box } = mailbox();
		const other = { ...web, id: "api", name: "API", down_after: 1, to: "api@example.com" };
		await tick(
			runEnv,
			makeConfig([routed, other, { ...web, id: "www", name: "WWW", down_after: 1 }]),
			T0,
			respond(500),
		);
		expect(box.subjects.map((s, i) => `${s} -> ${box.to[i]}`).sort()).toEqual([
			"DOWN: API -> api@example.com",
			"DOWN: WWW -> oncall@example.com",
			"DOWN: Web -> a@example.com",
			"DOWN: Web -> b@example.com",
		]);
	});

	it("retries a failed address alone and does not mail the others again", async () => {
		const { runEnv, box } = mailbox();
		box.failFor.add("b@example.com");
		const config = makeConfig([routed]);
		await tick(runEnv, config, T0, respond(500));
		expect(box.to).toEqual(team);
		expect(await all(`SELECT "to", attempts, dead FROM outbox`)).toEqual([
			{ to: "b@example.com", attempts: 1, dead: 0 },
		]);
		await tick(runEnv, config, T0 + MINUTE, respond(500));
		box.failFor.clear();
		await tick(runEnv, config, T0 + 2 * MINUTE, respond(500));
		expect(box.to).toEqual([...team, "b@example.com", "b@example.com"]);
		expect(await rows()).toEqual([]);
	});

	it("keeps deploy, self-check, stuck and stall mail on alert.to", async () => {
		const { runEnv, box } = mailbox();
		await env.DB.prepare(`DELETE FROM meta WHERE key = 'version'`).run();
		const cert = { id: "cert", type: "tls", name: "Certificate", host: "www.example.com", zone: "example.com" };
		const config = makeConfig([
			{ ...routed, down_after: 3 },
			{ ...cert, every: "1m", to: team },
		]);
		for (let k = 0; k <= 3; k++) await tick(runEnv, config, T0 + k * MINUTE, respond(200));
		await watch(runEnv, config, T0 + 10 * MINUTE);
		expect(box.subjects).toEqual([
			`DEPLOYED: tower ${pkg.version}`,
			"SELF-CHECK FAILING: Cloudflare API token",
			"SELF-CHECK FAILING: results for Certificate",
			"SELF-CHECK FAILING: probing stalled",
		]);
		expect(box.to).toEqual(Array(4).fill("oncall@example.com"));
	});

	it("moves pending mail from a corrected address to the new one", async () => {
		const { runEnv, box } = mailbox();
		box.failFor.add("opz@example.com");
		await tick(runEnv, makeConfig([{ ...routed, to: ["opz@example.com"] }]), T0, respond(500));
		expect(await rows()).toEqual([{ to: "opz@example.com", kind: "down" }]);
		await tick(runEnv, makeConfig([{ ...routed, to: ["ops@example.com"] }]), T0 + MINUTE, respond(500));
		expect(box.subjects.map((s, i) => `${s} -> ${box.to[i]}`)).toEqual([
			"DOWN: Web -> opz@example.com",
			"DOWN: Web -> ops@example.com",
		]);
		expect(await rows()).toEqual([]);
	});

	it("moves pending mail from a removed address to the addresses that lack it, then to alert.to", async () => {
		const { runEnv, box } = mailbox();
		box.failing = true;
		await tick(runEnv, makeConfig([routed]), T0, respond(500));
		await tick(runEnv, makeConfig([{ ...routed, to: ["a@example.com", "c@example.com"] }]), T0 + MINUTE, respond(500));
		expect(await rows()).toEqual([
			{ to: "a@example.com", kind: "down" },
			{ to: "c@example.com", kind: "down" },
		]);
		await tick(runEnv, makeConfig([{ ...web, down_after: 1 }]), T0 + 2 * MINUTE, respond(500));
		expect(await rows()).toEqual([{ to: "", kind: "down" }]);
		box.failing = false;
		box.to.length = 0;
		await tick(runEnv, makeConfig([{ ...web, down_after: 1 }]), T0 + 3 * MINUTE, respond(500));
		expect(box.to).toEqual(["oncall@example.com"]);
	});

	it("keeps dead mail to a removed address as dead", async () => {
		const { runEnv, box } = mailbox();
		box.failFor.add("opz@example.com");
		const typo = makeConfig([{ ...routed, to: ["opz@example.com"] }]);
		for (let k = 0; k < 10; k++) await tick(runEnv, typo, T0 + k * MINUTE, respond(500));
		await tick(runEnv, makeConfig([{ ...routed, to: ["ops@example.com"] }]), T0 + 10 * MINUTE, respond(500));
		expect(box.to).not.toContain("ops@example.com");
		expect(await all(`SELECT "to", dead FROM outbox`)).toEqual([{ to: "opz@example.com", dead: 1 }]);
	});
});

describe("pruning", () => {
	it("keeps outbox rows of relays and of tower itself, and drops relay keys of a removed relay", async () => {
		const { runEnv, box } = mailbox();
		box.failing = true;
		const hash = "a".repeat(64);
		const relays = [{ id: "alerts", name: "Alerts", token_sha256: hash }];
		await tick(runEnv, makeConfig([web], { relays }), T0, respond(200));
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO outbox ("check", "key", at, kind, since, reason) VALUES ('alerts', 'k', ?1, 'firing', 0, 'x')`,
			).bind(T0 + 1),
			env.DB.prepare(
				`INSERT INTO outbox ("check", "key", at, kind, since, reason) VALUES ('', 'deployed', ?1, 'deployed', NULL, NULL)`,
			).bind(T0 + 1),
			env.DB.prepare(
				`INSERT INTO outbox ("check", "key", at, kind, since, reason) VALUES ('ghost', 'k', ?1, 'firing', 0, 'x')`,
			).bind(T0 + 1),
			env.DB.prepare(
				`INSERT INTO relay_keys (relay, "key", title, since, seen) VALUES ('alerts', 'k', 't', ?1, ?1)`,
			).bind(T0),
			env.DB.prepare(
				`INSERT INTO relay_keys (relay, "key", title, since, seen) VALUES ('ghost', 'k', 't', ?1, ?1)`,
			).bind(T0),
		]);
		await tick(runEnv, makeConfig([web], { relays }), T0 + MINUTE, respond(200));
		expect(await all(`SELECT "check" FROM outbox ORDER BY "check"`)).toEqual([{ check: "" }, { check: "alerts" }]);
		expect(await all(`SELECT relay FROM relay_keys`)).toEqual([{ relay: "alerts" }]);
	});

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
