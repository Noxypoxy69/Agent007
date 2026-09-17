import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  taskConfig, renewConfig, fetchOwnTask, renewLease, HOSTED,
} from '../src/hostedRegistry.mjs';
import { heartbeatDeps } from '../src/workerDeps.mjs';

/**
 * THE THREE ROUTES A WORKER NEEDS, TWO OF WHICH DID NOT EXIST.
 *
 * A worker holds a REGISTRATION token, reaching only /register, /wait and
 * /return. Building the runtime turned up three things it had to do and could
 * not:
 *
 *   read its own task   the assigned event says "enough to know WHICH task,
 *                       never enough to act without reading it" — and there was
 *                       nothing to read from.
 *   RENEW ITS LEASE     renew_lease existed as a granted SECURITY DEFINER
 *                       function reachable from NO endpoint at all.
 *   return its work     /return, which already existed.
 *
 * The renewal one is the worst and the least visible. The default lease is 900
 * seconds and the default run timeout is 1800, so a worker doing a
 * normal-length task on a normal-length lease would have lost it EVERY TIME,
 * discarded completed work as a zombie result, and been entirely right to. The
 * runtime's whole design assumes renewal works, and renewal could not be
 * called.
 *
 * All three were correct, tested, unreachable code. Nothing had noticed because
 * nothing had ever been a worker.
 */

const ENV = {
  AGENTBRIDGE_REGISTER_URL: 'https://x.invalid/register',
  AGENTBRIDGE_REGISTRATION_TOKEN: 'g'.repeat(40),
};

const res = (status, body = {}) => ({
  ok: status >= 200 && status < 300, status, json: async () => body,
});
const stub = (status, body) => async () => res(status, body);

// ── the routes derive from one base ────────────────────────────────────────

test('both routes derive from the register URL, and both can be overridden', () => {
  assert.equal(taskConfig(ENV).url, 'https://x.invalid/task');
  assert.equal(renewConfig(ENV).url, 'https://x.invalid/renew');
  assert.equal(taskConfig({ ...ENV, AGENTBRIDGE_TASK_URL: 'https://o/t' }).url, 'https://o/t');
  assert.equal(renewConfig({ ...ENV, AGENTBRIDGE_RENEW_URL: 'https://o/r' }).url, 'https://o/r');
});

test('no registration config means NOT_CONFIGURED, never a guess', async () => {
  // Local-only operation is honest and fine; inventing a URL is not.
  assert.equal(taskConfig({}), null);
  assert.equal((await fetchOwnTask({}, { session_id: 's' })).state, HOSTED.NOT_CONFIGURED);
  assert.equal((await renewLease({}, { task_id: 't' })).state, HOSTED.NOT_CONFIGURED);
});

// ── reading own work ───────────────────────────────────────────────────────

test('a worker reads the task it was told to read', async () => {
  const out = await fetchOwnTask(ENV, { session_id: 's-me', task_id: 't1' },
    { fetchImpl: stub(200, { ok: true, task: { task_id: 't1', lease_token: 'tok-1' } }) });

  assert.equal(out.state, HOSTED.OK);
  assert.equal(out.task.lease_token, 'tok-1', 'the credential did not survive the round trip');
});

test('and with no task_id, everything it holds — the restarted-worker case', async () => {
  const out = await fetchOwnTask(ENV, { session_id: 's-me' },
    { fetchImpl: stub(200, { ok: true, tasks: [{ task_id: 't1' }, { task_id: 't2' }] }) });

  assert.deepEqual(out.tasks.map((t) => t.task_id), ['t1', 't2']);
});

test('a 404 is an ANSWER, not an unreachable Bridge', async () => {
  /*
   * The class fixed in 4da6712, held on the new routes so they are born with it
   * rather than acquiring it after somebody spends twenty minutes checking a
   * network they cannot fix.
   */
  const out = await fetchOwnTask(ENV, { session_id: 's-me', task_id: 'nope' },
    { fetchImpl: stub(404, { error: 'no-such-task', detail: 'nope' }) });

  assert.equal(out.state, HOSTED.REFUSED);
  assert.notEqual(out.state, HOSTED.UNREACHABLE);
  assert.match(out.detail, /nope/);
});

// ── renewal, and the refusal that must not be retried ──────────────────────

