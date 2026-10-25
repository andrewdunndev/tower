import { WorkerEntrypoint } from "cloudflare:workers";

let reply = null;

export class Tower extends WorkerEntrypoint {
	async status() {
		if (reply === null) throw new Error("prober unavailable");
		return JSON.parse(reply);
	}

	async health() {
		if (reply === null) throw new Error("prober unavailable");
		return "ok";
	}
}

// POST a StatusResponse to answer with it; POST nothing to make status() throw.
export default {
	async fetch(request) {
		reply = (await request.text()) || null;
		return new Response(null, { status: 204 });
	},
};
