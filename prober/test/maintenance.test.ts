import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { tick } from "../src/run.ts";
import { status } from "../src/status.ts";
import { all, MINUTE, mailbox, makeConfig, reset, respond, T0, web } from "./util.ts";

beforeEach(reset);

const check = { ...web, down_after: 1, up_after: 1 };
const window = (checks: string[] = ["web"]) => ({
	title: "Upgrade",
	start: new Date(T0 + MINUTE).toISOString(),
	end: new Date(T0 + 4 * MINUTE).toISOString(),
	checks,
});
const configWith = (maintenance: object[]) => makeConfig([check], { maintenance });
const daily = () => all<{ down: number; maint: number }>(`SELECT down, maint FROM daily`);

describe("maintenance", () => {
	it("mails no transition inside the window and counts it as maint", async () => {
		const { box, runEnv } = mailbox();
		const config = configWith([window()]);
		await tick(runEnv, config, T0, respond(200));
		await tick(runEnv, config, T0 + MINUTE, respond(500));
		expect(box.sends).toBe(0);
		expect(await daily()).toEqual([{ down: 0, maint: 1 }]);
	});

	it("mails and counts down outside the window", async () => {
		const { box, runEnv } = mailbox();
		const config = configWith([window(["other"])]);
		await tick(runEnv, config, T0, respond(200));
		await tick(runEnv, config, T0 + MINUTE, respond(500));
		expect(box.sends).toBe(1);
		expect(await daily()).toEqual([{ down: 1, maint: 0 }]);
	});

	it("mails once at window end when the state changed", async () => {
		const { box, runEnv } = mailbox();
		const config = configWith([window()]);
		await tick(runEnv, config, T0, respond(200));
		await tick(runEnv, config, T0 + MINUTE, respond(500));
		await tick(runEnv, config, T0 + 2 * MINUTE, respond(500));
		await tick(runEnv, config, T0 + 3 * MINUTE, respond(500));
		expect(box.sends).toBe(0);
		await tick(runEnv, config, T0 + 4 * MINUTE, respond(500));
		expect(box.sends).toBe(1);
		await tick(runEnv, config, T0 + 5 * MINUTE, respond(500));
		expect(box.sends).toBe(1);
		expect(await daily()).toEqual([{ down: 2, maint: 3 }]);
	});

	it("mails nothing at window end when the state is back where it was mailed", async () => {
		const { box, runEnv } = mailbox();
		const config = configWith([window()]);
		await tick(runEnv, config, T0, respond(200));
		await tick(runEnv, config, T0 + MINUTE, respond(500));
		await tick(runEnv, config, T0 + 2 * MINUTE, respond(200));
		await tick(runEnv, config, T0 + 4 * MINUTE, respond(200));
		expect(box.sends).toBe(0);
	});

	it("reports maintenance and lists upcoming and open windows by check name", async () => {
		const { runEnv } = mailbox();
		const config = makeConfig([check, { ...web, id: "hidden", name: "Hidden", public: false }], {
			maintenance: [
				window(),
				{ ...window(["hidden"]), title: "Private" },
				{
					...window(),
					title: "Past",
					start: new Date(T0 - 2 * MINUTE).toISOString(),
					end: new Date(T0 - MINUTE).toISOString(),
				},
			],
		});
		await tick(runEnv, config, T0, respond(200));
		const before = await status(env.DB, config, T0);
		expect(before.checks[0].status).toBe("up");
		const during = await status(env.DB, config, T0 + 2 * MINUTE);
		expect(during.checks[0].status).toBe("maintenance");
		expect(during.maintenance).toEqual([
			{
				title: "Upgrade",
				checks: ["Web"],
				starts: new Date(T0 + MINUTE).toISOString(),
				ends: new Date(T0 + 4 * MINUTE).toISOString(),
			},
		]);
		const after = await status(env.DB, config, T0 + 4 * MINUTE);
		expect(after.maintenance).toEqual([]);
		expect(after.checks[0].status).not.toBe("maintenance");
	});
});
