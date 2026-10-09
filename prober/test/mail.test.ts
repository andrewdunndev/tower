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

	it("keeps every line of a down message under 998 characters", () => {
		const check = { id: "w", type: "http", name: "n".repeat(5000), url: `https://example.com/${"u".repeat(5000)}` };
		const [subject, text] = message(check as never, { at: 0, kind: "down", since: 0, reason: "r".repeat(5000) });
		const raw = mime("tower@example.com", "oncall@example.com", subject, text);
		for (const l of raw.split("\r\n")) expect(l.length).toBeLessThanOrEqual(998);
	});
});
