import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectCollisions as srcCollisions } from '../bridge/collisions.mjs';
import { wentStale as srcWentStale, supervisoryReport as srcReport } from '../src/dispatch.mjs';
import {
  detectCollisions as depCollisions,
  wentStale as depWentStale,
  supervisoryReport as depReport,
} from '../supabase/functions/mcp/_shared.js';

/**
 * THE DEPLOYED COPY MUST AGREE WITH THE ONE THE TESTS COVER.
 *
 * supabase/functions/mcp/_shared.js is a hand-maintained splice of the src/ and
 * bridge/ modules, because a Supabase Edge Function cannot import from outside
 * its own directory. Every test in this suite exercises the ORIGINALS. Nothing
 * exercised the copy, so the copy could drift from the thing that was proven
 * correct and the suite would stay green through it.
 *
 * That is not hypothetical. Twice in one sitting an edit landed in the source
 * and had to be applied to the splice by hand, and a botched escape in the copy
 * alone took six test files down -- the syntax error was the lucky case,
 * because it was loud. Silent divergence is the one that ships.
 *
 * These do not compare source text: the splice legitimately differs in imports
 * and ordering. They compare BEHAVIOUR on inputs that exercise the branches
 * most recently changed, which is what actually has to match.
 */

const NOW_MS = Date.parse('2026-09-15T18:00:00.000Z');
const NOW = new Date(NOW_MS).toISOString();
const ago = (ms) => new Date(NOW_MS - ms).toISOString();
const MIN = 60_000;

test('detectCollisions agrees on the dormant-vs-critical split', () => {
  const sessions = [
    { agentId: 'code-c', lane: 'agentbridge', worktree: 'C:/wt/c', capacity: 'idle',
      lastSeenAt: ago(5_000), locks: [], processes: [], processProbeOk: true, git: { ok: true } },
    { agentId: 'code-b', lane: 'agentbridge', worktree: 'C:/wt/b', capacity: 'idle',
      lastSeenAt: ago(110 * MIN), locks: [], processes: [], processProbeOk: true, git: { ok: true } },
    { agentId: 'probe-reader', lane: 'probe', worktree: 'C:/wt/p1', capacity: 'offline',
      lastSeenAt: ago(75 * MIN), locks: [], processes: [], processProbeOk: true, git: { ok: true } },
    { agentId: 'probe-reader2', lane: 'probe', worktree: 'C:/wt/p2', capacity: 'offline',
      lastSeenAt: ago(75 * MIN), locks: [], processes: [], processProbeOk: true, git: { ok: true } },
  ];
  const opts = { now: NOW_MS, staleAfterSeconds: 90 };

  assert.deepEqual(depCollisions(sessions, opts), srcCollisions(sessions, opts));
});

test('detectCollisions agrees when the collision IS live', () => {
  // The positive control travels too: a splice that only agreed about the quiet
  // cases would still hide a real critical.
  const live = (agentId, worktree) => ({
    agentId, lane: 'agentbridge', worktree, capacity: 'idle', lastSeenAt: ago(5_000),
    locks: [], processes: [], processProbeOk: true, git: { ok: true },
  });
  const sessions = [live('code-c', 'C:/wt/c'), live('code-b', 'C:/wt/b')];
  const opts = { now: NOW_MS, staleAfterSeconds: 90 };

  const out = srcCollisions(sessions, opts);
  assert.deepEqual(depCollisions(sessions, opts), out);
  assert.ok(out.findings.some((f) => f.code === 'duplicate-lane' && f.severity === 'critical'),
    'the fixture stopped producing the critical it exists to compare');
});

test('detectCollisions agrees on sessions whose liveness is UNKNOWN', () => {
  /*
   * Without this the gate was hollow, and proving it can fail is what exposed
   * that: a mutation narrowing `couldBeActing` to exclude 'unknown' changed the
   * deployed copy only, and every fixture above set capacity and lastSeenAt
   * explicitly, so nothing ever reached the branch. The comparison passed and
   * proved nothing about the branch most likely to diverge.
   *
   * Unknown liveness is also the direction the guard must never guess in, so it
   * is exactly the branch worth pinning across the splice.
   */
  const vague = (agentId, worktree) => ({
    agentId, lane: 'agentbridge', worktree,
    locks: [], processes: [], processProbeOk: true, git: { ok: true },
    // no capacity, no lastSeenAt: nothing is known about whether it is running
  });
  const sessions = [vague('code-c', 'C:/wt/c'), vague('code-b', 'C:/wt/b')];
  const opts = { now: NOW_MS, staleAfterSeconds: 90 };

  const out = srcCollisions(sessions, opts);
  assert.deepEqual(depCollisions(sessions, opts), out);
  assert.ok(out.findings.some((f) => f.code === 'duplicate-lane' && f.severity === 'critical'),
    'unknown liveness stopped counting as possibly-live, so the branch is untested again');
});

test('wentStale agrees, including on what it refuses to report', () => {
  const sessions = [
    { agent_id: 'code-b', session_id: 's-b', lane_id: 'agentbridge',
      capacity: 'idle', heartbeat_at: ago(110 * MIN), head_sha: 'a'.repeat(40) },
    { agent_id: 'code-c', session_id: 's-c', lane_id: 'agentbridge',
      capacity: 'idle', heartbeat_at: ago(30_000), head_sha: 'b'.repeat(40) },
    { agent_id: 'b6', session_id: 's-6', lane_id: 'integration',
      capacity: 'offline', heartbeat_at: ago(76 * MIN), head_sha: 'c'.repeat(40) },
    { agent_id: 'never', session_id: 's-n', lane_id: 'x', capacity: 'idle', heartbeat_at: null },
  ];

  const out = srcWentStale({ sessions, now: NOW });
  assert.deepEqual(depWentStale({ sessions, now: NOW }), out);
  assert.deepEqual(out.map((r) => r.agent_id), ['code-b'],
    'the fixture stopped exercising the offline and never-seen branches');
});

test('supervisoryReport agrees on shape and ordering', () => {
  const args = {
    proposals: [
      { kind: 'assign', task_id: 't1', would_be_accepted: true, prepared_at: NOW },
      { kind: 'review', task_id: 't2', prepared_at: NOW },
    ],
    idle: [{ agent_id: 'code-c', session_id: 's-c', lane_id: 'agentbridge' }],
    blocked: [{ task_id: 't3', reason: 'no idle live worker holds lane "review"' }],
    tasks: [{ task_id: 't1', state: 'runnable' }, { task_id: 't2', state: 'returned' }],
    sessions: [{ agent_id: 'code-d', session_id: 's-d', lane_id: 'agentbridge',
      capacity: 'idle', heartbeat_at: ago(172 * MIN), head_sha: 'd'.repeat(40) }],
    now: NOW,
  };

  const out = srcReport(args);
  assert.deepEqual(depReport(args), out);
  // Key order is part of the contract -- the report is read top-down.
  assert.deepEqual(Object.keys(depReport(args)), Object.keys(out));
  assert.equal(out.counts.workers_went_stale, 1,
    'the fixture stopped exercising the stale-worker path');
});
