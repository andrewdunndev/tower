import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const assets = join(root, "page/dist/client/_astro");
const files = (ext: string) => readdirSync(assets).filter((f) => f.endsWith(ext));

it("the built page carries the instance favicon and theme", () => {
	const favicon = readFileSync(join(root, "test/fixture/favicon.svg"), "utf8");
	expect(files(".svg").map((f) => readFileSync(join(assets, f), "utf8"))).toContain(favicon);
	expect(files(".css").some((f) => /--up:#(336699|369)[;}]/.test(readFileSync(join(assets, f), "utf8")))).toBe(true);
});
