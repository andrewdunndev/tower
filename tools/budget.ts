export const CONCURRENCY = 6;
export const SKEW_MS = 2000;
export const DB_MARGIN_MS = 5000;

const STALE_INTERVALS = 3;
const CRON_SLACK_MS = 60_000;
export const allowance = (every: number) => STALE_INTERVALS * every + CRON_SLACK_MS;

export const fits = (probes: number, timeoutMs: number, shortestMs: number) =>
	Math.ceil(probes / CONCURRENCY) * timeoutMs <= shortestMs - SKEW_MS - DB_MARGIN_MS;
