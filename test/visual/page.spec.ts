import { expect, test } from "@playwright/test";

const STUB = "http://127.0.0.1:8801";

const LONG =
	"Payments API health endpoint behind the regional load balancer, primary-cluster-with-an-unusually-long-hostname.eu-west-1.example.com";
const now = new Date().toISOString();
const check = (name: string) => ({
	name,
	status: "up",
	since: now,
	uptime90: 1,
	p50: 120,
	p95: 180,
	days: Array(90).fill(1),
	latency: Array(288).fill(120),
});
const status = {
	v: 1,
	generatedAt: now,
	checks: [check("Website"), check(LONG)],
	incidents: [],
	maintenance: [],
	last_run: now,
	outbox_oldest_unsent_at: null,
	dead_outbox: 0,
	self: [],
	stuck: 0,
};

test.beforeAll(async ({ request }) => {
	expect((await request.post(`${STUB}/`, { data: JSON.stringify(status) })).status()).toBe(204);
});

for (const width of [375, 760, 1000, 1440]) {
	test(`a long check name ellipsizes without overflow at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		await page.goto("/");
		const m = await page.evaluate(() => {
			const rows = [...document.querySelectorAll<HTMLElement>(".checks > .row")];
			const name = rows[1]?.querySelector<HTMLElement>(".name");
			return {
				rows: rows.length,
				text: name?.textContent,
				pageScroll: document.scrollingElement?.scrollWidth ?? Number.POSITIVE_INFINITY,
				viewport: window.innerWidth,
				nameScroll: name?.scrollWidth ?? 0,
				nameClient: name?.clientWidth ?? 0,
				shortRow: rows[0]?.getBoundingClientRect().height,
				longRow: rows[1]?.getBoundingClientRect().height,
			};
		});
		expect(m.rows).toBe(2);
		expect(m.text).toBe(LONG);
		expect(m.pageScroll).toBeLessThanOrEqual(m.viewport);
		expect(m.nameScroll).toBeGreaterThan(m.nameClient);
		expect(m.longRow).toBe(m.shortRow);
	});
}
