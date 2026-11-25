import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { tick } from "../src/run.ts";
import { status } from "../src/status.ts";
import { MINUTE, mailbox, makeConfig, reset, respond, T0, web } from "./util.ts";

beforeEach(reset);

const DAY = 86_400_000;
// D1 free reads are 5M rows a day: 1440 ticks x 400 + 1749 status calls x 2400 = 4.78M.
const TICK_ROWS = 400;
const STATUS_ROWS = 2400;

// Wraps D1 so every statement and batch adds its meta.rows_read to the tally.
function metered(db: D1Database) {
	const tally = { rows: 0 };
	const add = (meta: { rows_read?: number }) => {
		tally.rows += meta.rows_read ?? 0;
	};
	const wrap = (st: D1PreparedStatement): D1PreparedStatement =>
		new Proxy(st, {
			get(target, key) {
				if (key === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
				if (key === "run" || key === "all")
					return async () => {
						const r = await target.all();
						add(r.meta);
						return r;
					};
				if (key === "first")
					return async () => {
						const r = await target.all();
						add(r.meta);
						return r.results[0] ?? null;
					};
				const v = Reflect.get(target, key);
				return typeof v === "function" ? v.bind(target) : v;
			},
		});
	const proxy = new Proxy(db, {
		get(target, key) {
			if (key === "prepare") return (sql: string) => wrap(target.prepare(sql));
			if (key === "batch")
				return async (sts: D1PreparedStatement[]) => {
					const rs = await target.batch(sts);
					for (const r of rs) add(r.meta);
					return rs;
				};
			const v = Reflect.get(target, key);
			return typeof v === "function" ? v.bind(target) : v;
		},
	});
	return { db: proxy as D1Database, tally };
}

describe("D1 row budget at day 90", () => {
	it("keeps a tick and a status call inside the daily read budget", async () => {
		const checks = [
			...Array.from({ length: 14 }, (_, i) => ({ ...web, id: `c${i}`, name: `C${i}` })),
			{ ...web, id: "hidden", name: "Hidden", public: false },
		];
		const config = makeConfig(checks);
		const { runEnv } = mailbox();
		const { db, tally } = metered(env.DB);
		const probe = { ...runEnv, DB: db };
		const ok = respond(200) as unknown as typeof fetch;
		await tick(probe, config, T0 - MINUTE, T0 - MINUTE, ok);

		const days = Array.from({ length: 90 }, (_, i) => new Date(T0 - i * DAY).toISOString().slice(0, 10));
		const daily = env.DB.prepare(
			`INSERT OR REPLACE INTO daily ("check", day, runs, down, maint) VALUES (?1, ?2, 1440, 3, 0)`,
		);
		const event = env.DB.prepare(`INSERT INTO events ("check", at, "from", "to") VALUES (?1, ?2, ?3, ?4)`);
		await env.DB.batch([
			// A private check with many events must not widen the status read.
			...Array.from({ length: 2000 }, (_, i) =>
				event.bind("hidden", T0 - (i + 1) * 60_000, i % 2 ? "down" : "up", i % 2 ? "up" : "down"),
			),
			...checks.flatMap((c) => days.map((d) => daily.bind(c.id, d))),
			...checks
				.filter((c) => c.id !== "hidden")
				.flatMap((c) =>
					Array.from({ length: 20 }, (_, i) =>
						event.bind(c.id, T0 - (i + 1) * 1.5 * DAY, i % 2 ? "down" : "up", i % 2 ? "up" : "down"),
					),
				),
		]);

		const ticks: number[] = [];
		for (let k = 0; k < 3; k++) {
			tally.rows = 0;
			await tick(probe, config, T0 + k * MINUTE, T0 + k * MINUTE, ok);
			ticks.push(tally.rows);
		}
		tally.rows = 0;
		await status(db, config, T0 + 5 * MINUTE, null);

		expect(Math.min(...ticks, tally.rows), "rows_read is reported").toBeGreaterThan(0);
		expect(Math.max(...ticks)).toBeLessThanOrEqual(TICK_ROWS);
		expect(tally.rows).toBeLessThanOrEqual(STATUS_ROWS);
	});
});
