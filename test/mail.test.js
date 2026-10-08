import { test, expect } from 'vitest';
import { hint, mime, notify } from '../src/mail.js';

test('hint reads the Cloudflare code', () => {
  expect(hint('HTTP 522')).toMatch(/dark/);
  expect(hint('timeout')).toMatch(/dark/);
  expect(hint('HTTP 521')).toMatch(/refused/);
  expect(hint('HTTP 526')).toMatch(/TLS/);
  expect(hint('HTTP 500')).toBe('');
});

test('mail carries no injected header and no non-ASCII', () => {
  const raw = mime('a@b.example', 'c@d.example', 'DOWN: x\r\nBcc: eé', 'body\né');
  const [head] = raw.split('\r\n\r\n');
  expect(head).not.toMatch(/^Bcc:/m);
  expect(head).toMatch(/Subject: DOWN: x Bcc: e\?/);
  expect(raw).not.toMatch(/[^\x00-\x7f]/);
});

test('a stalled send is cut off and logged, never thrown', async () => {
  const errors = [];
  const quiet = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  const env = { ALERT_FROM: 'a@b.example', ALERT_TO: 'c@d.example', ALERT: { send: () => new Promise(() => {}) } };
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => real(fn, 0);
  try {
    await notify(env, 'down', { name: 'X', url: 'https://x.example/' }, 'HTTP 500', {}, 0);
  } finally {
    globalThis.setTimeout = real;
    console.error = quiet;
  }
  expect(errors.join()).toMatch(/send timed out/);
});
