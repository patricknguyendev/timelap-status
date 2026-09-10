import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { verifyProductionHealth } from './health-check.mjs';

export const RECIPIENT = 'timelapsupport@gmail.com';
const MODES = ['unknown', 'operational', 'incident'];
export function nextStatus(previous, healthy, now) {
  if (!previous || !MODES.includes(previous.mode) || !Array.isArray(previous.history)
    || !Number.isFinite(Date.parse(now))) throw new Error('status_state_invalid');
  const mode = healthy ? 'operational' : 'incident';
  const changed = mode !== previous.mode;
  const event = changed && (mode === 'incident' || previous.mode === 'incident')
    ? { mode, at: now } : null;
  return {
    schemaVersion: 1, mode, checkedAt: now,
    history: event ? [event, ...previous.history].slice(0, 20) : previous.history,
    pending: [...(previous.pending ?? []), ...(event ? [event] : [])],
  };
}

export async function sendAlert(event, { key, fetchImpl = fetch, exercise = false } = {}) {
  if (!key || !['incident', 'operational'].includes(event.mode)
    || !Number.isFinite(Date.parse(event.at))) throw new Error('alert_configuration_invalid');
  const kind = event.mode === 'incident' ? 'Service issue detected' : 'Service recovered';
  const prefix = exercise ? '[TEST — no live incident] ' : '';
  const payload = {
    from: 'Timelap Status <status@send.timelap.app>',
    to: [RECIPIENT],
    subject: `${prefix}Timelap: ${kind}`,
    text: `${prefix}${kind}\nObserved: ${event.at}\n\n${exercise ? 'This is an authorized outage-notification exercise. Live status is unchanged.' : 'The independent monitor checks the public homepage, application health and release endpoints. Inspect the application before deciding on recovery actions.'}\n\nStatus: https://status.timelap.app\nApplication: https://www.timelap.app\n\nMiyo LLC, United States. No scheduling data is included.`,
  };
  const id = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const response = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': `timelap-status/${id}` },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error('alert_delivery_failed');
  const receipt = await response.json();
  if (typeof receipt.id !== 'string' || !/^[a-f0-9-]{36}$/.test(receipt.id)) throw new Error('alert_receipt_invalid');
  return receipt.id;
}

export async function run({ verify = verifyProductionHealth, now = new Date().toISOString(),
  path = new URL('./site/status.json', import.meta.url), key = process.env.RESEND_API_KEY,
  notify = sendAlert } = {}) {
  const previous = JSON.parse(await readFile(path, 'utf8'));
  let healthy = false;
  try { await verify(); healthy = true; } catch { /* Publish only a fixed status, never raw endpoint errors. */ }
  const state = nextStatus(previous, healthy, now);
  // Persist the observation even when notification delivery fails. The workflow commits in always().
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
  while (state.pending.length) {
    await notify(state.pending[0], { key });
    state.pending.shift();
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
  }
  return state.mode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.env.STATUS_EXERCISE === 'true') {
      const at = new Date().toISOString();
      for (const mode of ['incident', 'operational']) {
        const id = await sendAlert({ mode, at }, { key: process.env.RESEND_API_KEY, exercise: true });
        console.log(`exercise_${mode}_accepted:${id}`);
      }
    } else console.log(`status_monitor:${await run()}`);
  } catch { console.error('status_monitor_or_notification_failed'); process.exitCode = 1; }
}
