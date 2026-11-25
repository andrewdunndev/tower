const DAY_MS = 86_400_000;
const BUCKET_MS = 300_000;
const POINTS = 288;

export interface Sample {
	check: string;
	at: number;
	ms: number;
	ok: boolean;
}

export function create(sql: SqlStorage) {
	sql.exec(`
		CREATE TABLE IF NOT EXISTS samples ("check" TEXT NOT NULL, at INTEGER NOT NULL, ms INTEGER NOT NULL, ok INTEGER NOT NULL);
		CREATE INDEX IF NOT EXISTS samples_at ON samples (at);
	`);
}

// One tick's samples and the prune at t, in one transaction.
export function record(storage: DurableObjectStorage, rows: Sample[], t: number) {
	storage.transactionSync(() => {
		for (const r of rows)
			storage.sql.exec(
				`INSERT INTO samples ("check", at, ms, ok) VALUES (?, ?, ?, ?)`,
				r.check,
				r.at,
				r.ms,
				r.ok ? 1 : 0,
			);
		storage.sql.exec(`DELETE FROM samples WHERE at < ?`, t - DAY_MS);
	});
}

// The ms at rank floor(q * (n - 1)) of the sorted samples, read off a histogram sorted by ms.
export function quantile(histogram: { ms: number; n: number }[], q: number): number | null {
	const rank = Math.trunc(q * (histogram.reduce((a, r) => a + r.n, 0) - 1));
	let seen = 0;
	for (const r of histogram) {
		seen += r.n;
		if (seen > rank) return r.ms;
	}
	return null;
}

export interface Latency {
	p50: number | null;
	p95: number | null;
	latency: (number | null)[];
}

// What the page gets when the Ticker cannot answer: the same shape as an empty window.
export const NO_LATENCY: Latency = { p50: null, p95: null, latency: Array.from({ length: POINTS }, () => null) };

// p50, p95 and the 24-hour chart over (now - 24 h, now]. The prune keeps the sample at exactly t - 24 h until the
// next tick, so the read excludes it.
export function latency(sql: SqlStorage, ids: string[], now: number): Record<string, Latency> {
	const firstBucket = Math.floor(now / BUCKET_MS) * BUCKET_MS - (POINTS - 1) * BUCKET_MS;
	const spread = Map.groupBy(
		sql.exec<{ check: string; ms: number; n: number }>(
			`SELECT "check", ms, COUNT(*) AS n FROM samples WHERE ok = 1 AND at > ?1 GROUP BY "check", ms ORDER BY "check", ms`,
			now - DAY_MS,
		),
		(r) => r.check,
	);
	const points = Map.groupBy(
		sql.exec<{ check: string; bucket: number; ms: number }>(
			`SELECT "check", CAST((at - ?1) / ?2 AS INTEGER) AS bucket, AVG(ms) AS ms FROM samples WHERE ok = 1 AND at >= ?1 GROUP BY "check", bucket`,
			firstBucket,
			BUCKET_MS,
		),
		(r) => r.check,
	);
	return Object.fromEntries(
		ids.map((id) => {
			const hist = spread.get(id) ?? [];
			const byBucket = new Map((points.get(id) ?? []).map((r) => [r.bucket, r.ms]));
			return [
				id,
				{
					p50: quantile(hist, 0.5),
					p95: quantile(hist, 0.95),
					latency: Array.from({ length: POINTS }, (_, i) => {
						const ms = byBucket.get(i);
						return ms === undefined ? null : Math.round(ms);
					}),
				},
			];
		}),
	);
}
