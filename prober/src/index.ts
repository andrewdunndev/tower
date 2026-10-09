import { WorkerEntrypoint } from "cloudflare:workers";

export class Tower extends WorkerEntrypoint<Env> {
	async status(): Promise<{ v: 1 }> {
		return { v: 1 };
	}

	async beat(_id: string, _token: string, _ok: boolean): Promise<boolean> {
		return false;
	}
}

export default {
	async scheduled(_controller, _env) {},
} satisfies ExportedHandler<Env>;
