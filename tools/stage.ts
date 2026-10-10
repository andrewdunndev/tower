import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { type Instance, instanceSchema, type Note, noteSchema, publicNote, unknownIds } from "./schema.ts";

export const root = join(import.meta.dirname, "..");

export class StageError extends Error {
	constructor(messages: string[]) {
		super(messages.join("\n"));
	}
}

function frontmatter(text: string): { data: Record<string, unknown>; body: string } {
	const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
	const block = m?.[1] ?? "";
	const out: Record<string, unknown> = {};
	for (const line of block.split("\n")) {
		const kv = /^(\w+):\s*(.*)$/.exec(line);
		if (!kv) continue;
		const value = kv[2].trim();
		out[kv[1]] = value.startsWith("[")
			? value
					.slice(1, -1)
					.split(",")
					.map((v) => v.trim())
					.filter(Boolean)
			: value.replace(/^(["'])(.*)\1$/, "$2");
	}
	return { data: out, body: text.slice(m?.[0].length ?? 0) };
}

const issueLines = (file: string, issues: z.core.$ZodIssue[]) =>
	issues.map((i) => `${file}: ${i.path.join(".") || "(root)"}: ${i.message}`);

export function stage(instance: string, out = join(root, ".tower")): Omit<Instance, "maintenance"> {
	let config: unknown;
	try {
		config = JSON.parse(readFileSync(join(instance, "tower.json"), "utf8"));
	} catch (e) {
		throw new StageError([`${join(instance, "tower.json")}: ${(e as Error).message}`]);
	}
	const errors: string[] = [];
	const parsed = instanceSchema.safeParse(config);
	if (!parsed.success) errors.push(...issueLines("tower.json", parsed.error.issues));

	const notesDir = join(instance, "notes");
	const files = existsSync(notesDir) ? readdirSync(notesDir).filter((f) => f.endsWith(".md")) : [];
	const parsedNotes: { file: string; note: Note; body: string }[] = [];
	for (const f of files) {
		const { data, body } = frontmatter(readFileSync(join(notesDir, f), "utf8"));
		const r = noteSchema.safeParse(data);
		if (r.success) parsedNotes.push({ file: f, note: r.data, body });
		else errors.push(...issueLines(`notes/${f}`, r.error.issues));
	}
	if (parsed.success) {
		for (const { file, note } of parsedNotes) errors.push(...unknownIds(file, note, parsed.data.checks));
	}
	if (errors.length || !parsed.success) throw new StageError(errors);

	rmSync(out, { recursive: true, force: true });
	mkdirSync(join(out, "notes"), { recursive: true });
	const maintenance = parsedNotes.flatMap(({ note }) =>
		note.kind === "maintenance" && note.end
			? [{ title: note.title, start: note.start, end: note.end, checks: note.checks }]
			: [],
	);
	writeFileSync(join(out, "tower.json"), `${JSON.stringify({ ...parsed.data, maintenance }, null, "\t")}\n`);
	// The page gets check names, never ids, and only for public checks.
	for (const { file, note, body } of parsedNotes) {
		const shown = publicNote(note, parsed.data.checks);
		if (!shown) continue;
		const head = Object.entries(shown).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
		writeFileSync(join(out, "notes", file), `---\n${head.join("\n")}\n---\n${body}`);
	}
	if (existsSync(join(instance, "theme.css"))) cpSync(join(instance, "theme.css"), join(out, "theme.css"));
	return parsed.data;
}

if (import.meta.main) {
	const instance = process.argv[2];
	if (!instance) {
		console.error("usage: node tools/stage.ts <instance-dir>");
		process.exit(1);
	}
	try {
		stage(instance);
	} catch (e) {
		if (!(e instanceof StageError)) throw e;
		console.error(e.message);
		process.exit(1);
	}
}
