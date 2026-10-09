import { readdirSync, readFileSync } from "node:fs";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const built = "page/dist/server";
const pageModules = readdirSync(built, { recursive: true, encoding: "utf8" })
	.filter((f) => f.endsWith(".mjs"))
	.map((path) => ({ type: "ESModule" as const, path, contents: readFileSync(`${built}/${path}`, "utf8") }));

const migrations = await readD1Migrations("./prober/migrations");

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./prober/wrangler.jsonc" },
			miniflare: {
				bindings: { MIGRATIONS: migrations },
				serviceBindings: { PAGE: "page", STUB: "stub" },
				workers: [
					{
						name: "page",
						modules: pageModules,
						compatibilityDate: "2026-10-01",
						serviceBindings: { TOWER: { name: "stub", entrypoint: "Tower" } },
					},
					{ name: "stub", modules: true, scriptPath: "page/test/tower-stub.mjs", compatibilityDate: "2026-10-01" },
				],
			},
		}),
	],
	test: {
		include: ["tools/**/*.test.ts", "prober/test/**/*.test.ts", "page/test/**/*.test.ts"],
		globalSetup: ["./prober/test/listener.ts"],
		setupFiles: ["./prober/test/setup.ts"],
	},
});
