import type { Check } from "../../tools/schema.ts";
import type { Deps, Outcome } from "./probe.ts";

type HttpCheck = Extract<Check, { type: "http" }>;

const CACHED = new Set(["HIT", "STALE", "UPDATING"]);
const BODY_BYTES = 65536;

async function readText(res: Response, limit: number): Promise<string> {
	const reader = res.body?.getReader();
	if (!reader) return "";
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	while (bytes < limit) {
		const { done, value } = await reader.read();
		if (done) break;
		const chunk = value.subarray(0, limit - bytes);
		bytes += chunk.length;
		text += decoder.decode(chunk, { stream: true });
	}
	await reader.cancel();
	return text;
}

function dig(value: unknown, path: string): unknown {
	return path.split(".").reduce((o, k) => (o as Record<string, unknown> | null | undefined)?.[k], value);
}

async function judge(c: HttpCheck, res: Response): Promise<string | null> {
	if (res.status !== c.expect_status) {
		await res.body?.cancel();
		return `HTTP ${res.status}`;
	}
	if (!c.allow_cache && CACHED.has(res.headers.get("cf-cache-status") ?? "")) {
		await res.body?.cancel();
		return "served from cache";
	}
	if (c.contains === undefined && c.absent === undefined && !c.json) {
		await res.body?.cancel();
		return null;
	}
	const body = await readText(res, BODY_BYTES);
	if (c.contains !== undefined && !body.includes(c.contains)) return "missing expected text";
	if (c.absent !== undefined && body.includes(c.absent)) return "found forbidden text";
	if (c.json) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			return "body is not JSON";
		}
		if (dig(parsed, c.json.path) !== c.json.equals) return `json ${c.json.path} mismatch`;
	}
	return null;
}

export async function probeHttp(c: HttpCheck, d: Deps): Promise<Outcome> {
	try {
		const res = await d.fetch(c.url, {
			redirect: "manual",
			signal: AbortSignal.timeout(d.timeoutMs),
			headers: { "user-agent": "tower" },
		});
		const reason = await judge(c, res);
		return reason === null ? { verdict: "ok", reason: null } : { verdict: "down", reason };
	} catch (e) {
		const { name, message } = e as Error;
		return {
			verdict: "down",
			reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : `fetch failed: ${message}`,
		};
	}
}

export function hint(reason: string | null): string {
	if (reason === "timeout" || reason === "HTTP 522" || reason === "HTTP 523") return "the origin or its uplink is dark";
	if (reason === "HTTP 521") return "the host is up but refused the connection";
	if (reason === "HTTP 525" || reason === "HTTP 526") return "TLS between Cloudflare and the origin failed";
	if (reason === "HTTP 530") return "Cloudflare cannot reach the origin (tunnel connector down or origin DNS error)";
	if (reason === "HTTP 502") return "the origin behind the tunnel is down";
	return "";
}
