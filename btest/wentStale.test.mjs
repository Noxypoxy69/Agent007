import test from 'node:test';
import assert from 'node:assert/strict';
import { wentStale, supervisoryReport, WORKER_STALE_AFTER_MS } from '../src/dispatch.mjs';

/**
 * A WORKER THAT STOPPED IS NOT A LANE NOBODY STAFFED.
 *
 * On 2026-09-15 three of four watchers were killed by the host for memory, at
 * unrelated times, and the production line reported itself as idle. Every
 * symptom said "no idle live worker holds lane X", which a reader takes as a
 * staffing plan rather than three dead processes. These tests exist to keep
 * those two sentences distinguishable.
 */

const NOW = '2026-09-15T18:00:00.000Z';
const ago = (ms) => new Date(Date.parse(NOW) - ms).toISOString();
const MIN = 60_000;

const session = (over = {}) => ({
  agent_id: 'code-b',
  session_id: 'danny-win-f1',
  lane_id: 'agentbridge',
  capacity: 'idle',
  heartbeat_at: ago(30_000),
  head_sha: 'a'.repeat(40),
  ...over,
});

// ── what counts as lost ────────────────────────────────────────────────────
test('a worker that was heartbeating and STOPPED is reported', () => {
  const [lost] = wentStale({ sessions: [session({ heartbeat_at: ago(40 * MIN) })], now: NOW });
  assert.ok(lost, 'a worker silent for 40 minutes was not reported');
  assert.equal(lost.agent_id, 'code-b');
  assert.equal(lost.session_id, 'danny-win-f1');
  assert.equal(lost.lane_id, 'agentbridge');
  assert.equal(lost.silent_for_seconds, 2400);
});

test('a live worker is not reported', () => {
  assert.deepEqual(wentStale({ sessions: [session()], now: NOW }), []);
});

test('A DECLARED SHUTDOWN IS NOT AN ALERT', () => {
  /*
   * capacity 'offline' is a worker saying so on its way out. Paging somebody
   * about the one component that behaved correctly is how an alert channel
   * becomes something people mute.
   */
  const rows = wentStale({
    sessions: [session({ capacity: 'offline', heartbeat_at: ago(40 * MIN) })],
    now: NOW,
  });
  assert.deepEqual(rows, []);
});

test('a session that NEVER heartbeated is not mourned', () => {
  // It never started. Reporting it as lost would invent a worker in order to
  // report losing it.
  for (const heartbeat_at of [null, undefined, '', 'not-a-date']) {
    assert.deepEqual(wentStale({ sessions: [session({ heartbeat_at })], now: NOW }), [],
      `heartbeat_at=${String(heartbeat_at)}`);
  }
});

test('the boundary is the stale window, and it is exclusive', () => {
  const at = (ms) => wentStale({ sessions: [session({ heartbeat_at: ago(ms) })], now: NOW }).length;
  assert.equal(at(WORKER_STALE_AFTER_MS - 1000), 0, 'reported a worker still inside the window');
  assert.equal(at(WORKER_STALE_AFTER_MS), 0, 'reported a worker exactly at the window');
  assert.equal(at(WORKER_STALE_AFTER_MS + 1000), 1, 'missed a worker just past the window');
});

// ── the evidence it carries ────────────────────────────────────────────────
test('THE FROZEN head_sha IS CARRIED, because it is the tell', () => {
  /*
   * A head_sha stuck at an old commit is how you tell a worker that died
   * mid-task from one that finished and went quiet. It is the field that gave
   * the memory kills away in the first place.
   */
  const [lost] = wentStale({
    sessions: [session({ heartbeat_at: ago(40 * MIN), head_sha: 'b'.repeat(40) })],
    now: NOW,
  });
  assert.equal(lost.last_head_sha, 'b'.repeat(40));
  assert.equal(lost.last_heartbeat_at, ago(40 * MIN));
  assert.equal(lost.capacity_when_last_seen, 'idle');
});

test('the most recently lost worker comes first', () => {
  // That is the one still worth chasing; the three-day-old one is archaeology.
  const rows = wentStale({
    sessions: [
      session({ agent_id: 'old', session_id: 's-old', heartbeat_at: ago(300 * MIN) }),
      session({ agent_id: 'fresh', session_id: 's-fresh', heartbeat_at: ago(11 * MIN) }),
      session({ agent_id: 'mid', session_id: 's-mid', heartbeat_at: ago(90 * MIN) }),
    ],
    now: NOW,
  });
  assert.deepEqual(rows.map((r) => r.agent_id), ['fresh', 'mid', 'old']);
});

test('a row with no session_id is skipped rather than reported as a ghost', () => {
  assert.deepEqual(
    wentStale({ sessions: [session({ session_id: null, heartbeat_at: ago(40 * MIN) }), null], now: NOW }),
    [],
  );
});

test('the clock is required and is never guessed', () => {
  assert.throws(() => wentStale({ sessions: [] }), /requires a `now` timestamp/);
  assert.throws(() => wentStale({ sessions: [], now: 'whenever' }), /not a timestamp/);
});

// ── how it reaches the report ──────────────────────────────────────────────
test('LOST WORKERS LEAD THE REPORT, because they explain the rest', () => {
  /*
   * A blocked task under a dead worker is one fact, not two. Reading them the
   * other way round invites re-routing work around a lane whose only problem is
   * that nobody is standing on it.
   */
  const r = supervisoryReport({
    sessions: [session({ heartbeat_at: ago(40 * MIN) })],
    blocked: [{ task_id: 't1', reason: 'no idle live worker holds lane "agentbridge"' }],
    now: NOW,
  });

  assert.equal(r.counts.workers_went_stale, 1);
  assert.equal(r.worker_went_stale.length, 1);
  assert.equal(r.worker_went_stale[0].agent_id, 'code-b');

  const keys = Object.keys(r);
  assert.ok(keys.indexOf('worker_went_stale') < keys.indexOf('blocked'),
    'blocked was listed before the dead worker that caused it');
});

test('a quiet hour still reads as quiet', () => {
  const r = supervisoryReport({ now: NOW });
  assert.equal(r.counts.workers_went_stale, 0);
  assert.deepEqual(r.worker_went_stale, []);
});

test('the report does not invent losses when no sessions are supplied', () => {
  // supervisoryReport is called from two places; one forgetting to pass
  // sessions must read as "nothing known", never as "nothing lost".
  const r = supervisoryReport({ blocked: [{ task_id: 't1' }], now: NOW });
  assert.deepEqual(r.worker_went_stale, []);
  assert.equal(r.counts.blocked, 1);
});
