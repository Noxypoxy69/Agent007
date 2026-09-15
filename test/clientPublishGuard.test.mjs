import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publish } from '../src/client.mjs';

/**
 * THE ASSERTION THAT MATTERS IS "fetch WAS NEVER CALLED".
 *
 * Checking that publish() returns ok:false proves the function said no. It does
 * not prove the bytes stayed on the machine, and those are different facts: a
 * guard that transmits and THEN reports a leak has disclosed everything it was
 * written to protect, while looking correct in every log and every return value
 * anyone inspects.
 *
 * So every refusal below counts calls to a fetch spy and asserts zero. The
 * return value is checked second, and only as a convenience for the caller.
 *
 * WHY THIS WIRING NEEDED A TEST AT ALL. payloadGuard was written, mutation-proven
 * and integrated, and protected nothing: no code path invoked it. That was named
 * as a remaining risk when it was handed over — "nothing currently calls this
 * guard, so until it is wired in it protects nothing" — and this file is the
 * other half of closing it.
 */

/** A fetch that records and never reaches the network. Used as globalThis.fetch. */
function fetchSpy(response = { ok: true, status: 202, body: '{"accepted":true}' }) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: response.ok,
      status: response.status,
      text: async () => response.body,
    };
  };
  return { impl, calls };
}

async function withFetch(spy, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = spy.impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const CFG = { bridgeUrl: 'https://bridge.example/', machineId: 'm-1', secret: 'x'.repeat(32) };
const CLEAN_PAYLOAD = { schema: 'heartbeat/1', sessions: [] };

const cleanScan = () => ({ ok: true, leaks: [] });
const leakyScan = () => ({
  ok: false,
  leaks: [{ path: '/sessions/0/worktree', kind: 'home-directory', sample: 'C:**' }],
});

/* ── the control: a clean payload must actually go ───────────────────── */

test('a clean payload IS transmitted — a guard that blocks everything is not a guard', async () => {
  const spy = fetchSpy();
  const r = await withFetch(spy, () => publish(CFG, CLEAN_PAYLOAD, { scan: cleanScan }));
  assert.equal(spy.calls.length, 1, 'the clean case must reach fetch, or every refusal below is meaningless');
  assert.equal(r.ok, true);
  assert.equal(r.accepted, true);
});

/* ── the refusals: nothing may reach the network ─────────────────────── */

test('a leaking payload is NOT transmitted', async () => {
  const spy = fetchSpy();
  const r = await withFetch(spy, () => publish(CFG, CLEAN_PAYLOAD, { scan: leakyScan }));
  assert.equal(spy.calls.length, 0, 'THE BYTES LEFT THE MACHINE — this is the whole failure');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'payload-leaks');
});

test('the refusal carries the leak paths, so it is actionable', async () => {
  const r = await withFetch(fetchSpy(), () => publish(CFG, CLEAN_PAYLOAD, { scan: leakyScan }));
  assert.deepEqual(r.leaks.map((l) => l.path), ['/sessions/0/worktree']);
});

test('A SCANNER THAT THROWS REFUSES — "the check broke" is not "the check passed"', async () => {
  const spy = fetchSpy();
  const boom = () => {
    throw new Error('scanner exploded');
  };
  const r = await withFetch(spy, () => publish(CFG, CLEAN_PAYLOAD, { scan: boom }));
  assert.equal(spy.calls.length, 0);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'payload-scan-failed');
});

test('a scanner returning undefined refuses — only an explicit pass is a pass', async () => {
  const spy = fetchSpy();
  const r = await withFetch(spy, () => publish(CFG, CLEAN_PAYLOAD, { scan: () => undefined }));
  assert.equal(spy.calls.length, 0);
  assert.equal(r.ok, false);
});

test('a scanner returning a truthy non-boolean ok refuses', async () => {
  // `ok: 'yes'` is the shape that slips past a `!verdict.ok` test. Same class as
  // `data !== false` treating null as permission.
  const spy = fetchSpy();
  const r = await withFetch(spy, () => publish(CFG, CLEAN_PAYLOAD, { scan: () => ({ ok: 'yes' }) }));
  assert.equal(spy.calls.length, 0);
  assert.equal(r.ok, false);
});

