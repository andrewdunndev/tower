import { z } from "zod";

z.config({
	customError: (iss) => {
		if (iss.code === "invalid_type" && iss.input === undefined) return "required.";
		if (iss.code === "unrecognized_keys")
			return `unknown ${iss.keys.length > 1 ? "keys" : "key"} ${iss.keys.join(", ")}.`;
		return undefined;
	},
});

const UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

const duration = z
	.string({ error: 'Use a duration such as "1m", "5m", "1h" or "1d".' })
	.regex(/^[1-9]\d*[mhd]$/, 'Use a duration such as "1m", "5m", "1h" or "1d".')
	.transform((s) => Number(s.slice(0, -1)) * UNITS[s.slice(-1) as keyof typeof UNITS]);

const id = z
	.string()
	.regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "use lowercase letters, digits and hyphens, starting with a letter or digit.");

const DOTTED_QUAD = /^\d+\.\d+\.\d+\.\d+$/;
const PRIVATE_V4 = /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;
const PRIVATE_V6 = /^(::1?|f[cd][0-9a-f]{2}:.*|fe[89ab][0-9a-f]:.*)$/;

function isPrivateHost(host: string): boolean {
	const h = host.toLowerCase().replace(/^\[|\]$/g, "");
	return (
		h === "localhost" ||
		h.endsWith(".localhost") ||
		(DOTTED_QUAD.test(h) && PRIVATE_V4.test(h)) ||
		(h.includes(":") && PRIVATE_V6.test(h))
	);
}

const PRIVATE_MESSAGE =
	"Private, loopback and link-local addresses are unreachable from Workers: use a public hostname, or a heartbeat for private services.";

const host = z
	.string()
	.min(1, "required.")
	.refine((h) => !isPrivateHost(h), PRIVATE_MESSAGE);

const common = {
	id,
	name: z.string().min(1, "required."),
	public: z.boolean().default(true),
};

const limits = {
	down_after: z.number().int().min(1, "use a whole number of 1 or more.").default(3),
	up_after: z.number().int().min(1, "use a whole number of 1 or more.").default(2),
};

const http = z.strictObject({
	...common,
	...limits,
	type: z.literal("http"),
	every: duration.default(60_000),
	url: z
		.url({ protocol: /^https?$/, error: "use a full http:// or https:// URL.", abort: true })
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
		.strictObject({
			path: z.string().min(1, "use a dotted path such as data.status."),
			equals: z.union([z.string(), z.number(), z.boolean(), z.null()]),
		})
		.optional(),
	slow_ms: z.number().int().positive("use milliseconds above 0.").optional(),
});

const tcp = z.strictObject({
	...common,
	...limits,
	type: z.literal("tcp"),
	every: duration.default(60_000),
	host,
	port: z
		.number()
		.int()
		.min(1)
		.max(65535)
		.refine((p) => p !== 25, "Port 25 is blocked by Cloudflare Workers: probe a different port, or use a heartbeat."),
});

const dns = z.strictObject({
	...common,
	...limits,
	type: z.literal("dns"),
	every: duration.default(60_000),
	query: z.string().min(1, "required, the DNS name to resolve."),
	record: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "NS"], { error: "use A, AAAA, CNAME, MX, TXT or NS." }),
	expect: z.string().optional(),
});

const tls = z.strictObject({
	...common,
	...limits,
	type: z.literal("tls"),
	every: duration.default(3_600_000),
	host: z.string().min(1, "required."),
	zone: z.string().min(1, "name the Cloudflare zone holding the certificate, such as example.com."),
});

const tokenHash = z
	.string()
	.regex(/^[0-9a-f]{64}$/, "token_sha256: use the lowercase hex sha256 of the token (64 characters).");

const heartbeat = z.strictObject({
	...common,
	type: z.literal("heartbeat"),
	every: duration,
	grace: duration,
	token_sha256: tokenHash,
});

const WEEK_MS = 7 * 86400_000;

