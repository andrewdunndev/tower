import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const wrangler = join(import.meta.dirname, "../../node_modules/.bin/wrangler");
const env = {
	...process.env,
	WRANGLER_SEND_METRICS: "false",
	WRANGLER_REGISTRY_PATH: join(tmpdir(), "tower-visual-registry"),
} as Record<string, string>;
const dev = (port: number) => `${wrangler} dev --ip 127.0.0.1 --port ${port} --inspector-port ${port + 100}`;

export default defineConfig({
	testDir: ".",
	workers: 1,
	forbidOnly: true,
	use: { baseURL: "http://127.0.0.1:8799", browserName: "chromium" },
	webServer: [
		{
			command: `${dev(8801)} -c stub.wrangler.jsonc`,
			cwd: import.meta.dirname,
			port: 8801,
			env,
			stdout: "pipe",
		},
		{
			command: dev(8799),
			cwd: join(import.meta.dirname, "../../page"),
			port: 8799,
			env,
			stdout: "pipe",
		},
	],
});