test('a scanner returning no leaks array still refuses, and does not crash', async () => {
  const spy = fetchSpy();
  const r = await withFetch(spy, () => publish(CFG, CLEAN_PAYLOAD, { scan: () => ({ ok: false }) }));
  assert.equal(spy.calls.length, 0);
  assert.deepEqual(r.leaks, []);
});

/* ── order: the scan precedes the bridgeUrl check ────────────────────── */

test('a leaking payload is reported as leaking even with NO bridge configured', async () => {
  /*
   * If the URL check came first this would answer 'no-bridge-url', which reads
   * as a configuration problem and hides a disclosure one — and the day
   * somebody sets the URL, the leak ships with no warning ever printed.
   */
  const r = await withFetch(fetchSpy(), () => publish({ machineId: 'm-1', secret: 'x' }, CLEAN_PAYLOAD, { scan: leakyScan }));
  assert.equal(r.reason, 'payload-leaks');
});

test('NEAREST CLEAN: a clean payload with no bridge still reports no-bridge-url', async () => {
  const r = await withFetch(fetchSpy(), () => publish({ machineId: 'm-1' }, CLEAN_PAYLOAD, { scan: cleanScan }));
  assert.equal(r.reason, 'no-bridge-url');
});

/* ── the default is the real scanner, not a permissive stub ──────────── */

test('WITH NO scan OPTION it uses the real payloadGuard, and refuses a real leak', async () => {
  /*
   * Every test above injects a scanner, so every one of them would pass against
   * a publish() whose default was `() => ({ok:true})`. This is the control for
   * that: a payload carrying a genuine home directory, scanned by whatever the
   * default actually is.
   */
  const spy = fetchSpy();
  const dirty = { sessions: [{ worktree: 'C:\\Users\\Jane Doe\\Documents\\x' }] };
  const r = await withFetch(spy, () => publish(CFG, dirty));
  assert.equal(spy.calls.length, 0, 'the default scanner let a real leak through');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'payload-leaks');
  assert.ok(r.leaks.length > 0);
});

test('and the real scanner passes a genuinely clean payload', async () => {
  const spy = fetchSpy();
  const r = await withFetch(spy, () =>
    publish(CFG, { schema: 'heartbeat/1', machine: { name: 'machine-62710e' }, sessions: [] }),
  );
  assert.equal(spy.calls.length, 1, 'the real scanner is blocking ordinary publishes');
  assert.equal(r.ok, true);
});

/* ── the pre-existing contract must survive the change ───────────────── */

test('the signed body is still the payload, and the headers are unchanged', async () => {
  const spy = fetchSpy();
  await withFetch(spy, () => publish(CFG, CLEAN_PAYLOAD, { scan: cleanScan }));
  const { init } = spy.calls[0];
  assert.equal(init.body, JSON.stringify(CLEAN_PAYLOAD));
  assert.equal(init.headers['x-ab-machine'], 'm-1');
  assert.ok(init.headers['x-ab-signature']);
  assert.ok(init.headers['x-ab-nonce']);
});

test('a hostile response is still only read for two scalars', async () => {
  // The Step 1 invariant. Asserted here because this change touches the same
  // function, and a refactor that widened response handling would be invisible.
  const spy = fetchSpy({ ok: true, status: 200, body: JSON.stringify({ accepted: true, reason: 'x'.repeat(500), evil: { run: 'rm -rf /' } }) });
  const r = await withFetch(spy, () => publish(CFG, CLEAN_PAYLOAD, { scan: cleanScan }));
  assert.deepEqual(Object.keys(r).sort(), ['accepted', 'ok', 'reason', 'status']);
  assert.equal(r.reason.length, 200);
});

test('a network failure is reported without transmitting anything further', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('econnrefused');
  };
  try {
    const r = await publish(CFG, CLEAN_PAYLOAD, { scan: cleanScan });
    assert.equal(r.ok, false);
    assert.match(r.reason, /econnrefused/);
  } finally {
    globalThis.fetch = original;
  }
});
