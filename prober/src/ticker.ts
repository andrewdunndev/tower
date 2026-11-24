import { connect } from "cloudflare:sockets";
import { DurableObject } from "cloudflare:workers";
import config from "../../.tower/tower.json";
import type { Instance } from "../../tools/schema.ts";
import { create, latency, record, type Sample } from "./latency.ts";
import { tick } from "./run.ts";

const MINUTE = 60_000;
const minute = (at: number) => Math.floor(at / MINUTE) * MINUTE;

export class Ticker extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		create(ctx.storage.sql);
	}

	latency(now: number) {
		const ids = (config as Instance).checks.filter((c) => c.public).map((c) => c.id);
		return latency(this.ctx.storage.sql, ids, now);
	}

	async kick() {
		if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
	}

	async alarm() {
		const now = Date.now();
		await this.ctx.storage.setAlarm(minute(now) + MINUTE);
		const log = (rows: Sample[], t: number) => {
			try {
				record(this.ctx.storage, rows, t);
			} catch (e) {
				console.error("tower: latency write failed:", e);
			}
		};
		await tick(this.env, config as Instance, minute(now), now, fetch, connect, log);
	}
}
