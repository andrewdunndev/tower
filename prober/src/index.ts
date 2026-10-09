import { WorkerEntrypoint } from "cloudflare:workers";
import config from "../../.tower/tower.json";
import type { Instance } from "../../tools/schema.ts";
import { tick } from "./run.ts";
import { status } from "./status.ts";

const instance = config as Instance;

export class Tower extends WorkerEntrypoint<Env> {
	status() {
		return status(this.env.DB, instance, Date.now());
	}

	async beat(_id: string, _token: string, _ok: boolean) {
		return new Response(null, { status: 404 });
	}
}

export default {
	async scheduled(controller, env) {
		await tick(env, instance, controller.scheduledTime);
	},
} satisfies ExportedHandler<Env>;
