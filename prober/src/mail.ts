import { EmailMessage } from "cloudflare:email";
import type { Check, Instance } from "../../tools/schema.ts";
import { hint } from "./http.ts";

export interface Pending {
	at: number;
	key: string;
	kind:
		| "down"
		| "up"
		| "firing"
		| "resolved"
		| "stale"
		| "deployed"
		| "digest"
		| "resumed"
		| "self-failing"
		| "self-ok";
	since: number | null;
	reason: string | null;
}

export const SEND_TIMEOUT_MS = 10_000;

const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}...` : s);
const line = (s: string) => s.replace(/[\r\n]+/g, " ");
const ascii = (s: string) => line(s).replace(/[^\x20-\x7e]/g, "?");

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

type Relay = Instance["relays"][number];

const LABEL = { firing: "FIRING", resolved: "RESOLVED", stale: "STOPPED REPORTING" } as const;

function detail(reason: string | null): { title: string; description?: string; source_url?: string } {
	try {
		return { title: "", ...JSON.parse(reason ?? "") };
	} catch {
		return { title: "" };
	}
}

export function relayMessage(relay: Relay, p: Pending): [subject: string, text: string] {
	const { title, description, source_url } = detail(p.reason);
	const at = new Date(p.at).toISOString();
	const since = p.since === null ? null : new Date(p.since).toISOString();
	const label = LABEL[p.kind as keyof typeof LABEL];
	let when: string;
	if (p.kind === "resolved") when = since ? `Firing since ${since}, resolved ${at}.` : `Resolved ${at}.`;
	else if (p.kind === "stale")
		when = `No report within ${Math.round(relay.grace / 60_000)} minutes, closed ${at}.${since ? `\nFiring since ${since}.` : ""}`;
	else when = `Firing, received ${at}.`;
	const body = [clip(title, 1000), when, description && clip(description, 4000), source_url && `Source: ${source_url}`];
	return [
		`${label}: ${clip(relay.name)}: ${clip(line(title))}`,
		`${body.filter(Boolean).join("\n")}\nKey: ${clip(p.key, 256)}\n`,
	];
}

export function relaySummary(relay: Relay, rows: Pending[]): [subject: string, text: string] {
	const latest = new Map(rows.map((r) => [r.key, r]));
	const lines = [...latest.values()].map(
		(r) => `${LABEL[r.kind as keyof typeof LABEL]}: ${clip(line(detail(r.reason).title))}`,
	);
	return [`ALERTS: ${clip(relay.name)}: ${latest.size} changed`, `${lines.join("\n")}\n`];
}

export function towerMessage(config: Instance, p: Pending): [subject: string, text: string] {
	const relay = config.relays.find((r) => `full:${r.id}` === p.key);
	const at = new Date(p.at).toISOString();
	if (!relay) return [`SELF-CHECK ${p.kind === "self-ok" ? "OK" : "FAILING"}: ${clip(p.key)}`, `${at}\n`];
	const name = clip(relay.name);
	return p.kind === "self-ok"
		? [`SELF-CHECK OK: relay ${name} has room`, `Relay ${name} is below its limit of open keys, ${at}.\n`]
		: [
				`SELF-CHECK FAILING: relay ${name} is full`,
				`Relay ${name} is at its limit of open keys and refused a new one, ${at}.\nIt closes keys that resolve or stop reporting.\n`,
			];
}

export function compose(config: Instance, rows: (Pending & { check: string })[]): [string, string] | null {
	const latest = rows[rows.length - 1];
	const check = config.checks.find((c) => c.id === latest.check);
	if (check) return message(check, latest);
	const relay = config.relays.find((r) => r.id === latest.check);
	if (relay) return rows.length > 1 ? relaySummary(relay, rows) : relayMessage(relay, latest);
	return latest.check === "" ? towerMessage(config, latest) : null;
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
		text
			.replace(/[^\x20-\x7e\n]/g, "?")
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
		console.error(`tower: mail failed, will retry: ${subject}:`, (e as Error).message);
		return false;
	} finally {
		clearTimeout(timer);
	}
}
