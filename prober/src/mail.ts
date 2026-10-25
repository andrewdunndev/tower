import { EmailMessage } from "cloudflare:email";
import type { Check, Instance } from "../../tools/schema.ts";
import { hint } from "./http.ts";
import { SELF_NAMES } from "./status.ts";

export interface Pending {
	at: number;
	key: string;
	kind: "down" | "up" | "firing" | "resolved" | "stale" | "digest" | "self-failing";
	since: number | null;
	reason: string | null;
}

export const SEND_TIMEOUT_MS = 10_000;

const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}...` : s);
const line = (s: string) => s.replace(/[\r\n]+/g, " ");
const strip = (s: string, newlines: boolean) =>
	s.normalize("NFKD").replace(newlines ? /[^\x20-\x7e\n]/g : /[^\x20-\x7e]/g, "");
const ascii = (s: string) => strip(line(s), false);

function target(c: Check): string {
	switch (c.type) {
		case "http":
			return ` (${clip(c.url)})`;
		case "tcp":
			return ` (${clip(c.host)}:${c.port})`;
		case "dns":
			return ` (${clip(c.query)} ${c.record})`;
		case "tls":
			return ` (${clip(c.host)})`;
		case "heartbeat":
			return "";
	}
}

export function message(check: Check, p: Pending): [subject: string, text: string] {
	const name = clip(check.name);
	const at = new Date(p.at).toISOString();
	const since = p.since === null ? null : new Date(p.since).toISOString();
	if (p.kind === "up") {
		const span = since ? `Down since ${since}, up ${at}.` : `Up ${at}.`;
		return [`UP: ${name}`, `${name}${target(check)} is back.\n${span}\n`];
	}
	const why = [p.reason && clip(p.reason), hint(p.reason)].filter(Boolean).join(": ");
	return [
		`DOWN: ${name}`,
		`${name}${target(check)} is down, detected ${at}.\nLast failure: ${why}.\n${since ? `Up since ${since}.\n` : ""}`,
	];
}

function transitions(items: [Check, Pending][]): [subject: string, text: string] {
	if (items.length === 1) return message(...items[0]);
	const up = items[0][1].kind === "up";
	const names = items.map(([c]) => clip(line(c.name)));
	const lines = items.map(([check, p]) => {
		const at = new Date(p.at).toISOString();
		const since = p.since === null ? null : new Date(p.since).toISOString();
		const name = `${clip(check.name)}${target(check)}`;
		if (up) return `${name}: ${since ? `down since ${since}, up ${at}` : `up ${at}`}.`;
		const why = [p.reason && clip(p.reason), hint(p.reason)].filter(Boolean).join(": ");
		return `${name}: ${why}. Detected ${at}.`;
	});
	return [clip(`${up ? "UP" : "DOWN"}: ${items.length} checks: ${names.join(", ")}`), `${lines.join("\n")}\n`];
}

function stuckMessage(check: Check, p: Pending): [subject: string, text: string] {
	const name = clip(check.name);
	const at = new Date(p.at).toISOString();
	const since = new Date(p.since ?? p.at).toISOString();
	const last = p.reason ? `Last reason: ${clip(p.reason)}.\n` : "";
	return [
		`SELF-CHECK FAILING: results for ${name}`,
		`${name}${target(check)} has had no fresh result since ${since}, three of its intervals plus a minute; detected ${at}.\n${last}`,
	];
}

type Relay = Instance["relays"][number];

const LABEL = { firing: "FIRING", resolved: "RESOLVED", stale: "STOPPED REPORTING" } as const;
const SUMMARY_LINES = 50;

function detail(reason: string | null): { title: string; description?: string; source_url?: string } {
	try {
		return { title: "", ...JSON.parse(reason ?? "") };
	} catch {
		return { title: "" };
	}
}

export function relayMessage(relay: Relay, p: Pending): [subject: string, text: string] {
	const { title, description } = detail(p.reason);
	if (p.kind !== "stale") return [line(title), description ?? ""];
	const at = new Date(p.at).toISOString();
	const since = p.since === null ? null : new Date(p.since).toISOString();
	const when = `No report within ${Math.round(relay.grace / 60_000)} minutes, closed ${at}.${since ? `\nFiring since ${since}.` : ""}`;
	return [`${LABEL.stale}: ${clip(relay.name)}: ${clip(line(title))}`, `${title}\n${when}\nKey: ${p.key}\n`];
}

function relaySummary(relay: Relay, rows: Pending[]): [subject: string, text: string] {
	const latest = new Map(rows.map((r) => [r.key, r]));
	const lines = [...latest.values()]
		.slice(0, SUMMARY_LINES)
		.map((r) => `${LABEL[r.kind as keyof typeof LABEL]}: ${clip(line(detail(r.reason).title))}`);
	if (latest.size > SUMMARY_LINES) lines.push(`and ${latest.size - SUMMARY_LINES} more`);
	return [`ALERTS: ${clip(relay.name)}: ${latest.size} changed`, `${lines.join("\n")}\n`];
}

export interface Attention {
	lines: string[];
	need: number;
	up: number;
	total: number;
	resolved: number;
	sent: number;
	dead: number;
}

export const NONE: Attention = { lines: [], need: 0, up: 0, total: 0, resolved: 0, sent: 0, dead: 0 };

function digest(config: Instance, p: Pending, a: Attention): [string, string] {
	const day = new Date(p.at).toISOString().slice(0, 10);
	const title = `DIGEST: ${clip(config.title)} ${day}`;
	const summary = `Checked ${a.up}/${a.total} checks up. Relay keys fired and resolved: ${a.resolved}. Mail: ${a.sent} sent, ${a.dead} dead.`;
	return [
		`${title}: ${a.need === 0 ? "all up" : `${a.need} need attention`}`,
		`${[...a.lines.map((l) => clip(line(l), 300)), summary].join("\n")}\n`,
	];
}

export function towerMessage(config: Instance, p: Pending, report = NONE): [subject: string, text: string] {
	const at = new Date(p.at).toISOString();
	if (p.kind === "digest") return digest(config, p, report);
	if (p.key === "stall") {
		const since = new Date(p.since ?? p.at).toISOString();
		return [
			"SELF-CHECK FAILING: probing stalled",
			`No probe run has written results since ${since}; detected ${at}. The prober's cron trigger or its runs are failing; its Worker log says which.\n`,
		];
	}
	const relay = config.relays.find((r) => `full:${r.id}` === p.key);
	if (relay) {
		const name = clip(relay.name);
		return [
			`SELF-CHECK FAILING: relay ${name} is full`,
			`Relay ${name} is at its limit of open keys and refused a new one, ${at}.\nIt closes keys that resolve or stop reporting.\n`,
		];
	}
	const what = SELF_NAMES[p.key] ?? clip(p.key);
	return [
		`SELF-CHECK FAILING: ${what}`,
		`${what} is failing, ${at}.\nThe token needs Zone Read and SSL and Certificates Read, and CF_API_TOKEN must be set.\n`,
	];
}

