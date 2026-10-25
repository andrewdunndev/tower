import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const seeded = [
	["", "down"],
	["", "up"],
	["stuck", "self-failing"],
] as const;

async function seed(n: number) {
	await env.DB.batch(
		ids
			.slice(0, n)
			.map((c, i) =>
				env.DB.prepare(
					`INSERT INTO outbox ("check", "key", at, kind, since, reason) VALUES (?1, ?2, 1, ?3, 0, 'x')`,
				).bind(c.id, seeded[i][0], seeded[i][1]),
			),
	);
}

describe("slot claims", () => {
	it("runs a check once for overlapping ticks", async () => {
		const { runEnv } = mailbox();
		const { calls, fetch } = counting();
		await Promise.all([tick(runEnv, makeConfig(), T0, T0, fetch), tick(runEnv, makeConfig(), T0, T0, fetch)]);
		expect(calls.n).toBe(1);
	});

	it("keeps one run per slot under +-2 s scheduler skew", async () => {
		const { runEnv } = mailbox();
		const { calls, fetch } = counting();
		const config = makeConfig();
		for (const t of [T0 - 2000, T0 + 1900, T0 + MINUTE - 1999, T0 + MINUTE + 1999, T0 + 2 * MINUTE]) {
			await tick(runEnv, config, t, t, fetch);
		}
		expect(calls.n).toBe(3);
	});

	it("runs at the next boundary after every is lengthened", async () => {
		const { runEnv } = mailbox();
		const { calls, fetch } = counting();
		await tick(runEnv, makeConfig(), T0, T0, fetch);
		await tick(runEnv, makeConfig(), T0 + MINUTE, T0 + MINUTE, fetch);
		const longer = makeConfig([{ ...web, every: "5m" }]);
		for (const m of [2, 3, 4]) await tick(runEnv, longer, T0 + m * MINUTE, T0 + m * MINUTE, fetch);
		expect(calls.n).toBe(2);
		await tick(runEnv, longer, T0 + 5 * MINUTE, T0 + 5 * MINUTE, fetch);
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
		const late = tick(runEnv, config, T0, T0, slow);
		await hasStarted;
		await tick(runEnv, config, T0 + MINUTE, T0 + MINUTE, respond(500));
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
		const late = tick(runEnv, config, T0, T0, slowFailure);
		await hasStarted;
		await tick(runEnv, config, T0 + MINUTE, T0 + MINUTE, respond(200));
		release();
		await late;
		expect(box.sends).toBe(0);
		const rows = () =>
			all<{ n: number }>(
				"SELECT (SELECT COUNT(*) FROM samples) + (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM outbox) + (SELECT COUNT(*) FROM daily WHERE runs > 1) AS n",
			);
		expect(await rows()).toEqual([{ n: 1 }]);

		await tick(runEnv, config, T0 + 2 * MINUTE, T0 + 2 * MINUTE, respond(500));
		expect(await all('SELECT "to" FROM events')).toEqual([{ to: "down" }]);
	});

	it("honours each check's own interval", async () => {
		const { runEnv } = mailbox();
		const { calls, fetch } = counting();
		const config = makeConfig([{ ...web, every: "5m" }]);
		const start = Math.ceil(T0 / (5 * MINUTE)) * 5 * MINUTE;
		for (let i = 0; i < 10; i++) await tick(runEnv, config, start + i * MINUTE, start + i * MINUTE, fetch);
		expect(calls.n).toBe(2);
	});
});

