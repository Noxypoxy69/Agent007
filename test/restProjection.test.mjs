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
  // process_probe_ok is null when the probe never ran. httpStore reads
  // `!== false`, so null means "assume fine" -- matching the node store, which
  // spreads an absent key as undefined. The view must NOT coalesce it to true
  // on its own, or the two surfaces disagree about an unknown probe.
  const store = storeWith([['sessions_latest', SESSION_ROWS]]);
  const out = await store.listSessions();
  assert.equal(out[1].processProbeOk, true);
  assert.equal(out[1].git, null);
  assert.deepEqual(out[1].locks, []);
  assert.deepEqual(out[1].processes, []);
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
