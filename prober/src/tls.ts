import type { Check } from "../../tools/schema.ts";
import type { Deps, Outcome } from "./probe.ts";

const API = "https://api.cloudflare.com/client/v4";
const DAY_MS = 86_400_000;
const DOWN_UNDER_MS = 2 * DAY_MS;
const PACK_RANK: Record<string, number> = {
	mh_custom: 0,
	sni_custom: 0,
	legacy_custom: 0,
	keyless: 0,
	advanced: 1,
	total_tls: 2,
	universal: 3,
};

interface Pack {
	type: string;
	status: string;
	hosts: string[];
	validity_days?: number;
	certificates: { expires_on: string }[];
}

class Stop extends Error {
	constructor(
		readonly verdict: "inconclusive" | "config-error",
		reason: string,
		readonly token?: "bad" | "ok",
	) {
		super(reason);
	}
}

async function get<T>(path: string, d: Deps): Promise<T> {
	let res: Response;
	try {
		res = await d.fetch(API + path, {
			headers: { authorization: `Bearer ${d.token}` },
			signal: AbortSignal.timeout(d.timeoutMs),
		});
	} catch (e) {
		throw new Stop("inconclusive", `api unreachable: ${(e as Error).message}`);
	}
	if (res.status === 401 || res.status === 403) {
		throw new Stop(
			"config-error",
			`api HTTP ${res.status}: the token needs Zone Read and SSL and Certificates Read on the zone`,
			"bad",
		);
	}
	if (!res.ok) throw new Stop("inconclusive", `api HTTP ${res.status}`);
	try {
		return ((await res.json()) as { result: T }).result;
	} catch {
		throw new Stop("inconclusive", "api returned a malformed body");
	}
}

async function zoneId(zone: string, d: Deps): Promise<string> {
	const key = `zone:${zone}`;
	const cached = await d.db.prepare(`SELECT value FROM meta WHERE key = ?1`).bind(key).first<{ value: string }>();
	if (cached) return cached.value;
	const [found] = await get<{ id: string }[]>(`/zones?name=${encodeURIComponent(zone)}`, d);
	if (!found)
		throw new Stop("config-error", `zone ${zone} not found: check the name and the token's zone access`, "ok");
	await d.db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)`).bind(key, found.id).run();
	return found.id;
}

function specificity(host: string, pack: Pack): number | null {
	if (pack.hosts.includes(host)) return 0;
	const parent = host.split(".").slice(1).join(".");
	return pack.hosts.includes(`*.${parent}`) ? 1 : null;
}

export async function probeTls(c: Extract<Check, { type: "tls" }>, d: Deps): Promise<Outcome> {
	if (!d.token) return { verdict: "config-error", reason: "CF_API_TOKEN is not set", token: "bad" };
	try {
		const packs = await get<Pack[]>(`/zones/${await zoneId(c.zone, d)}/ssl/certificate_packs?per_page=50`, d);
		const covering = packs
			.filter((p) => p.status === "active" && p.type in PACK_RANK)
			.flatMap((p) => {
				const s = specificity(c.host, p);
				return s === null ? [] : [{ pack: p, score: PACK_RANK[p.type] * 2 + s }];
			})
			.sort((a, b) => a.score - b.score);
		if (covering.length === 0) return { verdict: "down", reason: "no active certificate covers the host", token: "ok" };
		const { pack } = covering[0];
		const expires = Math.min(...pack.certificates.map((x) => Date.parse(x.expires_on)));
		if (!Number.isFinite(expires)) return { verdict: "inconclusive", reason: "certificate has no expiry", token: "ok" };
		const left = expires - d.now;
		if (left < DOWN_UNDER_MS)
			return {
				verdict: "down",
				reason: left < 0 ? "certificate expired" : "certificate expires within 2 days",
				token: "ok",
			};
		const overdue = pack.validity_days !== undefined && left < (pack.validity_days * DAY_MS) / 6;
		return { verdict: "ok", reason: null, degraded: overdue, token: "ok" };
	} catch (e) {
		if (e instanceof Stop) return { verdict: e.verdict, reason: e.message, token: e.token };
		return { verdict: "inconclusive", reason: "api returned an unexpected body" };
	}
}
