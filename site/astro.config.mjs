import { defineConfig } from "astro/config";

export default defineConfig({
	site: "https://tower.dunn.dev",
	output: "static",
	trailingSlash: "always",
	compressHTML: false,
	build: {
		format: "directory",
	},
	markdown: {
		syntaxHighlight: false,
	},
});