test('RENEWAL EXTENDS THE LEASE — the positive control', async () => {
  const out = await renewLease(ENV, { task_id: 't1', lease_token: 'tok-1' },
    { fetchImpl: stub(200, { ok: true, lease_expires_at: '2026-09-16T04:00:00.000Z' }) });

  assert.equal(out.state, HOSTED.OK);
  assert.equal(out.lease_expires_at, '2026-09-16T04:00:00.000Z');
});

test('A 200 CARRYING ok:false IS A REFUSAL, not a success', async () => {
  /*
   * The worst possible outcome on this route: renewing nothing and reporting
   * that it had, so the worker keeps working on a lease it has lost and
   * discovers it only when the return is rejected.
   */
  const out = await renewLease(ENV, { task_id: 't1', lease_token: 'tok-old' },
    { fetchImpl: stub(200, { ok: false, reason: 'stale-lease' }) });

  assert.equal(out.state, HOSTED.REFUSED, 'a refusal wearing a 200 was read as success');
  assert.equal(out.detail, 'stale-lease');
});

test('a superseded token and a MALFORMED one answer the same way', async () => {
  /*
   * To a worker they mean the same thing: this credential is not one the task
   * will accept, and retrying will not change it. The 409-versus-500 split
   * mattered because a 500 reads as transient and invites the retry that must
   * not happen — and the caller most likely to send a damaged token is one that
   * crashed or resumed from a stale file, which is the zombie population.
   */
  for (const body of [{ ok: false, reason: 'stale-lease' }, { reason: 'stale-lease', detail: 'not a token' }]) {
    const out = await renewLease(ENV, { task_id: 't1', lease_token: 'garbage' },
      { fetchImpl: stub(409, body) });
    assert.equal(out.state, HOSTED.REFUSED, JSON.stringify(body));
    assert.notEqual(out.state, HOSTED.UNREACHABLE, 'a refusal was reported as a transport failure');
  }
});

test('a real outage is STILL unreachable, so the worker can tell them apart', async () => {
  const boom = async () => { throw new Error('ECONNREFUSED'); };
  assert.equal((await renewLease(ENV, { task_id: 't1', lease_token: 'tok' }, { fetchImpl: boom })).state,
    HOSTED.UNREACHABLE);
  assert.equal((await fetchOwnTask(ENV, { session_id: 's' }, { fetchImpl: boom })).state,
    HOSTED.UNREACHABLE);

  // And a 5xx, which is an answer but not a decision.
  assert.equal((await renewLease(ENV, { task_id: 't1', lease_token: 'tok' }, { fetchImpl: stub(503) })).state,
    HOSTED.UNREACHABLE);
});

test('a rejected credential is REJECTED on both routes, not unreachable', async () => {
  assert.equal((await fetchOwnTask(ENV, { session_id: 's' }, { fetchImpl: stub(401) })).state, HOSTED.REJECTED);
  assert.equal((await renewLease(ENV, { task_id: 't' }, { fetchImpl: stub(401) })).state, HOSTED.REJECTED);
});

// ── what goes on the wire ──────────────────────────────────────────────────

test('the session and the token are in the BODY, never the URL', async () => {
  /*
   * A credential in a query string lands in every access log between here and
   * Postgres. The project rule is that secrets are piped, not printed; a URL is
   * the printed form.
   */
  let seen = null;
  await renewLease(ENV, { task_id: 't1', lease_token: 'tok-1' }, {
    fetchImpl: async (url, init) => { seen = { url, init }; return res(200, { ok: true }); },
  });

  assert.equal(seen.url, 'https://x.invalid/renew', 'the token reached the URL');
  assert.ok(!seen.url.includes('tok-1'));
  assert.deepEqual(JSON.parse(seen.init.body), { task_id: 't1', lease_token: 'tok-1', lease_seconds: 900 });
  assert.match(seen.init.headers.authorization, /^Bearer g{40}$/);
});

test('fetchOwnTask omits task_id entirely rather than sending null', async () => {
  // A null task_id is a different question from no task_id, and the endpoint
  // branches on which was asked.
  let body = null;
  await fetchOwnTask(ENV, { session_id: 's-me' }, {
    fetchImpl: async (_u, init) => { body = JSON.parse(init.body); return res(200, { ok: true, tasks: [] }); },
  });
  assert.deepEqual(body, { session_id: 's-me' });
  assert.ok(!('task_id' in body), 'a null task_id would read as "that one" rather than "all of them"');
});

