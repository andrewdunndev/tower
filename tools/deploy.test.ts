import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("deploy", () => {
	it("exits 1 with the validation messages and no stack trace", () => {
		const dir = mkdtempSync(join(tmpdir(), "tower-bad-"));
		writeFileSync(join(dir, "tower.json"), JSON.stringify({ title: "", domain: "status.example.com", checks: [] }));
		const r = spawnSync("node", [join(import.meta.dirname, "deploy.ts"), dir, "--dry-run"], { encoding: "utf8" });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("tower.json: title: required.");
		expect(r.stderr).not.toMatch(/^\s+at /m);
		expect(r.stderr).not.toContain("title: title:");
	});
});
