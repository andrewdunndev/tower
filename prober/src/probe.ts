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
	token?: "bad" | "ok";
}

export interface Deps {
	db: D1Database;
	fetch: typeof fetch;
	connect: typeof connect;
	token: string | undefined;
	timeoutMs: number;
	now: number;
}

export function probe(check: Exclude<Check, { type: "heartbeat" }>, d: Deps): Promise<Outcome> {
	switch (check.type) {
		case "http":
			return probeHttp(check, d);
		case "tcp":
			return probeTcp(check, d);
		case "dns":
			return probeDns(check, d);
		case "tls":
			return probeTls(check, d);
	}
}
