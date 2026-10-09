import { describe, expect, it } from "vitest";
import { message, mime } from "../src/mail.ts";

describe("mime", () => {
	it("keeps headers on single lines and separates the body with CRLF", () => {
		const raw = mime("tower@example.com", "oncall@example.com", "DOWN: Web\r\nBcc: x@example.com", "one\ntwo é\nthree");
		const [head, body] = raw.split("\r\n\r\n");
		expect(head.split("\r\n")).toContain("Subject: DOWN: Web Bcc: x@example.com");
		expect(head).not.toMatch(/\n(?!\S)/);
		expect(body).toBe("one\r\ntwo ?\r\nthree");
		expect(raw.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
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
			const [subject, text] = message(check as never, { at: 0, kind: "down", since: 0, reason: long });
			const raw = mime("tower@example.com", "oncall@example.com", subject, text);
			for (const l of raw.split("\r\n")) expect(l.length).toBeLessThanOrEqual(998);
		}
	});
});
