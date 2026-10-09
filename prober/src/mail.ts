import { EmailMessage } from "cloudflare:email";
import type { Check } from "../../tools/schema.ts";
import { hint } from "./http.ts";

export interface Pending {
	at: number;
	kind: "down" | "up";
	since: number;
	reason: string | null;
}

const SEND_TIMEOUT_MS = 10_000;

const line = (s: string) => s.replace(/[\r\n]+/g, " ");
const ascii = (s: string) => line(s).replace(/[^\x20-\x7e]/g, "?");

function target(c: Check): string {
	switch (c.type) {
		case "http":
			return ` (${c.url})`;
		case "tcp":
			return ` (${c.host}:${c.port})`;
		case "dns":
			return ` (${c.query} ${c.record})`;
		case "tls":
			return ` (${c.host})`;
		case "heartbeat":
			return "";
	}
}

export function message(check: Check, p: Pending): [subject: string, text: string] {
	const at = new Date(p.at).toISOString();
	const since = new Date(p.since).toISOString();
	if (p.kind === "up") {
		return [`UP: ${check.name}`, `${check.name}${target(check)} is back.\nDown since ${since}, up ${at}.\n`];
	}
	const why = [p.reason, hint(p.reason)].filter(Boolean).join(": ");
	return [
		`DOWN: ${check.name}`,
		`${check.name}${target(check)} is down, detected ${at}.\nLast failure: ${why}.\nUp since ${since}.\n`,
	];
}

function mime(from: string, to: string, subject: string, text: string): string {
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
		ascii(text).replace(/\r?\n/g, "\r\n"),
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
