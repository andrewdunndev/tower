import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const raw = (files: Record<string, unknown>) => Object.values(files).join('\n');
const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

const readme = raw(import.meta.glob('../../../README.md', { query: '?raw', import: 'default', eager: true }));
const probe = raw(import.meta.glob('../../../prober/src/probe.ts', { query: '?raw', import: 'default', eager: true }));
const changelog = raw(import.meta.glob('../../../CHANGELOG.md', { query: '?raw', import: 'default', eager: true }));
// page/ carries an astro tsconfig that a glob import cannot resolve without page/node_modules.
const root = resolve(process.cwd(), '..');
const tests = ['prober/test', 'page/test', 'tools'].flatMap((dir: string) =>
  readdirSync(resolve(root, dir))
    .filter((f: string) => f.endsWith('.test.ts'))
    .map((f: string) => readFileSync(resolve(root, dir, f), 'utf-8')),
);

const products = (readme.split(/^## /m).find((s) => s.startsWith('Cloudflare, product by job')) ?? '')
  .split('\n')
  .filter((l) => l.startsWith('|'))
  .slice(2).length;

export const stats = [
  { num: products, label: 'Cloudflare products' },
  { num: count(probe, /^\s*case "[a-z]+":/gm), label: 'check kinds' },
  { num: tests.reduce((n, t) => n + count(t, /^\s*(?:test|it)\(/gm), 0), label: 'tests' },
  { num: count(changelog, /^## \d/gm), label: 'releases' },
];
