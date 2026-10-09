import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [cloudflareTest({ wrangler: { configPath: "./prober/wrangler.jsonc" } })],
	test: { include: ["tools/**/*.test.ts", "prober/test/**/*.test.ts"] },
});
