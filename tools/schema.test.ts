import { describe, expect, it } from "vitest";
import example from "../example/tower.json";
import { instanceSchema, noteSchema } from "./schema.ts";

type Json = Record<string, unknown>;

const NOW = new Date("2026-10-08T12:00:00Z");
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

	it("fills defaults", () => {
		const r = instanceSchema.parse(instance(http));
		expect(r.checks[0]).toMatchObject({ every: 60, public: true, down_after: 3, up_after: 2, expect_status: 200 });
		expect(r.history_days).toBe(90);
		expect(r.timeout_ms).toBe(10000);
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
});

describe("note", () => {
	const schema = noteSchema(NOW);
	const maintenance = {
		title: "Upgrade",
		kind: "maintenance",
		start: "2026-10-09T02:00:00Z",
		end: "2026-10-09T04:00:00Z",
	};
	const notes = (input: unknown) => {
		const r = schema.safeParse(input);
		return r.success ? [] : r.error.issues.map((i) => i.message);
	};

	it("accepts a future maintenance window", () => {
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

	it("rejects maintenance that has already started and not ended", () => {
		expect(notes({ ...maintenance, start: "2026-10-08T11:00:00Z" })).toContain(
			"A maintenance window cannot start in the past: move start to the future, or delete the note once it is over.",
		);
	});

	it("accepts maintenance that is over", () => {
		expect(notes({ ...maintenance, start: "2026-10-01T02:00:00Z", end: "2026-10-01T04:00:00Z" })).toEqual([]);
	});
});
