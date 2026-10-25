import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { hyperdx } from "../../test/fixture/hyperdx-incidentio.ts";
import { incident, kept } from "../src/relay.ts";
import { drain } from "../src/run.ts";
import { attention } from "../src/self.ts";
import { all, MINUTE, mailbox, makeConfig, reset, respond, sha256, T0, steadyTick as tick, web } from "./util.ts";

beforeEach(reset);

const TOKEN = "relay-secret";
const SAME_LENGTH = "relay-secreu";

const hash = await sha256(TOKEN);
const config = makeConfig([web], {
	relays: [
		{ id: "alerts", name: "Alerts", token_sha256: hash, grace: "15m" },
		{ id: "other", name: "Other", token_sha256: await sha256("other-secret"), grace: "1h" },
	],
});

const send = (runEnv: ReturnType<typeof mailbox>["runEnv"], body: string, at = T0, token = TOKEN) =>
	incident(runEnv, config, token, body, at);
const result = async (res: Response) => (await res.json<{ result: string }>()).result;
const keys = () => all("SELECT relay, key, title FROM relay_keys ORDER BY relay, key");
const outbox = () => all('SELECT "check", key, kind FROM outbox ORDER BY rowid');
const payload = (o: object) => JSON.stringify({ title: "Disk full", deduplication_key: "k1", status: "firing", ...o });

