import { EmailMessage } from "cloudflare:email";
import pkg from "../../package.json";
import type { Check, Instance } from "../../tools/schema.ts";
import { hint } from "./http.ts";
import { SELF_NAMES } from "./status.ts";

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
const strip = (s: string, newlines: boolean) =>
	s.normalize("NFKD").replace(newlines ? /[^\x20-\x7e\n]/g : /[^\x20-\x7e]/g, "");
const ascii = (s: string) => strip(line(s), false);

/** Printable ASCII only: accents keep their base letter, emoji and other non-ASCII drop. */
export function plain(s: string, newlines = false): string {
	const t = strip(newlines ? s.replace(/\r\n?/g, "\n").replace(/\t/g, " ") : s.replace(/\s+/g, " "), newlines);
	return newlines
		? t
				.replace(/ +/g, " ")
				.replace(/ ?\n ?/g, "\n")
				.trim()
		: t.replace(/ {2,}/g, " ").trim();
}

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

function stuckMessage(check: Check, p: Pending): [subject: string, text: string] {
	const name = clip(check.name);
	const at = new Date(p.at).toISOString();
	if (p.kind === "self-ok") return [`SELF-CHECK OK: results for ${name}`, `${name} has fresh results again, ${at}.\n`];
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
	const { title, description, source_url } = detail(p.reason);
	const at = new Date(p.at).toISOString();
	const since = p.since === null ? null : new Date(p.since).toISOString();
	const label = LABEL[p.kind as keyof typeof LABEL];
	let when: string;
	if (p.kind === "resolved") when = since ? `Firing since ${since}, resolved ${at}.` : `Resolved ${at}.`;
	else if (p.kind === "stale")
		when = `No report within ${Math.round(relay.grace / 60_000)} minutes, closed ${at}.${since ? `\nFiring since ${since}.` : ""}`;
	else when = `Firing, received ${at}.`;
	const body = [title, when, description, source_url && `Source: ${source_url}`];
	return [`${label}: ${clip(relay.name)}: ${clip(line(title))}`, `${body.filter(Boolean).join("\n")}\nKey: ${p.key}\n`];
}

function relaySummary(relay: Relay, rows: Pending[]): [subject: string, text: string] {
	const latest = new Map(rows.map((r) => [r.key, r]));
	const lines = [...latest.values()]
		.slice(0, SUMMARY_LINES)
		.map((r) => `${LABEL[r.kind as keyof typeof LABEL]}: ${clip(line(detail(r.reason).title))}`);
	if (latest.size > SUMMARY_LINES) lines.push(`and ${latest.size - SUMMARY_LINES} more`);
	return [`ALERTS: ${clip(relay.name)}: ${latest.size} changed`, `${lines.join("\n")}\n`];
}

function digest(config: Instance, p: Pending, lines: string[]): [string, string] {
	const day = new Date(p.at).toISOString().slice(0, 10);
	const title = `DIGEST: ${clip(config.title)} ${day}`;
	if (lines.length === 0) return [`${title}: all up`, ""];
	return [`${title}: ${lines.length} need attention`, `${lines.map((l) => clip(line(l), 300)).join("\n")}\n`];
}

export function towerMessage(config: Instance, p: Pending, lines: string[] = []): [subject: string, text: string] {
	const at = new Date(p.at).toISOString();
	switch (p.kind) {
		case "deployed":
			return [`DEPLOYED: tower ${pkg.version}`, `Version ${pkg.version} is running, ${at}.\n`];
		case "digest":
			return digest(config, p, lines);
		case "resumed":
			return ["SELF-CHECK OK: probing resumed", `Probing resumed after a gap, ${at}.\n`];
	}
	if (p.key === "stall") {
		const since = new Date(p.since ?? p.at).toISOString();
		return p.kind === "self-ok"
			? towerMessage(config, { ...p, kind: "resumed" })
			: [
					"SELF-CHECK FAILING: probing stalled",
					`No probe run has written results since ${since}; detected ${at}. The prober's cron trigger or its runs are failing; its Worker log says which.\n`,
				];
	}
	const ok = p.kind === "self-ok";
	const relay = config.relays.find((r) => `full:${r.id}` === p.key);
	if (relay) {
		const name = clip(relay.name);
		return ok
			? [`SELF-CHECK OK: relay ${name} has room`, `Relay ${name} is below its limit of open keys, ${at}.\n`]
			: [
					`SELF-CHECK FAILING: relay ${name} is full`,
					`Relay ${name} is at its limit of open keys and refused a new one, ${at}.\nIt closes keys that resolve or stop reporting.\n`,
				];
	}
	const what = SELF_NAMES[p.key] ?? clip(p.key);
	return ok
		? [`SELF-CHECK OK: ${what}`, `${what} recovered, ${at}.\n`]
		: [
				`SELF-CHECK FAILING: ${what}`,
				`${what} is failing, ${at}.\nThe token needs Zone Read and SSL and Certificates Read, and CF_API_TOKEN must be set.\n`,
			];
}

export function compose(
	config: Instance,
	rows: (Pending & { check: string })[],
	lines: string[] = [],
): [string, string] | null {
	const latest = rows[rows.length - 1];
	const check = config.checks.find((c) => c.id === latest.check);
	if (check) return latest.key === "stuck" ? stuckMessage(check, latest) : message(check, latest);
	const relay = config.relays.find((r) => r.id === latest.check);
	if (relay) return rows.length > 1 ? relaySummary(relay, rows) : relayMessage(relay, latest);
	return latest.check === "" ? towerMessage(config, latest, lines) : null;
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
