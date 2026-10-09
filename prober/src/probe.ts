import type { connect } from "cloudflare:sockets";
import type { Check } from "../../tools/schema.ts";
import { probeDns } from "./dns.ts";
import { probeHttp } from "./http.ts";
import { probeTcp } from "./tcp.ts";
import { probeTls } from "./tls.ts";

export interface Outcome {
	verdict: "ok" | "down" | "inconclusive" | "config-error";
	reason: string | null;
	degraded?: boolean;
}

export interface Deps {
	db: D1Database;
	fetch: typeof fetch;
	connect: typeof connect;
	token: string | undefined;
	timeoutMs: number;
	now: number;
}

export async function probe(check: Exclude<Check, { type: "heartbeat" }>, d: Deps): Promise<Outcome> {
	switch (check.type) {
		case "http": {
			const reason = await probeHttp(check, d.timeoutMs, d.fetch);
			return reason === null ? { verdict: "ok", reason: null } : { verdict: "down", reason };
		}
		case "tcp":
			return probeTcp(check, d.timeoutMs, d.connect);
		case "dns":
			return probeDns(check, d.timeoutMs, d.fetch);
		case "tls":
			return probeTls(check, d);
	}
}
