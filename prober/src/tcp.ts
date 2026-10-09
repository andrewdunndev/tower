import type { connect } from "cloudflare:sockets";
import type { Check } from "../../tools/schema.ts";
import type { Outcome } from "./probe.ts";

const BLOCKED = /prohibited|not allowed|blocked/i;

export async function probeTcp(
	c: Extract<Check, { type: "tcp" }>,
	timeoutMs: number,
	doConnect: typeof connect,
): Promise<Outcome> {
	let socket: ReturnType<typeof connect> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		socket = doConnect({ hostname: c.host, port: c.port });
		const limit = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
		});
		await Promise.race([socket.opened, limit]);
		return { verdict: "ok", reason: null };
	} catch (e) {
		const { message } = e as Error;
		if (BLOCKED.test(message)) return { verdict: "config-error", reason: `address blocked: ${message}` };
		return { verdict: "down", reason: message === "timeout" ? "timeout" : `connect failed: ${message}` };
	} finally {
		clearTimeout(timer);
		await socket?.close().catch(() => {});
	}
}
