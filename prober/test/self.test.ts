import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { towerMessage } from "../src/mail.ts";
import { incident, MAX_KEYS } from "../src/relay.ts";
import { tick } from "../src/run.ts";
import { attention } from "../src/self.ts";
import { status } from "../src/status.ts";
import { all, MINUTE, mailbox, makeConfig, reset, respond, steadyTick, T0, VERSION, web } from "./util.ts";

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
		expect(box.subjects).toEqual(["DEPLOYED: tower 0.1.0"]);
		await tick({ ...runEnv, VERSION: { id: "v2" } }, config, T0 + 2 * MINUTE, respond(200));
		await tick({ ...runEnv, VERSION: { id: "v2" } }, config, T0 + 3 * MINUTE, respond(200));
		expect(box.subjects).toHaveLength(2);
		expect(VERSION.id).toBe("v1");
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
		const hash = Array.from(
			new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("relay-secret"))),
			(b) => b.toString(16).padStart(2, "0"),
		).join("");
		const config = makeConfig([unhealthy], {
			digest: "07:30",
			relays: [{ id: "alerts", name: "Alerts", token_sha256: hash, grace: "1d" }],
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
		const [subject, body] =
			towerMessage(config, { at: at(7, 30), key: "digest", kind: "digest", since: null, reason: null }, lines) ?? [];
		expect(subject).toBe("DIGEST: Example 2026-10-08: 5 need attention");
		expect(body).toBe(`${lines.join("\n")}\n`);
		expect(
			towerMessage(config, { at: at(7, 30), key: "digest", kind: "digest", since: null, reason: null }, []),
		).toEqual(["DIGEST: Example 2026-10-08: all up", ""]);
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
		const hash = Array.from(
			new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))),
			(b) => b.toString(16).padStart(2, "0"),
		).join("");
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
