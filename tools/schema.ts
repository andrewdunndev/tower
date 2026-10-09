import { z } from "zod";

const UNITS = { m: 60, h: 3600, d: 86400 } as const;

const duration = z
	.string({ error: 'Use a duration such as "1m", "5m", "1h" or "1d".' })
	.regex(/^[1-9]\d*[mhd]$/, 'Use a duration such as "1m", "5m", "1h" or "1d".')
	.transform((s) => Number(s.slice(0, -1)) * UNITS[s.slice(-1) as keyof typeof UNITS]);

const id = z
	.string()
	.regex(
		/^[a-z0-9][a-z0-9-]{0,62}$/,
		"id: use lowercase letters, digits and hyphens, starting with a letter or digit.",
	);

const PRIVATE_V4 = /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;
const PRIVATE_V6 = /^(::1?|f[cd][0-9a-f]{2}:.*|fe[89ab][0-9a-f]:.*)$/;

function isPrivateHost(host: string): boolean {
	const h = host.toLowerCase().replace(/^\[|\]$/g, "");
	return h === "localhost" || h.endsWith(".localhost") || PRIVATE_V4.test(h) || PRIVATE_V6.test(h);
}

const PRIVATE_MESSAGE =
	"Private, loopback and link-local addresses are unreachable from Workers: use a public hostname, or a heartbeat for private services.";

const host = z
	.string()
	.min(1, "host: required.")
	.refine((h) => !isPrivateHost(h), PRIVATE_MESSAGE);

const common = {
	id,
	name: z.string().min(1, "name: required."),
	public: z.boolean().default(true),
	down_after: z.number().int().min(1, "down_after: use a whole number of 1 or more.").default(3),
	up_after: z.number().int().min(1, "up_after: use a whole number of 1 or more.").default(2),
};

const http = z.object({
	...common,
	type: z.literal("http"),
	every: duration.default(60),
	url: z
		.url({ protocol: /^https?$/, error: "url: use a full http:// or https:// URL." })
		.refine((u) => !isPrivateHost(new URL(u).hostname), PRIVATE_MESSAGE),
	expect_status: z
		.number()
		.int()
		.min(100)
		.max(599)
		.refine((s) => s < 300 || s >= 400, "Access-gated targets: use a bypass path or a heartbeat.")
		.default(200),
	allow_cache: z.boolean().default(false),
	contains: z.string().optional(),
	absent: z.string().optional(),
	json: z
		.object({
			path: z.string().min(1, "json.path: use a dotted path such as data.status."),
			equals: z.union([z.string(), z.number(), z.boolean(), z.null()]),
		})
		.optional(),
	slow_ms: z.number().int().positive("slow_ms: use milliseconds above 0.").optional(),
});

const tcp = z.object({
	...common,
	type: z.literal("tcp"),
	every: duration.default(60),
	host,
	port: z
		.number()
		.int()
		.min(1)
		.max(65535)
		.refine((p) => p !== 25, "Port 25 is blocked by Cloudflare Workers: probe a different port, or use a heartbeat."),
});

const dns = z.object({
	...common,
	type: z.literal("dns"),
	every: duration.default(60),
	query: z.string().min(1, "query: required, the DNS name to resolve."),
	record: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "NS"], { error: "record: use A, AAAA, CNAME, MX, TXT or NS." }),
	expect: z.string().optional(),
});

const tls = z.object({
	...common,
	type: z.literal("tls"),
	every: duration.default(3600),
	host: z.string().min(1, "host: required."),
	zone: z.string().min(1, "zone: name the Cloudflare zone holding the certificate, such as example.com."),
});

const heartbeat = z.object({
	...common,
	type: z.literal("heartbeat"),
	every: duration,
	grace: duration,
	token_sha256: z
		.string()
		.regex(/^[0-9a-f]{64}$/, "token_sha256: use the lowercase hex sha256 of the token (64 characters)."),
});

const check = z.discriminatedUnion("type", [http, tcp, dns, tls, heartbeat], {
	error: 'type: use "http", "tcp", "dns", "tls" or "heartbeat".',
});

export const instanceSchema = z
	.object({
		title: z.string().min(1, "title: required."),
		domain: z
			.string()
			.regex(
				/^[a-z0-9.-]+\.[a-z]{2,}$/,
				"domain: use a bare hostname such as status.example.com, with no scheme or path.",
			),
		alert: z.object({
			from: z.email("alert.from: use an email address."),
			to: z.email("alert.to: use an email address."),
		}),
		history_days: z.number().int().min(1).max(365).default(90),
		timeout_ms: z.number().int().min(1000).max(30000).default(10000),
		checks: z.array(check).min(1, "checks: list at least one check."),
	})
	.superRefine((inst, ctx) => {
		const seen = new Set<string>();
		for (const [i, c] of inst.checks.entries()) {
			if (seen.has(c.id)) {
				ctx.addIssue({
					code: "custom",
					path: ["checks", i, "id"],
					message: `Duplicate check id "${c.id}": ids must be unique, rename one.`,
				});
			}
			seen.add(c.id);
		}
	});

const WEEK_MS = 7 * 86400_000;

export function noteSchema(now: Date) {
	const when = z
		.string()
		.refine((s) => !Number.isNaN(Date.parse(s)), "Use an ISO 8601 time such as 2026-11-01T02:00:00Z.");
	return z
		.object({
			title: z.string().min(1, "title: required."),
			kind: z.enum(["maintenance", "incident"], { error: 'kind: use "maintenance" or "incident".' }),
			start: when,
			end: when.optional(),
			checks: z.array(id).default([]),
		})
		.superRefine((n, ctx) => {
			if (n.kind !== "maintenance") return;
			const start = Date.parse(n.start);
			if (!n.end) {
				ctx.addIssue({
					code: "custom",
					path: ["end"],
					message: "A maintenance note needs an end time: add end: with an ISO 8601 time.",
				});
				return;
			}
			const end = Date.parse(n.end);
			if (end <= start) {
				ctx.addIssue({ code: "custom", path: ["end"], message: "end must be after start." });
			} else if (end - start > WEEK_MS) {
				ctx.addIssue({
					code: "custom",
					path: ["end"],
					message: "A maintenance window is at most 7 days: shorten it or split it.",
				});
			}
			if (start < now.getTime() && end > now.getTime()) {
				ctx.addIssue({
					code: "custom",
					path: ["start"],
					message:
						"A maintenance window cannot start in the past: move start to the future, or delete the note once it is over.",
				});
			}
		});
}

export type Instance = z.output<typeof instanceSchema>;
export type Check = Instance["checks"][number];
export type Note = z.output<ReturnType<typeof noteSchema>>;
