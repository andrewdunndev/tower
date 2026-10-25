import { describe, expect, it } from "vitest";
import example from "../test/fixture/tower.json";
import { instanceSchema, noteSchema } from "./schema.ts";

type Json = Record<string, unknown>;

const http: Json = { id: "web", type: "http", name: "Web", url: "https://www.example.com/" };
const instance = (...checks: Json[]) => ({ ...example, checks });

function messages(input: unknown): string[] {
	const r = instanceSchema.safeParse(input);
	return r.success ? [] : r.error.issues.map((i) => i.message);
}

describe("instance", () => {
	it("accepts the example", () => {
		expect(messages(example)).toEqual([]);
	});

	it("rejects an instance name that cannot name a Worker", () => {
		for (const name of ["", "Tower", "-a", "a-", "a_b", "a".repeat(55)]) {
			expect(messages({ ...example, name })).not.toEqual([]);
		}
		expect(messages({ ...example, name: "a".repeat(54) })).toEqual([]);
	});

	it("rejects duplicate ids", () => {
		expect(messages(instance(http, { ...http, name: "Other" }))).toContain(
			'Duplicate check id "web": ids must be unique, rename one.',
		);
	});

	it("rejects tcp port 25", () => {
		const tcp = { id: "mail", type: "tcp", name: "Mail", host: "mail.example.com", port: 25 };
		expect(messages(instance(tcp))).toContain(
			"Port 25 is blocked by Cloudflare Workers: probe a different port, or use a heartbeat.",
		);
	});

	it.each(["10.0.0.1", "127.0.0.1", "169.254.1.1", "192.168.1.5", "172.16.0.9", "localhost", "[::1]", "fd00::1"])(
		"rejects private tcp host %s",
		(host) => {
			const tcp = { id: "t", type: "tcp", name: "T", host, port: 22 };
			expect(messages(instance(tcp))).toContain(
				"Private, loopback and link-local addresses are unreachable from Workers: use a public hostname, or a heartbeat for private services.",
			);
		},
	);

	it("rejects a private http url", () => {
		expect(messages(instance({ ...http, url: "http://192.168.1.5/" }))).toContain(
			"Private, loopback and link-local addresses are unreachable from Workers: use a public hostname, or a heartbeat for private services.",
		);
	});

	it("rejects a malformed url without throwing", () => {
		expect(messages(instance({ ...http, url: "not a url" }))).toContain("use a full http:// or https:// URL.");
	});

	it("accepts public hostnames that start with digits", () => {
		const tcp = { id: "t", type: "tcp", name: "T", host: "10.example.com", port: 22 };
		expect(messages(instance(tcp, { ...tcp, id: "u", host: "0.pool.ntp.org" }))).toEqual([]);
	});

	it("rejects a bad check id", () => {
		expect(messages(instance({ ...http, id: "Bad_ID" }))).toContain(
			"use lowercase letters, digits and hyphens, starting with a letter or digit.",
		);
	});

	it("rejects a domain with a scheme", () => {
		expect(messages({ ...example, domain: "https://status.example.com" })).toContain(
			"use a bare hostname such as status.example.com, with no scheme or path.",
		);
	});

	it("rejects an empty checks list", () => {
		expect(messages({ ...example, checks: [] })).toContain("list at least one check.");
	});

	it("rejects a 3xx expect_status", () => {
		expect(messages(instance({ ...http, expect_status: 302 }))).toContain(
			"Access-gated targets: use a bypass path or a heartbeat.",
		);
	});

	it("rejects a malformed duration", () => {
		expect(messages(instance({ ...http, every: "90s" }))).toContain('Use a duration such as "1m", "5m", "1h" or "1d".');
	});

	it("rejects a heartbeat token that is not a sha256", () => {
		const beat = { id: "b", type: "heartbeat", name: "B", every: "1h", grace: "5m", token_sha256: "secret" };
		expect(messages(instance(beat))).toContain(
			"token_sha256: use the lowercase hex sha256 of the token (64 characters).",
		);
	});

	describe("relays and digest", () => {
		const relay: Json = { id: "alerts", name: "Alerts", token_sha256: "a".repeat(64) };
		const withRelays = (...relays: Json[]) => ({ ...example, relays });

		it("accepts a relay and defaults grace to 15 minutes", () => {
			expect(messages(withRelays(relay))).toEqual([]);
			expect(instanceSchema.parse(withRelays(relay)).relays[0].grace).toBe(900_000);
			expect(instanceSchema.parse({ ...example, relays: undefined }).relays).toEqual([]);
		});

		it("defaults digest_only to false and takes a boolean", () => {
			expect(instanceSchema.parse(withRelays(relay)).relays[0].digest_only).toBe(false);
			const digested = (r: Json) => ({ ...withRelays(r), digest: "07:30" });
			expect(instanceSchema.parse(digested({ ...relay, digest_only: true })).relays[0].digest_only).toBe(true);
			expect(messages(withRelays({ ...relay, digest_only: "yes" })).length).toBeGreaterThan(0);
		});

		it("defaults maintenance to false and takes a boolean, with or without a digest", () => {
			expect(instanceSchema.parse(withRelays(relay)).relays[0].maintenance).toBe(false);
			expect(instanceSchema.parse(withRelays({ ...relay, maintenance: true })).relays[0].maintenance).toBe(true);
			expect(messages(withRelays({ ...relay, maintenance: "yes" })).length).toBeGreaterThan(0);
		});

		it("rejects a relay that is both digest_only and maintenance", () => {
			const both = { ...withRelays({ ...relay, digest_only: true, maintenance: true }), digest: "07:30" };
			expect(messages(both)).toEqual(["A relay is either digest_only or maintenance, not both."]);
		});

		it("rejects digest_only on an instance without a digest", () => {
			expect(messages({ ...withRelays({ ...relay, digest_only: true }), digest: undefined }).join()).toContain(
				"digest_only needs",
			);
		});

		it("rejects an unknown relay key", () => {
			expect(messages(withRelays({ ...relay, stale_after: "1h" }))).toContain("unknown key stale_after.");
		});

		it("shares one id space between checks and relays", () => {
			const clash = { ...relay, id: (example.checks[0] as Json).id };
			expect(messages(withRelays(clash)).join()).toContain("share one space");
		});

		it("rejects two relays with one token", () => {
			expect(messages(withRelays(relay, { ...relay, id: "other" }))).toContain(
				"Two relays share a token: mint a token for each.",
			);
		});

		it("reads a string and a list of hashes as the same list, at most two", () => {
			const parsed = (hash: unknown) => {
				const r = instanceSchema.parse(withRelays({ ...relay, token_sha256: hash }));
				return r.relays[0].token_sha256;
			};
			expect(parsed("a".repeat(64))).toEqual(["a".repeat(64)]);
			expect(parsed(["a".repeat(64), "b".repeat(64)])).toEqual(["a".repeat(64), "b".repeat(64)]);
			const hashes = (...h: string[]) => messages(withRelays({ ...relay, token_sha256: h.map((c) => c.repeat(64)) }));
			expect(hashes("a", "b", "c")).toContain("list at most 2 hashes: the current token and its replacement.");
			expect(hashes()).toContain("list at least one hash.");
		});

		it("rejects a hash repeated across relays or inside one list", () => {
			const a = "a".repeat(64);
			const b = "b".repeat(64);
			const other = { ...relay, id: "other", token_sha256: [b, a] };
			expect(messages(withRelays({ ...relay, token_sha256: [a] }, other))).toContain(
				"Two relays share a token: mint a token for each.",
			);
			expect(messages(withRelays({ ...relay, token_sha256: [a, a] }))).toContain(
				"Two relays share a token: mint a token for each.",
			);
		});

		it("limits grace to 7 days", () => {
			expect(messages(withRelays({ ...relay, grace: "7d" }))).toEqual([]);
			expect(messages(withRelays({ ...relay, grace: "8d" }))).toContain("use at most 7 days.");
		});

		it("takes digest as a UTC time of day", () => {
			expect(messages({ ...example, digest: "07:30" })).toEqual([]);
			for (const digest of ["7:30", "24:00", "07:60", "0730", "07:30:00"]) {
				expect(messages({ ...example, digest })).toContain('use a UTC time of day such as "07:30".');
			}
		});
	});

	describe("to", () => {
		const addresses = (n: number) => Array.from({ length: n }, (_, i) => `team${i}@example.com`);
		const routed = (to: unknown) => instance({ ...http, to });

		it("takes one address as a list of one", () => {
			expect(instanceSchema.parse(routed("ops@example.com")).checks[0].to).toEqual(["ops@example.com"]);
		});

		it("leaves to unset when it is absent", () => {
			expect(instanceSchema.parse(instance(http)).checks[0].to).toBeUndefined();
		});

		it("takes one to five addresses, as written", () => {
			expect(instanceSchema.parse(routed(["Ops@Example.com"])).checks[0].to).toEqual(["Ops@Example.com"]);
			expect(instanceSchema.parse(routed(addresses(5))).checks[0].to).toEqual(addresses(5));
		});

		it("rejects an empty list and more than five", () => {
			expect(messages(routed([]))).toContain("list at least one address.");
			expect(messages(routed(addresses(6)))).toContain("use at most 5 addresses, or a group address.");
		});

		it("rejects a bad address, alone or in a list", () => {
			expect(messages(routed("ops"))).toContain("use an email address.");
			expect(messages(routed(["ops@example.com", "ops"]))).toContain("use an email address.");
			expect(messages(routed(7))).toContain("use an email address or a list of them.");
		});

		it("rejects an address listed twice in any case", () => {
			expect(messages(routed(["ops@example.com", "OPS@example.com"]))).toContain(
				'Duplicate address "OPS@example.com": list each address once.',
			);
		});

		it("takes to on every check type and on a relay", () => {
			const to = "ops@example.com";
			const checks = [
				{ ...http, to },
				{ id: "t", type: "tcp", name: "T", host: "mail.example.com", port: 22, to },
				{ id: "d", type: "dns", name: "D", query: "example.com", record: "A", to },
				{ id: "c", type: "tls", name: "C", host: "www.example.com", zone: "example.com", to },
				{ id: "h", type: "heartbeat", name: "H", every: "1h", grace: "5m", token_sha256: "b".repeat(64), to },
			];
			const relays = [{ id: "alerts", name: "Alerts", token_sha256: "a".repeat(64), to }];
			const parsed = instanceSchema.parse({ ...example, checks, relays });
			expect([...parsed.checks, ...parsed.relays].map((o) => o.to)).toEqual(Array(6).fill([to]));
		});
	});
});

