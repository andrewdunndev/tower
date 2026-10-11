import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import pkg from "../../package.json";
import { compose, towerMessage } from "../src/mail.ts";
import { incident, MAX_KEYS } from "../src/relay.ts";
import { tick, watch } from "../src/run.ts";
import { attention } from "../src/self.ts";
import { status } from "../src/status.ts";
import { all, MINUTE, mailbox, makeConfig, reset, respond, sha256, steadyTick, T0, web } from "./util.ts";

beforeEach(reset);

const DAY = 86_400_000;
const cert = {
	id: "cert",
	type: "tls",
	name: "Certificate",
	host: "www.example.com",
	zone: "example.com",
	every: "1m",
	down_after: 1,
	up_after: 1,
};
const unhealthy = { ...web, down_after: 1 };

function cloudflare(packs: number | object[]) {
	return (async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.includes("/zones?name=")) return Response.json({ success: true, result: [{ id: "zone1" }] });
		if (typeof packs === "number") return new Response("{}", { status: packs });
		return Response.json({
			success: true,
			result: [
				{
					id: "p",
					type: "universal",
					status: "active",
					hosts: ["www.example.com"],
					validity_days: 90,
					certificates: [{ expires_on: new Date(T0 + 60 * DAY).toISOString() }],
				},
			],
		});
	}) as typeof fetch;
}

const unsent = () => all<{ key: string; kind: string }>(`SELECT "key", kind FROM outbox`);

describe("deploy mail", () => {
	it("mails once per version id", async () => {
		const { runEnv, box } = mailbox();
		await env.DB.prepare(`DELETE FROM meta WHERE key = 'version'`).run();
		const config = makeConfig();
		await tick(runEnv, config, T0, respond(200));
		await tick(runEnv, config, T0 + MINUTE, respond(200));
		expect(box.subjects).toEqual([`DEPLOYED: tower ${pkg.version}`]);
		await tick({ ...runEnv, VERSION: { id: "v2" } }, config, T0 + 2 * MINUTE, respond(200));
		await tick({ ...runEnv, VERSION: { id: "v2" } }, config, T0 + 3 * MINUTE, respond(200));
		expect(box.subjects).toHaveLength(2);
	});
});

