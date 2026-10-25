import config from "../../.tower/outside.json";
import { REPEAT_HOURS, REPEAT_MS } from "../../prober/src/latch.ts";
import { sendMail } from "../../prober/src/mail.ts";

const TIMEOUT_S = 10;

interface Config {
	url: string;
	alert: { from: string; to: string };
}

interface Deps {
	DB: D1Database;
	EMAIL: Pick<SendEmail, "send">;
}

async function failure(url: string, get: typeof fetch): Promise<string | null> {
	try {
		const res = await get(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_S * 1000) });
		const body = await res.text();
		if (res.status === 200 && body === "ok") return null;
		return `${res.status} ${body.replace(/[^\x20-\x7e]/g, "").slice(0, 20)}`.trim();
	} catch (e) {
		const name = (e as Error).name;
		return name === "TimeoutError" || name === "AbortError" ? `no answer within ${TIMEOUT_S} s` : "network error";
	}
}

export async function outside(env: Deps, cfg: Config, t: number, get: typeof fetch): Promise<void> {
	const reason = await failure(cfg.url, get);
	const domain = new URL(cfg.url).host;
	const iso = (ms: number) => new Date(ms).toISOString();
	const [, read] = await env.DB.batch<{ since: number; mailed: number | null }>([
		env.DB.prepare(
			"CREATE TABLE IF NOT EXISTS outside (id INTEGER PRIMARY KEY CHECK (id = 1), since INTEGER NOT NULL, mailed INTEGER)",
		),
		env.DB.prepare("SELECT since, mailed FROM outside"),
	]);
	const row = read.results[0];
	const send = async (subject: string, text: string) =>
		(await sendMail(env.EMAIL, cfg.alert, subject, text)) === "sent";

	if (reason === null) {
		if (!row) return;
		if (row.mailed !== null) {
			const sent = await send(
				`OUTSIDE CHECK RECOVERED: ${domain}`,
				`GET ${cfg.url} answers 200 ok again.\nFailing since ${iso(row.since)}, recovered ${iso(t)}.\n`,
			);
			if (!sent) return;
		}
		await env.DB.prepare("DELETE FROM outside").run();
		return;
	}
	if (!row) {
		await env.DB.prepare("INSERT INTO outside (id, since) VALUES (1, ?1)").bind(t).run();
		return;
	}
	if (row.mailed !== null && t - row.mailed < REPEAT_MS) return;
	const sent = await send(
		`OUTSIDE CHECK FAILING: ${domain}`,
		`GET ${cfg.url} did not answer 200 ok: ${reason}.\nFailing since ${iso(row.since)}, detected ${iso(t)}. This repeats every ${REPEAT_HOURS} hours until it answers.\n`,
	);
	if (sent) await env.DB.prepare("UPDATE outside SET mailed = ?1").bind(t).run();
}

export default {
	async scheduled(controller, env) {
		await outside(env, config, controller.scheduledTime, fetch);
	},
} satisfies ExportedHandler<Deps>;
