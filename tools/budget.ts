export const CONCURRENCY = 6;
export const SKEW_MS = 2000;
export const DB_MARGIN_MS = 5000;

export const fits = (probes: number, timeoutMs: number, shortestMs: number) =>
	Math.ceil(probes / CONCURRENCY) * timeoutMs <= shortestMs - SKEW_MS - DB_MARGIN_MS;