export function compose(
	config: Instance,
	rows: (Pending & { check: string })[],
	report = NONE,
): [string, string] | null {
	const latest = rows[rows.length - 1];
	const check = config.checks.find((c) => c.id === latest.check);
	if (check) {
		if (latest.key === "stuck") return stuckMessage(check, latest);
		const newest = new Map(rows.map((r) => [r.check, r]));
		return transitions(
			[...newest.values()].flatMap((r) => {
				const c = config.checks.find((x) => x.id === r.check);
				return c ? [[c, r] as [Check, Pending]] : [];
			}),
		);
	}
	const relay = config.relays.find((r) => r.id === latest.check);
	if (relay) return rows.length > 1 ? relaySummary(relay, rows) : relayMessage(relay, latest);
	return latest.check === "" ? towerMessage(config, latest, report) : null;
}

export function mime(from: string, to: string, subject: string, text: string): string {
	const domain = line(from).split("@").pop();
	return [
		`From: ${line(from)}`,
		`To: ${line(to)}`,
		`Subject: ${ascii(subject)}`,
		`Date: ${new Date().toUTCString()}`,
		`Message-ID: <${crypto.randomUUID()}@${domain}>`,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=us-ascii",
		"Content-Transfer-Encoding: 7bit",
		"",
		strip(text, true)
			.replace(/[^\n]{900}(?=[^\n])/g, "$&\n")
			.replace(/\n/g, "\r\n"),
	].join("\r\n");
}

export async function sendMail(
	email: Pick<SendEmail, "send">,
	alert: { from: string; to: string },
	subject: string,
	text: string,
): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const limit = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("send timed out")), SEND_TIMEOUT_MS);
	});
	try {
		await Promise.race([
			email.send(new EmailMessage(alert.from, alert.to, mime(alert.from, alert.to, subject, text))),
			limit,
		]);
		return true;
	} catch (e) {
		console.error("tower: mail failed, will retry:", (e as Error).message);
		return false;
	} finally {
		clearTimeout(timer);
	}
}
