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

const stageNamed = (name: string) => {
	const dir = mkdtempSync(join(tmpdir(), "tower-named-"));
	writeFileSync(join(dir, "tower.json"), JSON.stringify({ ...fixture, name }));
	const out = mkdtempSync(join(tmpdir(), "tower-out-"));
	stage(dir, out);
	const read = (f: string) => JSON.parse(readFileSync(join(out, f), "utf8"));
	return { out, prober: read("prober.wrangler.json"), page: read("page.wrangler.json") };
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

	it("carries the cron and the DB, EMAIL and VERSION bindings into the staged prober", () => {
		const { prober } = stageNamed("tower");
		expect(prober.triggers.crons).toEqual(["* * * * *"]);
		expect(prober.d1_databases[0].binding).toBe("DB");
		expect(prober.send_email).toEqual([{ name: "EMAIL" }]);
		expect(prober.version_metadata).toEqual({ binding: "VERSION" });
	});

	it("resolve paths relative to the generated file", () => {
		const { out, prober } = stageNamed("tower");
		expect(existsSync(join(out, prober.main))).toBe(true);
		expect(existsSync(join(out, prober.d1_databases[0].migrations_dir, "0001_init.sql"))).toBe(true);
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

	it("hands the page the title and nothing else", () => {
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
