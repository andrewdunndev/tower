import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import fixture from "../test/fixture/tower.json";
import { instanceSchema, type Note, publicNote, unknownIds } from "./schema.ts";
import { stage } from "./stage.ts";

const checks = instanceSchema.parse(fixture).checks;
const note = (ids: string[]): Note => ({ title: "T", kind: "incident", start: "2026-09-01T10:00:00Z", checks: ids });

describe("the example", () => {
	it("validates and stages", () => {
		const out = mkdtempSync(join(tmpdir(), "tower-example-"));
		const staged = stage(join(import.meta.dirname, "../example"), out);
		expect(staged.checks.length).toBeGreaterThan(0);
		expect(readFileSync(join(out, "notes/website-slow.md"), "utf8")).toContain('checks: ["Website"]');
	});
});

describe("a broken instance", () => {
	it("bad-to is rejected before anything is staged", () => {
		const out = join(mkdtempSync(join(tmpdir(), "tower-reject-")), "out");
		expect(() => stage(join(import.meta.dirname, "reject", "bad-to"), out)).toThrow(
			expect.objectContaining({
				name: "Error",
				message: expect.stringContaining("tower.json: checks.0.to.0: use an email address."),
			}),
		);
		expect(existsSync(out)).toBe(false);
	});
});

const stageNamed = (name: string, extra: object = {}) => {
	const dir = mkdtempSync(join(tmpdir(), "tower-named-"));
	writeFileSync(join(dir, "tower.json"), JSON.stringify({ ...fixture, name, ...extra }));
	const out = mkdtempSync(join(tmpdir(), "tower-out-"));
	stage(dir, out);
	const read = (f: string) => JSON.parse(readFileSync(join(out, f), "utf8"));
	return { out, read, prober: read("prober.wrangler.json"), page: read("page.wrangler.json") };
};

describe("resource names", () => {
	it("derive from the instance name and do not overlap between instances", () => {
		const names = ["a", "tower"].map((n) => {
			const { prober, page } = stageNamed(n);
			return [prober.name, page.name, page.services[0].service, prober.d1_databases[0].database_name];
		});
		expect(names).toEqual([
			["a-prober", "a-page", "a-prober", "a"],
			["tower-prober", "tower-page", "tower-prober", "tower"],
		]);
	});

	it("carries the cron, the TICKER object and the DB, EMAIL and VERSION bindings into the staged prober", () => {
		const { prober } = stageNamed("tower");
		expect(prober.triggers.crons).toEqual(["* * * * *"]);
		expect(prober.d1_databases[0].binding).toBe("DB");
		expect(prober.durable_objects.bindings).toEqual([{ name: "TICKER", class_name: "Ticker" }]);
		expect(prober.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["Ticker"] }]);
		expect(prober.send_email).toEqual([{ name: "EMAIL" }]);
		expect(prober.version_metadata).toEqual({ binding: "VERSION" });
	});

	it("carries the minute cron and TOWER into the staged page", () => {
		const { page } = stageNamed("tower");
		expect(page.triggers.crons).toEqual(["* * * * *"]);
		expect(page.send_email).toBeUndefined();
		expect(page.services[0].binding).toBe("TOWER");
	});

	it("resolve paths relative to the generated file", () => {
		const { out, prober, page } = stageNamed("tower");
		expect(existsSync(join(out, prober.main))).toBe(true);
		expect(existsSync(join(out, page.main))).toBe(true);
		expect(existsSync(join(out, prober.d1_databases[0].migrations_dir, "0001_init.sql"))).toBe(true);
	});
});

describe("outside", () => {
	const staged = (outside: boolean) => stageNamed("a", { outside });

	it("stages its own config and the healthz URL with the alert addresses", () => {
		const { out, read } = staged(true);
		const config = read("outside.wrangler.json");
		expect(config.name).toBe("a-outside");
		expect(config.d1_databases).toEqual([{ binding: "DB", database_name: "a-outside" }]);
		expect(config.send_email).toEqual([{ name: "EMAIL" }]);
		expect(config.triggers.crons).toEqual(["* * * * *"]);
		expect(config.services).toBeUndefined();
		expect(existsSync(join(out, config.main))).toBe(true);
		expect(read("outside.json")).toEqual({ url: `https://${fixture.domain}/healthz`, alert: fixture.alert });
	});

	it("stages nothing when off", () => {
		const { out } = staged(false);
		expect(existsSync(join(out, "outside.wrangler.json"))).toBe(false);
		expect(existsSync(join(out, "outside.json"))).toBe(false);
	});
});

describe("look", () => {
	it("takes the instance favicon and theme, else the tool's favicon and an empty theme", () => {
		const fixtureDir = join(import.meta.dirname, "../test/fixture");
		const own = mkdtempSync(join(tmpdir(), "tower-own-"));
		stage(fixtureDir, own);
		expect(readFileSync(join(own, "favicon.svg"), "utf8")).toBe(readFileSync(join(fixtureDir, "favicon.svg"), "utf8"));
		expect(readFileSync(join(own, "theme.css"), "utf8")).toBe(readFileSync(join(fixtureDir, "theme.css"), "utf8"));

		const plain = mkdtempSync(join(tmpdir(), "tower-plain-"));
		stage(join(import.meta.dirname, "../example"), plain);
		expect(readFileSync(join(plain, "favicon.svg"), "utf8")).toBe(
			readFileSync(join(import.meta.dirname, "../favicon.svg"), "utf8"),
		);
		expect(readFileSync(join(plain, "theme.css"), "utf8")).toBe("");
	});

	it("hands the page the title", () => {
		const out = mkdtempSync(join(tmpdir(), "tower-page-"));
		stage(join(import.meta.dirname, "../example"), out);
		expect(JSON.parse(readFileSync(join(out, "page.json"), "utf8"))).toEqual({ title: "Example Status" });
	});
});

describe("staged notes", () => {
	it("carry check names only", () => {
		const out = mkdtempSync(join(tmpdir(), "tower-stage-"));
		stage(join(import.meta.dirname, "../test/fixture"), out);
		const read = (f: string) => readFileSync(join(out, "notes", f), "utf8");
		expect(read("dns-outage.md")).toContain('\nchecks: ["DNS"]\n');
		const text = ["dns-outage.md", "markup.md", "upgrade.md"].map(read);
		const secrets = ["https://www.example.com/", "www.example.com", "example.com", "backup", "Backup"];
		for (const raw of text) for (const needle of secrets) expect(raw).not.toContain(needle);
	});

	it("drop private checks and skip a note that names only private ones", () => {
		expect(publicNote(note(["dns", "backup"]), checks)?.checks).toEqual(["DNS"]);
		expect(publicNote(note(["backup"]), checks)).toBeNull();
		expect(publicNote(note([]), checks)?.checks).toEqual([]);
	});

	it("name the fix for an id that is not in tower.json", () => {
		expect(unknownIds("a.md", note(["dns", "dsn"]), checks)).toEqual([
			'notes/a.md: checks: unknown id "dsn": use a check id from tower.json',
		]);
		expect(unknownIds("a.md", note(["dns"]), checks)).toEqual([]);
	});
});
