import type { Check } from "../../tools/schema.ts";
import type { Deps, Outcome } from "./probe.ts";

export async function probeTcp(c: Extract<Check, { type: "tcp" }>, d: Deps): Promise<Outcome> {
	let socket: ReturnType<Deps["connect"]> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		socket = d.connect({ hostname: c.host, port: c.port });
		const limit = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("timeout")), d.timeoutMs);
		});
		await Promise.race([socket.opened, limit]);
		return { verdict: "ok", reason: null };
	} catch (e) {
		const { message } = e as Error;
		return { verdict: "down", reason: message === "timeout" ? "timeout" : `connect failed: ${message}` };
	} finally {
		clearTimeout(timer);
		socket?.close().catch(() => {});
	}
}
