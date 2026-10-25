import type { connect } from "cloudflare:sockets";
import { beforeEach, describe, expect, it } from "vitest";
import { tick } from "../src/run.ts";
import { status } from "../src/status.ts";
import { all, MINUTE, mailbox, makeConfig, reset, T0, web } from "./util.ts";

beforeEach(async () => {
	closed = 0;
	await reset();
});

const DAY = 86_400_000;
const strict = { down_after: 1, up_after: 1 };

let closed = 0;
function socket(opened: Promise<unknown>) {
	return {
		opened,
		close: async () => {
			closed++;
		},
	};
}
const dialing = (open: () => Promise<unknown>) => (() => socket(open())) as unknown as typeof connect;
const reachable = dialing(async () => ({}));
const refused = dialing(async () => {
	throw new Error("connection refused");
});
const blocked = dialing(async () => {
	throw new Error("Connections to port 25 are prohibited");
});
const silent = dialing(() => new Promise(() => {}));

const tcp = { id: "ssh", type: "tcp", name: "SSH", host: "ssh.example.com", port: 22, ...strict };
const noFetch = (async () => {
	throw new Error("unexpected fetch");
}) as typeof fetch;

describe("tcp", () => {
	it("goes down on a refused connection and recovers", async () => {
		const { runEnv, box } = mailbox();
		const config = makeConfig([tcp]);
		await tick(runEnv, config, T0, T0, noFetch, reachable);
		expect(await all("SELECT avail FROM state")).toEqual([{ avail: 1 }]);
		await tick(runEnv, config, T0 + MINUTE, T0 + MINUTE, noFetch, refused);
		expect(await all("SELECT avail, reason FROM state")).toEqual([
			{ avail: 0, reason: "connect failed: connection refused" },
		]);
		await tick(runEnv, config, T0 + 2 * MINUTE, T0 + 2 * MINUTE, noFetch, reachable);
		expect(await all("SELECT avail FROM state")).toEqual([{ avail: 1 }]);
		expect(box.sends).toBe(2);
		expect(closed).toBe(3);
	});

	it("fails a connection that never opens at the timeout", async () => {
		const { runEnv } = mailbox();
		await tick(runEnv, makeConfig([tcp], { timeout_ms: 1000 }), T0, T0, noFetch, silent);
		expect(await all("SELECT avail, reason FROM state")).toEqual([{ avail: 0, reason: "timeout" }]);
	});

	it("reads a platform-blocked address as down with its reason", async () => {
		const { runEnv } = mailbox();
		await tick(runEnv, makeConfig([tcp]), T0, T0, noFetch, blocked);
		expect(await all("SELECT avail, config_error, reason FROM state")).toEqual([
			{ avail: 0, config_error: 0, reason: "connect failed: Connections to port 25 are prohibited" },
		]);
	});
});

const record = { id: "dns", type: "dns", name: "DNS", query: "www.example.com", record: "A", ...strict };

function resolver(body: object | number) {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		expect(String(input)).toContain("https://cloudflare-dns.com/dns-query?name=www.example.com&type=A");
		expect(new Headers(init?.headers).get("accept")).toBe("application/dns-json");
		return typeof body === "number" ? new Response("", { status: body }) : Response.json(body);
	}) as typeof fetch;
}
const answer = { Status: 0, Answer: [{ name: "www.example.com", type: 1, data: "192.0.2.1" }] };

