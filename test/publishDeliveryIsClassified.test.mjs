/**
 * A TRANSPORT FAILURE HAS TWO KINDS, AND CALLING THEM BOTH THE SAME THING IS A
 * LIE IN WHICHEVER DIRECTION YOU PICK.
 *
 * THE ORIGINAL DEFECT. src/client.mjs turned every transport error into a bare
 * `ok:false`, and the CLI printed "publish failed". A bridge that RECEIVES the
 * body, commits it and goes quiet produces exactly that error -- so a heartbeat
 * that landed was reported as one that did not, and a watcher republished it.
 * CLAUDE.md: "Reporting failure for completed work is worse than failing
 * outright, BECAUSE THE RETRY IS WHAT CORRUPTS THE PICTURE."
 *
 * THE OVER-CORRECTION, which this file also guards. Calling EVERY transport
 * failure indeterminate tells an operator whose bridge is simply DOWN that the
 * beat "may have landed". That is the same lie reversed, and it is inverted advice
 * for the commonest failure there is. So delivery is CLASSIFIED:
 *
 *   delivery 'none'     nothing can have been transmitted -> a definite failure
 *   delivery 'unknown'  cannot be determined from here    -> stated, not advised
 *
 * WHY THE CLI ASSERTIONS USE A POST-SEND FIXTURE, which is the point of the file.
 * An earlier version proved the UNKNOWN property against `http://127.0.0.1:1`.
 * That is a fixture where "may have landed" is FALSE -- and it turns out node
 * rejects port 1 before connecting at all, giving a codeless `Error: bad port`,
 * so it was not even the refused-connection path it appeared to be. Demonstrating
 * a claim on a fixture that contradicts it is CLAUDE.md hollow gate 9. Every
 * "unknown" assertion below therefore runs against a server that READ THE BODY
 * and is asserted to have done so, by byte count, in the same test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CLI = path.join(
  path.dirname(new URL(import.meta.url).pathname.slice(process.platform === 'win32' ? 1 : 0)),
  '..', 'bin', 'agentbridge.mjs',
);
const { publish, classifyDelivery } = await import(new URL('../src/client.mjs', import.meta.url));

const WORK = mkdtempSync(path.join(tmpdir(), 'ab-t049b-'));
process.on('exit', () => { try { rmSync(WORK, { recursive: true, force: true }); } catch { /* best effort */ } });

function home(bridgeUrl) {
  const dir = mkdtempSync(path.join(WORK, 'h-'));
  const cfgDir = path.join(dir, '.agentbridge');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    ...(bridgeUrl ? { bridgeUrl } : {}),
    machineId: 'm1', machineLabel: 'm1', intervalSeconds: 60, secretStore: 'none',
  }));
  writeFileSync(path.join(cfgDir, 'registry.json'), JSON.stringify({ agents: [] }));
  return { AGENTBRIDGE_HOME: cfgDir, USERPROFILE: dir, HOME: dir };
}

const runCli = (env) => new Promise((resolve) => {
  execFile(process.execPath, [CLI, 'heartbeat'],
    { env: { ...process.env, ...env }, timeout: 60_000, encoding: 'utf8' },
    (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr: stderr ?? '' }));
});

/** A bridge that answers with `status` and records that it was reached. */
async function answering(t, status) {
  const calls = [];
  const server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      calls.push(b.length);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status === 200 ? { accepted: true } : { error: 'unauthorized' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return { calls, url: `http://127.0.0.1:${server.address().port}/ingest` };
}

/**
 * A bridge that READS THE WHOLE BODY -- treat that as committed -- and then closes
 * the socket, resets it, or says nothing at all. `received` is the witness: every
 * "unknown" assertion checks it, so none of them can pass against a fixture where
 * nothing arrived.
 *
 *   'destroy'  res.socket.destroy() -- a polite close. Surfaces as UND_ERR_SOCKET
 *              ("other side closed"), NEVER as ECONNRESET.
 *   'rst'      res.socket.resetAndDestroy() -- a real TCP RST. Surfaces as
 *              ECONNRESET, and the test that uses it asserts that it did.
 *   'silent'   never answers; only a timeout ends it.
 *
 * THIS ACTION WAS CALLED 'reset' AND DID NOT RESET ANYTHING. It was the polite
 * close, so no end-to-end test in this file ever produced ECONNRESET, and adding
 * ECONNRESET to the definitely-not-sent allowlist survived every one of them --
 * caught only by the pure matcher unit. A fixture named for a case it cannot
 * construct cannot fail for it (CLAUDE.md rule 9).
 */
async function readsBodyThen(t, action) {
  const received = [];
  const sockets = [];
  const server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      received.push(b.length);
      if (action === 'destroy') res.socket.destroy();
      else if (action === 'rst') res.socket.resetAndDestroy();
    });
  });
  server.on('connection', (s) => sockets.push(s));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { for (const s of sockets) s.destroy(); await new Promise((r) => server.close(r)); });
  return { received, url: `http://127.0.0.1:${server.address().port}/ingest` };
}