const relay = z.strictObject({
	id,
	name: z.string().min(1, "required."),
	token_sha256: tokenHash,
	grace: duration.refine((ms) => ms <= WEEK_MS, "use at most 7 days.").default(900_000),
});

const check = z.discriminatedUnion("type", [http, tcp, dns, tls, heartbeat], {
	error: 'use "http", "tcp", "dns", "tls" or "heartbeat".',
});

const ISO_WITH_OFFSET = /T\d\d:\d\d(:\d\d)?(\.\d+)?(Z|[+-]\d\d:\d\d)$/;

const when = z.string().regex(ISO_WITH_OFFSET, "Use an ISO 8601 time with an offset such as 2026-11-01T02:00:00Z.");

export const instanceSchema = z
	.strictObject({
		name: z
			.string()
			.max(54, "use at most 54 characters.")
			.regex(
				/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
				"use lowercase letters, digits and hyphens, starting and ending with a letter or digit. It names the Workers and the database.",
			),
		title: z.string().min(1, "required."),
		domain: z
			.string()
			.regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "use a bare hostname such as status.example.com, with no scheme or path."),
		alert: z.strictObject({
			from: z.email("use an email address."),
			to: z.email("use an email address."),
		}),
		timeout_ms: z.number().int().min(1000).max(30000).default(10000),
		checks: z.array(check).min(1, "list at least one check."),
		relays: z.array(relay).default([]),
		digest: z
			.string()
			.regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use a UTC time of day such as "07:30".')
			.optional(),
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
		const hashes = new Set<string>();
		for (const [i, r] of inst.relays.entries()) {
			if (seen.has(r.id)) {
				ctx.addIssue({
					code: "custom",
					path: ["relays", i, "id"],
					message: `Duplicate id "${r.id}": check and relay ids share one space, rename one.`,
				});
			}
			seen.add(r.id);
			if (hashes.has(r.token_sha256)) {
				ctx.addIssue({
					code: "custom",
					path: ["relays", i, "token_sha256"],
					message: "Two relays share a token: mint a token for each.",
				});
			}
			hashes.add(r.token_sha256);
		}
	});

export const noteSchema = z
	.strictObject({
		title: z.string().min(1, "required."),
		kind: z.enum(["maintenance", "incident"], { error: 'use "maintenance" or "incident".' }),
		start: when,
		end: when.optional(),
		checks: z.array(id).default([]),
	})
	.superRefine((n, ctx) => {
		if (n.kind !== "maintenance") return;
		if (!n.end) {
			ctx.addIssue({
				code: "custom",
				path: ["end"],
				message: "A maintenance note needs an end time: add end: with an ISO 8601 time.",
			});
			return;
		}
		const span = Date.parse(n.end) - Date.parse(n.start);
		if (span <= 0) {
			ctx.addIssue({ code: "custom", path: ["end"], message: "end must be after start." });
		} else if (span > WEEK_MS) {
			ctx.addIssue({
				code: "custom",
				path: ["end"],
				message: "A maintenance window is at most 7 days: shorten it or split it.",
			});
		}
	});

export type Instance = z.output<typeof instanceSchema> & {
	maintenance: { title: string; start: string; end: string; checks: string[] }[];
};
export type Check = Instance["checks"][number];
export type Note = z.output<typeof noteSchema>;

const unknownId = (file: string, id: string) =>
	`notes/${file}: checks: unknown id "${id}": use a check id from tower.json`;

export function unknownIds(file: string, note: Note, checks: Check[]): string[] {
	return note.checks.filter((id) => !checks.some((c) => c.id === id)).map((id) => unknownId(file, id));
}

/** The page's view of a note: check names for public checks only; null when every named check is private. */
export function publicNote(note: Note, checks: Check[]): Note | null {
	const names = new Map(checks.filter((c) => c.public).map((c) => [c.id, c.name]));
	const shown = note.checks.flatMap((id) => names.get(id) ?? []);
	return note.checks.length > 0 && shown.length === 0 ? null : { ...note, checks: shown };
}
