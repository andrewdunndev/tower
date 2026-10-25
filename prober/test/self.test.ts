import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { compose } from "../src/mail.ts";
import { incident, MAX_KEYS } from "../src/relay.ts";
import { tick, watch } from "../src/run.ts";
import { attention } from "../src/self.ts";
import { DEPLOY_GRACE_MS, status } from "../src/status.ts";
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

describe("deploy", () => {
	it("records the version id and sends no mail", async () => {
		const { runEnv, box } = mailbox();
		await env.DB.prepare(`DELETE FROM meta WHERE key = 'version'`).run();
		const config = makeConfig();
		await tick(runEnv, config, T0, T0, respond(200));
		expect(await all("SELECT value FROM meta WHERE key = 'version'")).toEqual([{ value: "v1" }]);
		await tick({ ...runEnv, VERSION: { id: "v2" } }, config, T0 + MINUTE, T0 + MINUTE, respond(200));
		expect(await all("SELECT value FROM meta WHERE key = 'version'")).toEqual([{ value: "v2" }]);
		expect(box.sends).toBe(0);
	});
});

describe("digest", () => {
	const config = makeConfig([web], { digest: "07:30" });
	const at = (h: number, m: number, day = 0) => T0 - 12 * 3_600_000 + day * DAY + (h * 60 + m) * MINUTE;

	it("mails once a day, not before HH:MM, and late after a stall", async () => {
		const { runEnv, box } = mailbox();
		await tick(runEnv, config, at(7, 29), at(7, 29), respond(200));
		expect(box.sends).toBe(0);
		await tick(runEnv, config, at(7, 30), at(7, 30), respond(200));
		await tick(runEnv, config, at(7, 31), at(7, 31), respond(200));
		expect(box.subjects).toEqual(["DIGEST: Example 2026-10-08: all up"]);
		await steadyTick(runEnv, config, at(23, 59), respond(200));
		expect(box.sends).toBe(1);
		await env.DB.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('tick', ?1)`)
			.bind(String(at(7, 40, 1)))
			.run();
		await tick(runEnv, config, at(9, 0, 1), at(9, 0, 1), respond(200));
		expect(box.subjects.filter((s) => s.startsWith("DIGEST"))).toHaveLength(2);
	});

	it("mails a summary line, never a blank body, on an all-up day", async () => {
		const { runEnv, box } = mailbox();
		await tick(runEnv, config, at(7, 30), at(7, 30), respond(200));
		expect(box.subjects).toEqual(["DIGEST: Example 2026-10-08: all up"]);
		expect(box.bodies[0]).toBe("Checked 1/1 checks up. Relay keys fired and closed: 0. Mail: 0 sent, 0 dead.\r\n");
	});

	it("lists a fired-and-resolved relay key by title, counts it, and resets the sent count", async () => {
		const { runEnv, box } = mailbox();
		const hash = await sha256("relay-secret");
		const quiet = makeConfig([web], {
			digest: "07:30",
			relays: [
				{ id: "alerts", name: "Alerts", token_sha256: hash, digest_only: true },
				{ id: "push", name: "Push", token_sha256: await sha256("push-secret") },
			],
		});
		const body = (status: string) => JSON.stringify({ title: "Disk full", deduplication_key: "k1", status });
		await incident(runEnv, quiet, "relay-secret", body("firing"), at(6, 0));
		await incident(runEnv, quiet, "relay-secret", body("resolved"), at(6, 10));
		await incident(runEnv, quiet, "push-secret", body("firing"), at(7, 25));
		await tick(runEnv, quiet, at(7, 30), at(7, 30), respond(200));
		const digest = box.bodies.at(-1)?.replaceAll("\r\n", "\n");
		expect(box.subjects.at(-1)).toBe("DIGEST: Example 2026-10-08: 1 need attention");
		expect(digest).toBe(
			"OPEN: Push: Disk full\nDisk full: fired 1, first 10-08 06:00Z, last 10-08 06:00Z, closed\nChecked 1/1 checks up. Relay keys fired and closed: 1. Mail: 1 sent, 0 dead.\n",
		);
		expect(await all("SELECT value FROM meta WHERE key = 'sent'")).toEqual([{ value: "0" }]);
	});

	it("lists only what needs attention, and sends nothing before the digest time", async () => {
		const { runEnv, box } = mailbox();
		const noisy = makeConfig([unhealthy], { digest: "07:30" });
		await tick(runEnv, noisy, at(7, 30), at(7, 30), respond(500));
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
		expect((await attention(env.DB, config)).lines).toEqual([]);
		await tick(runEnv, config, at(7, 0), at(7, 0), respond(500));
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
		const report = await attention(env.DB, config);
		expect(report.lines).toEqual([
			"DOWN: Web",
			"OPEN: Alerts: disk full",
			"SELF-CHECK: Cloudflare API token",
			"MAIL: 1 unsent",
			"MAIL: 1 dead",
		]);
		const row = { check: "", at: at(7, 30), key: "digest", kind: "digest", since: null, reason: null } as const;
		expect(compose(config, [row], report)).toEqual([
			"DIGEST: Example 2026-10-08: 5 need attention",
			`${report.lines.join("\n")}\nChecked 0/1 checks up. Relay keys fired and closed: 0. Mail: 2 sent, 1 dead.\n`,
		]);
		expect(compose(config, [row], { ...report, lines: [], need: 0, up: 1, sent: 0, dead: 0 })).toEqual([
			"DIGEST: Example 2026-10-08: all up",
			"Checked 1/1 checks up. Relay keys fired and closed: 0. Mail: 0 sent, 0 dead.\n",
		]);
	});
});

const attentionOf = async (config: Parameters<typeof attention>[1]) => (await attention(env.DB, config)).lines;
const flagKeys = async () =>
	(await all<{ key: string }>("SELECT key FROM meta WHERE key LIKE 'self:%' OR key LIKE 'full:%' ORDER BY key")).map(
		(r) => r.key,
	);

describe("digest-only flags", () => {
	const base = T0 - 60 * MINUTE;
	const live = () => {
		const { runEnv, box } = mailbox();
		return { box, env: { ...runEnv, CF_API_TOKEN: "tok" } };
	};
	const serve = (packs: number | object[]) =>
		(async (input: RequestInfo | URL, init?: RequestInit) =>
			String(input).includes("/zones")
				? cloudflare(packs)(input, init)
				: new Response("", { status: 200 })) as typeof fetch;
	const minutes = async (
		runEnv: Parameters<typeof tick>[0],
		cfg: Parameters<typeof tick>[1],
		from: number,
		to: number,
		f: typeof fetch,
	) => {
		for (let k = from; k <= to; k++) await tick(runEnv, cfg, base + k * MINUTE, base + k * MINUTE, f);
	};

	it("flags a 401 without mail, holds on a 503, clears on an authenticated run", async () => {
		const config = makeConfig([cert]);
		const { box, env: runEnv } = live();
		await minutes(runEnv, config, 0, 0, cloudflare(401));
		expect(box.sends).toBe(0);
		expect(await flagKeys()).toEqual(["self:token"]);
		expect((await status(env.DB, config, base + MINUTE)).self).toEqual([
			{ name: "Cloudflare API token", since: new Date(base).toISOString() },
		]);
		expect(await attentionOf(config)).toEqual(["SELF-CHECK: Cloudflare API token"]);
		await minutes(runEnv, config, 1, 1, cloudflare(503));
		expect(await flagKeys()).toEqual(["self:token"]);
		await minutes(runEnv, config, 2, 2, cloudflare([]));
		expect(await flagKeys()).toEqual([]);
		expect(box.sends).toBe(0);
	});

	it("flags an unset secret, and nothing without a tls check", async () => {
		const { runEnv, box } = mailbox();
		await minutes(runEnv, makeConfig([cert]), 0, 0, cloudflare([]));
		expect(await flagKeys()).toEqual(["self:token"]);
		await reset();
		await minutes(runEnv, makeConfig([web]), 0, 0, respond(200));
		expect(await flagKeys()).toEqual([]);
		expect(box.sends).toBe(0);
	});

	describe("stuck checks", () => {
		const config = makeConfig([web, cert]);

		it("flags a check with no conclusive result at exactly three intervals plus a minute, and no other", async () => {
			const { box, env: runEnv } = live();
			await minutes(runEnv, config, 0, 3, serve(503));
			expect(await flagKeys()).toEqual([]);
			await minutes(runEnv, config, 4, 4, serve(503));
			expect(await flagKeys()).toEqual(["self:stuck:cert"]);
			expect(await all("SELECT avail FROM state WHERE \"check\" = 'web'")).toEqual([{ avail: 1 }]);
			expect(box.sends).toBe(0);
			expect(await attentionOf(config)).toEqual(["SELF-CHECK: results for Certificate"]);
		});

		it("keeps the flag when a superseded run sees a conclusive result, clears it on a later one", async () => {
			const { box, env: runEnv } = live();
			await minutes(runEnv, config, 0, 5, serve(503));
			await env.DB.prepare(`UPDATE meta SET value = ?1 WHERE key = 'tick'`)
				.bind(String(base + 9 * MINUTE))
				.run();
			await minutes(runEnv, config, 6, 6, serve([]));
			expect(await flagKeys()).toEqual(["self:stuck:cert"]);
			await minutes(runEnv, config, 10, 12, serve([]));
			expect(await flagKeys()).toEqual([]);
			expect(box.sends).toBe(0);
		});

		it("gives a check added later three intervals plus a minute from when it was added", async () => {
			const { env: runEnv } = live();
			await minutes(runEnv, makeConfig([web]), 0, 9, serve(503));
			await minutes(runEnv, config, 10, 13, serve(503));
			expect(await flagKeys()).toEqual([]);
			await minutes(runEnv, config, 14, 14, serve(503));
			expect(await flagKeys()).toEqual(["self:stuck:cert"]);
		});

		it("counts a check by its own interval", async () => {
			const { env: runEnv } = live();
			const hourly = makeConfig([web, { ...cert, every: "1h" }]);
			await minutes(runEnv, hourly, 0, 5, serve(503));
			expect(await flagKeys()).toEqual([]);
			await tick(runEnv, hourly, base + 3 * 3_600_000 + MINUTE, base + 3 * 3_600_000 + MINUTE, serve(503));
			expect(await flagKeys()).toEqual(["self:stuck:cert"]);
		});

		it("flags a check that never runs because its slot is ahead of the clock, and clears when it runs", async () => {
			const { runEnv, box } = mailbox();
			const one = makeConfig([web]);
			await minutes(runEnv, one, 0, 0, respond(200));
			await env.DB.prepare(`UPDATE state SET slot = 9e15 WHERE "check" = 'web'`).run();
			await minutes(runEnv, one, 1, 4, respond(200));
			expect(await flagKeys()).toEqual(["self:stuck:web"]);
			await env.DB.prepare(`UPDATE state SET slot = -1`).run();
			await minutes(runEnv, one, 5, 5, respond(200));
			expect(await flagKeys()).toEqual([]);
			expect(box.sends).toBe(0);
		});

		it("flags a private check but shows only a public one in status", async () => {
			const { env: runEnv } = live();
			const hidden = makeConfig([{ ...cert, public: false }]);
			await minutes(runEnv, hidden, 0, 4, serve(503));
			expect((await status(env.DB, hidden, base + 5 * MINUTE)).self).toEqual([]);
			expect(await attentionOf(hidden)).toContain("SELF-CHECK: results for Certificate");
			expect((await status(env.DB, makeConfig([cert]), base + 5 * MINUTE)).self).toEqual([
				{ name: "results for Certificate", since: new Date(base + 4 * MINUTE).toISOString() },
			]);
		});

		it("drops the flag of a removed check", async () => {
			const { env: runEnv } = live();
			await minutes(runEnv, config, 0, 4, serve(503));
			expect(await flagKeys()).toEqual(["self:stuck:cert"]);
			await minutes(runEnv, makeConfig([web]), 5, 5, serve(503));
			expect(await flagKeys()).toEqual([]);
		});
	});

	it("flags a full relay without mail and clears it once the relay has room", async () => {
		const { runEnv, box } = mailbox();
		const token = "relay-secret";
		const config = makeConfig([web], {
			relays: [{ id: "alerts", name: "Alerts", token_sha256: await sha256(token), grace: "1h" }],
		});
		const fire = (key: string, state = "firing") =>
			incident(runEnv, config, token, JSON.stringify({ title: "t", deduplication_key: key, status: state }), base);
		for (let i = 0; i < MAX_KEYS; i++) await fire(`k${i}`);
		const queued = await all("SELECT count(*) AS n FROM outbox");
		await fire("overflow");
		expect(await all("SELECT count(*) AS n FROM outbox")).toEqual(queued);
		await steadyTick(runEnv, config, base + MINUTE, respond(200));
		expect(await flagKeys()).toContain("full:alerts");
		expect(await attentionOf(config)).toContain("SELF-CHECK: relay Alerts is full");
		expect(box.subjects.filter((s) => s.startsWith("SELF-CHECK"))).toEqual([]);
		await fire("k0", "resolved");
		await steadyTick(runEnv, config, base + 2 * MINUTE, respond(200));
		expect(await flagKeys()).not.toContain("full:alerts");
	});
});

describe("write self-check", () => {
	const triggers = {
		"a failed claim": `CREATE TRIGGER boom BEFORE UPDATE ON state BEGIN SELECT RAISE(ABORT, 'boom'); END`,
		"a failed main batch after a good claim": `CREATE TRIGGER boom BEFORE INSERT ON daily BEGIN SELECT RAISE(ABORT, 'boom'); END`,
	};
	const failed = (subjects: string[]) => subjects.filter((s) => s === "SELF-CHECK FAILING: database writes");
	const writes = () => all("SELECT key FROM meta WHERE key = 'writes'");

	describe.each(Object.entries(triggers))("%s", (_, trigger) => {
		const setup = async (extra: object = {}) => {
			const mail = mailbox();
			const config = makeConfig([web], extra);
			await tick(mail.runEnv, config, T0, T0, respond(200));
			await env.DB.prepare(trigger).run();
			const fail = (k: number) =>
				expect(tick(mail.runEnv, config, T0 + k * MINUTE, T0 + k * MINUTE, respond(200))).rejects.toThrow();
			return { ...mail, config, fail };
		};

		it("mails at the first failure, every 3 hours after, and nothing on recovery", async () => {
			const { runEnv, box, config, fail } = await setup();
			await fail(1);
			expect(box.subjects).toEqual(["SELF-CHECK FAILING: database writes"]);
			expect(box.bodies[0]).toContain("This repeats every 3 hours until a run writes.");
			for (let k = 2; k <= 180; k++) await fail(k);
			expect(failed(box.subjects)).toHaveLength(1);
			await fail(181);
			expect(failed(box.subjects)).toHaveLength(2);
			expect(await writes()).toHaveLength(1);
			await env.DB.prepare(`DROP TRIGGER boom`).run();
			await tick(runEnv, config, T0 + 182 * MINUTE, T0 + 182 * MINUTE, respond(200));
			expect(await writes()).toEqual([]);
			expect(failed(box.subjects)).toHaveLength(2);
		});

		it("retries the mail on the next run when the first send fails", async () => {
			const { box, fail } = await setup();
			box.failing = true;
			await fail(1);
			box.failing = false;
			await fail(2);
			await fail(3);
			expect(box.subjects).toEqual(Array(2).fill("SELF-CHECK FAILING: database writes"));
		});

		it("lists the failure in the digest while it holds", async () => {
			const { config, fail } = await setup({ digest: "23:00" });
			await fail(1);
			expect(await attentionOf(config)).toEqual(["SELF-CHECK: database writes"]);
		});
	});

	it("still mails, and rethrows the original error, when meta is unwritable", async () => {
		const mail = mailbox();
		const config = makeConfig([web]);
		await tick(mail.runEnv, config, T0, T0, respond(200));
		await env.DB.prepare(`CREATE TRIGGER boom BEFORE INSERT ON meta BEGIN SELECT RAISE(ABORT, 'boom'); END`).run();
		await expect(tick(mail.runEnv, config, T0 + MINUTE, T0 + MINUTE, respond(200))).rejects.toThrow("boom");
		expect(failed(mail.box.subjects)).toHaveLength(1);
	});

	it("sends nothing for a cron that merely skips runs", async () => {
		const { runEnv, box } = mailbox();
		const config = makeConfig();
		let t = T0;
		await tick(runEnv, config, t, t, respond(200));
		for (const gap of [2 * MINUTE, 182_000, 182_000, 4 * MINUTE]) {
			t += gap;
			await watch(runEnv, config, t);
			await tick(runEnv, config, t, t, respond(200));
		}
		expect(box.sends).toBe(0);
		expect(await all("SELECT key FROM meta WHERE key = 'stall' OR key LIKE 'self:%'")).toEqual([]);
	});
});

describe("deploy grace", () => {
	const config = makeConfig();
	const stalls = (box: { subjects: string[] }) => box.subjects.filter((s) => s.includes("stalled"));
	const deployedAt = (t: number) => ({ id: "v1", timestamp: new Date(t).toISOString() });

	it("raises no stall inside the grace even with no ticks past the window", async () => {
		const { runEnv, box } = mailbox();
		await tick(runEnv, config, T0, T0, respond(200));
		const graced = { ...runEnv, VERSION: deployedAt(T0 + 4 * MINUTE) };
		await watch(graced, config, T0 + 10 * MINUTE);
		await watch(graced, config, T0 + 4 * MINUTE + DEPLOY_GRACE_MS - 1);
		expect(box.sends).toBe(0);
		expect(await all("SELECT * FROM meta WHERE key = 'stall'")).toEqual([]);
	});

	it("raises as before once the grace has passed", async () => {
		const { runEnv, box } = mailbox();
		await tick(runEnv, config, T0, T0, respond(200));
		const graced = { ...runEnv, VERSION: deployedAt(T0 + 4 * MINUTE) };
		await watch(graced, config, T0 + 4 * MINUTE + DEPLOY_GRACE_MS);
		expect(stalls(box)).toHaveLength(1);
	});

	it("gives no grace for a missing or unparsable timestamp", async () => {
		for (const VERSION of [{ id: "v1" }, { id: "v1", timestamp: "not a date" }]) {
			await reset();
			const { runEnv, box } = mailbox();
			await tick(runEnv, config, T0, T0, respond(200));
			await watch({ ...runEnv, VERSION }, config, T0 + 5 * MINUTE);
			expect(stalls(box)).toHaveLength(1);
		}
	});

	it("raises a deploy that never ticks at the later of grace end and the normal window", async () => {
		const { runEnv, box } = mailbox();
		await tick(runEnv, config, T0, T0, respond(200));
		const late = { ...runEnv, VERSION: deployedAt(T0 + 30 * MINUTE) };
		await watch(late, config, T0 + 30 * MINUTE + DEPLOY_GRACE_MS - 1);
		expect(stalls(box)).toHaveLength(0);
		await watch(late, config, T0 + 30 * MINUTE + DEPLOY_GRACE_MS);
		expect(stalls(box)).toHaveLength(1);

		await reset();
		const again = mailbox();
		await tick(again.runEnv, config, T0, T0, respond(200));
		const early = { ...again.runEnv, VERSION: deployedAt(T0 - 20 * MINUTE) };
		await watch(early, config, T0 + 5 * MINUTE);
		expect(stalls(again.box)).toHaveLength(1);
	});
});

describe("stalled prober", () => {
	const config = makeConfig();
	const stalls = (box: { subjects: string[] }) => box.subjects.filter((s) => s.includes("stalled"));
	const ONSET = T0 + 5 * MINUTE;

	it("says nothing before the prober has ever run", async () => {
		const { runEnv, box } = mailbox();
		await watch(runEnv, config, T0);
		expect(box.sends).toBe(0);
		expect(await all("SELECT * FROM meta WHERE key = 'stall'")).toEqual([]);
	});

	it("waits three of the shortest interval plus a minute", async () => {
		const { runEnv, box } = mailbox();
		const hourly = makeConfig([{ ...web, every: "1h" }]);
		await tick(runEnv, hourly, T0, T0, respond(200));
		await watch(runEnv, hourly, T0 + 4 * MINUTE);
		expect(box.sends).toBe(0);
		await watch(runEnv, hourly, T0 + 3 * 3_600_000 + MINUTE + 1);
		expect(stalls(box)).toHaveLength(1);
	});

	it("words the mail with the last run, the detection time and the repeat", async () => {
		const { runEnv, box } = mailbox();
		await tick(runEnv, config, T0, T0, respond(200));
		await watch(runEnv, config, ONSET);
		expect(box.subjects).toEqual(["SELF-CHECK FAILING: probing stalled"]);
		expect(box.bodies[0]).toBe(
			`No probe run has written results since ${new Date(T0).toISOString()}; detected ${new Date(ONSET).toISOString()}. The prober's cron trigger or its runs are failing; its Worker log says which. This repeats every 3 hours until probing resumes.\r\n`,
		);
	});

	describe("stall", () => {
		const stalled = makeConfig([web]);
		const start = async () => {
			const mail = mailbox();
			await tick(mail.runEnv, stalled, T0 - 60 * MINUTE, T0 - 60 * MINUTE, respond(200));
			return mail;
		};
		const onset = T0 - 55 * MINUTE;

		it("mails at onset, not again for 179 minutes, and again at 180", async () => {
			const { runEnv, box } = await start();
			await watch(runEnv, stalled, onset);
			expect(stalls(box)).toHaveLength(1);
			for (let k = 1; k < 180; k++) await watch(runEnv, stalled, onset + k * MINUTE);
			expect(stalls(box)).toHaveLength(1);
			await watch(runEnv, stalled, onset + 180 * MINUTE);
			expect(stalls(box)).toHaveLength(2);
		});

		it("mails on whichever call first lands after 180 minutes, however many minutes were skipped", async () => {
			const { runEnv, box } = await start();
			await watch(runEnv, stalled, onset);
			await watch(runEnv, stalled, onset + 180 * MINUTE + 7 * MINUTE);
			expect(stalls(box)).toHaveLength(2);
		});

		it("clears on a fresh run without mail, and the next stall mails at once", async () => {
			const { runEnv, box } = await start();
			await watch(runEnv, stalled, onset);
			await tick(runEnv, stalled, onset + MINUTE, onset + MINUTE, respond(200));
			await tick(runEnv, stalled, onset + 2 * MINUTE, onset + 2 * MINUTE, respond(200));
			expect(await all("SELECT * FROM meta WHERE key = 'stall'")).toEqual([]);
			expect(stalls(box)).toHaveLength(1);
			await watch(runEnv, stalled, onset + 10 * MINUTE);
			expect(stalls(box)).toHaveLength(2);
		});

		it("retries a mail that failed to send on the next watch", async () => {
			const { runEnv, box } = await start();
			box.failing = true;
			await watch(runEnv, stalled, onset);
			box.failing = false;
			await watch(runEnv, stalled, onset + MINUTE);
			await watch(runEnv, stalled, onset + 2 * MINUTE);
			expect(stalls(box)).toHaveLength(2);
		});
	});

	it("stays raised when a superseded run commits fresh results", async () => {
		const { runEnv, box } = mailbox();
		await tick(runEnv, config, T0, T0, respond(200));
		await watch(runEnv, config, ONSET);
		await env.DB.prepare(`UPDATE meta SET value = ?1 WHERE key = 'tick'`)
			.bind(String(T0 + 9 * MINUTE))
			.run();
		await tick(runEnv, config, T0 + 6 * MINUTE, T0 + 6 * MINUTE, respond(200));
		expect(stalls(box)).toHaveLength(1);
		expect(await all("SELECT key FROM meta WHERE key = 'stall'")).toEqual([{ key: "stall" }]);
	});

	it("stays raised while a committed run still writes no result", async () => {
		const { runEnv, box } = mailbox();
		await tick(runEnv, config, T0, T0, respond(200));
		await watch(runEnv, config, ONSET);
		await env.DB.prepare(`UPDATE state SET slot = 9e15`).run();
		await tick(runEnv, config, T0 + 6 * MINUTE, T0 + 6 * MINUTE, respond(200));
		await tick(runEnv, config, T0 + 7 * MINUTE, T0 + 7 * MINUTE, respond(200));
		expect(stalls(box)).toHaveLength(1);
		expect(await all("SELECT key FROM meta WHERE key = 'stall'")).toEqual([{ key: "stall" }]);
	});

	it("never sends OK, DEPLOYED or resumed", async () => {
		const { runEnv, box } = mailbox();
		await tick(runEnv, config, T0, T0, respond(200));
		await watch(runEnv, config, ONSET);
		await tick({ ...runEnv, VERSION: { id: "v2" } }, config, T0 + 6 * MINUTE, T0 + 6 * MINUTE, respond(200));
		await tick({ ...runEnv, VERSION: { id: "v2" } }, config, T0 + 7 * MINUTE, T0 + 7 * MINUTE, respond(200));
		expect(box.subjects).toEqual(["SELF-CHECK FAILING: probing stalled"]);
	});
});

