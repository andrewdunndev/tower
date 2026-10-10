import { EmailMessage } from "cloudflare:email";
import type { Check } from "../../tools/schema.ts";
import { hint } from "./http.ts";

export interface Pending {
	at: number;
	kind: "down" | "up";
	since: number | null;
	reason: string | null;
}

export const SEND_TIMEOUT_MS = 10_000;

const clip = (s: string) => (s.length > 200 ? `${s.slice(0, 200)}...` : s);
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
		text.replace(/[^\x20-\x7e\n]/g, "?").replace(/\n/g, "\r\n"),
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
