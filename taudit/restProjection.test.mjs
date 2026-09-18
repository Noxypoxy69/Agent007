import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpStore } from '../bridge/httpStore.mjs';

/**
 * THE VIEWS THE WORKER READS, PINNED TO THE SHAPE THE WORKER EXPECTS.
 *
 * bridge/httpStore.mjs reads three REST resources -- sessions_latest,
 * lanes_latest and reader_tokens -- and bridge/schema.sql defined NONE of them.
 * It defines base tables in an `agentbridge` schema that PostgREST does not
 * even expose. The hosted surface was written against a projection that did not
 * exist, and nothing said so, because the store throws only when a request
 * FAILS: a missing relation is a 404, and the code that would have noticed was
 * never run against a real database.
 *
 * The views now exist (migration agentbridge_rest_views_for_worker). The rows
 * below are the real projection, captured from that migration against seeded
 * data and rolled back -- not invented to match the mapping.
 *
 * WHAT THIS ACTUALLY GUARDS: that the node store and the hosted store hand
 * mcp/toolDefs the same object. store.mjs returns `{...r.state, lastSeenAt,
 * machineLabel}` -- camelCase, straight out of the jsonb. httpStore rebuilds
 * that shape from flat snake_case columns. If the view's column names drift,
 * every field silently becomes undefined and the tools answer "unknown" with
 * total confidence instead of erroring. That is the failure mode a shared
 * toolDefs exists to prevent, so it gets a test rather than a comment.
 */

/** The exact rows public.sessions_latest emits. */
const SESSION_ROWS = [
  {
    agent_id: 'code-b',
    lane: 'agentbridge',
    machine_label: 'probe-machine',
    worktree: 'agentbridge-b',
    git: { ok: true, head: 'cb4a23f', branch: 'b/worker-identity' },
    locks: ['voice_'],
    processes: [{ pid: 4242, kind: 'node' }],
    process_probe_ok: true,
    last_seen_at: '2026-09-15T06:33:13.380845+00:00',
  },
  {
    // A session whose process probe never reported.
    agent_id: 'code-z',
    lane: 'idle-lane',
    machine_label: 'probe-machine',
    worktree: 'agentbridge-z',
    git: null,
    locks: [],
    processes: [],
    process_probe_ok: null,
    last_seen_at: '2026-09-15T06:33:13.380845+00:00',
  },
];

const LANE_ROWS = [{ lanes: { messaging: ['src/lib/sms/**'], agentbridge: ['src/**', 'test/**'] } }];

