import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import example from "../example/tower.json";
import { instanceSchema, type Note, publicNote, unknownIds } from "./schema.ts";
import { stage } from "./stage.ts";

const checks = instanceSchema.parse(example).checks;
const note = (ids: string[]): Note => ({ title: "T", kind: "incident", start: "2026-09-01T10:00:00Z", checks: ids });

describe("staged notes", () => {
	it("carry check names only", () => {
		const out = mkdtempSync(join(tmpdir(), "tower-stage-"));
		stage(join(import.meta.dirname, "../example"), out);
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
