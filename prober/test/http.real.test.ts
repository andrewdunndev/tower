import { beforeEach, describe, expect, inject, it } from "vitest";
import { tick } from "../src/run.ts";
import { all, mailbox, makeConfig, reset, T0 } from "./util.ts";

beforeEach(reset);

describe("http over the real fetch", () => {
	it("reads a 200 as ok when tick runs with its default fetch", async () => {
		const { runEnv } = mailbox();
		const parsed = makeConfig([{ id: "local", type: "http", name: "Local", url: "http://local.example.com/" }]);
		const config = {
			...parsed,
			checks: parsed.checks.map((c) => ({ ...c, url: `http://127.0.0.1:${inject("httpPort")}/` })),
		} as typeof parsed;
		await tick(runEnv, config, T0);
		expect(await all("SELECT avail, fails, reason FROM state")).toEqual([{ avail: 1, fails: 0, reason: null }]);
		expect(await all("SELECT ok FROM samples")).toEqual([{ ok: 1 }]);
	});
});