/** A fetch that answers the three resources and records what was asked for. */
function stubFetch(routes, seen = []) {
  return async (url) => {
    seen.push(String(url));
    for (const [match, rows] of routes) {
      if (String(url).includes(match)) {
        return { ok: true, status: 200, json: async () => rows };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

const ENV = { SUPABASE_URL: 'https://ornbhvaijcpsbcgquzhd.supabase.co', SUPABASE_SERVICE_KEY: 'x'.repeat(40) };

const storeWith = (routes, seen) =>
  createHttpStore(ENV, { fetchImpl: stubFetch(routes, seen) });

test('listSessions rebuilds the camelCase shape store.mjs returns', async () => {
  const seen = [];
  const store = storeWith([['sessions_latest', SESSION_ROWS]], seen);
  const out = await store.listSessions();

  // It must hit the VIEW, not the base table. A base-table read would return
  // snake_case git columns and no machine_label, and map to all-undefined.
  assert.ok(seen.some((u) => u.includes('/rest/v1/sessions_latest')), `queried: ${seen.join(', ')}`);

  assert.deepEqual(out[0], {
    agentId: 'code-b',
    lane: 'agentbridge',
    machineLabel: 'probe-machine',
    worktree: 'agentbridge-b',
    git: { ok: true, head: 'cb4a23f', branch: 'b/worker-identity' },
    locks: ['voice_'],
    processes: [{ pid: 4242, kind: 'node' }],
    processProbeOk: true,
    lastSeenAt: '2026-09-15T06:33:13.380845+00:00',
  });

  // No field may arrive undefined -- that is what a column rename looks like,
  // and it renders as a confident "unknown" rather than an error.
  for (const [k, v] of Object.entries(out[0])) {
    assert.notEqual(v, undefined, `${k} came back undefined: the view's columns have drifted`);
  }
});

test('an unreported process probe is not reported as a healthy one', async () => {
  /*
   * THE NAME WAS RIGHT AND THE BODY PINNED THE OPPOSITE, for as long as this
   * test existed.
   *
   * `process_probe_ok` is NULL when the probe never ran. httpStore used to read
   * `!== false`, which turned that into TRUE — "a probe ran and found nothing",
   * the most confident thing the field can say, on exactly the row least
   * entitled to it. This test asserted that behaviour while its own title
   * called it out as wrong.
   *
   * 0a94bcb fixed the store to emit null and did not touch this file, leaving
   * the gate red at the tip. Found by blind audit. Both halves were mine: the
   * fix, and the failure to carry it here.
   *
   * The probe assertion now says what the title always said.
   *
   * `locks` and `processes` ARE STILL `[]` HERE, AND THAT IS CORRECT — a point
   * the audit got wrong and this fixture settles. The row carries `locks: []`
   * and `processes: []`, which are MEASURED empty lists: the collector looked
   * and found none. Only `process_probe_ok` is NULL. Mapping the measured
   * empties to null would be the same defect pointing the other way, and it is
   * pinned as a positive in the test below.
   */
  const store = storeWith([['sessions_latest', SESSION_ROWS]]);
  const out = await store.listSessions();
  assert.equal(out[1].processProbeOk, null,
    'a NULL probe column was reported as a healthy probe — the row least entitled to confidence');
  assert.equal(out[1].git, null);
  assert.deepEqual(out[1].locks, [], 'a MEASURED empty lock list was turned into unknown');
  assert.deepEqual(out[1].processes, [], 'a MEASURED empty process list was turned into unknown');
});

test('a MEASURED probe, lock list and process list still survive the projection', async () => {
  /*
   * Rule 5, and the direction the fix above could break. A store that mapped
   * everything to null would satisfy every assertion in the previous test and
   * would destroy the field's meaning in the other direction: a genuinely
   * failed probe (`false`) and a genuinely empty list (`[]`) are measurements
   * and must survive as themselves.
   */
  const store = storeWith([['sessions_latest', [{
    agent_id: 'code-b', session_id: 'danny-win-b1', lane: 'agentbridge',
    machine_label: null, worktree: null, git: null,
    locks: [], processes: [], process_probe_ok: false,
    last_seen_at: '2026-09-18T20:00:00.000Z',
  }]]]);
  const [s] = await store.listSessions();
  assert.equal(s.processProbeOk, false, 'a measured probe FAILURE was flattened into unknown');
  assert.deepEqual(s.locks, [], 'a measured empty lock list became unknown');
  assert.deepEqual(s.processes, [], 'a measured empty process list became unknown');
});

test('getLanes returns name -> globs, and {} when the table is empty', async () => {
  const store = storeWith([['lanes_latest', LANE_ROWS]]);
  assert.deepEqual(await store.getLanes(), {
    messaging: ['src/lib/sms/**'],
    agentbridge: ['src/**', 'test/**'],
  });

  // jsonb_object_agg over no rows yields one row whose `lanes` is NULL. "No
  // lanes file" and "lanes unknown" must not render identically to a caller.
  const empty = storeWith([['lanes_latest', [{ lanes: null }]]]);
  assert.deepEqual(await empty.getLanes(), {});
});

test('a reader token is matched by digest, never by value', async () => {
  const seen = [];
  const token = 'a'.repeat(32);
  const store = storeWith([['reader_tokens', [{ label: 'worker-ro', disabled: false }]]], seen);

  assert.equal(await store.checkReaderToken(token), 'worker-ro');

  const url = seen.find((u) => u.includes('reader_tokens'));
  assert.ok(url.includes('token_sha256=eq.'), `no digest lookup: ${url}`);
  assert.ok(!url.includes(token), 'THE PLAINTEXT TOKEN WAS PUT IN THE URL');
  assert.ok(url.includes('disabled=is.false'), 'a disabled token would be accepted');
});

test('a missing view is an ERROR, not an empty machine', async () => {
  // The whole reason this file exists: before the views were created, every one
  // of these reads was a 404. That must surface as a failure, because "no
  // agents are registered" is a calm, plausible, and completely wrong answer.
  const store = createHttpStore(ENV, { fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
  await assert.rejects(() => store.listSessions(), /supabase-read-failed:404/);
  await assert.rejects(() => store.getLanes(), /supabase-read-failed:404/);
});
