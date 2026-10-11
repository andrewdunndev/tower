import { readdirSync, readFileSync } from "node:fs";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const built = "page/dist/server";
const pageModules = readdirSync(built, { recursive: true, encoding: "utf8" })
	.filter((f) => f.endsWith(".mjs"))
	.map((path) => ({ type: "ESModule" as const, path, contents: readFileSync(`${built}/${path}`, "utf8") }));

const compatibilityDate = JSON.parse(readFileSync(`${built}/wrangler.json`, "utf8")).compatibility_date;

const migrations = await readD1Migrations("./prober/migrations");

export default defineConfig({
	test: {
		projects: [
			{
				plugins: [
					cloudflareTest({
						wrangler: { configPath: "./.tower/prober.wrangler.json" },
						miniflare: {
							bindings: { MIGRATIONS: migrations },
							serviceBindings: { PAGE: "page", PAGE_REAL: "page-real", STUB: "stub" },
							workers: [
								{
									name: "page",
									modules: pageModules,
									compatibilityDate,
									serviceBindings: { TOWER: { name: "stub", entrypoint: "Tower" } },
								},
								{
									name: "page-real",
									modules: pageModules,
									compatibilityDate,
									serviceBindings: { TOWER: { name: "vitest-plugin-runner-workers", entrypoint: "Tower" } },
								},
								{ name: "stub", modules: true, scriptPath: "page/test/tower-stub.mjs", compatibilityDate },
							],
						},
					}),
				],
				test: {
					name: "workers",
					include: ["prober/test/**/*.test.ts", "page/test/**/*.test.ts"],
					globalSetup: ["./prober/test/listener.ts"],
					setupFiles: ["./prober/test/setup.ts"],
				},
			},
			{ test: { name: "tools", environment: "node", include: ["tools/**/*.test.ts"] } },
		],
	},
});
