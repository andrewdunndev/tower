import { readFileSync, readdirSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const dir = new URL('../migrations/', import.meta.url);

export function migrations() {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .flatMap((f) => readFileSync(new URL(f, dir), 'utf8').split(';'))
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function migrate(db) {
  await db.batch(migrations().map((s) => db.prepare(s)));
}

export async function fresh() {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response(null) } }',
    compatibilityDate: '2026-09-01',
    d1Databases: ['DB'],
  }));
  const db = await mf.getD1Database('DB');
  await migrate(db);
  return { mf, db };
}
