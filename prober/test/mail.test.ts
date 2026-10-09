import { describe, expect, it } from "vitest";
import { mime } from "../src/mail.ts";

describe("mime", () => {
	it("keeps headers on single lines and separates the body with CRLF", () => {
		const raw = mime("tower@example.com", "oncall@example.com", "DOWN: Web\r\nBcc: x@example.com", "one\ntwo é\nthree");
		const [head, body] = raw.split("\r\n\r\n");
		expect(head.split("\r\n")).toContain("Subject: DOWN: Web Bcc: x@example.com");
		expect(head).not.toMatch(/\n(?!\S)/);
		expect(body).toBe("one\r\ntwo ?\r\nthree");
		expect(raw.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
	});
});