describe("run deadline", () => {
	const LEFT = 250;
	const wall = Date.now;
	afterEach(() => {
		vi.restoreAllMocks();
	});
	// tick reads the clock first; every later read lands LEFT ms before an on-time run's deadline.
	const tight = (t: number) => {
		let reads = 0;
		vi.spyOn(Date, "now").mockImplementation(() => wall() + (reads++ ? MINUTE - 7000 - LEFT : 0));
		return t;
	};
	const slow = { ...web, id: "slow", name: "Slow", url: "https://slow.example.com/", down_after: 1 };
	const config = makeConfig([{ ...web, down_after: 1 }, slow]);
	const serve = (status: number, hang: boolean) =>
		(async (input: RequestInfo | URL) =>
			hang && String(input).includes("slow")
				? new Promise<Response>(() => {})
				: new Response("", { status })) as typeof fetch;
	const dump = async () => ({
		state: await all('SELECT * FROM state ORDER BY "check"'),
		samples: await all('SELECT "check", at, ok FROM samples ORDER BY "check"'),
		daily: await all('SELECT * FROM daily ORDER BY "check"'),
		events: await all('SELECT * FROM events ORDER BY "check"'),
		outbox: await all("SELECT * FROM outbox"),
	});

	it("commits the probes that finished and counts a probe still running as no result", async () => {
		const { runEnv, box } = mailbox();
		await tick(runEnv, config, T0, tight(T0), serve(500, true));
		expect(await all('SELECT "check", avail, last_conclusive, last_run, reason FROM state ORDER BY "check"')).toEqual([
			{ check: "slow", avail: 1, last_conclusive: null, last_run: T0, reason: "probe outlived the run" },
			{ check: "web", avail: 0, last_conclusive: T0, last_run: T0, reason: "HTTP 500" },
		]);
		expect(await all('SELECT "check", at FROM samples')).toEqual([{ check: "web", at: T0 }]);
		expect(await all('SELECT "check", "to" FROM events')).toEqual([{ check: "web", to: "down" }]);
		expect(await all('SELECT "check" FROM daily')).toEqual([{ check: "web" }]);
		expect(box.subjects).toEqual(["DOWN: Web"]);
	});

	it("writes the same rows as before when every probe finishes in time", async () => {
		const run = async (squeezed: boolean) => {
			await reset();
			const { runEnv, box } = mailbox();
			await tick(runEnv, config, T0, squeezed ? tight(T0) : T0, serve(500, false));
			vi.restoreAllMocks();
			return { ...(await dump()), subjects: box.subjects };
		};
		const unbounded = await run(false);
		expect(await run(true)).toEqual(unbounded);
		expect(unbounded.events).toHaveLength(2);
	});

	it("flags only the check whose probe keeps outliving the run", async () => {
		const { runEnv, box } = mailbox();
		const hung = (t: number) => tick(runEnv, config, t, tight(t), serve(200, true));
		for (let k = 0; k <= 3; k++) await hung(T0 + k * MINUTE);
		expect(box.subjects).toEqual([]);
		await hung(T0 + 4 * MINUTE);
		expect(box.subjects).toEqual(["SELF-CHECK FAILING: results for Slow"]);
		expect(await all("SELECT avail, last_conclusive FROM state WHERE \"check\" = 'web'")).toEqual([
			{ avail: 1, last_conclusive: T0 + 4 * MINUTE },
		]);
	});

	it("starts no queued probe once the deadline has passed", async () => {
		const { runEnv } = mailbox();
		const late = Array.from({ length: 6 }, (_, i) => ({ ...slow, id: `s${i}`, name: `S${i}` }));
		const queued = { ...web, id: "queued", name: "Queued", url: "https://queued.example.com/" };
		let release = () => {};
		const gate = new Promise<void>((r) => (release = r));
		const calls = { queued: 0 };
		const fetch = (async (input: RequestInfo | URL) => {
			if (String(input).includes("queued")) calls.queued++;
			else await gate;
			return new Response("", { status: 200 });
		}) as typeof globalThis.fetch;
		await tick(runEnv, makeConfig([...late, queued]), T0, tight(T0), fetch);
		release();
		await new Promise((r) => setTimeout(r, 50));
		expect(calls.queued).toBe(0);
		expect(await all("SELECT reason FROM state WHERE \"check\" = 'queued'")).toEqual([
			{ reason: "probe outlived the run" },
		]);
	});

	it("gives a run that starts past its nominal deadline a minimum budget", async () => {
		const { runEnv } = mailbox();
		await tick(runEnv, makeConfig([{ ...web, down_after: 1 }]), T0, T0 + 55_000, respond(500));
		expect(await all("SELECT avail, last_conclusive, reason FROM state")).toEqual([
			{ avail: 0, last_conclusive: T0, reason: "HTTP 500" },
		]);
	});

	it("cuts a longer-interval probe at the shortest interval's deadline", async () => {
		const { runEnv } = mailbox();
		const fetch = (async (input: RequestInfo | URL) => {
			if (String(input).includes("slow")) await new Promise((r) => setTimeout(r, 1000));
			return new Response("", { status: 500 });
		}) as typeof globalThis.fetch;
		await tick(
			runEnv,
			makeConfig([
				{ ...web, down_after: 1 },
				{ ...slow, every: "5m" },
			]),
			T0,
			tight(T0),
			fetch,
		);
		expect(await all('SELECT "check", avail, reason FROM state ORDER BY "check"')).toEqual([
			{ check: "slow", avail: 1, reason: "probe outlived the run" },
			{ check: "web", avail: 0, reason: "HTTP 500" },
		]);
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
		for (const i of [0, 1]) await tick(runEnv, config, T0 + i * MINUTE, T0 + i * MINUTE, respond(500));
		expect(await all("SELECT avail FROM state")).toEqual([{ avail: 1 }]);
		expect(box.sends).toBe(0);
		await tick(runEnv, config, T0 + 2 * MINUTE, T0 + 2 * MINUTE, respond(500));
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
		await expect(tick(runEnv, downAfterOne, T0, T0, respond(500))).rejects.toThrow();
		expect(await all("SELECT avail FROM state")).toEqual([{ avail: 1 }]);
		expect(await all("SELECT * FROM samples")).toEqual([]);
		expect(await all("SELECT * FROM outbox")).toEqual([]);

		await env.DB.prepare(`DROP TRIGGER boom`).run();
		await tick(runEnv, downAfterOne, T0 + MINUTE, T0 + MINUTE, respond(500));
		expect(await all("SELECT avail FROM state")).toEqual([{ avail: 0 }]);
		expect(await all("SELECT kind FROM outbox")).toEqual([{ kind: "down" }]);
	});

	it("coalesces a backlog into one mail", async () => {
		const { runEnv, box } = mailbox();
		await tick(runEnv, downAfterOne, T0, T0, respond(200));
		await env.DB.batch([
			env.DB.prepare(`INSERT INTO outbox ("check", at, kind, since, reason) VALUES ('web', 1, 'down', 0, 'HTTP 500')`),
			env.DB.prepare(`INSERT INTO outbox ("check", at, kind, since, reason) VALUES ('web', 2, 'up', 1, NULL)`),
		]);
		await tick(runEnv, downAfterOne, T0 + MINUTE, T0 + MINUTE, respond(200));
		expect(box.sends).toBe(1);
		expect(await all("SELECT * FROM outbox")).toEqual([]);
	});

	it("mails a check's transition and its stuck flag separately", async () => {
		const { runEnv, box } = mailbox();
		await tick(runEnv, downAfterOne, T0, T0, respond(200));
		await env.DB.batch(
			[
				`INSERT INTO outbox ("check", "key", at, kind, since, reason) VALUES ('web', '', 1, 'down', 0, 'x')`,
				`INSERT INTO outbox ("check", "key", at, kind, since, reason) VALUES ('web', 'stuck', 1, 'self-failing', 0, 'x')`,
			].map((q) => env.DB.prepare(q)),
		);
		await tick(runEnv, downAfterOne, T0 + MINUTE, T0 + MINUTE, respond(200));
		expect(box.sends).toBe(2);
		expect(await all("SELECT * FROM outbox")).toEqual([]);
	});

	it("drains a row inserted without a key, as v0.1.0 wrote it", async () => {
		const { runEnv, box } = mailbox();
		await tick(runEnv, downAfterOne, T0, T0, respond(200));
		await env.DB.prepare(
			`INSERT INTO outbox ("check", at, kind, since, reason) VALUES ('web', 1, 'down', 0, 'HTTP 500')`,
		).run();
		expect(await all(`SELECT "key" FROM outbox`)).toEqual([{ key: "" }]);
		await tick(runEnv, downAfterOne, T0 + MINUTE, T0 + MINUTE, respond(200));
		expect(box.sends).toBe(1);
		expect(await all("SELECT * FROM outbox")).toEqual([]);
	});

	it("sends once when two ticks drain at the same time", async () => {
		const { runEnv, box } = mailbox();
		await env.DB.prepare(
			`INSERT INTO outbox ("check", at, kind, since, reason) VALUES ('web', 1, 'down', 0, 'HTTP 500')`,
		).run();
		await Promise.all([
			tick(runEnv, makeConfig(), T0, T0, respond(200)),
			tick(runEnv, makeConfig(), T0, T0, respond(200)),
		]);
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
		await tick(runEnv, config, T0, T0, respond(200));
		await env.DB.prepare(
			`INSERT INTO outbox ("check", at, kind, since, reason) VALUES ('web', ${T0}, 'down', 0, 'x')`,
		).run();
		for (let i = 1; i <= 9; i++) await tick(runEnv, config, T0 + i * MINUTE, T0 + i * MINUTE, respond(200));
		expect(await all("SELECT attempts, dead FROM outbox")).toEqual([{ attempts: 9, dead: 0 }]);
		const alive = await status(env.DB, config, T0 + 9 * MINUTE);
		expect(alive).toMatchObject({ outbox_oldest_unsent_at: new Date(T0).toISOString(), dead_outbox: 0 });
		await tick(runEnv, config, T0 + 10 * MINUTE, T0 + 10 * MINUTE, respond(200));
		expect(await all("SELECT attempts, dead FROM outbox")).toEqual([{ attempts: 10, dead: 1 }]);
		const dead = await status(env.DB, config, T0 + 10 * MINUTE);
		expect(dead).toMatchObject({ outbox_oldest_unsent_at: null, dead_outbox: 1 });
		await tick(runEnv, config, T0 + 11 * MINUTE, T0 + 11 * MINUTE, respond(200));
		expect(box.sends).toBe(10);
		expect(await status(env.DB, config, T0 + 11 * MINUTE)).toMatchObject({ dead_outbox: 1 });
		await tick(runEnv, config, T0 + 24 * 60 * MINUTE + MINUTE, T0 + 24 * 60 * MINUTE + MINUTE, respond(200));
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
		await tick(runEnv, config, T0, T0, respond(500));
		expect(await rows()).toEqual(team.map((to) => ({ to, kind: "down" })));
		box.failing = false;
		box.to.length = 0;
		box.subjects.length = 0;
		await tick(runEnv, config, T0 + MINUTE, T0 + MINUTE, respond(500));
		await tick(runEnv, config, T0 + 2 * MINUTE, T0 + 2 * MINUTE, respond(200));
		expect(box.to).toEqual([...team, ...team]);
		expect(box.subjects).toEqual(["DOWN: Web", "DOWN: Web", "UP: Web", "UP: Web"]);
		expect(await rows()).toEqual([]);
	});

	it("takes one address as a string", async () => {
		const { runEnv, box } = mailbox();
		await tick(runEnv, makeConfig([{ ...routed, to: "ops@example.com" }]), T0, T0, respond(500));
		expect(box.to).toEqual(["ops@example.com"]);
	});

	it("writes one row for an unrouted check and mails alert.to", async () => {
		const { runEnv, box } = mailbox();
		box.failing = true;
		const config = makeConfig([{ ...web, down_after: 1 }]);
		await tick(runEnv, config, T0, T0, respond(500));
		expect(await rows()).toEqual([{ to: "", kind: "down" }]);
		box.failing = false;
		await tick(runEnv, config, T0 + MINUTE, T0 + MINUTE, respond(500));
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
		await tick(runEnv, config, T0, T0, respond(500));
		expect(box.to).toEqual(team);
		expect(await all(`SELECT "to", attempts, dead FROM outbox`)).toEqual([
			{ to: "b@example.com", attempts: 1, dead: 0 },
		]);
		await tick(runEnv, config, T0 + MINUTE, T0 + MINUTE, respond(500));
		box.failFor.clear();
		await tick(runEnv, config, T0 + 2 * MINUTE, T0 + 2 * MINUTE, respond(500));
		expect(box.to).toEqual([...team, "b@example.com", "b@example.com"]);
		expect(await rows()).toEqual([]);
	});

	it("keeps self-check, stuck and stall mail on alert.to", async () => {
		const { runEnv, box } = mailbox();
		await env.DB.prepare(`DELETE FROM meta WHERE key = 'version'`).run();
		const cert = { id: "cert", type: "tls", name: "Certificate", host: "www.example.com", zone: "example.com" };
		const config = makeConfig([
			{ ...routed, down_after: 3 },
			{ ...cert, every: "1m", to: team },
		]);
		for (let k = 0; k <= 4; k++) await tick(runEnv, config, T0 + k * MINUTE, T0 + k * MINUTE, respond(200));
		await watch(runEnv, config, T0 + 10 * MINUTE);
		expect(box.subjects).toEqual([
			"SELF-CHECK FAILING: Cloudflare API token",
			"SELF-CHECK FAILING: results for Certificate",
			"SELF-CHECK FAILING: probing stalled",
		]);
		expect(box.to).toEqual(Array(3).fill("oncall@example.com"));
	});

	it("moves pending mail from a corrected address to the new one", async () => {
		const { runEnv, box } = mailbox();
		box.failFor.add("opz@example.com");
		await tick(runEnv, makeConfig([{ ...routed, to: ["opz@example.com"] }]), T0, T0, respond(500));
		expect(await rows()).toEqual([{ to: "opz@example.com", kind: "down" }]);
		await tick(runEnv, makeConfig([{ ...routed, to: ["ops@example.com"] }]), T0 + MINUTE, T0 + MINUTE, respond(500));
		expect(box.subjects.map((s, i) => `${s} -> ${box.to[i]}`)).toEqual([
			"DOWN: Web -> opz@example.com",
			"DOWN: Web -> ops@example.com",
		]);
		expect(await rows()).toEqual([]);
	});

	it("moves pending mail from a removed address to the addresses that lack it, then to alert.to", async () => {
		const { runEnv, box } = mailbox();
		box.failing = true;
		await tick(runEnv, makeConfig([routed]), T0, T0, respond(500));
		await tick(
			runEnv,
			makeConfig([{ ...routed, to: ["a@example.com", "c@example.com"] }]),
			T0 + MINUTE,
			T0 + MINUTE,
			respond(500),
		);
		expect(await rows()).toEqual([
			{ to: "a@example.com", kind: "down" },
			{ to: "c@example.com", kind: "down" },
		]);
		await tick(runEnv, makeConfig([{ ...web, down_after: 1 }]), T0 + 2 * MINUTE, T0 + 2 * MINUTE, respond(500));
		expect(await rows()).toEqual([{ to: "", kind: "down" }]);
		box.failing = false;
		box.to.length = 0;
		await tick(runEnv, makeConfig([{ ...web, down_after: 1 }]), T0 + 3 * MINUTE, T0 + 3 * MINUTE, respond(500));
		expect(box.to).toEqual(["oncall@example.com"]);
	});

	it("keeps dead mail to a removed address as dead", async () => {
		const { runEnv, box } = mailbox();
		box.failFor.add("opz@example.com");
		const typo = makeConfig([{ ...routed, to: ["opz@example.com"] }]);
		for (let k = 0; k < 10; k++) await tick(runEnv, typo, T0 + k * MINUTE, T0 + k * MINUTE, respond(500));
		await tick(
			runEnv,
			makeConfig([{ ...routed, to: ["ops@example.com"] }]),
			T0 + 10 * MINUTE,
			T0 + 10 * MINUTE,
			respond(500),
		);
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
		await tick(runEnv, makeConfig([web], { relays }), T0, T0, respond(200));
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO outbox ("check", "key", at, kind, since, reason) VALUES ('alerts', 'k', ?1, 'firing', 0, 'x')`,
			).bind(T0 + 1),
			env.DB.prepare(
				`INSERT INTO outbox ("check", "key", at, kind, since, reason) VALUES ('', 'stall', ?1, 'self-failing', NULL, NULL)`,
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
		await tick(runEnv, makeConfig([web], { relays }), T0 + MINUTE, T0 + MINUTE, respond(200));
		expect(await all(`SELECT "check" FROM outbox ORDER BY "check"`)).toEqual([{ check: "" }, { check: "alerts" }]);
		expect(await all(`SELECT relay FROM relay_keys`)).toEqual([{ relay: "alerts" }]);
	});

	it("drops queued deployed, resumed and self-ok rows", async () => {
		const { runEnv, box } = mailbox();
		await env.DB.prepare(
			`INSERT INTO outbox ("check", "key", at, kind) VALUES ('', 'deployed', 1, 'deployed'), ('', 'resumed', 1, 'resumed'), ('', 'stall', 1, 'self-ok')`,
		).run();
		await tick(runEnv, makeConfig(), T0, T0, respond(200));
		expect(await all(`SELECT * FROM outbox`)).toEqual([]);
		expect(box.sends).toBe(0);
	});

	describe("a check absent from the config", () => {
		const DAY = 24 * 60 * MINUTE;
		const gone = { ...web, id: "gone", name: "Gone", down_after: 1 };
		const both = makeConfig([web, gone]);
		const only = makeConfig([web]);
		const tables = ["state", "daily", "events"];
		const rows = async () => {
			const out: Record<string, number> = {};
			for (const table of tables) out[table] = (await all(`SELECT * FROM ${table} WHERE "check" = 'gone'`)).length;
			return out;
		};
		const marker = () => all(`SELECT key FROM meta WHERE key = 'gone:gone'`);

		it("keeps its history for 7 days, then drops it with the marker", async () => {
			const { runEnv } = mailbox();
			await tick(runEnv, both, T0, T0, respond(500));
			const full = await rows();
			expect(full).toEqual({ state: 1, daily: 1, events: 1 });
			await tick(runEnv, only, T0 + MINUTE, T0 + MINUTE, respond(200));
			expect(await marker()).toHaveLength(1);
			await tick(runEnv, only, T0 + 7 * DAY - MINUTE, T0 + 7 * DAY - MINUTE, respond(200));
			expect(await rows()).toEqual(full);
			await tick(runEnv, only, T0 + 7 * DAY + 2 * MINUTE, T0 + 7 * DAY + 2 * MINUTE, respond(200));
			expect(await rows()).toEqual({ state: 0, daily: 0, events: 0 });
			expect(await marker()).toEqual([]);
		});

		it("clears the marker when the id comes back, and restarts the 7 days when it leaves again", async () => {
			const { runEnv } = mailbox();
			await tick(runEnv, both, T0, T0, respond(500));
			await tick(runEnv, only, T0 + MINUTE, T0 + MINUTE, respond(200));
			await tick(runEnv, both, T0 + 3 * DAY, T0 + 3 * DAY, respond(500));
			expect(await marker()).toEqual([]);
			await tick(runEnv, only, T0 + 3 * DAY + MINUTE, T0 + 3 * DAY + MINUTE, respond(200));
			const at = T0 + 7 * DAY + 2 * MINUTE;
			await tick(runEnv, only, at, at, respond(200));
			expect((await rows()).state).toBe(1);
			const later = T0 + 10 * DAY + 2 * MINUTE;
			await tick(runEnv, only, later, later, respond(200));
			expect((await rows()).state).toBe(0);
		});

		it("drops its queued mail and stuck flag at once", async () => {
			const { runEnv } = mailbox();
			await tick(runEnv, both, T0, T0, respond(500));
			await env.DB.prepare(
				`INSERT INTO outbox ("check", at, kind, since, reason) VALUES ('gone', 1, 'down', 0, 'x')`,
			).run();
			await tick(runEnv, only, T0 + MINUTE, T0 + MINUTE, respond(200));
			expect(await all(`SELECT * FROM outbox WHERE "check" = 'gone'`)).toEqual([]);
		});
	});

	it("keeps samples for 24 hours and daily rows and events for 90 days", async () => {
		const { runEnv } = mailbox();
		const config = makeConfig([web]);
		await tick(runEnv, config, T0, T0, respond(200));
		await env.DB.prepare(`INSERT INTO events ("check", at, "from", "to") VALUES ('web', ?1, 'up', 'down')`)
			.bind(T0)
			.run();
		await tick(runEnv, config, T0 + 25 * 3_600_000, T0 + 25 * 3_600_000, respond(200));
		expect(await all("SELECT at FROM samples")).toEqual([{ at: T0 + 25 * 3_600_000 }]);
		await tick(runEnv, config, T0 + 91 * 86_400_000, T0 + 91 * 86_400_000, respond(200));
		expect(await all("SELECT day FROM daily")).toEqual([{ day: "2026-10-09" }, { day: "2027-01-07" }]);
		expect(await all("SELECT * FROM events")).toEqual([]);
	});
});

describe("one mail per outage", () => {
	const six = ["a", "b", "c", "d", "e", "f"].map((id) => ({
		...web,
		id,
		name: `Site ${id}`,
		down_after: 1,
		up_after: 1,
	}));

	it("sends one DOWN mail for six checks going down and one UP mail on recovery", async () => {
		const { runEnv, box } = mailbox();
		const config = makeConfig(six);
		await tick(runEnv, config, T0, T0, respond(200));
		await tick(runEnv, config, T0 + MINUTE, T0 + MINUTE, respond(500));
		expect(box.subjects).toEqual(["DOWN: 6 checks: Site a, Site b, Site c, Site d, Site e, Site f"]);
		for (const id of ["a", "f"]) expect(box.bodies[0]).toContain(`Site ${id} (https://www.example.com/): HTTP 500`);
		await tick(runEnv, config, T0 + 2 * MINUTE, T0 + 2 * MINUTE, respond(200));
		expect(box.subjects).toHaveLength(2);
		expect(box.subjects[1]).toBe("UP: 6 checks: Site a, Site b, Site c, Site d, Site e, Site f");
		expect(await all("SELECT * FROM outbox")).toEqual([]);
	});

	it("keeps a single check's subject", async () => {
		const { runEnv, box } = mailbox();
		await tick(runEnv, makeConfig(six.slice(0, 2)), T0, T0, respond(200));
		await tick(
			runEnv,
			makeConfig([six[0], { ...six[1], url: "https://ok.example.com/" }]),
			T0 + MINUTE,
			T0 + MINUTE,
			async (input) => new Response("", { status: String(input).includes("ok.") ? 200 : 500 }),
		);
		expect(box.subjects).toEqual(["DOWN: Site a"]);
	});

	it("groups per recipient and retries each recipient's mail on its own", async () => {
		const { runEnv, box } = mailbox();
		box.failFor.add("b@example.com");
		const routedSix = six.map((c, i) => ({ ...c, to: i < 3 ? ["a@example.com"] : ["a@example.com", "b@example.com"] }));
		const config = makeConfig(routedSix);
		await tick(runEnv, config, T0, T0, respond(200));
		await tick(runEnv, config, T0 + MINUTE, T0 + MINUTE, respond(500));
		expect(box.to.filter((t) => t === "a@example.com")).toHaveLength(1);
		expect(box.subjects[0]).toBe("DOWN: 6 checks: Site a, Site b, Site c, Site d, Site e, Site f");
		expect(box.subjects[1]).toBe("DOWN: 3 checks: Site d, Site e, Site f");
		expect(await all(`SELECT "to", attempts FROM outbox`)).toEqual(
			["d", "e", "f"].map(() => ({ to: "b@example.com", attempts: 1 })),
		);
	});

	it("groups a default-routed row and an explicit alert.to row as one recipient, ignoring case", async () => {
		const { runEnv, box } = mailbox();
		const mixed = six.map((c, i) => (i === 0 ? { ...c, to: ["ONCALL@example.com", "other@example.com"] } : c));
		const config = makeConfig(mixed);
		await tick(runEnv, config, T0, T0, respond(200));
		await tick(runEnv, config, T0 + MINUTE, T0 + MINUTE, respond(500));
		expect(box.to.filter((t) => t === "oncall@example.com")).toHaveLength(1);
		expect(box.subjects).toHaveLength(2);
		expect(box.subjects[0]).toBe("DOWN: 6 checks: Site a, Site b, Site c, Site d, Site e, Site f");
	});

	it("sends a relay's pending keys as one mail per drain", async () => {
		const { runEnv, box } = mailbox();
		const relays = [{ id: "alerts", name: "Alerts", token_sha256: "a".repeat(64) }];
		await env.DB.batch(
			["k1", "k2", "k3"].map((k) =>
				env.DB.prepare(
					`INSERT INTO outbox ("check", "key", at, kind, since, reason) VALUES ('alerts', ?1, 1, 'firing', NULL, '{"title":"t"}')`,
				).bind(k),
			),
		);
		await drain(runEnv, makeConfig([web], { relays }));
		expect(box.subjects).toEqual(["ALERTS: Alerts: 3 changed"]);
	});
});
