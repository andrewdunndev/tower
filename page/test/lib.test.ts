import { describe, expect, it } from "vitest";
import { maintenanceWithBodies, mergeIncidents, type Note } from "../src/lib.ts";

const NOW = "2026-10-08T12:00:00.000Z";
const note = (n: Partial<Note>): Note => ({
	title: "Note",
	kind: "incident",
	start: "2026-10-01T10:00:00Z",
	checks: ["API"],
	bodyHtml: "<p>body</p>",
	...n,
});
const auto = {
	kind: "auto" as const,
	title: "API is not responding",
	checks: ["API"],
	severity: "down" as const,
	started: "2026-10-05T00:00:00.000Z",
	resolved: null,
	bodyHtml: null,
};

describe("notes on the page", () => {
	it("merges incident notes beside automatic incidents, newest first", () => {
		const merged = mergeIncidents(
			[auto],
			[note({ title: "Newer", start: "2026-10-07T10:00:00Z", end: "2026-10-07T11:00:00Z" })],
			NOW,
		);
		expect(merged.map((i) => [i.kind, i.title])).toEqual([
			["note", "Newer"],
			["auto", "API is not responding"],
		]);
		expect(merged[0]).toMatchObject({
			severity: "info",
			resolved: "2026-10-07T11:00:00.000Z",
			bodyHtml: "<p>body</p>",
		});
	});

	it("leaves maintenance notes and incidents older than 90 days out of the timeline", () => {
		const merged = mergeIncidents(
			[],
			[note({ kind: "maintenance" }), note({ title: "Old", start: "2026-06-01T00:00:00Z" })],
			NOW,
		);
		expect(merged).toEqual([]);
	});

	it("gives each window the body of the note with the same title and start", () => {
		const window = {
			title: "Upgrade",
			checks: ["API"],
			starts: "2026-11-01T02:00:00.000Z",
			ends: "2026-11-01T03:00:00.000Z",
		};
		const notes = [
			note({ kind: "maintenance", title: "Upgrade", start: "2026-12-01T02:00:00Z", bodyHtml: "<p>other</p>" }),
			note({ kind: "maintenance", title: "Different", start: "2026-11-01T02:00:00Z", bodyHtml: "<p>other</p>" }),
			note({ kind: "maintenance", title: "Upgrade", start: "2026-11-01T04:00:00+02:00", bodyHtml: "<p>match</p>" }),
		];
		expect(maintenanceWithBodies([window], notes)).toEqual([{ ...window, bodyHtml: "<p>match</p>" }]);
		expect(maintenanceWithBodies([window], [])).toEqual([{ ...window, bodyHtml: null }]);
	});
});
