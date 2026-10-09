import { connect } from "cloudflare:sockets";
import { describe, expect, inject, it } from "vitest";
import { probeTcp } from "../src/tcp.ts";

const check = (host: string, port: number) =>
	({ id: "t", type: "tcp", name: "T", host, port }) as Parameters<typeof probeTcp>[0];
const dial = (host: string, port: number, timeoutMs = 1000) =>
	probeTcp(check(host, port), { connect, timeoutMs } as Parameters<typeof probeTcp>[1]);

describe("tcp over real sockets", () => {
	it("reads a listening port as ok", async () => {
		expect(await dial("127.0.0.1", inject("listenPort"))).toEqual({ verdict: "ok", reason: null });
	});

	it("reads a refused port as down", async () => {
		const { verdict, reason } = await dial("127.0.0.1", inject("closedPort"));
		expect(verdict).toBe("down");
		expect(reason).toMatch(/^connect failed: /);
	});

	it("reads a filtered address as down at the timeout", async () => {
		const started = Date.now();
		expect(await dial("192.0.2.1", 9, 300)).toEqual({ verdict: "down", reason: "timeout" });
		expect(Date.now() - started).toBeLessThan(2000);
	});
});
