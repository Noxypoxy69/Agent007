import test from 'node:test';
import assert from 'node:assert/strict';
import {
  proposeWork, canConfirm, supervisoryReport,
  PROPOSAL_STALE_AFTER_MS, PROPOSAL_KINDS,
} from '../src/dispatch.mjs';

/**
 * SUPERVISED MEANS THE PROPOSAL IS NEVER A PERMISSION.
 *
 * The owner chose: the dispatcher prepares, the coordinator confirms. The way
 * that decision gets quietly reversed is not by someone changing their mind --
 * it is by confirmation trusting the verdict recorded at proposal time. Then
 * the dispatcher's judgment, formed against a world that has since moved,
 * becomes the authority, and "supervised" is "autonomous with an hour of lag".
 *
 * So canConfirm re-runs the guard against live rows and ignores the stored
 * verdict. These tests exist mainly to hold that line.
 */

const NOW = '2026-09-15T15:00:00.000Z';
const ago = (ms) => new Date(Date.parse(NOW) - ms).toISOString();

const alive = (s) => s?.capacity !== 'offline';

const task = (over = {}) => ({
  task_id: 't1', state: 'runnable', lane_id: 'agentbridge', repo_id: 'agentbridge',
  allowed_paths: [], depends_on: [], ...over,
});
const worker = (over = {}) => ({
  agent_id: 'code-b', session_id: 'danny-win-f1', lane_id: 'agentbridge',
  repo_id: 'agentbridge', capacity: 'idle', ...over,
});

const propose = (over = {}) => proposeWork({ now: NOW, isLive: alive, ...over });

// ── routing ────────────────────────────────────────────────────────────────
test('work is routed BY LANE, not by a fixed chain', () => {
  /*
   * A C -> B -> D -> A rotation was proposed. It describes today's roster
   * rather than a rule, and canAssign already refuses on lane mismatch, so most
   * hops in such a chain produce refusals instead of handoffs.
   */
  const { proposals } = propose({
    tasks: [task({ lane_id: 'review' })],
    sessions: [worker(), worker({ agent_id: 'code-d', session_id: 'd1', lane_id: 'review' })],
  });

  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].agent_id, 'code-d', 'the lane holder should have been chosen');
});

test('AMBIGUITY IS REPORTED, never broken by a tie-rule', () => {
  // Picking "the first" is a decision about who does the work, made by the
  // component explicitly told not to make those.
  const { proposals, blocked } = propose({
    tasks: [task()],
    sessions: [worker(), worker({ agent_id: 'code-c', session_id: 'danny-win-10' })],
  });

  assert.equal(proposals.length, 0);
  assert.equal(blocked.length, 1);
  assert.match(blocked[0].reason, /2 idle workers are eligible/);
  assert.deepEqual(blocked[0].candidates.sort(), ['code-b', 'code-c']);
});

test('a busy worker is not offered more work', () => {
  const { proposals, blocked } = propose({
    tasks: [task({ task_id: 'busy', state: 'assigned', assigned_session: 'danny-win-f1' }), task()],
    sessions: [worker()],
  });
  assert.equal(proposals.length, 0);
  assert.match(blocked[0].reason, /no idle live worker/);
});

test('an offline or stale worker is not a candidate', () => {
  assert.equal(propose({ tasks: [task()], sessions: [worker({ capacity: 'offline' })] }).proposals.length, 0);
  assert.equal(
    proposeWork({ tasks: [task()], sessions: [worker()], now: NOW, isLive: () => false }).proposals.length,
    0,
  );
});

test('liveness is INJECTED, never decided here', () => {
  // A dispatcher with its own opinion about who is alive is a second answer to
  // the question the registry exists to answer.
  assert.throws(() => proposeWork({ now: NOW }), /requires an isLive predicate/);
  assert.throws(() => proposeWork({ isLive: alive }), /requires a `now` timestamp/);
});

