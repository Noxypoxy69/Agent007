import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCollisions } from '../bridge/collisions.mjs';

/**
 * TWO DEAD SESSIONS ARE NOT A COLLISION.
 *
 * The registry held two offline probe sessions on lane "probe" and three agents
 * on lane "agentbridge" of which exactly one was alive. Both raised CRITICAL
 * findings that nobody could act on, and a critical that cannot be acted on is
 * how a reader learns to skim the criticals -- which eventually costs them the
 * one that mattered.
 *
 * The rule these tests hold: severity follows whether the parties COULD BE
 * ACTING AT THE SAME TIME, and demotion requires positive evidence of absence.
 * Nothing is ever dropped.
 */

const NOW = Date.parse('2026-09-15T18:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

const session = (o = {}) => ({
  agentId: 'code-c', lane: 'messaging', worktree: 'C:/wt/code-c',
  lastSeenAt: ago(5_000), capacity: 'idle', processProbeOk: true, locks: [], processes: [],
  git: { ok: true, branch: 'b', head: 'a'.repeat(40), baseSha: 'b'.repeat(40),
    mainRef: 'origin/main', mainSha: 'b'.repeat(40), upstream: 'origin/b',
    unpushed: 0, aheadOfMain: 0, behindMain: 0, staged: [], dirty: [], untracked: [] },
  ...o,
});
const run = (sessions) => detectCollisions(sessions, { now: NOW, staleAfterSeconds: 90 });
const find = (r, code) => r.findings.find((f) => f.code === code);

// ── the real noise this was written for ────────────────────────────────────
test('TWO OFFLINE PROBE SESSIONS ON ONE LANE ARE NOT CRITICAL', () => {
  const r = run([
    session({ agentId: 'probe-reader', lane: 'probe', worktree: 'C:/wt/p1', capacity: 'offline' }),
    session({ agentId: 'probe-reader2', lane: 'probe', worktree: 'C:/wt/p2', capacity: 'offline' }),
  ]);

  assert.equal(find(r, 'duplicate-lane'), undefined, 'two dead probes still raised a critical');
  const d = find(r, 'duplicate-lane-dormant');
  assert.ok(d, 'the conflict vanished entirely instead of being demoted');
  assert.equal(d.severity, 'info');
});

test('THE EVIDENCE SURVIVES THE DEMOTION, and gains the state of each party', () => {
  /*
   * Filtering these out would destroy the record of a misconfiguration still
   * sitting in the registry, waiting to matter the moment somebody restarts one
   * of them. A demoted finding must be MORE informative, not less.
   */
  const r = run([
    session({ agentId: 'probe-reader', lane: 'probe', worktree: 'C:/wt/p1', capacity: 'offline' }),
    session({ agentId: 'probe-reader2', lane: 'probe', worktree: 'C:/wt/p2', capacity: 'offline' }),
  ]);
  const d = find(r, 'duplicate-lane-dormant');

  assert.equal(d.evidence.lane, 'probe');
  assert.deepEqual(d.evidence.agents, [
    { agent: 'probe-reader', state: 'offline' },
    { agent: 'probe-reader2', state: 'offline' },
  ]);
});

test('the real roster: three on a lane, one alive, reads as dormant', () => {
  // code-c live, code-b and code-d killed by the host hours ago.
  const r = run([
    session({ agentId: 'code-c', lane: 'agentbridge', worktree: 'C:/wt/c' }),
    session({ agentId: 'code-b', lane: 'agentbridge', worktree: 'C:/wt/b', lastSeenAt: ago(110 * MIN) }),
    session({ agentId: 'code-d', lane: 'agentbridge', worktree: 'C:/wt/d', lastSeenAt: ago(172 * MIN) }),
  ]);

  assert.equal(find(r, 'duplicate-lane'), undefined);
  const d = find(r, 'duplicate-lane-dormant');
  assert.deepEqual(d.evidence.agents, [
    { agent: 'code-c', state: 'operational' },
    { agent: 'code-b', state: 'stale' },
    { agent: 'code-d', state: 'stale' },
  ]);
});

// ── THE POSITIVE CONTROL: it must still go critical ────────────────────────
test('TWO LIVE AGENTS ON ONE LANE ARE STILL CRITICAL', () => {
  /*
   * A guard that only ever demotes is an outage dressed as a quiet dashboard.
   * This is the case the whole check exists for and it must be untouched.
   */
  const r = run([
    session({ agentId: 'code-c', lane: 'agentbridge', worktree: 'C:/wt/c' }),
    session({ agentId: 'code-b', lane: 'agentbridge', worktree: 'C:/wt/b' }),
  ]);

  const c = find(r, 'duplicate-lane');
  assert.ok(c, 'two live agents on one lane stopped being critical');
  assert.equal(c.severity, 'critical');
  assert.deepEqual(c.evidence.agents, ['code-c', 'code-b']);
  assert.equal(find(r, 'duplicate-lane-dormant'), undefined);
});

test('two live plus one dead is still critical, because two can still contend', () => {
  const r = run([
    session({ agentId: 'code-c', lane: 'agentbridge', worktree: 'C:/wt/c' }),
    session({ agentId: 'code-b', lane: 'agentbridge', worktree: 'C:/wt/b' }),
    session({ agentId: 'b6', lane: 'agentbridge', worktree: 'C:/wt/6', capacity: 'offline' }),
  ]);
  assert.equal(find(r, 'duplicate-lane').severity, 'critical');
});

// ── the direction it must never guess in ───────────────────────────────────
test('DEMOTION REQUIRES POSITIVE EVIDENCE: no heartbeat data means treat as live', () => {
  /*
   * Absence of evidence is not evidence of death. Guessing the other way would
   * silently downgrade real contention wherever a caller does not populate
   * lastSeenAt -- which is most of the older callers.
   */
  const r = run([
    session({ agentId: 'code-c', lane: 'agentbridge', worktree: 'C:/wt/c', lastSeenAt: null, capacity: null }),
    session({ agentId: 'code-b', lane: 'agentbridge', worktree: 'C:/wt/b', lastSeenAt: null, capacity: null }),
  ]);
  assert.equal(find(r, 'duplicate-lane').severity, 'critical',
    'unknown liveness was treated as dead and hid a real collision');
});

// ── the same rule, applied to the other contention findings ────────────────
test('a shared worktree between two dead sessions is demoted, not dropped', () => {
  const r = run([
    session({ agentId: 'p1', lane: 'a', worktree: 'C:/wt/shared', capacity: 'offline' }),
    session({ agentId: 'p2', lane: 'b', worktree: 'C:/wt/shared', capacity: 'offline' }),
  ]);
  assert.equal(find(r, 'shared-worktree'), undefined);
  const d = find(r, 'shared-worktree-dormant');
  assert.equal(d.severity, 'info');
  assert.deepEqual(d.evidence.agents.map((a) => a.agent).sort(), ['p1', 'p2']);
});

test('a shared worktree between two LIVE sessions is still critical', () => {
  const r = run([
    session({ agentId: 'p1', lane: 'a', worktree: 'C:/wt/shared' }),
    session({ agentId: 'p2', lane: 'b', worktree: 'C:/wt/shared' }),
  ]);
  assert.equal(find(r, 'shared-worktree').severity, 'critical');
});

test('lock contention between dead sessions is demoted and keeps the ages', () => {
  const lock = { resource: 'migrations', ageSeconds: 42 };
  const r = run([
    session({ agentId: 'p1', lane: 'a', worktree: 'C:/wt/1', capacity: 'offline', locks: [{ ...lock, heldBy: 'p1' }] }),
    session({ agentId: 'p2', lane: 'b', worktree: 'C:/wt/2', capacity: 'offline', locks: [{ ...lock, heldBy: 'p2' }] }),
  ]);
  assert.equal(find(r, 'lock-contention'), undefined);
  const d = find(r, 'lock-contention-dormant');
  assert.equal(d.severity, 'info');
  assert.deepEqual(d.evidence.holders, [
    { agent: 'p1', state: 'offline', ageSeconds: 42 },
    { agent: 'p2', state: 'offline', ageSeconds: 42 },
  ]);
});

test('lock contention between LIVE sessions is still critical', () => {
  const lock = { resource: 'migrations', ageSeconds: 42 };
  const r = run([
    session({ agentId: 'p1', lane: 'a', worktree: 'C:/wt/1', locks: [{ ...lock, heldBy: 'p1' }] }),
    session({ agentId: 'p2', lane: 'b', worktree: 'C:/wt/2', locks: [{ ...lock, heldBy: 'p2' }] }),
  ]);
  assert.equal(find(r, 'lock-contention').severity, 'critical');
});

test('foreign-lock is NOT demoted, because it is not about contention', () => {
  /*
   * It records that a lock in one worktree is held under a different agent's
   * name. That already happened, and it stays true and worth reading whether or
   * not either party is still running.
   */
  const r = run([
    session({
      agentId: 'p1', lane: 'a', worktree: 'C:/wt/1', capacity: 'offline',
      locks: [{ resource: 'migrations', ageSeconds: 9, heldBy: 'somebody-else' }],
    }),
  ]);
  assert.equal(find(r, 'foreign-lock').severity, 'critical');
});
