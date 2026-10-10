import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { root, StageError, stage } from "./stage.ts";

const [instance, ...flags] = process.argv.slice(2);
if (!instance) {
	console.error("usage: node tools/deploy.ts <instance-dir> [--dry-run]");
	process.exit(1);
}
const dryRun = flags.includes("--dry-run");

function run(cmd: string, args: string[], cwd = root) {
	const { status } = spawnSync(cmd, args, { cwd, stdio: "inherit" });
	if (status !== 0) process.exit(status ?? 1);
}
const wrangler = (cwd: string, ...args: string[]) =>
	run(join(root, "node_modules/.bin/wrangler"), args, join(root, cwd));

let domain: string;
try {
	({ domain } = stage(instance));
} catch (e) {
	if (!(e instanceof StageError)) throw e;
	console.error(e.message);
	process.exit(1);
}

const config = ["-c", "../.tower/prober.wrangler.json"];
const dry = dryRun ? ["--dry-run"] : [];
wrangler("prober", "deploy", ...config, ...dry);
if (!dryRun) wrangler("prober", "d1", "migrations", "apply", "DB", "--remote", ...config);
run("npm", ["run", "build", "-w", "page"]);
wrangler("page", "deploy", "--route", `${domain}/*`, ...dry);