// ── returned work ──────────────────────────────────────────────────────────
test('RETURNED WORK IS A REVIEW, never a reassignment', () => {
  /*
   * Proposing that somebody else pick up returned work would quietly discard a
   * worker's finished contract. What it needs is a coordinator to look at the
   * commit.
   */
  const t = task({ state: 'returned', returned_by: 'danny-win-f1', returned_head_sha: 'a'.repeat(40) });
  const { proposals } = propose({ tasks: [t], sessions: [worker({ agent_id: 'code-c', session_id: 'x' })] });

  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].kind, 'review');
  assert.equal(proposals[0].agent_id, undefined, 'a review proposal must not name a new assignee');
  assert.equal(proposals[0].head_sha, 'a'.repeat(40));
  assert.equal(proposals[0].would_be_accepted, true);
});

test('the dispatcher forms no opinion on whether work is GOOD', () => {
  // It cannot read a diff. It reports that a return exists and what to look at.
  const t = task({ state: 'returned', returned_by: 's1', returned_head_sha: 'b'.repeat(40), returned_notes: 'tests green' });
  const [p] = propose({ tasks: [t] }).proposals;
  assert.equal(p.notes, 'tests green');
  assert.equal(p.quality, undefined);
  assert.equal(p.approved, undefined);
});

// ── the line that must not move ────────────────────────────────────────────
test('CONFIRMATION RE-RUNS THE GUARD AND IGNORES THE RECORDED VERDICT', () => {
  /*
   * THE test. A proposal that said "ok" when the worker was idle must not
   * confirm once that worker has taken other work -- otherwise the dispatcher's
   * stale judgment is the authority and supervision is theatre.
   */
  const stale = {
    kind: 'assign', task_id: 't1', agent_id: 'code-b', session_id: 'danny-win-f1',
    would_be_accepted: true, reasons: [], prepared_at: ago(60_000),
  };

  const t = task();
  const otherWork = task({ task_id: 't2', state: 'assigned', assigned_session: 'danny-win-f1' });

  // The recorded verdict says yes. Live state says the task is no longer
  // runnable.
  const r = canConfirm(stale, {
    task: task({ state: 'cancelled' }),
    worker: worker(),
    tasks: [t, otherWork],
    now: NOW,
    isLive: alive,
  });

  assert.equal(r.ok, false, 'a stale "ok" was trusted');
  assert.match(r.errors.join(' '), /only runnable or returned work can be assigned/);
});

test('a proposal for a worker that has since gone offline cannot be confirmed', () => {
  const p = {
    kind: 'assign', task_id: 't1', agent_id: 'code-b', session_id: 'danny-win-f1',
    would_be_accepted: true, prepared_at: ago(60_000),
  };
  const r = canConfirm(p, { task: task(), worker: null, tasks: [], now: NOW, isLive: alive });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /no live session now/);
});

test('a worker that RESTARTED is a different session, and is refused', () => {
  /*
   * Confirming onto a new runtime would be assigning to something nobody
   * proposed. The session is part of the proposal for the same reason it is
   * part of a return.
   */
  const p = {
    kind: 'assign', task_id: 't1', agent_id: 'code-b', session_id: 'danny-win-f1',
    would_be_accepted: true, prepared_at: ago(60_000),
  };
  const r = canConfirm(p, {
    task: task(), worker: worker({ session_id: 'danny-win-f2' }), tasks: [], now: NOW, isLive: alive,
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /now "danny-win-f2"/);
});

test('A PROPOSAL GOES STALE and must be re-prepared', () => {
  // An hour-old suggestion confirmed without a fresh look is the dispatcher
  // deciding late rather than the supervisor deciding now.
  const old = {
    kind: 'assign', task_id: 't1', agent_id: 'code-b', session_id: 'danny-win-f1',
    would_be_accepted: true, prepared_at: ago(PROPOSAL_STALE_AFTER_MS + 60_000),
  };
  const r = canConfirm(old, { task: task(), worker: worker(), tasks: [], now: NOW, isLive: alive });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /stale; re-prepare it/);

  const fresh = { ...old, prepared_at: ago(PROPOSAL_STALE_AFTER_MS - 60_000) };
  assert.equal(canConfirm(fresh, { task: task(), worker: worker(), tasks: [], now: NOW, isLive: alive }).ok, true);
});

