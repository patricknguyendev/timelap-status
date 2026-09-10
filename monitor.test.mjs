import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { nextStatus, run, sendAlert, RECIPIENT } from './monitor.mjs';

const at = '2026-09-10T16:00:00.000Z';
const initial = { mode: 'unknown', checkedAt: null, history: [], pending: [] };
test('healthy bootstrap does not send an alert', () => {
  assert.deepEqual(nextStatus(initial, true, at).pending, []);
});
test('outage and recovery enqueue once, unchanged checks preserve the queue', () => {
  const outage = nextStatus(initial, false, at);
  assert.equal(outage.pending.length, 1);
  const same = nextStatus(outage, false, at);
  assert.equal(same.pending.length, 1);
  assert.equal(same.history.length, 1);
  const recovery = nextStatus(same, true, at);
  assert.deepEqual(recovery.pending.map(x => x.mode), ['incident', 'operational']);
});
test('history is bounded', () => {
  let state = initial;
  for (let i = 0; i < 50; i++) state = nextStatus(state, i % 2 === 1, at);
  assert.equal(state.history.length, 20);
});
test('notification is fixed-recipient, sanitized, and has stable retry idempotency', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, ...options });
    return Response.json({ id: '12345678-1234-1234-1234-123456789abc' });
  };
  const event = { mode: 'incident', at, secret: 'private-token' };
  await sendAlert(event, { key: 'fixture-key', fetchImpl });
  await sendAlert(event, { key: 'fixture-key', fetchImpl });
  assert.deepEqual(JSON.parse(requests[0].body).to, [RECIPIENT]);
  assert.equal(requests[0].headers['Idempotency-Key'], requests[1].headers['Idempotency-Key']);
  assert.doesNotMatch(requests[0].body, /private-token|fixture-key/);
  assert.equal(requests[0].redirect, 'error');
});
test('exercise is clearly labeled and separate from real notification keys', async () => {
  const requests = [];
  const fetchImpl = async (_, req) => { requests.push(req); return Response.json({ id: '12345678-1234-1234-1234-123456789abc' }); };
  await sendAlert({ mode: 'incident', at }, { key: 'fixture', fetchImpl, exercise: true });
  await sendAlert({ mode: 'incident', at }, { key: 'fixture', fetchImpl });
  assert.match(requests[0].body, /TEST — no live incident/);
  assert.notEqual(requests[0].headers['Idempotency-Key'], requests[1].headers['Idempotency-Key']);
});
test('missing key and failed provider do not claim delivery', async () => {
  await assert.rejects(sendAlert({ mode: 'incident', at }), /configuration_invalid/);
  await assert.rejects(sendAlert({ mode: 'incident', at }, { key: 'fixture', fetchImpl: async () => new Response('', { status: 429 }) }), /delivery_failed/);
});
test('failed send persists incident and retries without disclosing raw probe failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'timelap-status-'));
  const path = join(dir, 'state.json');
  try {
    await writeFile(path, JSON.stringify(initial));
    await assert.rejects(run({ path, now: at, verify: async () => { throw new Error('secret-url'); }, notify: async () => { throw new Error('provider down'); } }));
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(saved.mode, 'incident');
    assert.equal(saved.pending.length, 1);
    assert.doesNotMatch(JSON.stringify(saved), /secret-url|provider down/);
    let sends = 0;
    await run({ path, now: at, verify: async () => { throw new Error(); }, notify: async () => { sends++; } });
    assert.equal(sends, 1);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).pending.length, 0);
    await run({ path, now: at, verify: async () => { throw new Error(); }, notify: async () => { sends++; } });
    assert.equal(sends, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('public page refuses stale, future, malformed and unavailable health claims', async () => {
  const script = await readFile(new URL('./site/status.js', import.meta.url), 'utf8');
  const scenarios = [
    [{ schemaVersion: 1, mode: 'operational', checkedAt: new Date().toISOString(), history: [] }, 'operational'],
    [{ schemaVersion: 1, mode: 'incident', checkedAt: new Date().toISOString(), history: [] }, 'incident'],
    [{ schemaVersion: 1, mode: 'operational', checkedAt: new Date(Date.now() - 46 * 60000).toISOString(), history: [] }, 'unknown'],
    [{ schemaVersion: 1, mode: 'operational', checkedAt: new Date(Date.now() + 120000).toISOString(), history: [] }, 'unknown'],
    [{ schemaVersion: 2, mode: 'operational', checkedAt: new Date().toISOString() }, 'unknown'],
    [null, 'unknown'],
  ];
  for (const [payload, mode] of scenarios) {
    const nodes = new Map();
    const element = () => ({ textContent: '', children: [], replaceChildren() { this.children = []; }, append(child) { this.children.push(child); } });
    const document = { body: { dataset: {} }, createElement: element, getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); } };
    const context = vm.createContext({ document, Date, AbortSignal, setInterval: () => {}, fetch: async () => { if (!payload) throw new Error('offline'); return Response.json(payload); } });
    await vm.runInContext(script.replace('refresh();\nsetInterval(refresh, 60000);', 'refresh();'), context);
    assert.equal(document.body.dataset.mode, mode);
  }
});