describe("note", () => {
	const maintenance = {
		title: "Upgrade",
		kind: "maintenance",
		start: "2026-10-09T02:00:00Z",
		end: "2026-10-09T04:00:00Z",
	};
	const notes = (input: unknown) => {
		const r = noteSchema.safeParse(input);
		return r.success ? [] : r.error.issues.map((i) => i.message);
	};

	it("accepts a maintenance window", () => {
		expect(notes(maintenance)).toEqual([]);
	});

	it("accepts an incident without end", () => {
		expect(notes({ title: "Outage", kind: "incident", start: "2026-10-01T00:00:00Z" })).toEqual([]);
	});

	it("rejects maintenance without end", () => {
		expect(notes({ ...maintenance, end: undefined })).toContain(
			"A maintenance note needs an end time: add end: with an ISO 8601 time.",
		);
	});

	it("rejects maintenance longer than 7 days", () => {
		expect(notes({ ...maintenance, end: "2026-10-17T02:00:00Z" })).toContain(
			"A maintenance window is at most 7 days: shorten it or split it.",
		);
	});

	it("rejects maintenance that ends before it starts", () => {
		expect(notes({ ...maintenance, end: "2026-10-09T01:00:00Z" })).toContain("end must be after start.");
	});

	it("rejects a time without an offset", () => {
		expect(notes({ ...maintenance, start: "2026-10-09T05:00:00" })).toContain(
			"Use an ISO 8601 time with an offset such as 2026-11-01T02:00:00Z.",
		);
	});
});

