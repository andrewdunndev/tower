import { connect } from "cloudflare:sockets";
import { WorkerEntrypoint } from "cloudflare:workers";
import config from "../../.tower/tower.json";
import type { Instance } from "../../tools/schema.ts";
import { recordBeat } from "./heartbeat.ts";
import { incident, kept } from "./relay.ts";
import { tick, watch } from "./run.ts";
import { health } from "./self.ts";
import { status } from "./status.ts";

const instance = config as Instance;

export class Tower extends WorkerEntrypoint<Env> {
	async status() {
		try {
			return await status(this.env.DB, instance, Date.now());
		} catch (e) {
			console.error("tower: status failed:", e);
			throw new Error("status unavailable");
		}
	}

	async health() {
		return health(this.env.DB, instance, Date.now(), this.env.VERSION);
	}

	async beat(id: string, token: string, ok: boolean) {
		return recordBeat(this.env.DB, instance.checks, id, token, ok, Date.now());
	}

	async watch(now: number) {
		await watch(this.env, instance, now);
	}

	async incident(token: string, body: string) {
		return incident(this.env, instance, token, body, Date.now());
	}

	async kept(token: string) {
		return kept(this.env, instance, token);
	}
}

export default {
	async scheduled(controller, env) {
		await tick(env, instance, controller.scheduledTime, Date.now(), fetch, connect);
	},
} satisfies ExportedHandler<Env>;
