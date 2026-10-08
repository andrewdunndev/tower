import { EmailMessage } from 'cloudflare:email';
import config from '../services.json';

const SEND_TIMEOUT = 10_000;

const line = (s) => String(s).replace(/[\r\n]+/g, ' ');
const ascii = (s) => line(s).replace(/[^\x20-\x7e]/g, '?');

export function hint(reason) {
  if (reason === 'timeout' || /^HTTP 52[23]$/.test(reason)) return 'the origin or its uplink is dark';
  if (reason === 'HTTP 521') return 'the host is up but refused the connection';
  if (/^HTTP 52[56]$/.test(reason)) return 'TLS between Cloudflare and the origin failed';
  return '';
}

export function message(kind, service, reason, before, now) {
  const at = new Date(now).toISOString();
  if (kind === 'up') {
    return [`UP: ${service.name}`, `${service.name} (${service.url}) answers again.\nDown since ${new Date(before.since).toISOString()}, up ${at}.\n`];
  }
  const why = [reason, hint(reason)].filter(Boolean).join(': ');
  return [`DOWN: ${service.name}`, `${service.name} (${service.url}) failed ${config.down_after} checks in a row, detected ${at}.\nLast failure: ${why}.\n`];
}

export function mime(from, to, subject, text) {
  const domain = line(from).split('@').pop();
  return [
    `From: ${line(from)}`, `To: ${line(to)}`, `Subject: ${ascii(subject)}`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=us-ascii', 'Content-Transfer-Encoding: 7bit', '',
    ascii(text).replace(/\r?\n/g, '\r\n'),
  ].join('\r\n');
}

export async function notify(env, kind, service, reason, before, now) {
  const [subject, text] = message(kind, service, reason, before, now);
  const why = reason ? `: ${line(reason)}` : '';
  const missing = ['ALERT', 'ALERT_FROM', 'ALERT_TO'].filter((k) => !env[k]);
  if (missing.length) {
    console.log(`tower: ${missing.join(', ')} not set, not mailed: ${subject}${why}`);
    return true;
  }
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('send timed out')), SEND_TIMEOUT); });
  try {
    const msg = new EmailMessage(env.ALERT_FROM, env.ALERT_TO, mime(env.ALERT_FROM, env.ALERT_TO, subject, text));
    await Promise.race([env.ALERT.send(msg), limit]);
    console.log(`tower: mailed: ${subject}${why}`);
    return true;
  } catch (e) {
    console.error(`tower: mail failed, will retry: ${subject}${why}:`, e?.message ?? e);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
