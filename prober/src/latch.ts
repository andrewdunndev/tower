export const REPEAT_MS = 3 * 3_600_000;

export interface Latch {
	claim(key: string, t: number): Promise<boolean>;
	release(key: string, t: number): Promise<void>;
}

export async function selfAlert(latch: Latch, key: string, t: number, send: () => Promise<boolean>): Promise<void> {
	if ((await latch.claim(key, t)) && !(await send())) await latch.release(key, t);
}

export function memoryLatch(): Latch {
	const last = new Map<string, number>();
	return {
		claim: async (key, t) => {
			const at = last.get(key);
			if (at !== undefined && t - at < REPEAT_MS) return false;
			last.set(key, t);
			return true;
		},
		release: async (key, t) => {
			last.set(key, t - REPEAT_MS);
		},
	};
}

export function d1Latch(db: D1Database): Latch {
	return {
		claim: async (key, t) => {
			const run = await db
				.prepare(
					`INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE CAST(meta.value AS INTEGER) <= CAST(excluded.value AS INTEGER) - ${REPEAT_MS}`,
				)
				.bind(key, String(t))
				.run();
			return run.meta.changes === 1;
		},
		release: async (key, t) => {
			await db
				.prepare(`UPDATE meta SET value = ?3 WHERE key = ?1 AND value = ?2`)
				.bind(key, String(t), String(t - REPEAT_MS))
				.run();
		},
	};
}