describe("dns", () => {
	it("goes down on NXDOMAIN, SERVFAIL and an empty answer, and recovers", async () => {
		const { runEnv } = mailbox();
		const config = makeConfig([record]);
		let t = T0;
		const run = async (f: typeof fetch) => {
			t += MINUTE;
			await tick(runEnv, config, t, t, f);
		};
		await run(resolver(answer));
		for (const [body, reason] of [
			[{ Status: 3 }, "NXDOMAIN"],
			[{ Status: 2 }, "DNS rcode 2"],
			[{ Status: 0 }, "no answer"],
			[{ Status: 0, Answer: [{ name: "www.example.com", type: 5, data: "other.example.com." }] }, "no answer"],
		] as const) {
			await run(resolver(body));
			expect(await all("SELECT avail, reason FROM state")).toEqual([{ avail: 0, reason }]);
			await run(resolver(answer));
			expect(await all("SELECT avail FROM state")).toEqual([{ avail: 1 }]);
		}
	});

	it("is inconclusive when the resolver cannot be reached", async () => {
		const { runEnv, box } = mailbox();
		const config = makeConfig([record]);
		await tick(runEnv, config, T0, T0, resolver(answer));
		const failing = [
			noFetch,
			resolver(503),
			(async () => new Response("<html>", { status: 200 })) as typeof fetch,
			noFetch,
		];
		for (const [i, f] of failing.entries()) await tick(runEnv, config, T0 + (i + 1) * MINUTE, T0 + (i + 1) * MINUTE, f);
		expect(await all("SELECT avail, fails, last_conclusive, last_run FROM state")).toEqual([
			{ avail: 1, fails: 0, last_conclusive: T0, last_run: T0 + 4 * MINUTE },
		]);
		expect(await all("SELECT * FROM samples")).toHaveLength(1);
		expect(await all("SELECT * FROM outbox")).toEqual([]);
		expect(box.sends).toBe(0);
		expect(await all("SELECT key FROM meta WHERE key LIKE 'self:stuck:%'")).toHaveLength(1);
	});

	it("checks the expected answer", async () => {
		const { runEnv } = mailbox();
		const config = makeConfig([{ ...record, expect: "192.0.2.9" }]);
		await tick(runEnv, config, T0, T0, resolver(answer));
		expect(await all("SELECT avail, reason FROM state")).toEqual([{ avail: 0, reason: "answer mismatch" }]);
		const match = makeConfig([{ ...record, expect: "192.0.2.1" }]);
		await tick(runEnv, match, T0 + MINUTE, T0 + MINUTE, resolver(answer));
		expect(await all("SELECT avail FROM state")).toEqual([{ avail: 1 }]);
	});
});

const cert = { id: "cert", type: "tls", name: "Certificate", host: "www.example.com", zone: "example.com", ...strict };

// Shapes follow the Cloudflare certificate_packs list reference, https://developers.cloudflare.com/api/resources/ssl/subresources/certificate_packs/methods/list/ (read 2026-10-08).
function pack(type: string, hosts: string[], daysLeft: number, validity = 90, extra: object = {}) {
	return {
		id: `${type}-${hosts.join("-")}`,
		type,
		status: "active",
		hosts,
		certificate_authority: "lets_encrypt",
		validity_days: validity,
		certificates: [{ id: "c1", hosts, status: "active", expires_on: new Date(T0 + daysLeft * DAY).toISOString() }],
		...extra,
	};
}

function cloudflare(result: object[] | number, zones: object[] = [{ id: "zone1" }]) {
	const calls: { url: string; auth: string | null }[] = [];
	const handler = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
		if (url.includes("/zones?name=example.com")) return Response.json({ success: true, result: zones });
		if (url.includes("/zones/zone1/ssl/certificate_packs")) {
			return typeof result === "number"
				? Response.json({ success: false, errors: [{ code: 10000 }] }, { status: result })
				: Response.json({ success: true, result });
		}
		return new Response("", { status: 404 });
	}) as typeof fetch;
	return { calls, fetch: handler };
}

async function tls(packs: object[] | number, t = T0, extra: object = {}) {
	const { runEnv } = mailbox();
	const api = cloudflare(packs);
	await tick({ ...runEnv, CF_API_TOKEN: "tok", ...extra }, makeConfig([cert]), t, t, api.fetch);
	return { api, state: (await all("SELECT avail, degraded, config_error, reason FROM state"))[0] };
}