/** A port that was open and is now closed: a real ECONNREFUSED, not `bad port`. */
async function refusedUrl() {
  const server = createServer(() => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/ingest`;
  await new Promise((r) => server.close(r));
  return url;
}

/* ── positive controls first: rule 5 ─────────────────────────────────────── */

test('control: a beat that lands still reports landed', async (t) => {
  const b = await answering(t, 200);
  const r = await runCli(home(b.url));
  assert.ok(b.calls.length > 0, 'the fixture never reached the bridge, so this proves nothing');
  assert.equal(r.code, 0);
  assert.match(r.stderr, /published\./);
});

test('control: an answered refusal is still a definite failure and says nothing about unknown', async (t) => {
  const b = await answering(t, 401);
  const r = await runCli(home(b.url));
  assert.ok(b.calls.length > 0);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /publish failed: 401/);
  assert.doesNotMatch(r.stderr, /UNKNOWN/,
    'a decision the bridge actually made was downgraded to "we do not know"');
});

/* ── the property, on a fixture where "may have landed" is TRUE ──────────── */

test('THE PROPERTY: a bridge that READ the body and then went quiet is UNKNOWN, not failed', async (t) => {
  const b = await readsBodyThen(t, 'destroy');
  const r = await runCli(home(b.url));
  assert.ok(b.received.length > 0 && b.received[0] > 0,
    'the bridge never received a body, so this fixture does not construct the case it claims to');
  assert.match(r.stderr, /publish UNKNOWN/,
    'a write the bridge had already read was reported with a definite outcome');
  assert.doesNotMatch(r.stderr, /publish failed/,
    'the command claimed the publish FAILED for a body the bridge demonstrably received');
});

test('the alarm is preserved: an indeterminate publish still exits non-zero', async (t) => {
  /*
   * "Nobody answered" is not a known failure AND is not fine. A watcher that reads
   * it as fine loops healthily while the roster goes stale, which is what
   * test/heartbeatExitCode exists to prevent. Asserted on the post-send fixture,
   * not on a refused port.
   */
  const b = await readsBodyThen(t, 'destroy');
  const r = await runCli(home(b.url));
  assert.ok(b.received.length > 0);
  assert.equal(r.code, 1, 'an indeterminate publish stopped alarming');
});

test('A REAL RESET AFTER THE BODY: ECONNRESET is UNKNOWN end to end, not a definite failure', async (t) => {
  /*
   * The load-bearing decision of the whole repair is that ECONNRESET is NOT on
   * the definitely-not-sent allowlist -- because a reset that arrives after the
   * body was written surfaces exactly like one on connect. Until this test, only
   * the matcher unit below asserted it, so the decision had one guard.
   *
   * Preconditions are ASSERTED, not assumed: the bridge read a body (the write is
   * committed), and the code the operator sees is ECONNRESET (the fixture really
   * produced the case, rather than the UND_ERR_SOCKET a polite close gives).
   */
  const b = await readsBodyThen(t, 'rst');
  const r = await runCli(home(b.url));
  assert.ok(b.received.length > 0 && b.received[0] > 0,
    'the bridge never received a body, so a reset here would not be a post-send reset');
  assert.match(r.stderr, /ECONNRESET/,
    'the fixture did not produce ECONNRESET, or the code never reached the operator, '
    + 'so the case under test was never reached');
  assert.match(r.stderr, /publish UNKNOWN/,
    'a connection reset AFTER the bridge read the body was reported with a definite outcome -- '
    + 'ECONNRESET has been classified as not-sent, which re-creates the original defect');
  assert.doesNotMatch(r.stderr, /nothing was sent/,
    'the command claimed nothing was sent for a body the bridge demonstrably received');
  assert.equal(r.code, 1, 'an indeterminate publish stopped alarming');
});

/* ── the other direction: a bridge that is simply down ───────────────────── */

test('THE OTHER HALF: a refused connection is a DEFINITE failure, not unknown', async () => {
  const url = await refusedUrl();
  const r = await runCli(home(url));
  assert.match(r.stderr, /ECONNREFUSED/,
    'the fixture did not produce a refused connection, or the code never reached the operator, '
    + 'so the case under test was never reached');
  assert.match(r.stderr, /nothing was sent/,
    'a bridge that refused the connection was not reported as a definite non-delivery');
  assert.doesNotMatch(r.stderr, /UNKNOWN/,
    'a connection that was refused cannot have delivered anything, so "we do not know" is false '
    + 'and advises retry-hesitancy for the commonest failure there is');
  assert.equal(r.code, 1);
});

/* ── the matcher itself, where the socket cannot reach ───────────────────── */

test('the delivery matcher classifies only what was measured, and defaults to unknown', () => {
  /*
   * Rule 10: the decision lives in an exported pure function so the suite can
   * assert it. ECONNRESET is the one that matters -- it was MEASURED with nothing
   * sent, and is still deliberately left unknown, because a reset after the body
   * was written surfaces the same way. That is now also shown end to end, with a
   * real RST after the body, by the 'A REAL RESET AFTER THE BODY' test above;
   * this is the second guard on the decision, not the only one.
   */
  assert.equal(classifyDelivery({ cause: { code: 'ECONNREFUSED' } }), 'none');
  assert.equal(classifyDelivery({ cause: { code: 'ENOTFOUND' } }), 'none');

  assert.equal(classifyDelivery({ cause: { code: 'ECONNRESET' } }), 'unknown',
    'ECONNRESET was classified as a definite non-delivery; a reset arriving after the body was '
    + 'written surfaces the same way, so this re-creates the original defect');
  assert.equal(classifyDelivery({ cause: { code: 'UND_ERR_SOCKET' } }), 'unknown');
  assert.equal(classifyDelivery({ name: 'AbortError', code: 20 }), 'unknown');
  assert.equal(classifyDelivery({ cause: { message: 'bad port' } }), 'unknown',
    'an error with no code at all must not be assumed to be anything');
  assert.equal(classifyDelivery(undefined), 'unknown', 'a missing error must not classify as definite');
  assert.equal(classifyDelivery({ code: 'ECONNREFUSED' }), 'none', 'a top-level code is read too');
});

/* ── the timeout case, at the unit, with the server as witness ───────────── */

test('a commit-then-silence timeout is unknown, and the server witnesses the write', async (t) => {
  const b = await readsBodyThen(t, 'silent');
  const r = await publish(
    { bridgeUrl: b.url, machineId: 'm1', secret: 's' },
    { schema: 'agentbridge.heartbeat.v1', sessions: [] },
    { timeoutMs: 300 },
  );
  assert.ok(b.received.length > 0 && b.received[0] > 0,
    'the bridge never received the body, so this does not construct the committed case');
  assert.equal(r.delivery, 'unknown');
  assert.equal(r.reason, 'timeout');
});

/* ── the reason's code guard, where it is NOT redundant ──────────────────── */

test('only a STRING code is carried into the reason; a numeric one never reaches an operator', async (t) => {
  /*
   * `reason` appends `cause.code` only when `typeof code === 'string'`. For an
   * AbortError (numeric DOMException code 20) that guard is redundant today,
   * because the AbortError branch is tested first -- so weakening the guard to
   * `code != null` survived every other test in this file. Rule 11: test the
   * mechanism where the mutation stops being a no-op. That is a NON-Abort error
   * carrying a numeric code, which reaches the guard directly.
   *
   * fetch is stubbed because no real socket failure is known to produce one;
   * the stub is the only way to reach the guard, and the positive control below
   * proves the stub is what publish actually called.
   */
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  const cfg = { bridgeUrl: 'http://127.0.0.1:9/x', machineId: 'm1', secret: 's' };
  const failWith = (cause) => {
    const calls = [];
    globalThis.fetch = async (...a) => {
      calls.push(a);
      throw Object.assign(new TypeError('fetch failed'), { cause });
    };
    return calls;
  };

  // Positive control first (rule 5): a string code IS carried, through the stub.
  const c1 = failWith({ code: 'ECONNREFUSED' });
  const named = await publish(cfg, { sessions: [] });
  assert.equal(c1.length, 1, 'publish never called the stubbed fetch, so nothing below is measured');
  assert.equal(named.reason, 'fetch failed: ECONNREFUSED');

  const c2 = failWith({ code: 23 });
  const numeric = await publish(cfg, { sessions: [] });
  assert.equal(c2.length, 1, 'publish never called the stubbed fetch, so nothing below is measured');
  assert.equal(numeric.reason, 'fetch failed',
    'a numeric error code was shown to the operator as if it named a failure');
  assert.equal(numeric.delivery, 'unknown', 'a numeric code must not classify as anything definite');
});

/* ── the local refusals, which are definite and must not drift ───────────── */

test('control: a DEFINITE local refusal carries no delivery verdict at all', async () => {
  /*
   * Nothing was transmitted and nothing was attempted, so these are known
   * non-deliveries that never reach the classifier. They must not acquire a
   * 'unknown' verdict, which would tell a watcher to retry something that can
   * never succeed.
   */
  const noUrl = await publish({ bridgeUrl: null, machineId: 'm1', secret: 's' }, { sessions: [] });
  assert.equal(noUrl.reason, 'no-bridge-url');
  assert.equal(noUrl.delivery, undefined);

  const leaking = await publish(
    { bridgeUrl: 'http://127.0.0.1:9/x', machineId: 'm1', secret: 's' },
    { sessions: [] },
    { scan: () => ({ ok: false, leaks: ['secret'] }) },
  );
  assert.equal(leaking.reason, 'payload-leaks');
  assert.equal(leaking.delivery, undefined);
});

/* ── the security surface this must not widen ────────────────────────────── */

test('control: the answered path still returns exactly its four keys', async (t) => {
  const b = await answering(t, 200);
  const r = await publish({ bridgeUrl: b.url, machineId: 'm1', secret: 's' }, { sessions: [] });
  assert.deepEqual(Object.keys(r).sort(), ['accepted', 'ok', 'reason', 'status']);
  assert.equal(r.delivery, undefined);
});