describe("incident", () => {
	it("mails a firing once inline and answers duplicate for a repeat", async () => {
		const { runEnv, box } = mailbox();
		const first = await send(runEnv, hyperdx("ALERT"));
		expect(first.status).toBe(202);
		expect(await result(first)).toBe("transition");
		expect(box.sends).toBe(1);
		expect(await result(await send(runEnv, hyperdx("ALERT"), T0 + MINUTE))).toBe("duplicate");
		expect(box.sends).toBe(1);
		expect(await outbox()).toEqual([]);
		expect(await keys()).toEqual([{ relay: "alerts", key: "evt-1", title: "Alert for Errors - 12 exceeds 10" }]);
	});

	it("mails a resolved once and answers duplicate for a repeat or an unknown key", async () => {
		const { runEnv, box } = mailbox();
		await send(runEnv, hyperdx("ALERT"));
		expect(await result(await send(runEnv, hyperdx("OK"), T0 + MINUTE))).toBe("transition");
		expect(box.sends).toBe(2);
		expect(await result(await send(runEnv, hyperdx("OK"), T0 + 2 * MINUTE))).toBe("duplicate");
		expect(await result(await send(runEnv, hyperdx("OK", "never-fired")))).toBe("duplicate");
		expect(box.sends).toBe(2);
		expect(await keys()).toEqual([]);
	});

	it("rejects a missing key, a bad status and unparseable JSON with 400 and writes nothing", async () => {
		const { runEnv, box } = mailbox();
		for (const body of [
			payload({ deduplication_key: undefined }),
			payload({ deduplication_key: "" }),
			payload({ deduplication_key: "k".repeat(257) }),
			payload({ status: "error" }),
			payload({ title: "" }),
			"not json",
			"[]",
		]) {
			expect((await send(runEnv, body)).status).toBe(400);
		}
		expect(await keys()).toEqual([]);
		expect(await outbox()).toEqual([]);
		expect(box.sends).toBe(0);
	});

	it("answers 404 to a wrong, same-length or empty token before writing anything", async () => {
		const { runEnv, box } = mailbox();
		for (const token of ["wrong", SAME_LENGTH, ""]) {
			expect((await send(runEnv, payload({}), T0, token)).status).toBe(404);
		}
		expect((await send(runEnv, "not json", T0, SAME_LENGTH)).status).toBe(404);
		const blank = makeConfig([web], { relays: [{ id: "blank", name: "Blank", token_sha256: await sha256("") }] });
		expect((await incident(runEnv, blank, "", payload({}), T0)).status).toBe(404);
		expect(await keys()).toEqual([]);
		expect(await outbox()).toEqual([]);
		expect(box.sends).toBe(0);
	});

	it("clips a long title and description, ignores unknown keys, keeps source_url", async () => {
		const { runEnv, box } = mailbox();
		box.failing = true;
		const long = payload({
			title: "t".repeat(5000),
			description: "d".repeat(9000),
			source_url: "https://x.example/a",
			extra: 1,
			metadata: { a: 1 },
		});
		expect((await send(runEnv, long)).status).toBe(202);
		const [row] = await all<{ reason: string }>(`SELECT reason FROM outbox`);
		const stored = JSON.parse(row.reason);
		expect(stored.title).toHaveLength(900);
		expect(stored.description).toHaveLength(4000);
		expect(Object.keys(stored).sort()).toEqual(["description", "source_url", "title"]);
	});

	it("keeps a one-key-per-relay namespace: one key on two relays mails twice", async () => {
		const { runEnv, box } = mailbox();
		await send(runEnv, payload({}));
		await incident(runEnv, config, "other-secret", payload({}), T0);
		expect(box.sends).toBe(2);
		expect((await keys()).map((k) => k.relay)).toEqual(["alerts", "other"]);
	});

	it("rejects the 101st key, mails one FAILING and then stays quiet", async () => {
		const { runEnv, box } = mailbox();
		await env.DB.prepare(
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 99)
			 INSERT INTO relay_keys (relay, "key", title, since, seen) SELECT 'alerts', 'k' || i, 't', ?1, ?1 FROM n`,
		)
			.bind(T0)
			.run();
		expect(await result(await send(runEnv, payload({ deduplication_key: "extra" }), T0 + 200))).toBe("rejected");
		expect(box.sends).toBe(0);
		await drain(runEnv, config);
		expect(box.sends).toBe(1);
		expect(await result(await send(runEnv, payload({ deduplication_key: "extra2" }), T0 + 202))).toBe("rejected");
		expect(await result(await send(runEnv, payload({ deduplication_key: "k5" }), T0 + 203))).toBe("duplicate");
		await drain(runEnv, config);
		expect(box.sends).toBe(1);
		expect(await all("SELECT count(*) AS n FROM relay_keys")).toEqual([{ n: 100 }]);
	});

	it("mails one transition for concurrent firings of one key", async () => {
		const { runEnv, box } = mailbox();
		const results = await Promise.all(Array.from({ length: 5 }, () => send(runEnv, payload({}))));
		expect((await Promise.all(results.map(result))).filter((r) => r === "transition")).toHaveLength(1);
		expect(box.sends).toBe(1);
	});

	it("answers 202 when the send fails and lets the next tick send it", async () => {
		const { runEnv, box } = mailbox();
		box.failing = true;
		const res = await send(runEnv, payload({}));
		expect(res.status).toBe(202);
		expect(await result(res)).toBe("transition");
		expect(await outbox()).toEqual([{ check: "alerts", key: "k1", kind: "firing" }]);
		box.failing = false;
		const sentBefore = box.sends;
		await tick(runEnv, config, T0 + MINUTE, respond(200));
		expect(box.sends).toBe(sentBefore + 1);
		expect(await outbox()).toEqual([]);
	});

	it("sends once when the inline drain races the cron", async () => {
		const { runEnv, box } = mailbox();
		box.failing = true;
		await send(runEnv, payload({}));
		box.failing = false;
		const before = box.sends;
		await Promise.all([drain(runEnv, config), tick(runEnv, config, T0 + MINUTE, respond(200))]);
		expect(box.sends).toBe(before + 1);
	});
});

describe("verbatim mail", () => {
	it("mails the sender's title as the subject and its description as the body", async () => {
		const { runEnv, box } = mailbox();
		await send(runEnv, hyperdx("ALERT"));
		await send(runEnv, hyperdx("OK"), T0 + MINUTE);
		expect(box.subjects).toEqual(["Alert for Errors - 12 exceeds 10", "Alert for Errors - 12 exceeds 10"]);
		for (const body of box.bodies) expect(body.replaceAll("\r\n", "\n")).toBe("12 errors in the last 5 minutes");
	});

	it("stores a title with accents and emoji as sent, and the digest line shows it", async () => {
		const { runEnv } = mailbox();
		const title = "\u{1f6a8} caf\u00e9 down";
		const quiet = makeConfig([web], {
			digest: "12:00",
			relays: [{ id: "alerts", name: "Alerts", token_sha256: hash, digest_only: true }],
		});
		await incident(runEnv, quiet, TOKEN, payload({ title }), T0);
		expect(await all("SELECT title FROM relay_fired")).toEqual([{ title }]);
		expect((await attention(env.DB, quiet)).lines[0].startsWith(`${title}: fired 1`)).toBe(true);
	});

	it("rejects a blank or whitespace-only title", async () => {
		const { runEnv } = mailbox();
		for (const title of ["", "  \n\t"]) expect((await send(runEnv, payload({ title }))).status).toBe(400);
		expect(await keys()).toEqual([]);
	});

	it("mails a resolve under the firing title, the latest one", async () => {
		const { runEnv, box } = mailbox();
		await send(runEnv, payload({ title: "GPU at 50 C on gpu-1" }));
		await send(runEnv, payload({ title: "GPU at 52 C on gpu-1" }), T0 + MINUTE);
		await send(runEnv, payload({ status: "resolved", title: "GPU at 50 C" }), T0 + 2 * MINUTE);
		expect(box.subjects).toEqual(["GPU at 50 C on gpu-1", "GPU at 52 C on gpu-1"]);
	});
});

describe("burst", () => {
	const fire = (runEnv: ReturnType<typeof mailbox>["runEnv"], i: number, at: number) =>
		send(runEnv, payload({ deduplication_key: `k${i}` }), at);

	it("mails five transitions inline, queues the rest and sends them as one summary", async () => {
		const { runEnv, box } = mailbox();
		for (let i = 0; i < 20; i++) expect(await result(await fire(runEnv, i, T0 + i * 1000))).toBe("transition");
		expect(box.sends).toBe(5);
		expect(await all("SELECT count(*) AS n FROM outbox")).toEqual([{ n: 15 }]);
		await tick(runEnv, config, T0 + MINUTE, respond(200));
		expect(box.sends).toBe(6);
		expect(await outbox()).toEqual([]);
	});

	it("covers each key in exactly one mail across the inline singles and the summary", async () => {
		const { runEnv, box } = mailbox();
		const titles = Array.from({ length: 9 }, (_, i) => `Incident number ${i}`);
		for (const [i, title] of titles.entries())
			await send(runEnv, payload({ title, deduplication_key: `k${i}` }), T0 + i * 1000);
		await tick(runEnv, config, T0 + MINUTE, respond(200));
		for (const title of titles) {
			expect(box.subjects.filter((s, i) => s.includes(title) || box.bodies[i].includes(title))).toHaveLength(1);
		}
		expect(box.subjects.filter((s) => s.startsWith("ALERTS:"))).toEqual(["ALERTS: Alerts: 4 changed"]);
		expect(box.sends).toBe(6);
	});

	it("does not count duplicates and resets the window after a minute", async () => {
		const { runEnv, box } = mailbox();
		await fire(runEnv, 0, T0);
		for (let i = 0; i < 10; i++) await fire(runEnv, 0, T0 + 1000 + i);
		for (let i = 1; i < 5; i++) await fire(runEnv, i, T0 + 2000 + i);
		expect(box.sends).toBe(5);
		await fire(runEnv, 5, T0 + 3000);
		expect(box.sends).toBe(5);
		await fire(runEnv, 0, T0 + 4000);
		await fire(runEnv, 5, T0 + 4001);
		expect(box.sends).toBe(5);
		await fire(runEnv, 6, T0 + MINUTE + 3000);
		expect(box.sends).toBe(6);
		expect(box.subjects.at(-1)).toBe("ALERTS: Alerts: 2 changed");
		expect(await outbox()).toEqual([]);
	});

	it("leaves queued rows for the cron when a duplicate follows a failed inline send", async () => {
		const { runEnv, box } = mailbox();
		await fire(runEnv, 0, T0);
		box.failing = true;
		await fire(runEnv, 1, T0 + 1);
		const sent = box.sends;
		box.failing = false;
		await fire(runEnv, 1, T0 + 2);
		expect(box.sends).toBe(sent);
	});

	it("bounds a relay's pending mail while the mailer is down", async () => {
		const { runEnv, box } = mailbox();
		box.failing = true;
		let last = "";
		for (let i = 0; i < 300; i++) {
			last = await result(await fire(runEnv, i, T0));
			await send(runEnv, payload({ deduplication_key: `k${i}`, status: "resolved" }), T0);
		}
		expect(last).toBe("rejected");
		const [{ n }] = await all<{ n: number }>("SELECT count(*) AS n FROM outbox");
		expect(n).toBeLessThanOrEqual(400);
	});

	it("caps the summary lines", async () => {
		const { runEnv, box } = mailbox();
		for (let i = 0; i < 80; i++) await fire(runEnv, i, T0);
		await tick(runEnv, config, T0 + MINUTE, respond(200));
		expect(box.subjects.at(-1)).toBe("ALERTS: Alerts: 75 changed");
	});

	it("keeps one relay's burst from queueing another's mail", async () => {
		const { runEnv, box } = mailbox();
		for (let i = 0; i < 8; i++) await fire(runEnv, i, T0 + i);
		await incident(runEnv, config, "other-secret", payload({}), T0 + 10);
		expect(box.sends).toBe(6);
	});
});

describe("lease", () => {
	it("closes a key with one STOPPED REPORTING after grace, and a re-fire mails again", async () => {
		const { runEnv, box } = mailbox();
		await send(runEnv, payload({}));
		await tick(runEnv, config, T0 + 14 * MINUTE, respond(200));
		expect(box.sends).toBe(1);
		await tick(runEnv, config, T0 + 16 * MINUTE, respond(200));
		expect(box.sends).toBe(2);
		expect(await keys()).toEqual([]);
		await tick(runEnv, config, T0 + 17 * MINUTE, respond(200));
		expect(box.sends).toBe(2);
		expect(await result(await send(runEnv, payload({}), T0 + 18 * MINUTE))).toBe("transition");
		expect(box.sends).toBe(3);
	});

	it("keeps a key open while duplicates arrive inside grace", async () => {
		const { runEnv, box } = mailbox();
		await send(runEnv, payload({}));
		await send(runEnv, payload({}), T0 + 10 * MINUTE);
		await tick(runEnv, config, T0 + 20 * MINUTE, respond(200));
		expect(box.sends).toBe(1);
		expect(await keys()).toHaveLength(1);
		await tick(runEnv, config, T0 + 26 * MINUTE, respond(200));
		expect(box.sends).toBe(2);
	});

	it("uses each relay's own grace", async () => {
		const { runEnv, box } = mailbox();
		await incident(runEnv, config, "other-secret", payload({}), T0);
		await tick(runEnv, config, T0 + 30 * MINUTE, respond(200));
		expect(box.sends).toBe(1);
		await tick(runEnv, config, T0 + 61 * MINUTE, respond(200));
		expect(box.sends).toBe(2);
	});

	it("drops keys and mail of a relay removed from config", async () => {
		const { runEnv, box } = mailbox();
		box.failing = true;
		await send(runEnv, payload({}));
		await tick(runEnv, makeConfig([web]), T0 + MINUTE, respond(200));
		expect(await keys()).toEqual([]);
		expect(await outbox()).toEqual([]);
	});
});

describe("routing", () => {
	const team = ["a@example.com", "b@example.com"];
	const routed = makeConfig([web], {
		relays: [{ id: "alerts", name: "Alerts", token_sha256: hash, grace: "15m", to: team }],
	});
	const post = (runEnv: ReturnType<typeof mailbox>["runEnv"], o: object, at: number) =>
		incident(runEnv, routed, TOKEN, payload(o), at);
	const mails = (box: { subjects: string[]; to: string[] }) => box.subjects.map((s, i) => `${s} -> ${box.to[i]}`);

	it("mails firing, resolved and STOPPED REPORTING to each of the relay's addresses", async () => {
		const { runEnv, box } = mailbox();
		await post(runEnv, {}, T0);
		await post(runEnv, { status: "resolved" }, T0 + 1);
		await post(runEnv, { deduplication_key: "k2", title: "Disk slow" }, T0 + 2);
		await tick(runEnv, routed, T0 + 16 * MINUTE, respond(200));
		expect(mails(box)).toEqual([
			"Disk full -> a@example.com",
			"Disk full -> b@example.com",
			"Disk full -> a@example.com",
			"Disk full -> b@example.com",
			"Disk slow -> a@example.com",
			"Disk slow -> b@example.com",
			"STOPPED REPORTING: Alerts: Disk slow -> a@example.com",
			"STOPPED REPORTING: Alerts: Disk slow -> b@example.com",
		]);
		expect(await outbox()).toEqual([]);
	});

	it("sends one ALERTS summary to each address", async () => {
		const { runEnv, box } = mailbox();
		for (let i = 0; i < 7; i++) await post(runEnv, { deduplication_key: `k${i}` }, T0 + i);
		expect(box.sends).toBe(10);
		await tick(runEnv, routed, T0 + MINUTE, respond(200));
		expect(mails(box).slice(10)).toEqual([
			"ALERTS: Alerts: 2 changed -> a@example.com",
			"ALERTS: Alerts: 2 changed -> b@example.com",
		]);
	});

	it("counts the backlog in events, not in mails", async () => {
		const { runEnv, box } = mailbox();
		box.failing = true;
		const results: string[] = [];
		for (let i = 0; i < 120; i++) {
			results.push(await result(await post(runEnv, { deduplication_key: `k${i}` }, T0)));
			await post(runEnv, { deduplication_key: `k${i}`, status: "resolved" }, T0);
		}
		expect(results.filter((r) => r === "transition")).toHaveLength(100);
		expect(results.at(-1)).toBe("rejected");
		expect(await all("SELECT count(*) AS n FROM outbox")).toEqual([{ n: 400 }]);
	});
});

describe("digest_only relay", () => {
	const quiet = makeConfig([web], {
		digest: "12:00",
		relays: [{ id: "alerts", name: "Alerts", token_sha256: hash, digest_only: true }],
	});
	const at = (h: number, m: number, day = 0) => Date.UTC(2026, 9, 8 + day, h, m);
	const post = (runEnv: ReturnType<typeof mailbox>["runEnv"], o: object, t: number) =>
		incident(runEnv, quiet, TOKEN, payload(o), t);
	const digests = (box: { subjects: string[]; bodies: string[] }) =>
		box.subjects.flatMap((s, i) => (s.startsWith("DIGEST") ? [box.bodies[i].replaceAll("\r\n", "\n")] : []));

	it("records firing and resolve without outbox rows or mail", async () => {
		const { runEnv, box } = mailbox();
		expect(await result(await post(runEnv, {}, T0))).toBe("transition");
		expect(await result(await post(runEnv, {}, T0 + MINUTE))).toBe("duplicate");
		expect(await result(await post(runEnv, { status: "resolved" }, T0 + 2 * MINUTE))).toBe("transition");
		expect(await outbox()).toEqual([]);
		expect(await keys()).toEqual([]);
		expect(box.sends).toBe(0);
	});

	it("expires a silent key without mail", async () => {
		const { runEnv, box } = mailbox();
		await post(runEnv, {}, T0);
		await tick(runEnv, quiet, T0 + 20 * MINUTE, respond(200));
		expect(await keys()).toEqual([]);
		expect(await outbox()).toEqual([]);
		expect(box.subjects.filter((x) => x.startsWith("STOPPED"))).toEqual([]);
	});

	it("lists a key that fired and resolved by title with its count, first and last, then clears it", async () => {
		const { runEnv, box } = mailbox();
		await post(runEnv, {}, at(9, 0));
		await post(runEnv, {}, at(9, 5));
		await post(runEnv, { status: "resolved" }, at(9, 10));
		await post(runEnv, {}, at(9, 30));
		await post(runEnv, { status: "resolved" }, at(9, 40));
		expect(await outbox()).toEqual([]);
		await tick(runEnv, quiet, at(12, 0), respond(200));
		const [digest] = digests(box);
		expect(box.subjects).toHaveLength(1);
		expect(digest).toContain("Disk full: fired 2, first 10-08 09:00Z, last 10-08 09:30Z, resolved\n");
		expect(await all("SELECT * FROM relay_fired")).toEqual([]);
		await tick(runEnv, quiet, at(12, 0, 1), respond(200));
		expect(digests(box)[1]).not.toContain("Disk full");
	});

	it("reads open for a key still firing at the digest, and counts it as needing attention", async () => {
		const { runEnv, box } = mailbox();
		await post(runEnv, {}, at(9, 0));
		await post(runEnv, { deduplication_key: "k2", title: "Gone" }, at(9, 1));
		await post(runEnv, { deduplication_key: "k2", title: "Gone", status: "resolved" }, at(9, 2));
		await post(runEnv, {}, at(11, 55));
		await tick(runEnv, quiet, at(12, 0), respond(200));
		expect(box.subjects).toEqual(["DIGEST: Example 2026-10-08: 1 need attention"]);
		expect(digests(box)[0]).toContain("Disk full: fired 1, first 10-08 09:00Z, last 10-08 11:55Z, open\n");
		expect(digests(box)[0]).not.toContain("OPEN:");
	});

	it("keeps the tally when the digest fails to send and clears it when one is sent", async () => {
		const { runEnv, box } = mailbox();
		await post(runEnv, {}, at(9, 0));
		await post(runEnv, { status: "resolved" }, at(9, 10));
		box.failing = true;
		await tick(runEnv, quiet, at(12, 0), respond(200));
		expect(await all("SELECT n FROM relay_fired")).toEqual([{ n: 1 }]);
		box.failing = false;
		await tick(runEnv, quiet, at(12, 1), respond(200));
		expect(digests(box).at(-1)).toContain("Disk full: fired 1");
		expect(await all("SELECT n FROM relay_fired")).toEqual([]);
	});

	it("does not count a re-post as a fire, and a re-created row after a digest reads fired 0", async () => {
		const { runEnv } = mailbox();
		await post(runEnv, {}, at(9, 0));
		await post(runEnv, {}, at(9, 5));
		expect(await all("SELECT n FROM relay_fired")).toEqual([{ n: 1 }]);
		await env.DB.prepare("DELETE FROM relay_fired").run();
		await post(runEnv, {}, at(9, 10));
		expect(await all("SELECT n, first_at, last_at FROM relay_fired")).toEqual([
			{ n: 0, first_at: at(9, 10), last_at: at(9, 10) },
		]);
	});

	it("keeps the latest firing title, and a resolve with another title does not overwrite it", async () => {
		const { runEnv, box } = mailbox();
		await post(runEnv, { title: "GPU at 50 C on gpu-1" }, at(9, 0));
		await post(runEnv, { title: "GPU at 52 C on gpu-1" }, at(9, 5));
		await post(runEnv, { status: "resolved", title: "GPU at 50 C" }, at(9, 10));
		await tick(runEnv, quiet, at(12, 0), respond(200));
		expect(digests(box)[0]).toContain("GPU at 52 C on gpu-1: fired 1");
		expect(digests(box)[0]).not.toContain("GPU at 50 C:");
	});

	it("starts the digest line with the title and never shows the description", async () => {
		const { runEnv, box } = mailbox();
		await post(runEnv, { title: "observe-hyperdx logged 165 warnings", description: "Group: x\nmore" }, at(9, 0));
		await tick(runEnv, quiet, at(12, 0), respond(200));
		expect(digests(box)[0].startsWith("observe-hyperdx logged 165 warnings: fired 1")).toBe(true);
		expect(digests(box)[0]).not.toContain("Group:");
	});

	it("stops tallying new keys at the cap but still records them as open", async () => {
		const { runEnv } = mailbox();
		for (let i = 0; i < 100; i++) await post(runEnv, { deduplication_key: `k${i}` }, at(9, 0));
		await env.DB.prepare(`DELETE FROM relay_keys`).run();
		await post(runEnv, { deduplication_key: "over" }, at(9, 1));
		expect(await all("SELECT count(*) AS n FROM relay_fired")).toEqual([{ n: 100 }]);
		expect(await keys()).toEqual([{ relay: "alerts", key: "over", title: "Disk full" }]);
		await post(runEnv, { deduplication_key: "k5" }, at(9, 2));
		expect(await all("SELECT n FROM relay_fired WHERE key = 'k5'")).toEqual([{ n: 2 }]);
	});

	it("caps the digest at 50 tally lines and says how many more", async () => {
		const { runEnv, box } = mailbox();
		for (let i = 0; i < 60; i++) await post(runEnv, { deduplication_key: `k${i}`, title: `T${i}` }, at(9, 0));
		await tick(runEnv, quiet, at(12, 0), respond(200));
		expect(digests(box)[0]).toContain("and 10 more\n");
		expect(digests(box)[0].match(/: fired 1,/g)).toHaveLength(50);
	});
});

describe("maintenance relay", () => {
	const kind = makeConfig([web], { relays: [{ id: "alerts", name: "Alerts", token_sha256: hash, maintenance: true }] });
	const post = (runEnv: ReturnType<typeof mailbox>["runEnv"], o: object, t = T0) =>
		incident(runEnv, kind, TOKEN, payload(o), t);
	const read = async (token = TOKEN) => {
		const res = await kept(mailbox().runEnv, kind, token);
		return { status: res.status, body: res.status === 200 ? await res.json() : null };
	};

	it("answers 202, mails nothing and drains nothing", async () => {
		const { runEnv, box } = mailbox();
		const res = await post(runEnv, { description: "12 errors in the last 5 minutes" });
		expect(res.status).toBe(202);
		expect(await result(res)).toBe("transition");
		expect(await outbox()).toEqual([]);
		await tick(runEnv, kind, T0 + MINUTE, respond(200));
		expect(box.sends).toBe(0);
	});

	it("serves the firing keys with their description, 404 for a bad token, and empties on resolve", async () => {
		const { runEnv } = mailbox();
		await post(runEnv, { description: "12 errors in the last 5 minutes" });
		await post(runEnv, { deduplication_key: "k2", title: "Later" }, T0 + MINUTE);
		expect((await read()).body).toEqual([
			{ key: "k1", title: "Disk full", description: "12 errors in the last 5 minutes", since: T0, seen: T0 },
			{ key: "k2", title: "Later", description: null, since: T0 + MINUTE, seen: T0 + MINUTE },
		]);
		expect((await read("wrong")).status).toBe(404);
		expect((await read("")).status).toBe(404);
		await post(runEnv, { status: "resolved" }, T0 + 2 * MINUTE);
		await post(runEnv, { deduplication_key: "k2", status: "resolved" }, T0 + 2 * MINUTE);
		expect((await read()).body).toEqual([]);
	});

	it("answers 404 for a relay that is not maintenance", async () => {
		expect((await kept(mailbox().runEnv, config, TOKEN)).status).toBe(404);
	});

	it("never lists its keys in the digest and expires silently after grace", async () => {
		const { runEnv, box } = mailbox();
		await post(runEnv, {});
		await tick(runEnv, kind, T0 + 20 * MINUTE, respond(200));
		expect(await outbox()).toEqual([]);
		expect(box.sends).toBe(0);
		expect((await read()).body).toEqual([]);
		const withDigest = makeConfig([web], {
			digest: "12:00",
			relays: [{ id: "alerts", name: "Alerts", token_sha256: hash, maintenance: true }],
		});
		await incident(runEnv, withDigest, TOKEN, payload({}), T0);
		expect((await attention(env.DB, withDigest)).lines).toEqual([]);
		expect(await all("SELECT * FROM relay_fired")).toEqual([]);
	});
});
