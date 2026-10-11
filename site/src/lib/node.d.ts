declare module 'node:fs' {
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: 'utf-8'): string;
}
declare module 'node:path' {
  export function resolve(...paths: string[]): string;
}
declare const process: { cwd(): string };
