import { createServer } from "node:net";
import type { TestProject } from "vitest/node";

declare module "vitest" {
	interface ProvidedContext {
		listenPort: number;
		closedPort: number;
	}
}

export default async function setup(project: TestProject) {
	const server = createServer((s) => s.on("error", () => {}));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	project.provide("listenPort", (server.address() as { port: number }).port);
	const probe = createServer();
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
	project.provide("closedPort", (probe.address() as { port: number }).port);
	await new Promise((resolve) => probe.close(resolve));
	return () => server.close();
}