describe("tls", () => {
	it("is up on a healthy certificate and sends the token only to the API", async () => {
		const { api, state } = await tls([pack("universal", ["example.com", "*.example.com"], 60)]);
		expect(state).toMatchObject({ avail: 1, degraded: 0, config_error: 0 });
		expect(api.calls.map((c) => c.auth)).toEqual(["Bearer tok", "Bearer tok"]);
	});

	it("caches the zone id", async () => {
		const { runEnv } = mailbox();
		const api = cloudflare([pack("universal", ["*.example.com"], 60)]);
		const env = { ...runEnv, CF_API_TOKEN: "tok" };
		await tick(env, makeConfig([{ ...cert, every: "1m" }]), T0, T0, api.fetch);
		await tick(env, makeConfig([{ ...cert, every: "1m" }]), T0 + MINUTE, T0 + MINUTE, api.fetch);
		expect(api.calls.filter((c) => c.url.includes("/zones?name="))).toHaveLength(1);
		expect(await all("SELECT value FROM meta WHERE key = 'zone:example.com'")).toEqual([{ value: "zone1" }]);
	});

	it("prefers custom over advanced over total over universal", async () => {
		const host = ["www.example.com"];
		const expired = -1;
		const order = ["mh_custom", "advanced", "total_tls", "universal"];
		for (let i = 0; i < order.length; i++) {
			const packs = order.slice(i).map((type, j) => pack(type, host, j === 0 ? expired : 60));
			const { state } = await tls(packs.reverse());
			expect(state, order[i]).toMatchObject({ avail: 0, reason: "certificate expired" });
			await reset();
		}
	});

	it("prefers an exact host over a wildcard within the same type", async () => {
		const wildcardExpired = pack("advanced", ["*.example.com"], -1);
		const exactFine = pack("advanced", ["www.example.com"], 60);
		expect((await tls([wildcardExpired, exactFine])).state).toMatchObject({ avail: 1 });
		await reset();
		expect((await tls([exactFine, wildcardExpired])).state).toMatchObject({ avail: 1 });
		await reset();
		const wildcardOnly = pack("advanced", ["*.example.com"], -1);
		expect((await tls([wildcardOnly])).state).toMatchObject({ avail: 0 });
	});

	it("ignores packs that do not cover the host or are not active", async () => {
		const { state } = await tls([
			pack("universal", ["*.example.com"], 60),
			pack("advanced", ["other.example.com"], -1),
			pack("advanced", ["www.example.com"], -1, 90, { status: "pending_validation" }),
			pack("advanced", ["a.b.example.com"], -1),
		]);
		expect(state).toMatchObject({ avail: 1 });
	});

	it("takes the earliest expiry among a pack's certificates", async () => {
		const both = pack("advanced", ["www.example.com"], 60);
		both.certificates.push({ ...both.certificates[0], expires_on: new Date(T0 + DAY).toISOString() });
		expect((await tls([both])).state).toMatchObject({ avail: 0, reason: "certificate expires within 2 days" });
	});

	it("goes down when expired or under two days and stays up at three", async () => {
		expect((await tls([pack("universal", ["www.example.com"], -1)])).state).toMatchObject({ avail: 0 });
		await reset();
		expect((await tls([pack("universal", ["www.example.com"], 1.9)])).state).toMatchObject({ avail: 0 });
		await reset();
		expect((await tls([pack("universal", ["www.example.com"], 3)])).state).toMatchObject({ avail: 1, degraded: 1 });
	});

	it("goes down when no pack covers the host", async () => {
		expect((await tls([])).state).toMatchObject({ avail: 0, reason: "no active certificate covers the host" });
	});

	it("is degraded, never down or mailed, when renewal is overdue, and clears when renewed", async () => {
		const { runEnv, box } = mailbox();
		const env = { ...runEnv, CF_API_TOKEN: "tok" };
		const config = makeConfig([{ ...cert, every: "1m" }]);
		const days = [20, 14, 5, 80];
		const degraded = [0, 1, 1, 0];
		for (const [i, left] of days.entries()) {
			await tick(
				env,
				config,
				T0 + i * MINUTE,
				T0 + i * MINUTE,
				cloudflare([pack("universal", ["www.example.com"], left)]).fetch,
			);
			expect(await all("SELECT avail, degraded FROM state")).toEqual([{ avail: 1, degraded: degraded[i] }]);
			if (i === 2) expect((await status(runEnv.DB, config, T0 + i * MINUTE)).checks[0].status).toBe("degraded");
		}
		expect(box.sends).toBe(0);
	});

	it("treats a scope error as a config error and flags only the token self-check", async () => {
		for (const code of [401, 403]) {
			const { runEnv, box } = mailbox();
			await tick({ ...runEnv, CF_API_TOKEN: "tok" }, makeConfig([cert]), T0, T0, cloudflare(code).fetch);
			expect(await all("SELECT avail, config_error, last_conclusive FROM state")).toEqual([
				{ avail: 1, config_error: 1, last_conclusive: null },
			]);
			expect(box.sends).toBe(0);
			expect(await all("SELECT key FROM meta WHERE key = 'self:token'")).toHaveLength(1);
			await reset();
		}
	});

	it("treats a missing token or unknown zone as a config error", async () => {
		expect((await tls([], T0, { CF_API_TOKEN: undefined })).state).toMatchObject({ config_error: 1 });
		await reset();
		const { runEnv } = mailbox();
		await tick({ ...runEnv, CF_API_TOKEN: "tok" }, makeConfig([cert]), T0, T0, cloudflare([], []).fetch);
		expect(await all("SELECT config_error FROM state")).toEqual([{ config_error: 1 }]);
	});

	it("treats an unexpected API body as inconclusive and still runs the other checks", async () => {
		const { runEnv } = mailbox();
		const config = makeConfig([web, cert]);
		const fetcher = (async (input: RequestInfo | URL) =>
			String(input).includes("api.cloudflare.com")
				? Response.json({ success: true, result: null })
				: new Response("ok")) as typeof fetch;
		await tick({ ...runEnv, CF_API_TOKEN: "tok" }, config, T0, T0, fetcher);
		expect(await all(`SELECT "check", last_run FROM state ORDER BY "check"`)).toEqual([
			{ check: "cert", last_run: T0 },
			{ check: "web", last_run: T0 },
		]);
	});

	it("is inconclusive on an API outage and leaves the state alone", async () => {
		for (const f of [noFetch, cloudflare(502).fetch]) {
			const { runEnv, box } = mailbox();
			await tick({ ...runEnv, CF_API_TOKEN: "tok" }, makeConfig([cert]), T0, T0, f);
			expect(await all("SELECT avail, config_error, last_conclusive FROM state")).toEqual([
				{ avail: 1, config_error: 0, last_conclusive: null },
			]);
			expect(box.sends).toBe(0);
			await reset();
		}
	});

	it("goes down and recovers across runs", async () => {
		const { runEnv, box } = mailbox();
		const env = { ...runEnv, CF_API_TOKEN: "tok" };
		const config = makeConfig([{ ...cert, every: "1m" }]);
		await tick(env, config, T0, T0, cloudflare([pack("universal", ["www.example.com"], 60)]).fetch);
		await tick(env, config, T0 + MINUTE, T0 + MINUTE, cloudflare([pack("universal", ["www.example.com"], -1)]).fetch);
		expect(await all("SELECT avail FROM state")).toEqual([{ avail: 0 }]);
		await tick(
			env,
			config,
			T0 + 2 * MINUTE,
			T0 + 2 * MINUTE,
			cloudflare([pack("universal", ["www.example.com"], 60)]).fetch,
		);
		expect(await all("SELECT avail FROM state")).toEqual([{ avail: 1 }]);
		expect(box.sends).toBe(2);
	});
});