describe("run budget", () => {
	const many = (n: number, extra: Json = {}) =>
		Array.from({ length: n }, (_, i) => ({ ...http, id: `web${i}`, ...extra }));
	const budget = (checks: Json[], timeout_ms?: number) => messages({ ...instance(...checks), timeout_ms });
	const overrun = (m: string[]) => m.find((x) => x.includes("can need"));

	it("passes 30 checks at the default timeout and refuses 31", () => {
		expect(budget(many(30))).toEqual([]);
		expect(overrun(budget(many(31)))).toBe(
			"31 probes at a 10 s timeout can need 60 s, more than the 53 s the shortest interval (60 s) leaves: lower timeout_ms, drop checks, or lengthen every.",
		);
	});

	it("passes 6 checks at a 30 s timeout and refuses 7", () => {
		expect(budget(many(6), 30000)).toEqual([]);
		expect(overrun(budget(many(7), 30000))).toContain("7 probes at a 30 s timeout can need 60 s");
	});

	it("budgets against the shortest interval", () => {
		expect(budget(many(31, { every: "5m" }), 30000)).toEqual([]);
		expect(overrun(budget([...many(31, { every: "5m" }), { ...http, id: "fast" }], 30000))).toContain(
			"the shortest interval (60 s)",
		);
	});

	it("counts a heartbeat toward the shortest interval but not the probes", () => {
		const beat = { id: "b", type: "heartbeat", name: "B", every: "1d", grace: "5m", token_sha256: "a".repeat(64) };
		expect(budget([...many(30, { every: "1h" }), beat])).toEqual([]);
		expect(overrun(budget([...many(31, { every: "1h" }), beat]))).toContain("the shortest interval (60 s)");
	});
});

describe("unknown keys", () => {
	it("names a typo at the top level", () => {
		expect(messages({ ...example, titel: "x" })).toEqual(["unknown key titel."]);
	});

	it.each([
		http,
		{ id: "t", type: "tcp", name: "T", host: "db.example.com", port: 5432 },
		{ id: "d", type: "dns", name: "D", query: "example.com", record: "A" },
		{ id: "s", type: "tls", name: "S", host: "www.example.com", zone: "example.com" },
		{ id: "b", type: "heartbeat", name: "B", every: "1h", grace: "5m", token_sha256: "a".repeat(64) },
	])("names a typo inside a $type check", (check) => {
		expect(messages(instance({ ...check, down_afer: 2 }))).toEqual(["unknown key down_afer."]);
	});

	it("names a typo in alert, json and notes", () => {
		expect(messages({ ...example, alert: { ...example.alert, cc: "a@b.co" } })).toEqual(["unknown key cc."]);
		expect(messages(instance({ ...http, json: { path: "a", equals: 1, equal: 2 } }))).toEqual(["unknown key equal."]);
		const note = noteSchema.safeParse({ title: "t", kind: "incident", start: "2026-11-01T02:00:00Z", chek: [] });
		expect(note.success ? [] : note.error.issues.map((i) => i.message)).toEqual(["unknown key chek."]);
	});
});
