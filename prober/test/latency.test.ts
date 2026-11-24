import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { latency, prune, record } from "../src/latency.ts";
import { MINUTE, T0 } from "./util.ts";

const DAY = 24 * 60 * MINUTE;
const TICKS = 1500;
const ids = ["web", "api"];

// main's two queries over samples, copied verbatim from main at 4924755 (the check column added).
function main(sql: SqlStorage, id: string, now: number) {
	const [p] = sql
		.exec<{ p50: number | null; p95: number | null }>(
			`SELECT MAX(CASE WHEN rank = CAST(0.5 * (n - 1) AS INTEGER) THEN ms END) AS p50,
			        MAX(CASE WHEN rank = CAST(0.95 * (n - 1) AS INTEGER) THEN ms END) AS p95
			 FROM (SELECT ms, ROW_NUMBER() OVER (ORDER BY ms) - 1 AS rank, COUNT(*) OVER () AS n
			       FROM samples WHERE "check" = ?2 AND ok = 1 AND at > ?1)`,
			now - DAY,
			id,
		)
		.toArray();
	const first = Math.floor(now / 300_000) * 300_000 - 287 * 300_000;
	const latency = Array.from({ length: 288 }, () => null as number | null);
	for (const r of sql
		.exec<{ bucket: number; ms: number }>(
			`SELECT CAST((at - ?1) / 300000 AS INTEGER) AS bucket, AVG(ms) AS ms FROM samples WHERE "check" = ?2 AND ok = 1 AND at >= ?1 GROUP BY bucket`,
			first,
			id,
		)
		.toArray())
		latency[r.bucket] = Math.round(r.ms);
	return { p50: p.p50, p95: p.p95, latency };
}

async function filled() {
	const stub = env.TICKER.getByName("parity");
	return { stub, last: T0 + (TICKS - 1) * MINUTE };
}

describe("latency", () => {
	it("matches main's queries over samples at the window edge and when stalled", async () => {
		const { stub, last } = await filled();
		await runInDurableObject(stub, (_, state) => {
			for (let i = 0; i < TICKS; i++) {
				const t = T0 + i * MINUTE;
				record(
					state.storage,
					ids.map((check, c) => ({
						check,
						at: t,
						ms: ((i * 37 + c * 11) % 97) + (i % 5) * 50,
						ok: (i + c * 4) % 9 !== 0,
					})),
					t,
				);
			}
			const nows = [last, last + 30_000, last + 59_000, last + 2 * 60 * MINUTE];
			// then a sweep over the next hour, so every sample that ages out at the edge is crossed
			for (let k = 1; k <= 120; k++) nows.push(last + k * 30_000 + 7);
			for (const now of nows) {
				const got = latency(state.storage.sql, ids, now);
				for (const id of ids) {
					const want = main(state.storage.sql, id, now);
					expect(got[id]).toEqual(want);
					expect(want.p95).toBeGreaterThan(want.p50 as number);
					expect(want.latency.filter((v) => v !== null).length).toBeGreaterThan(100);
				}
			}
			// the retained sample at exactly t - 24 h is the one a plain read would count
			expect(state.storage.sql.exec(`SELECT COUNT(*) AS n FROM samples WHERE at = ?`, last - DAY).one().n).toBe(2);
			expect(state.storage.sql.exec(`SELECT COUNT(*) AS n FROM histogram WHERE n <= 0`).one().n).toBe(0);
			const sum = (q: string) => state.storage.sql.exec<{ n: number }>(q).one().n;
			expect(sum(`SELECT SUM(n) AS n FROM histogram`)).toBe(sum(`SELECT COUNT(*) AS n FROM samples WHERE ok = 1`));
		});
	});

	it("answers null for a check with no samples and drops an aged-out one", async () => {
		const stub = env.TICKER.getByName("empty");
		await runInDurableObject(stub, (_, state) => {
			expect(latency(state.storage.sql, ["web"], T0).web).toMatchObject({ p50: null, p95: null });
			record(state.storage, [{ check: "web", at: T0, ms: 40, ok: true }], T0);
			expect(latency(state.storage.sql, ["web"], T0).web.p50).toBe(40);
			prune(state.storage.sql, T0 + DAY + MINUTE);
			expect(state.storage.sql.exec(`SELECT COUNT(*) AS n FROM samples`).one().n).toBe(0);
			expect(state.storage.sql.exec(`SELECT COUNT(*) AS n FROM histogram`).one().n).toBe(0);
		});
	});
});
