import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { root, StageError, stage } from "./stage.ts";

export type DbState = "present" | "absent" | "unknown";
export type Step = "migrate" | "prober";

/** Migrate first when the database exists, deploy first when deploying creates it; an unreadable state aborts. */
export function plan(db: DbState, dryRun: boolean): Step[] | "abort" {
	if (dryRun) return ["prober"];
	if (db === "unknown") return "abort";
	return db === "present" ? ["migrate", "prober"] : ["prober", "migrate"];
}

function main() {
	const [instance, ...flags] = process.argv.slice(2);
	if (!instance) {
		console.error("usage: node tools/deploy.ts <instance-dir> [--dry-run]");
		process.exit(1);
	}
	const dryRun = flags.includes("--dry-run");
	const bin = join(root, "node_modules/.bin/wrangler");

	function run(cmd: string, args: string[], cwd = root) {
		const { status } = spawnSync(cmd, args, { cwd, stdio: "inherit" });
		if (status !== 0) process.exit(status ?? 1);
	}
	const wrangler = (cwd: string, ...args: string[]) => run(bin, args, join(root, cwd));

	let domain: string;
	let name: string;
	try {
		({ domain, name } = stage(instance));
	} catch (e) {
		if (!(e instanceof StageError)) throw e;
		console.error(e.message);
		process.exit(1);
	}

	const config = ["-c", "../.tower/prober.wrangler.json"];
	const dry = dryRun ? ["--dry-run"] : [];
	const steps = plan(dryRun ? "unknown" : databaseState(bin, name), dryRun);
	if (steps === "abort") {
		console.error("tower: could not read the D1 database list; nothing was deployed.");
		process.exit(1);
	}
	for (const step of steps) {
		if (step === "migrate") wrangler("prober", "d1", "migrations", "apply", "DB", "--remote", ...config);
		else wrangler("prober", "deploy", ...config, ...dry);
	}
	run("npm", ["run", "build", "-w", "page"]);
	wrangler("page", "deploy", "--route", `${domain}/*`, ...dry);
}

function databaseState(bin: string, name: string): DbState {
	const r = spawnSync(bin, ["d1", "list", "--json"], { cwd: join(root, "prober"), encoding: "utf8" });
	if (r.status !== 0) return "unknown";
	try {
		const list: { name: string }[] = JSON.parse(r.stdout);
		return list.some((d) => d.name === name) ? "present" : "absent";
	} catch {
		return "unknown";
	}
}

if (import.meta.main) main();
