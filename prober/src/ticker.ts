import { connect } from "cloudflare:sockets";
import { DurableObject } from "cloudflare:workers";
import config from "../../.tower/tower.json";
import type { Instance } from "../../tools/schema.ts";
import { tick } from "./run.ts";

const MINUTE = 60_000;
const minute = (at: number) => Math.floor(at / MINUTE) * MINUTE;

export class Ticker extends DurableObject<Env> {
	async kick() {
		if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
	}

	async alarm() {
		const now = Date.now();
		await this.ctx.storage.setAlarm(minute(now) + MINUTE);
		await tick(this.env, config as Instance, minute(now), now, fetch, connect);
	}
}
