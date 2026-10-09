import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./prober/migrations");

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./prober/wrangler.jsonc" },
			miniflare: { bindings: { MIGRATIONS: migrations } },
		}),
	],
	test: {
		include: ["tools/**/*.test.ts", "prober/test/**/*.test.ts"],
		setupFiles: ["./prober/test/setup.ts"],
	},
});
