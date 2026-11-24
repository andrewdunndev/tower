import { BUCKET_MS, POINTS, quantile } from "./status.ts";

// The latency telemetry the Ticker keeps in its own SQLite: raw samples for 24 hours, plus the rollups the status
// panel reads. The SQL is the D1 SQL of migration 0006, moved here verbatim.
const DAY_MS = 86_400_000;

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
		CREATE TABLE IF NOT EXISTS histogram ("check" TEXT NOT NULL, ms INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY ("check", ms)) WITHOUT ROWID;
		CREATE TABLE IF NOT EXISTS buckets (bucket INTEGER NOT NULL, "check" TEXT NOT NULL, n INTEGER NOT NULL, total INTEGER NOT NULL, PRIMARY KEY (bucket, "check")) WITHOUT ROWID;
	`);
}

// One tick's samples and the prune at t, in one transaction so the rollups never disagree with the samples.
export function record(storage: DurableObjectStorage, rows: Sample[], t: number) {
	storage.transactionSync(() => {
		const sql = storage.sql;
		for (const r of rows) {
			sql.exec(`INSERT INTO samples ("check", at, ms, ok) VALUES (?, ?, ?, ?)`, r.check, r.at, r.ms, r.ok ? 1 : 0);
			if (!r.ok) continue;
			sql.exec(
				`INSERT INTO histogram ("check", ms, n) VALUES (?1, ?2, 1) ON CONFLICT ("check", ms) DO UPDATE SET n = n + 1`,
				r.check,
				r.ms,
			);
			sql.exec(
				`INSERT INTO buckets (bucket, "check", n, total) VALUES (?1, ?2, 1, ?3)
				 ON CONFLICT (bucket, "check") DO UPDATE SET n = n + 1, total = total + ?3`,
				Math.floor(r.at / BUCKET_MS) * BUCKET_MS,
				r.check,
				r.ms,
			);
		}
		prune(sql, t);
	});
}

export function prune(sql: SqlStorage, t: number) {
	const cutoff = t - DAY_MS;
	sql.exec(
		`UPDATE histogram SET n = n - (SELECT COUNT(*) FROM samples s WHERE s."check" = histogram."check" AND s.ms = histogram.ms AND s.ok = 1 AND s.at < ?1)
		 WHERE ("check", ms) IN (SELECT "check", ms FROM samples WHERE ok = 1 AND at < ?1)`,
		cutoff,
	);
	sql.exec(
		`DELETE FROM histogram WHERE n <= 0 AND ("check", ms) IN (SELECT "check", ms FROM samples WHERE ok = 1 AND at < ?1)`,
		cutoff,
	);
	sql.exec(`DELETE FROM samples WHERE at < ?1`, cutoff);
	sql.exec(`DELETE FROM buckets WHERE bucket < ?1`, cutoff);
}

// p50, p95 and the 24-hour chart over (now - 24 h, now]. The prune keeps the sample at exactly t - 24 h until the
// next tick, so the samples at or before now - 24 h are subtracted from the histogram here.
export function latency(sql: SqlStorage, ids: string[], now: number) {
	const firstBucket = Math.floor(now / BUCKET_MS) * BUCKET_MS - (POINTS - 1) * BUCKET_MS;
	const spread = new Map<string, Map<number, number>>(ids.map((id) => [id, new Map()]));
	for (const r of sql.exec<{ check: string; ms: number; n: number }>(`SELECT "check", ms, n FROM histogram`))
		spread.get(r.check)?.set(r.ms, r.n);
	for (const r of sql.exec<{ check: string; ms: number; n: number }>(
		`SELECT "check", ms, COUNT(*) AS n FROM samples WHERE ok = 1 AND at <= ?1 GROUP BY "check", ms`,
		now - DAY_MS,
	)) {
		const m = spread.get(r.check);
		m?.set(r.ms, (m.get(r.ms) ?? 0) - r.n);
	}
	const points = Map.groupBy(
		sql.exec<{ check: string; bucket: number; ms: number }>(
			`SELECT "check", CAST((bucket - ?1) / ?2 AS INTEGER) AS bucket, CAST(total AS REAL) / n AS ms FROM buckets WHERE bucket >= ?1`,
			firstBucket,
			BUCKET_MS,
		),
		(r) => r.check,
	);
	return Object.fromEntries(
		ids.map((id) => {
			const rows = [...(spread.get(id) ?? [])].filter(([, n]) => n > 0).sort((a, b) => a[0] - b[0]);
			const byBucket = new Map((points.get(id) ?? []).map((r) => [r.bucket, r.ms]));
			const hist = rows.map(([ms, n]) => ({ ms, n }));
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
