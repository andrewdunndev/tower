import { describe, expect, it } from "vitest";
import { compose, message, mime } from "../src/mail.ts";
import { MINUTE, makeConfig, T0, web } from "./util.ts";

describe("mime", () => {
	it("keeps headers on single lines and separates the body with CRLF", () => {
		const raw = mime("tower@example.com", "oncall@example.com", "DOWN: Web\r\nBcc: x@example.com", "one\ntwo é\nthree");
		const [head, body] = raw.split("\r\n\r\n");
		expect(head.split("\r\n")).toContain("Subject: DOWN: Web Bcc: x@example.com");
		expect(head).not.toMatch(/\n(?!\S)/);
		expect(body).toBe("one\r\ntwo e\r\nthree");
		expect(raw.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
	});

	it("drops emoji and other non-ASCII instead of printing a question mark", () => {
		const raw = mime(
			"tower@example.com",
			"oncall@example.com",
			"DOWN: caf\u00e9 \u2705 \u{1f6a8}",
			"caf\u00e9 \u2705\n\u{1f6a8} x",
		);
		const [head, body] = raw.split("\r\n\r\n");
		expect(head).toContain("Subject: DOWN: cafe  ");
		expect(raw).not.toContain("?");
		expect(body).toBe("cafe \r\n x");
	});

	it("keeps every line of a down message under 998 characters, whatever the check type", () => {
		const long = "x".repeat(5000);
		const checks = [
			{ id: "w", type: "http", name: long, url: `https://example.com/${long}` },
			{ id: "w", type: "tcp", name: long, host: long, port: 25 },
			{ id: "w", type: "dns", name: long, query: long, record: "A" },
			{ id: "w", type: "tls", name: long, host: long },
		];
		for (const check of checks) {
			const [subject, text] = message(check as never, { at: 0, key: "", kind: "down", since: 0, reason: long });
			const raw = mime("tower@example.com", "oncall@example.com", subject, text);
			for (const l of raw.split("\r\n")) expect(l.length).toBeLessThanOrEqual(998);
		}
	});
});

describe("relay mail", () => {
	const config = makeConfig([web], {
		relays: [{ id: "alerts", name: "Alerts", token_sha256: "a".repeat(64), grace: "15m" }],
	});
	const row = (key: string, kind: "firing" | "resolved" | "stale", title: string, check = "alerts") => ({
		check,
		key,
		kind,
		at: T0,
		since: kind === "firing" ? null : T0 - MINUTE,
		reason: JSON.stringify({ title, description: "disk", source_url: "https://x.example/a" }),
	});

	it("mails a firing or resolved row as the sender's title and description, nothing added", () => {
		expect(compose(config, [row("k1", "firing", "Disk full")])).toEqual(["Disk full", "disk"]);
		expect(compose(config, [row("k1", "resolved", "Disk full")])).toEqual(["Disk full", "disk"]);
		const bare = { ...row("k1", "firing", "Disk full"), reason: JSON.stringify({ title: "Disk full" }) };
		expect(compose(config, [bare])).toEqual(["Disk full", ""]);
	});

	it("labels a stopped-reporting row with tower's own text", () => {
		const [stale, body] = compose(config, [row("k1", "stale", "Disk full")]) ?? [];
		expect(stale).toBe("STOPPED REPORTING: Alerts: Disk full");
		expect(body).toContain("No report within 15 minutes");
		expect(body).toContain("Key: k1");
	});

	it("sends one summary line per key when more than one row is pending", () => {
		const [subject, text] =
			compose(config, [
				row("a", "firing", "A is down"),
				row("b", "firing", "B is down"),
				row("a", "resolved", "A is down"),
				row("c", "stale", "C is quiet"),
			]) ?? [];
		expect(subject).toBe("ALERTS: Alerts: 3 changed");
		expect(text).toBe("RESOLVED: A is down\nFIRING: B is down\nSTOPPED REPORTING: C is quiet\n");
	});

	it("keeps every mime line under the header limit for a maximal title and description", () => {
		const long = "t".repeat(900);
		const [subject, text] =
			compose(config, [
				{ ...row("k", "firing", long), reason: JSON.stringify({ title: long, description: "d".repeat(4000) }) },
			]) ?? [];
		for (const l of mime("a@example.com", "b@example.com", subject ?? "", text ?? "").split("\r\n")) {
			expect(l.length).toBeLessThanOrEqual(998);
		}
	});

	it("skips an owner that is neither a check, a relay nor tower", () => {
		expect(compose(config, [row("k", "firing", "x", "ghost")])).toBeNull();
	});
});
