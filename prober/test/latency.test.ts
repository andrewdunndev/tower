import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { latency, record } from "../src/latency.ts";
import { MINUTE, T0 } from "./util.ts";

const DAY = 24 * 60 * MINUTE;
const BUCKET = 5 * MINUTE;
const now = Math.floor(T0 / BUCKET) * BUCKET + 2 * MINUTE;
const first = Math.floor(now / BUCKET) * BUCKET - 287 * BUCKET;

const run = (name: string, fn: (storage: DurableObjectStorage) => void) =>
	runInDurableObject(env.TICKER.getByName(name), (_o, state) => fn(state.storage));
const ok = (at: number, ms: number, check = "web") => ({ check, at, ms, ok: true });

describe("latency", () => {
	it("reads the quantiles at rank floor(q * (n - 1)) of the ok samples", () =>
		run("quantiles", (storage) => {
			record(
				storage,
				Array.from({ length: 10 }, (_, i) => ok(now - (i + 1) * MINUTE, (10 - i) * 100)),
				now,
			);
			// 1000, 900 ... 100 sorted is 100 ... 1000: rank 4 is 500, rank 8 is 900
			expect(latency(storage.sql, ["web"], now).web).toMatchObject({ p50: 500, p95: 900 });
		}));

	it("counts a sample only when it is ok", () =>
		run("failed", (storage) => {
			record(
				storage,
				[ok(now - MINUTE, 100), { check: "web", at: now - 90_000, ms: 9000, ok: false }, ok(now - 2 * MINUTE, 300)],
				now,
			);
			const got = latency(storage.sql, ["web"], now).web;
			expect([got.p50, got.p95]).toEqual([100, 100]);
			expect(got.latency.filter((v) => v !== null)).toEqual([200]);
		}));

	it("covers (now - 24 h, now]: the sample at exactly now - 24 h is out, one ms later is in", () =>
		run("edge", (storage) => {
			record(storage, [ok(now - DAY, 7000), ok(now - DAY + 1, 40), ok(now - DAY + 2, 8000)], now - DAY + 2);
			expect(storage.sql.exec(`SELECT COUNT(*) AS n FROM samples`).one().n).toBe(3);
			const got = latency(storage.sql, ["web"], now).web;
			expect([got.p50, got.p95]).toEqual([40, 40]);
			expect(latency(storage.sql, ["web"], now - 1).web.p50).toBe(7000);
		}));

	it("places samples in 5 minute buckets, the last one holding now", () =>
		run("buckets", (storage) => {
			record(
				storage,
				[
					ok(first, 10),
					ok(first + BUCKET - 1, 30),
					ok(first + BUCKET, 50),
					ok(now - 3 * MINUTE, 60),
					ok(now, 71),
					ok(now, 72),
				],
				now,
			);
			const chart = latency(storage.sql, ["web"], now).web.latency;
			expect(chart).toHaveLength(288);
			expect(chart[0]).toBe(20);
			expect(chart[1]).toBe(50);
			expect(chart[286]).toBe(60);
			expect(chart[287]).toBe(72);
			expect(chart.filter((v) => v !== null)).toHaveLength(4);
		}));

	it("answers nulls for a check with no samples and keeps checks apart", () =>
		run("empty", (storage) => {
			expect(latency(storage.sql, ["web"], now).web).toMatchObject({ p50: null, p95: null });
			record(storage, [ok(now, 40, "api")], now);
			const got = latency(storage.sql, ["web", "api"], now);
			expect([got.web.p50, got.api.p50]).toEqual([null, 40]);
		}));
});

describe("record", () => {
	it("prunes samples older than 24 hours and keeps the one at exactly 24 hours", () =>
		run("prune", (storage) => {
			record(storage, [ok(now - DAY - 1, 1), ok(now - DAY, 2), ok(now - 1, 3)], now);
			expect(storage.sql.exec(`SELECT ms FROM samples ORDER BY ms`).toArray()).toEqual([{ ms: 2 }, { ms: 3 }]);
		}));
});
