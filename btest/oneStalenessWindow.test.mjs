import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolDefs, STALE_AFTER_MS, isLive } from '../supabase/functions/mcp/_shared.js';

/**
 * ONE QUESTION, ONE ANSWER: IS THIS AGENT ALIVE?
 *
 * Found by verifying the live deploy rather than by any test. At 19:12 UTC on
 * 2026-09-15, against the same rows in the same second:
 *
 *   get_supervisory_report   code-c is an idle live worker
 *   get_collision_summary    code-c is "stale", no heartbeat for 93s
 *
 * Both were reading session_registrations. They disagreed because
 * detectCollisions defaults to a 90-second window, which predates both the
 * 120-second heartbeat interval and the 600-second liveness window everything
 * else uses -- so a healthy worker was reported stale for a quarter of every
 * cycle.
 *
 * AND THE WRONG ARITHMETIC REACHED A REAL CONCLUSION. Lane "agentbridge" was
 * demoted to dormant because the guard believed all three claimants were stale
 * when one was live. The verdict was right by luck. Luck is not a guard.
 *
 * So the data plane passes the shared window explicitly, and this holds it
 * there.
 */

const store = (sessions) => ({
  listSessions: async () => sessions,
  getLanes: async () => ({}),
});

const run = async (sessions) => {
  const def = toolDefs(store(sessions)).find((d) => d.name === 'get_collision_summary');
  return JSON.parse((await def.run({})).content[0].text);
};

const session = (o = {}) => ({
  agentId: 'code-c', lane: 'agentbridge', worktree: 'C:/wt/c',
  capacity: 'idle', locks: [], processes: [], processProbeOk: true,
  git: { ok: true }, ...o,
});

test('A WORKER ON A 120s HEARTBEAT IS NOT STALE TO THE COLLISION GUARD', async () => {
  /*
   * The exact case that was wrong in production: 93 seconds since the last
   * beat, on a 120-second interval. That is a worker mid-cycle, not a worker
   * that died.
   */
  const ninetyThreeSecondsAgo = new Date(Date.now() - 93_000).toISOString();
  const r = await run([session({ lastSeenAt: ninetyThreeSecondsAgo })]);

  assert.equal(r.findings.some((f) => f.code === 'stale-session'), false,
    'a worker 93s into a 120s heartbeat cycle was reported stale');
});

test('the collision guard and isLive agree on the SAME row', async () => {
  // The two surfaces a coordinator reads must not contradict each other about
  // one agent at one moment. That contradiction is the whole bug.
  const now = new Date().toISOString();
  for (const secondsAgo of [10, 93, 300, 599, 601, 1200]) {
    const lastSeenAt = new Date(Date.parse(now) - secondsAgo * 1000).toISOString();
    const row = session({ lastSeenAt });

    const guardSaysStale = (await run([row])).findings.some((f) => f.code === 'stale-session');
    const liveSaysAlive = isLive(
      { capacity: 'idle', heartbeat_at: lastSeenAt }, { now },
    );

    assert.equal(guardSaysStale, !liveSaysAlive,
      `at ${secondsAgo}s the collision guard and isLive disagreed`
      + ` (guard stale=${guardSaysStale}, isLive alive=${liveSaysAlive})`);
  }
});

test('a genuinely dead worker is STILL reported stale', async () => {
  // The positive control. Widening the window must not mean nothing is ever
  // stale -- code-b had been silent for 26,000 seconds and had to keep showing.
  const r = await run([session({ lastSeenAt: new Date(Date.now() - 26_000_000).toISOString() })]);
  assert.ok(r.findings.some((f) => f.code === 'stale-session'),
    'a worker silent for hours stopped being reported');
});

test('the window is the shared constant, not a number retyped here', async () => {
  /*
   * A copy that happens to equal 600 today is a copy that drifts tomorrow. The
   * boundary is probed either side of the SHARED value, so changing
   * STALE_AFTER_MS moves this test with it instead of breaking it.
   */
  const at = async (ms) => (await run([
    session({ lastSeenAt: new Date(Date.now() - ms).toISOString() }),
  ])).findings.some((f) => f.code === 'stale-session');

  assert.equal(await at(STALE_AFTER_MS - 5_000), false, 'stale just inside the shared window');
  assert.equal(await at(STALE_AFTER_MS + 5_000), true, 'not stale just outside the shared window');
});