// ── the heartbeat client ───────────────────────────────────────────────────

test('A LOCAL-ONLY WORKER IS NOT A FAILING WORKER', async () => {
  /*
   * FOUND BY MUTATION. The runtime tests fake the heartbeat dep, so nothing
   * exercised heartbeatDeps itself — making NOT_CONFIGURED count as a failure
   * left every one of them green.
   *
   * It matters because the false alarm would be PERMANENT: a worker with no
   * hosted config never beats successfully, so every cycle increments, and
   * after three it announces it is going dark. Forever. The log that exists to
   * warn about a real outage would be full of a worker that is fine.
   *
   * Local-only is a legitimate setup. NOT_CONFIGURED is an answer, not a fault
   * — the same distinction as UNREACHABLE versus REFUSED, one layer up.
   */
  const { heartbeat } = heartbeatDeps({}, { session_id: 's-me', agent_id: 'code-b' });
  const out = await heartbeat({ capacity: 'busy' });

  assert.equal(out.ok, true, 'a local-only worker was reported as failing to beat');
  assert.notEqual(out.goingDark, true);

  // And it does not accumulate, which is what would make the alarm permanent.
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await heartbeat({})).ok, true, `failed on beat ${i + 2}`);
  }
});

test('A REAL REFUSAL COUNTS, and three in a row means going dark', async () => {
  /*
   * The positive control for the rule above: NOT_CONFIGURED must not count,
   * and everything else must. A guard that forgives every failure is not a
   * guard.
   *
   * The threshold is the staleness window, not a round number. Sessions go
   * stale at ten minutes and the driver cycles far faster, so three
   * consecutive misses means the roster is about to be right about us.
   */
  const { heartbeat } = heartbeatDeps(ENV, { session_id: 's-me', agent_id: 'code-b' });
  const refuse = stub(409, { error: 'nope' });

  const a = await heartbeat({}, { fetchImpl: refuse });
  await heartbeat({}, { fetchImpl: refuse });
  const c = await heartbeat({}, { fetchImpl: refuse });

  assert.equal(a.ok, false, 'a refused heartbeat was reported as landing');
  assert.notEqual(a.goingDark, true, 'one miss was treated as going dark');
  assert.equal(c.goingDark, true, 'three consecutive misses did not raise going-dark');
  assert.equal(c.consecutiveFailures, 3);
});

test('a successful beat RESETS the counter', async () => {
  // Otherwise a worker that recovers still announces it is going dark, and the
  // warning stops meaning anything.
  const { heartbeat } = heartbeatDeps({}, { session_id: 's-me', agent_id: 'code-b' });
  const ok = await heartbeat({});
  assert.equal(ok.ok, true);
  assert.notEqual(ok.goingDark, true);
});

test('THE HEARTBEAT CARRIES machine_id, WITHOUT WHICH THE WORKER GOES DARK', async () => {
  /*
   * MEASURED, NOT IMAGINED. The first worker ever run on this project logged
   * "heartbeat FAILED x40: machine_id is required -- THIS WORKER IS GOING DARK"
   * and carried on: it claimed a task, ran it and returned it while invisible
   * to the roster, which reported idle_workers 0 during a tick in which a
   * worker was holding a live lease.
   *
   * /register requires machine_id and heartbeatDeps never sent it. The loud
   * failure was correct and did not help, because nothing could supply the
   * field from where the error was printed.
   *
   * This asserts the PAYLOAD rather than the outcome. A test that only checked
   * ok:true would pass against a fake that accepts anything, which is how a
   * field can go missing for the entire life of a component.
   */
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{}' };
  };

  const { heartbeat } = heartbeatDeps(ENV, {
    session_id: 's-me',
    agent_id: 'code-b',
    machine_id: 'machine-abc',
  });
  await heartbeat({ capacity: 'busy', task_id: 't-1' }, { fetchImpl });

  assert.equal(seen.length, 1, 'the heartbeat did not post at all');
  assert.equal(
    seen[0].machine_id,
    'machine-abc',
    'machine_id is absent from the heartbeat payload; /register refuses it and the worker goes dark',
  );
  // the fields it already sent must survive the addition
  assert.equal(seen[0].session_id, 's-me');
  assert.equal(seen[0].agent_id, 'code-b');
  assert.equal(seen[0].capacity, 'busy');
});