describe("stalled prober with a digest", () => {
	const quiet = makeConfig([web], { digest: "12:00" });

	it("mails the stall once when the digest queue fails after the stall mail", async () => {
		const { runEnv, box } = mailbox();
		await tick(runEnv, quiet, T0 - 30 * MINUTE, T0 - 30 * MINUTE, respond(200));
		await env.DB.prepare(`CREATE TRIGGER boom BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'boom'); END`).run();
		await watch(runEnv, quiet, T0 + 20 * MINUTE);
		expect(box.subjects).toEqual(["SELF-CHECK FAILING: probing stalled"]);
	});

	it("mails one digest listing a stalled prober when only watch() runs through the digest time", async () => {
		const { runEnv, box } = mailbox();
		await tick(runEnv, quiet, T0 - 30 * MINUTE, T0 - 30 * MINUTE, respond(200));
		for (let m = -20; m <= 25 * 60; m += 5) await watch(runEnv, quiet, T0 + m * MINUTE);
		const digests = box.subjects.filter((s) => s.startsWith("DIGEST"));
		expect(box.subjects.filter((s) => !s.startsWith("DIGEST"))).toEqual(
			Array(box.subjects.length - digests.length).fill("SELF-CHECK FAILING: probing stalled"),
		);
		expect(digests).toHaveLength(2);
		expect(box.bodies.filter((b) => b.includes("SELF-CHECK: probing stalled"))).toHaveLength(2);
		expect((await attention(env.DB, quiet)).lines).toEqual(["SELF-CHECK: probing stalled"]);
	});
});