describe("digest", () => {
	const config = makeConfig([web], { digest: "07:30" });
	const at = (h: number, m: number, day = 0) => T0 - 12 * 3_600_000 + day * DAY + (h * 60 + m) * MINUTE;

	it("mails once a day, not before HH:MM, and late after a stall", async () => {
		const { runEnv, box } = mailbox();
		await tick(runEnv, config, at(7, 29), respond(200));
		expect(box.sends).toBe(0);
		await tick(runEnv, config, at(7, 30), respond(200));
		await tick(runEnv, config, at(7, 31), respond(200));
		expect(box.subjects).toEqual(["DIGEST: Example 2026-10-08: all up"]);
		await steadyTick(runEnv, config, at(23, 59), respond(200));
		expect(box.sends).toBe(1);
		await env.DB.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('tick', ?1)`)
			.bind(String(at(7, 40, 1)))
			.run();
		await tick(runEnv, config, at(9, 0, 1), respond(200));
		expect(box.subjects.filter((s) => s.startsWith("DIGEST"))).toHaveLength(2);
	});

	it("lists only what needs attention, and sends nothing without a digest time", async () => {
		const { runEnv, box } = mailbox();
		const noisy = makeConfig([unhealthy], { digest: "07:30" });
		await tick(runEnv, noisy, at(7, 30), respond(500));
		expect(box.subjects).toContain("DIGEST: Example 2026-10-08: 1 need attention");
		box.subjects.length = 0;
		await steadyTick(runEnv, makeConfig(), at(7, 30, 1), respond(200));
		expect(box.subjects).toEqual([]);
	});

	it("names down checks, open relay keys, stuck mail and failing self-checks, and nothing else", async () => {
		const { runEnv } = mailbox();
		const config = makeConfig([unhealthy], {
			digest: "07:30",
			relays: [{ id: "alerts", name: "Alerts", token_sha256: await sha256("relay-secret"), grace: "1d" }],
		});
		expect(await attention(env.DB, config)).toEqual([]);
		await tick(runEnv, config, at(7, 0), respond(500));
		await incident(
			runEnv,
			config,
			"relay-secret",
			JSON.stringify({ title: "disk full", deduplication_key: "k1", status: "firing", description: "secret detail" }),
			at(7, 1),
		);
		await env.DB.batch([
			env.DB.prepare(`INSERT INTO meta (key, value) VALUES ('self:token', '1')`),
			env.DB.prepare(
				`INSERT INTO outbox ("check", "key", at, kind, attempts, dead) VALUES ('web', '', 1, 'down', 10, 1), ('web', '', 2, 'up', 2, 0), ('web', '', 3, 'up', 0, 0)`,
			),
		]);
		const lines = await attention(env.DB, config);
		expect(lines).toEqual([
			"DOWN: Web",
			"OPEN: Alerts: disk full",
			"SELF-CHECK: Cloudflare API token",
			"MAIL: 1 unsent",
			"MAIL: 1 dead",
		]);
		const row = { at: at(7, 30), key: "digest", kind: "digest", since: null, reason: null } as const;
		expect(towerMessage(config, row, lines)).toEqual([
			"DIGEST: Example 2026-10-08: 5 need attention",
			`${lines.join("\n")}\n`,
		]);
		expect(towerMessage(config, row, [])).toEqual(["DIGEST: Example 2026-10-08: all up", ""]);
	});
});

describe("token", () => {
	const config = makeConfig([cert]);
	const failing = (box: { subjects: string[] }) => box.subjects.filter((s) => s.includes("Cloudflare API token"));

	it("raises once on a 401, holds on a 503, clears on an authenticated run", async () => {
		const { runEnv, box } = mailbox();
		const live = { ...runEnv, CF_API_TOKEN: "tok" };
		await tick(live, config, T0, cloudflare(401));
		await tick(live, config, T0 + MINUTE, cloudflare(403));
		expect(box.subjects).toEqual(["SELF-CHECK FAILING: Cloudflare API token"]);
		expect((await status(env.DB, config, T0 + MINUTE)).self).toEqual([
			{ name: "Cloudflare API token", since: new Date(T0).toISOString() },
		]);
		await tick(live, config, T0 + 2 * MINUTE, cloudflare(503));
		expect((await status(env.DB, config, T0 + 2 * MINUTE)).self).toHaveLength(1);
		expect(failing(box)).toHaveLength(1);
		await tick(live, config, T0 + 3 * MINUTE, cloudflare([]));
		expect(failing(box)).toEqual(["SELF-CHECK FAILING: Cloudflare API token", "SELF-CHECK OK: Cloudflare API token"]);
		expect((await status(env.DB, config, T0 + 3 * MINUTE)).self).toEqual([]);
	});

	it("raises when the secret is unset", async () => {
		const { runEnv, box } = mailbox();
		await tick(runEnv, config, T0, cloudflare([]));
		expect(box.subjects).toEqual(["SELF-CHECK FAILING: Cloudflare API token"]);
	});

	it("stays quiet when there is no tls check", async () => {
		const { runEnv, box } = mailbox();
		await tick(runEnv, makeConfig(), T0, respond(200));
		expect(box.sends).toBe(0);
		expect(await all("SELECT * FROM meta WHERE key LIKE 'self:%'")).toEqual([]);
	});
});

describe("write self-check", () => {
	const boom = () =>
		env.DB.prepare(`CREATE TRIGGER boom BEFORE UPDATE ON state BEGIN SELECT RAISE(ABORT, 'boom'); END`).run();

	it("sends one direct mail while writes fail, then a resumed mail", async () => {
		const { runEnv, box } = mailbox();
		const config = makeConfig();
		await tick(runEnv, config, T0, respond(200));
		await boom();
		await expect(tick(runEnv, config, T0 + MINUTE, respond(200))).rejects.toThrow();
		await expect(tick(runEnv, config, T0 + 2 * MINUTE, respond(200))).rejects.toThrow();
		await expect(tick(runEnv, config, T0 + 3 * MINUTE, respond(200))).rejects.toThrow();
		expect(box.subjects).toEqual(["SELF-CHECK FAILING: database writes"]);
		await env.DB.prepare(`DROP TRIGGER boom`).run();
		await tick(runEnv, config, T0 + 4 * MINUTE, respond(200));
		expect(box.subjects).toEqual(["SELF-CHECK FAILING: database writes", "SELF-CHECK OK: probing resumed"]);
	});

	it("mails resumed after a stalled cron", async () => {
		const { runEnv, box } = mailbox();
		const config = makeConfig();
		await tick(runEnv, config, T0, respond(200));
		await tick(runEnv, config, T0 + 10 * MINUTE, respond(200));
		await tick(runEnv, config, T0 + 11 * MINUTE, respond(200));
		expect(box.subjects).toEqual(["SELF-CHECK OK: probing resumed"]);
		expect(await unsent()).toEqual([]);
	});
});

describe("relay cap", () => {
	it("clears the full flag with one OK once the relay has room", async () => {
		const { runEnv, box } = mailbox();
		const token = "relay-secret";
		const hash = await sha256(token);
		const config = makeConfig([web], { relays: [{ id: "alerts", name: "Alerts", token_sha256: hash, grace: "1h" }] });
		const fire = (key: string, status = "firing") =>
			incident(runEnv, config, token, JSON.stringify({ title: "t", deduplication_key: key, status }), T0);
		for (let i = 0; i < MAX_KEYS; i++) await fire(`k${i}`);
		await fire("overflow");
		await steadyTick(runEnv, config, T0 + MINUTE, respond(200));
		expect(box.subjects.filter((s) => s.startsWith("SELF-CHECK"))).toEqual([
			"SELF-CHECK FAILING: relay Alerts is full",
		]);
		await fire("k0", "resolved");
		await steadyTick(runEnv, config, T0 + 2 * MINUTE, respond(200));
		await steadyTick(runEnv, config, T0 + 3 * MINUTE, respond(200));
		expect(box.subjects.filter((s) => s.startsWith("SELF-CHECK"))).toEqual([
			"SELF-CHECK FAILING: relay Alerts is full",
			"SELF-CHECK OK: relay Alerts has room",
		]);
	});
});

describe("stuck checks", () => {
	const live = () => {
		const { runEnv, box } = mailbox();
		return { box, env: { ...runEnv, CF_API_TOKEN: "tok" } };
	};
	const stuck = (box: { subjects: string[] }) => box.subjects.filter((s) => s.includes("results for"));
	const config = makeConfig([web, cert]);
	// The web check answers 200; the certificate check's Cloudflare API answers 503 or a valid pack.
	const serve = (packs: number | object[]) =>
		(async (input: RequestInfo | URL, init?: RequestInit) =>
			String(input).includes("/zones")
				? cloudflare(packs)(input, init)
				: new Response("", { status: 200 })) as typeof fetch;
	const minutes = async (
		runEnv: Parameters<typeof tick>[0],
		cfg: typeof config,
		from: number,
		to: number,
		f: typeof fetch,
	) => {
		for (let k = from; k <= to; k++) await tick(runEnv, cfg, T0 + k * MINUTE, f);
	};

	it("flags a check with no conclusive result at exactly three intervals, and no other", async () => {
		const { box, env: runEnv } = live();
		await minutes(runEnv, config, 0, 2, serve(503));
		expect(box.subjects).toEqual([]);
		await minutes(runEnv, config, 3, 3, serve(503));
		expect(box.subjects).toEqual(["SELF-CHECK FAILING: results for Certificate"]);
		expect(await all("SELECT avail FROM state WHERE \"check\" = 'web'")).toEqual([{ avail: 1 }]);
	});

	it("mails once, then one OK on a conclusive result, and no OK for a check that was never flagged", async () => {
		const { box, env: runEnv } = live();
		await minutes(runEnv, config, 0, 5, serve(503));
		expect(stuck(box)).toEqual(["SELF-CHECK FAILING: results for Certificate"]);
		await minutes(runEnv, config, 6, 8, serve([]));
		expect(stuck(box)).toEqual([
			"SELF-CHECK FAILING: results for Certificate",
			"SELF-CHECK OK: results for Certificate",
		]);
		expect(await all("SELECT * FROM meta WHERE key LIKE 'self:stuck:%'")).toEqual([]);

		const quiet = live();
		await minutes(quiet.env, config, 0, 1, serve(503));
		await minutes(quiet.env, config, 2, 4, serve([]));
		expect(stuck(quiet.box)).toEqual([]);
	});

	it("gives a check added later three intervals from when it was added", async () => {
		const { box, env: runEnv } = live();
		await minutes(runEnv, makeConfig([web]), 0, 9, serve(503));
		await minutes(runEnv, config, 10, 12, serve(503));
		expect(box.subjects).toEqual([]);
		await minutes(runEnv, config, 13, 13, serve(503));
		expect(stuck(box)).toEqual(["SELF-CHECK FAILING: results for Certificate"]);
	});

	it("counts a check by its own interval", async () => {
		const { box, env: runEnv } = live();
		const hourly = makeConfig([web, { ...cert, every: "1h" }]);
		await minutes(runEnv, hourly, 0, 5, serve(503));
		expect(stuck(box)).toEqual([]);
		await tick(runEnv, hourly, T0 + 3 * 3_600_000, serve(503));
		expect(stuck(box)).toEqual(["SELF-CHECK FAILING: results for Certificate"]);
	});

	it("flags a check whose token is unset, after the token mail", async () => {
		const { runEnv, box } = mailbox();
		await minutes(runEnv, config, 0, 3, serve([]));
		expect(box.subjects).toEqual([
			"SELF-CHECK FAILING: Cloudflare API token",
			"SELF-CHECK FAILING: results for Certificate",
		]);
	});

	it("flags a check that never runs because its slot is ahead of the clock, and clears when it runs", async () => {
		const { runEnv, box } = mailbox();
		await tick(runEnv, makeConfig(), T0, respond(200));
		await env.DB.prepare(`UPDATE state SET slot = 9e15 WHERE "check" = 'web'`).run();
		await minutes(runEnv, makeConfig(), 1, 3, respond(200));
		expect(box.subjects).toEqual(["SELF-CHECK FAILING: results for Web"]);
		await env.DB.prepare(`UPDATE state SET slot = -1`).run();
		await minutes(runEnv, makeConfig(), 4, 4, respond(200));
		expect(box.subjects).toEqual(["SELF-CHECK FAILING: results for Web", "SELF-CHECK OK: results for Web"]);
	});

	it("sends no stuck mail when a stalled cron resumes with fresh results", async () => {
		const { runEnv, box } = mailbox();
		await tick(runEnv, makeConfig(), T0, respond(200));
		await tick(runEnv, makeConfig(), T0 + 10 * MINUTE, respond(200));
		expect(box.subjects).toEqual(["SELF-CHECK OK: probing resumed"]);
	});

	it("mails a private check but shows only a public one in status", async () => {
		const { box, env: runEnv } = live();
		const hidden = makeConfig([{ ...cert, public: false }]);
		await minutes(runEnv, hidden, 0, 3, serve(503));
		expect(stuck(box)).toEqual(["SELF-CHECK FAILING: results for Certificate"]);
		expect((await status(env.DB, hidden, T0 + 4 * MINUTE)).self).toEqual([]);
		expect(await attention(env.DB, hidden)).toContain("SELF-CHECK: results for Certificate");
		expect((await status(env.DB, makeConfig([cert]), T0 + 4 * MINUTE)).self).toEqual([
			{ name: "results for Certificate", since: new Date(T0 + 3 * MINUTE).toISOString() },
		]);
	});

	it("drops the flag of a removed check", async () => {
		const { env: runEnv } = live();
		await minutes(runEnv, config, 0, 3, serve(503));
		expect(await all("SELECT key FROM meta WHERE key LIKE 'self:stuck:%'")).toEqual([{ key: "self:stuck:cert" }]);
		await minutes(runEnv, makeConfig([web]), 4, 4, serve(503));
		expect(await all("SELECT key FROM meta WHERE key LIKE 'self:stuck:%'")).toEqual([]);
	});

	it("writes both mails with the check's name, target and last reason", () => {
		const row = { check: "cert", key: "stuck", at: T0 + 3 * MINUTE, since: T0, reason: "Cloudflare API 503" } as const;
		expect(compose(config, [{ ...row, kind: "self-failing" }])).toEqual([
			"SELF-CHECK FAILING: results for Certificate",
			`Certificate (www.example.com) has had no fresh result since ${new Date(T0).toISOString()}, three of its intervals; detected ${new Date(T0 + 3 * MINUTE).toISOString()}.\nLast reason: Cloudflare API 503.\n`,
		]);
		expect(compose(config, [{ ...row, kind: "self-ok", since: null, reason: null }])).toEqual([
			"SELF-CHECK OK: results for Certificate",
			`Certificate has fresh results again, ${new Date(T0 + 3 * MINUTE).toISOString()}.\n`,
		]);
	});
});

describe("stalled prober", () => {
	const config = makeConfig();
	const stalls = (box: { subjects: string[] }) => box.subjects.filter((s) => s.includes("stalled"));

	it("says nothing before the prober has ever run", async () => {
		const { runEnv, box } = mailbox();
		await watch(runEnv, config, T0);
		expect(box.sends).toBe(0);
		expect(await all("SELECT * FROM meta WHERE key = 'stall'")).toEqual([]);
	});

	it("mails once when no run has written results for more than three intervals", async () => {
		const { runEnv, box } = mailbox();
		await tick(runEnv, config, T0, respond(200));
		await watch(runEnv, config, T0 + 3 * MINUTE);
		expect(box.sends).toBe(0);
		await watch(runEnv, config, T0 + 3 * MINUTE + 1);
		await watch(runEnv, config, T0 + 4 * MINUTE);
		expect(box.subjects).toEqual(["SELF-CHECK FAILING: probing stalled"]);
	});

	it("waits three of the shortest interval", async () => {
		const { runEnv, box } = mailbox();
		const hourly = makeConfig([{ ...web, every: "1h" }]);
		await tick(runEnv, hourly, T0, respond(200));
		await watch(runEnv, hourly, T0 + 4 * MINUTE);
		expect(box.sends).toBe(0);
		await watch(runEnv, hourly, T0 + 3 * 3_600_000 + 1);
		expect(stalls(box)).toHaveLength(1);
	});

	it("is cleared by the next committed run with one OK", async () => {
		const { runEnv, box } = mailbox();
		await tick(runEnv, config, T0, respond(200));
		await watch(runEnv, config, T0 + 5 * MINUTE);
		await tick(runEnv, config, T0 + 6 * MINUTE, respond(200));
		await tick(runEnv, config, T0 + 7 * MINUTE, respond(200));
		expect(box.subjects).toEqual(["SELF-CHECK FAILING: probing stalled", "SELF-CHECK OK: probing resumed"]);
		expect(await all("SELECT * FROM meta WHERE key = 'stall'")).toEqual([]);
	});

	it("stays raised while a committed run still writes no result", async () => {
		const { runEnv, box } = mailbox();
		await tick(runEnv, config, T0, respond(200));
		await watch(runEnv, config, T0 + 5 * MINUTE);
		await env.DB.prepare(`UPDATE state SET slot = 9e15`).run();
		await tick(runEnv, config, T0 + 6 * MINUTE, respond(200));
		await tick(runEnv, config, T0 + 7 * MINUTE, respond(200));
		expect(box.subjects.filter((s) => s.includes("probing"))).toEqual(["SELF-CHECK FAILING: probing stalled"]);
		expect(await all("SELECT key FROM meta WHERE key = 'stall'")).toEqual([{ key: "stall" }]);
	});

	it("words the mail with the last run and the detection time", () => {
		const row = {
			check: "",
			key: "stall",
			kind: "self-failing",
			at: T0 + 5 * MINUTE,
			since: T0,
			reason: null,
		} as const;
		expect(compose(config, [row])).toEqual([
			"SELF-CHECK FAILING: probing stalled",
			`No probe run has written results since ${new Date(T0).toISOString()}; detected ${new Date(T0 + 5 * MINUTE).toISOString()}. The prober's cron trigger or its runs are failing; its Worker log says which.\n`,
		]);
	});
});
