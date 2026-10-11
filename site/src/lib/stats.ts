const raw = (files: Record<string, unknown>) => Object.values(files).join('\n');
const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

const readme = raw(import.meta.glob('../../../README.md', { query: '?raw', import: 'default', eager: true }));
const schema = raw(import.meta.glob('../../../tools/schema.ts', { query: '?raw', import: 'default', eager: true }));
const changelog = raw(import.meta.glob('../../../CHANGELOG.md', { query: '?raw', import: 'default', eager: true }));
const checkTypes = (schema.match(/z\.discriminatedUnion\(\s*"type"\s*,\s*\[([^\]]*)\]/)?.[1] ?? '')
  .split(',')
  .filter((m) => m.trim()).length;

const products = (readme.split(/^## /m).find((s) => s.startsWith('Cloudflare, product by job')) ?? '')
  .split('\n')
  .filter((l) => l.startsWith('|'))
  .slice(2).length;

export const stats = [
  { num: products, label: 'Cloudflare products' },
  { num: checkTypes, label: 'check types' },
  { num: count(changelog, /^## \d/gm), label: 'releases' },
];
