import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Instance } from "./schema.ts";

const root = join(import.meta.dirname, "..");
const [instance, ...flags] = process.argv.slice(2);
if (!instance) {
	console.error("usage: node tools/deploy.ts <instance-dir> [--dry-run]");
	process.exit(1);
}
const dryRun = flags.includes("--dry-run");

const run = (cmd: string, args: string[], cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
const wrangler = (cwd: string, ...args: string[]) =>
	run(join(root, "node_modules/.bin/wrangler"), args, join(root, cwd));

run("node", [join(root, "tools/stage.ts"), instance]);
const { domain } = JSON.parse(readFileSync(join(root, ".tower/tower.json"), "utf8")) as Instance;

const dry = dryRun ? ["--dry-run"] : [];
wrangler("prober", "deploy", ...dry);
if (!dryRun) wrangler("prober", "d1", "migrations", "apply", "DB", "--remote");
run("npm", ["run", "build", "-w", "page"]);
wrangler("page", "deploy", "--route", `${domain}/*`, ...dry);
