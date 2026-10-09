import type { Check } from "../../tools/schema.ts";
import type { Deps, Outcome } from "./probe.ts";

const TYPES = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28 } as const;

interface Doh {
	Status: number;
	Answer?: { type: number; data: string }[];
}

const normal = (s: string) => s.replace(/^"|"$/g, "").replace(/\.$/, "").toLowerCase();

export async function probeDns(c: Extract<Check, { type: "dns" }>, d: Deps): Promise<Outcome> {
	let doh: Doh;
	try {
		const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(c.query)}&type=${c.record}`;
		const res = await d.fetch(url, {
			headers: { accept: "application/dns-json" },
			signal: AbortSignal.timeout(d.timeoutMs),
		});
		if (!res.ok) return { verdict: "inconclusive", reason: `resolver HTTP ${res.status}` };
		doh = await res.json();
	} catch (e) {
		return { verdict: "inconclusive", reason: `resolver unreachable: ${(e as Error).message}` };
	}
	if (doh.Status !== 0) return { verdict: "down", reason: doh.Status === 3 ? "NXDOMAIN" : `DNS rcode ${doh.Status}` };
	const answers = (doh.Answer ?? []).filter((a) => a.type === TYPES[c.record]);
	if (answers.length === 0) return { verdict: "down", reason: "no answer" };
	if (c.expect !== undefined && !answers.some((a) => normal(a.data) === normal(c.expect as string))) {
		return { verdict: "down", reason: "answer mismatch" };
	}
	return { verdict: "ok", reason: null };
}
