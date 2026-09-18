import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dispatchTick } from '../bridge/oauthWorker.mjs';
import { toolDefs } from '../supabase/functions/mcp/_shared.js';

/**
 * THE TICK, AND THE CAPABILITY THAT BOUNDS IT.
 *
 * The owner ruled: the dispatcher prepares, the coordinator confirms. That is
 * enforced by what the dispatcher's token can OPEN -- one endpoint -- not by
 * the dispatcher choosing not to assign. A component that could assign and
 * merely refrains is a habit, not a control.
 *
 * These cover the tick itself and the tool surface it must not appear on.
 */

async function dataPlane(t, reply) {
  const calls = [];
  const server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      calls.push({ url: req.url, method: req.method, auth: req.headers.authorization });
      const r = typeof reply === 'function' ? reply(calls.length) : reply;
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
      res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {}));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return { calls, base: `http://127.0.0.1:${server.address().port}` };
}

const quiet = (t) => {
  // The tick logs a line per run; keep the test output readable while still
  // asserting on what it says where that matters.
  const lines = [];
  const log = console.log; const err = console.error;
  console.log = (m) => lines.push(String(m));
  console.error = (m) => lines.push(String(m));
  t.after(() => { console.log = log; console.error = err; });
  return lines;
};

// ── the tick ───────────────────────────────────────────────────────────────
test('the tick posts to /dispatch with the DISPATCHER token', async (t) => {
  quiet(t);
  const { calls, base } = await dataPlane(t, {
    body: { ok: true, prepared: 2, report: { counts: { awaiting_review: 1, blocked: 0, idle_workers: 3 } } },
  });

  const r = await dispatchTick({ DATA_PLANE_URL: base, BRIDGE_DISPATCHER_TOKEN: 'disp' });

  assert.equal(r.ok, true);
  assert.equal(r.prepared, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/dispatch');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].auth, 'Bearer disp');
});

test('the tick NEVER carries a coordinator token', async (t) => {
  /*
   * The ruling is enforced by capability. If the tick sent the coordinator
   * credential it could assign work, and nothing but its own restraint would
   * stop it.
   */
  quiet(t);
  const { calls, base } = await dataPlane(t, { body: { ok: true, prepared: 0 } });

  await dispatchTick({
    DATA_PLANE_URL: base,
    BRIDGE_DISPATCHER_TOKEN: 'disp',
    BRIDGE_COORDINATOR_TOKEN: 'coord-should-not-be-used',
    BRIDGE_READER_TOKEN: 'reader-should-not-be-used',
  });

  assert.equal(calls[0].auth, 'Bearer disp');
  assert.ok(!calls[0].auth.includes('coord'));
  assert.ok(!calls[0].auth.includes('reader'));
});

test('an unconfigured tick refuses loudly rather than silently doing nothing', async (t) => {
  const lines = quiet(t);
  const r = await dispatchTick({ DATA_PLANE_URL: 'http://127.0.0.1:1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-configured');
  assert.match(lines.join(' '), /BRIDGE_DISPATCHER_TOKEN/);
});

test('a failed tick is harmless and says so, because the next tick is the retry', async (t) => {
  /*
   * The tick writes proposals and nothing else, so there is no partial state to
   * repair. It neither retries nor alerts -- and a stale open set is refused by
   * confirm_proposal as stale anyway.
   */
  const lines = quiet(t);
  const { base } = await dataPlane(t, { status: 500, body: { error: 'boom' } });

  const r = await dispatchTick({ DATA_PLANE_URL: base, BRIDGE_DISPATCHER_TOKEN: 'disp' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 500);
  assert.match(lines.join(' '), /dispatch: http 500/);
});

test('an unreachable data plane does not throw out of the tick', async (t) => {
  // A throwing scheduled handler is an unhandled rejection in the isolate.
  const lines = quiet(t);
  const r = await dispatchTick({ DATA_PLANE_URL: 'http://127.0.0.1:1', BRIDGE_DISPATCHER_TOKEN: 'disp' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unreachable');
  assert.match(lines.join(' '), /unreachable/);
});

test('the log line leads with what needs a decision', async (t) => {
  /*
   * A log that prints a healthy roster every minute is a log nobody reads, and
   * the blocked task in it is the reason anyone would have looked.
   */
  const lines = quiet(t);
  const { base } = await dataPlane(t, {
    body: { ok: true, prepared: 3, report: { counts: { awaiting_review: 2, blocked: 1, idle_workers: 0 } } },
  });

  await dispatchTick({ DATA_PLANE_URL: base, BRIDGE_DISPATCHER_TOKEN: 'disp' });
  const line = lines.find((l) => l.startsWith('dispatch: prepared'));
  assert.ok(line, 'no summary line was logged');
  assert.match(line, /prepared=3/);
  assert.match(line, /review=2/);
  assert.match(line, /blocked=1/);
});

test('a malformed reply does not read as a successful tick', async (t) => {
  const lines = quiet(t);
  const { base } = await dataPlane(t, { body: 'not json at all' });
  const r = await dispatchTick({ DATA_PLANE_URL: base, BRIDGE_DISPATCHER_TOKEN: 'disp' });
  assert.equal(r.ok, false);
  assert.match(lines.join(' '), /dispatch:/);
});

// ── the tool surface ───────────────────────────────────────────────────────
test('proposal tools exist ONLY for a coordinator, never for a reader', () => {
  const read = { listSessions: async () => [], getLanes: async () => ({}) };
  const names = toolDefs(read).map((d) => d.name);
  for (const n of ['list_proposals', 'confirm_proposal', 'get_supervisory_report']) {
    assert.ok(!names.includes(n), `${n} is exposed to a reader`);
  }
});

test('the coordinator gets all three, and confirm_proposal SAYS it re-verifies', () => {
  /*
   * The description is read by the model before every call. If it implies the
   * recorded verdict is authoritative, a coordinator will treat a stale "yes"
   * as permission -- which is the failure this whole design exists to prevent.
   */
  const coord = {
    listSessions: async () => [], getLanes: async () => ({}),
    listProposals: async () => [], confirmProposal: async () => ({}), supervisoryReport: async () => ({}),
  };
  const defs = toolDefs(coord);
  const by = (n) => defs.find((d) => d.name === n);

  assert.ok(by('list_proposals'));
  assert.ok(by('get_supervisory_report'));

  const confirm = by('confirm_proposal');
  assert.ok(confirm);
  assert.match(confirm.description, /RE-RUN AGAINST LIVE STATE FIRST/);
  assert.match(confirm.description, /recorded verdict is ignored/);
  assert.match(confirm.description, /stale/);

  // And list_proposals must not present the stored verdict as current.
  assert.match(by('list_proposals').description, /never a permission/);
});

test('list_proposals renames the stored verdict so it cannot read as current', async () => {
  /*
   * `would_be_accepted: true` in a tool result invites exactly one reading.
   * Naming the field for WHEN it was true is the cheapest possible guard
   * against a coordinator treating a proposal as a decision.
   */
  const coord = {
    listSessions: async () => [], getLanes: async () => ({}),
    listProposals: async () => [{
      proposal_id: 'p1', kind: 'assign', task_id: 't1', agent_id: 'code-b',
      would_be_accepted: true, reasons: [], prepared_at: '2026-09-15T15:00:00.000Z',
    }],
    confirmProposal: async () => ({}), supervisoryReport: async () => ({}),
  };
  const def = toolDefs(coord).find((d) => d.name === 'list_proposals');
  const [row] = JSON.parse((await def.run({})).content[0].text);

  assert.equal(row.would_be_accepted_when_prepared, true);
  assert.equal(row.would_be_accepted, undefined, 'the bare field name survived');
  assert.deepEqual(row.reasons_when_prepared, []);
  assert.equal(row.reasons, undefined);
});
