import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { instanceSchema, noteSchema } from "./schema.ts";

const root = join(import.meta.dirname, "..");
const instance = process.argv[2];
if (!instance) {
	console.error("usage: node tools/stage.ts <instance-dir>");
	process.exit(1);
}

function frontmatter(text: string): Record<string, unknown> {
	const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
	const out: Record<string, unknown> = {};
	for (const line of block.split("\n")) {
		const m = /^(\w+):\s*(.*)$/.exec(line);
		if (!m) continue;
		const value = m[2].trim();
		out[m[1]] = value.startsWith("[")
			? value
					.slice(1, -1)
					.split(",")
					.map((v) => v.trim())
					.filter(Boolean)
			: value.replace(/^(["'])(.*)\1$/, "$2");
	}
	return out;
}

const errors: string[] = [];
const report = (file: string, issues: z.core.$ZodIssue[]) => {
	for (const i of issues) errors.push(`${file}: ${i.path.join(".") || "(root)"}: ${i.message}`);
};

let config: unknown;
try {
	config = JSON.parse(readFileSync(join(instance, "tower.json"), "utf8"));
} catch (e) {
	console.error(`${join(instance, "tower.json")}: ${(e as Error).message}`);
	process.exit(1);
}
const parsed = instanceSchema.safeParse(config);
if (!parsed.success) report("tower.json", parsed.error.issues);

const notesDir = join(instance, "notes");
const notes = existsSync(notesDir) ? readdirSync(notesDir).filter((f) => f.endsWith(".md")) : [];
const parsedNotes: { file: string; note: z.output<typeof noteSchema>; body: string }[] = [];
for (const f of notes) {
	const text = readFileSync(join(notesDir, f), "utf8");
	const r = noteSchema.safeParse(frontmatter(text));
	if (r.success) parsedNotes.push({ file: f, note: r.data, body: text.replace(/^---\n[\s\S]*?\n---\n?/, "") });
	else report(`notes/${f}`, r.error.issues);
}

if (errors.length || !parsed.success) {
	console.error(errors.join("\n"));
	process.exit(1);
}

const out = join(root, ".tower");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "notes"), { recursive: true });
const maintenance = parsedNotes.flatMap(({ note }) =>
	note.kind === "maintenance" && note.end
		? [{ title: note.title, start: note.start, end: note.end, checks: note.checks }]
		: [],
);
writeFileSync(join(out, "tower.json"), `${JSON.stringify({ ...parsed.data, maintenance }, null, "\t")}\n`);
// The page gets check names, never ids, and only for public checks.
const names = new Map(parsed.data.checks.filter((c) => c.public).map((c) => [c.id, c.name]));
for (const { file, note, body } of parsedNotes) {
	const shown = { ...note, checks: note.checks.flatMap((id) => names.get(id) ?? []) };
	const head = Object.entries(shown).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
	writeFileSync(join(out, "notes", file), `---\n${head.join("\n")}\n---\n${body}`);
}
if (existsSync(join(instance, "theme.css"))) cpSync(join(instance, "theme.css"), join(out, "theme.css"));