test('an undateable or future-dated proposal is refused', () => {
  const base = {
    kind: 'assign', task_id: 't1', agent_id: 'code-b', session_id: 'danny-win-f1', would_be_accepted: true,
  };
  for (const prepared_at of [null, '', 'whenever']) {
    const r = canConfirm({ ...base, prepared_at }, { task: task(), worker: worker(), now: NOW, isLive: alive });
    assert.equal(r.ok, false, String(prepared_at));
    assert.match(r.errors.join(' '), /cannot be dated/);
  }
  const future = canConfirm({ ...base, prepared_at: '2027-01-01T00:00:00.000Z' },
    { task: task(), worker: worker(), now: NOW, isLive: alive });
  assert.equal(future.ok, false);
  assert.match(future.errors.join(' '), /dated in the future/);
});

test('confirming a review re-checks that the task is still returned', () => {
  const p = { kind: 'review', task_id: 't1', prepared_at: ago(60_000) };
  const returned = task({ state: 'returned', returned_by: 's1', returned_head_sha: 'c'.repeat(40) });
  assert.equal(canConfirm(p, { task: returned, now: NOW, isLive: alive }).ok, true);

  // Somebody accepted it in the meantime.
  const r = canConfirm(p, { task: task({ state: 'accepted' }), now: NOW, isLive: alive });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /already "accepted"/);
});

test('an unknown proposal kind confirms nothing', () => {
  assert.equal(canConfirm({ kind: 'deploy', task_id: 't1' }, { now: NOW }).ok, false);
  assert.equal(canConfirm(null, { now: NOW }).ok, false);
  assert.deepEqual(PROPOSAL_KINDS, ['assign', 'review']);
});

// ── the report ─────────────────────────────────────────────────────────────
test('the report leads with counts, then only what needs a decision', () => {
  const { proposals, idle, blocked } = propose({
    tasks: [
      task(),
      task({ task_id: 't2', state: 'returned', returned_by: 's1', returned_head_sha: 'd'.repeat(40) }),
      task({ task_id: 't3', state: 'accepted' }),
    ],
    sessions: [worker()],
  });

  const r = supervisoryReport({ proposals, idle, blocked, tasks: [task(), task({ state: 'accepted' })], now: NOW });

  assert.equal(r.at, NOW);
  assert.equal(r.counts.tasks.runnable, 1);
  assert.equal(r.counts.tasks.accepted, 1);
  assert.equal(r.awaiting_review.length, 1);
  // Nothing in the actionable sections is a status update.
  for (const key of ['awaiting_review', 'ready_to_assign', 'would_refuse', 'blocked']) {
    assert.ok(Array.isArray(r[key]), key);
  }
});

test('a would-refuse proposal is surfaced separately, not silently dropped', () => {
  /*
   * A proposal the guard would reject is the most interesting row in the
   * report: it means the dispatcher found work and something is stopping it.
   * Hiding it would make a stuck production line look like an idle one.
   */
  const t = task({ depends_on: ['nope'] });
  const { proposals } = propose({ tasks: [t], sessions: [worker()] });
  assert.equal(proposals[0].would_be_accepted, false);
  assert.match(proposals[0].reasons.join(' '), /does not exist/);

  const r = supervisoryReport({ proposals, now: NOW });
  assert.equal(r.would_refuse.length, 1);
  assert.equal(r.ready_to_assign.length, 0);
});

test('a quiet hour reads as quiet', () => {
  const r = supervisoryReport({ now: NOW });
  assert.deepEqual(r.counts, {
    proposals: 0, awaiting_review: 0, idle_workers: 0, blocked: 0, tasks: {},
  });
});
