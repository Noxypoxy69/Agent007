import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pathCollisions, baseFreshness, invalidatedBy, reviewerQueue, canReview,
  retryDecision, drainOutbox, RETRY_LIMIT, INVALIDATABLE,
} from '../src/runtime.mjs';
import { shouldActOnEvent } from '../src/leases.mjs';

/**
 * AUTONOMOUS RUNTIME v1 — the behaviours that must survive the process.
 *
 * The constraint is "execution must not depend on persistent chat sessions", so
 * every rule here has to be derivable from rows and a clock. These tests are
 * written as "the agent has just been killed and something else picked this up
 * cold" -- because that is the real operating condition, not the exception.
 */

const NOW = '2026-09-15T22:00:00.000Z';
const at = (off) => new Date(Date.parse(NOW) + off).toISOString();
const MIN = 60_000;
const TOKEN = '11111111-1111-4111-8111-111111111111';
const SHA = 'a'.repeat(40);

const task = (over = {}) => ({
  task_id: 't1', state: 'assigned', assigned_session: 'danny-win-f1',
  lease_token: TOKEN, lease_expires_at: at(10 * MIN),
  allowed_paths: [], shared_paths: [], depends_on: [], attempt: 1, ...over,
});

// ── path collisions ────────────────────────────────────────────────────────
test('two live tasks cannot hold the same path', () => {
  const mine = task({ task_id: 'mine', state: 'runnable', allowed_paths: ['src/a.mjs'] });
  const theirs = task({ task_id: 'theirs', allowed_paths: ['src/a.mjs'], assigned_session: 'danny-win-10' });

  const hits = pathCollisions(mine, [theirs], { now: NOW });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, 'src/a.mjs');
  assert.equal(hits[0].held_by_task, 'theirs');
  assert.equal(hits[0].held_by_session, 'danny-win-10');
});

test('a DEAD holder does not poison the path forever', () => {
  // Blocking on an expired lease would leave the pool permanently contaminated
  // by work whose worker died -- which happened three times in one day.
  const mine = task({ task_id: 'mine', state: 'runnable', allowed_paths: ['src/a.mjs'] });
  const dead = task({ task_id: 'dead', allowed_paths: ['src/a.mjs'], lease_expires_at: at(-MIN) });
  assert.deepEqual(pathCollisions(mine, [dead], { now: NOW }), []);
});

test('SHARED REQUIRES BOTH SIDES TO AGREE', () => {
  /*
   * One task unilaterally declaring a file shared would let it walk into
   * somebody else's exclusive contract, which is the collision this prevents
   * rather than an exemption from it.
   */
  const both = (p) => [
    task({ task_id: 'mine', state: 'runnable', allowed_paths: [p], shared_paths: [p] }),
    task({ task_id: 'theirs', allowed_paths: [p], shared_paths: [p] }),
  ];
  const [m, t] = both('README.md');
  assert.deepEqual(pathCollisions(m, [t], { now: NOW }), [], 'mutually shared paths still collided');

  const oneSided = task({ task_id: 'theirs', allowed_paths: ['README.md'], shared_paths: [] });
  assert.equal(pathCollisions(m, [oneSided], { now: NOW }).length, 1,
    'a one-sided shared declaration was honoured');
});

test('an unassigned task holds nothing', () => {
  const mine = task({ task_id: 'mine', state: 'runnable', allowed_paths: ['x'] });
  const queued = task({ task_id: 'q', state: 'runnable', allowed_paths: ['x'], lease_token: null });
  assert.deepEqual(pathCollisions(mine, [queued], { now: NOW }), []);
});

// ── stale base ─────────────────────────────────────────────────────────────
test('UNKNOWN IS NOT FRESH, and it is not stale either', () => {
  /*
   * A surface with no worktree cannot observe the tip. Reporting "fresh" from
   * ignorance is the confident-answer-from-nothing shape this project keeps
   * rediscovering; the caller must be made to decide.
   */
  assert.equal(baseFreshness(task({ base_sha: SHA }), {}).state, 'unknown');
  assert.equal(baseFreshness(task({ base_sha: null }), { tip: SHA }).state, 'unknown');
  assert.match(baseFreshness(task({ base_sha: SHA }), {}).reason, /tip was not observed/);
});

test('a base behind the tip is stale and says by how much', () => {
  const r = baseFreshness(task({ base_sha: 'b'.repeat(40) }), { tip: SHA });
  assert.equal(r.state, 'stale');
  assert.match(r.reason, /re-base before claiming/);

  assert.equal(baseFreshness(task({ base_sha: SHA }), { tip: SHA }).state, 'fresh');
});

// ── upstream invalidation ──────────────────────────────────────────────────
test('WORK RESTING ON A WITHDRAWN PREMISE IS INVALIDATED', () => {
  /*
   * The case a human catches and a runtime misses. Every other guard asks "may
   * this proceed now"; this one asks "did something I already allowed stop
   * being true". The downstream worker is building on a retraction and does not
   * know it.
   */
  const dep = task({ task_id: 'dep', state: 'cancelled' });
  const downstream = task({ task_id: 'down', depends_on: ['dep'] });

  const [hit] = invalidatedBy(dep, [downstream], { now: NOW });
  assert.ok(hit, 'downstream work survived its dependency being withdrawn');
  assert.equal(hit.task_id, 'down');
  assert.equal(hit.was_state, 'assigned');
  assert.equal(hit.holder_session, 'danny-win-f1', 'the live holder was not named');
  assert.match(hit.reason, /no longer accepted/);
});

test('a dependency going TO accepted invalidates nothing', () => {
  const dep = task({ task_id: 'dep', state: 'accepted' });
  assert.deepEqual(invalidatedBy(dep, [task({ task_id: 'down', depends_on: ['dep'] })], { now: NOW }), []);
});

test('ACCEPTED WORK IS NEVER INVALIDATED', () => {
  // Withdrawing it would rewrite a completed contract rather than stop an
  // outstanding one. If it truly rests on a withdrawn premise that is a NEW
  // task, not a retraction.
  const dep = task({ task_id: 'dep', state: 'cancelled' });
  const done = task({ task_id: 'down', state: 'accepted', depends_on: ['dep'] });
  assert.deepEqual(invalidatedBy(dep, [done], { now: NOW }), []);
  assert.equal(INVALIDATABLE.includes('accepted'), false);
  assert.equal(INVALIDATABLE.includes('cancelled'), false);
});

test('tasks that do not depend on the changed one are untouched', () => {
  const dep = task({ task_id: 'dep', state: 'cancelled' });
  const other = task({ task_id: 'other', depends_on: ['something-else'] });
  assert.deepEqual(invalidatedBy(dep, [other], { now: NOW }), []);
});

test('a dead holder is reported as no holder, not a stale name', () => {
  const dep = task({ task_id: 'dep', state: 'returned' });
  const down = task({ task_id: 'down', depends_on: ['dep'], lease_expires_at: at(-MIN) });
  assert.equal(invalidatedBy(dep, [down], { now: NOW })[0].holder_session, null);
});

// ── reviewer queue ─────────────────────────────────────────────────────────
test('REVIEWER DEATH PUTS THE WORK BACK IN THE QUEUE', () => {
  /*
   * If a review were not a lease, a reviewer that died would take the work out
   * of circulation silently -- the same failure as a worker dying, and one of
   * the behaviours this runtime is required to survive.
   */
  const rows = [
    task({ task_id: 'waiting', state: 'returned', returned_by: 's1', returned_head_sha: SHA }),
    task({
      task_id: 'live-review', state: 'returned', returned_by: 's1', returned_head_sha: SHA,
      reviewer: 'danny-win-10', review_lease_token: TOKEN, review_lease_expires_at: at(10 * MIN),
    }),
    task({
      task_id: 'dead-review', state: 'returned', returned_by: 's1', returned_head_sha: SHA,
      reviewer: 'danny-win-10', review_lease_token: TOKEN, review_lease_expires_at: at(-MIN),
    }),
  ];

  const q = reviewerQueue(rows, { now: NOW });
  const byId = Object.fromEntries(q.map((r) => [r.task_id, r]));

  assert.equal(byId.waiting.waiting, true);
  assert.equal(byId['dead-review'].waiting, true, 'a dead reviewer kept the work hostage');
  assert.equal(byId['dead-review'].reviewer, null, 'a dead reviewer was still named as the holder');
  assert.equal(byId['live-review'].waiting, false);
  assert.equal(byId['live-review'].reviewer, 'danny-win-10');

  // Waiting work sorts first: it is the part that needs somebody.
  assert.equal(q[q.length - 1].task_id, 'live-review');
});

test('only returned work is in the reviewer queue', () => {
  const rows = [task({ state: 'assigned' }), task({ task_id: 'x', state: 'accepted' })];
  assert.deepEqual(reviewerQueue(rows, { now: NOW }), []);
});

test('NOBODY REVIEWS THEIR OWN RETURN', () => {
  // One party on both sides of a review is not a review, it is a formality --
  // and it is the exact property the returned state exists to create.
  const t = task({ state: 'returned', returned_by: 'danny-win-f1', returned_head_sha: SHA });
  const own = canReview(t, { session_id: 'danny-win-f1' }, { now: NOW });
  assert.equal(own.ok, false);
  assert.match(own.errors.join(' '), /cannot review it/);

  assert.equal(canReview(t, { session_id: 'danny-win-10' }, { now: NOW }).ok, true);
});

test('a review already held by a live reviewer refuses a second one', () => {
  const t = task({
    state: 'returned', returned_by: 's1', returned_head_sha: SHA,
    reviewer: 'danny-win-10', review_lease_token: TOKEN, review_lease_expires_at: at(5 * MIN),
  });
  assert.match(canReview(t, { session_id: 'other' }, { now: NOW }).errors.join(' '), /already under review/);
  // The holder may resume its own review.
  assert.equal(canReview(t, { session_id: 'danny-win-10' }, { now: NOW }).ok, true);
});

test('unreturned work is not reviewable', () => {
  assert.equal(canReview(task({ state: 'assigned' }), { session_id: 's' }, { now: NOW }).ok, false);
});

// ── retry vs escalate ──────────────────────────────────────────────────────
test('A TASK THAT KILLS EVERY WORKER STOPS BEING RETRIED', () => {
  /*
   * Re-queueing is right once and wrong forever: a poisonous task would cycle
   * indefinitely, burning workers while the queue looks like it is making
   * progress. Escalation is an OUTCOME, not a failure to decide.
   */
  assert.equal(retryDecision(task({ attempt: 1 })).action, 'requeue');
  assert.equal(retryDecision(task({ attempt: RETRY_LIMIT - 1 })).action, 'requeue');

  const stop = retryDecision(task({ attempt: RETRY_LIMIT }));
  assert.equal(stop.action, 'escalate');
  assert.match(stop.reason, /unlikely to fare better/);
  assert.equal(stop.attempt, RETRY_LIMIT);
});

test('a missing attempt count is treated as zero, not as infinity', () => {
  assert.equal(retryDecision({ task_id: 't' }).action, 'requeue');
});

// ── outbox drain ───────────────────────────────────────────────────────────
const ev = (id, over = {}) => ({ event_id: id, kind: 'assigned', task_id: 't1', lease_token: TOKEN, ...over });

test('EVENTS APPLY IN event_id ORDER, not arrival order', () => {
  /*
   * A 'returned' processed before the 'assigned' that preceded it makes the
   * runtime draw the wrong conclusion from a correct log.
   */
  const rows = [task()];
  const out = drainOutbox([ev(9), ev(3), ev(7)], rows, { now: NOW, decide: shouldActOnEvent });
  assert.deepEqual(out.mark_delivered, [3, 7, 9]);
  assert.deepEqual(out.act.map((a) => a.event_id), [3, 7, 9]);
});

test('SKIPPED EVENTS ARE STILL MARKED DELIVERED', () => {
  /*
   * A superseded event left unmarked is re-read forever, and an outbox that
   * only grows is a queue that eventually stops draining. Not-acted-on is a
   * conclusion, so it gets recorded as one.
   */
  const movedOn = [task({ lease_token: '22222222-2222-4222-8222-222222222222' })];
  const out = drainOutbox([ev(1)], movedOn, { now: NOW, decide: shouldActOnEvent });

  assert.equal(out.act.length, 0);
  assert.equal(out.skip.length, 1);
  assert.deepEqual(out.mark_delivered, [1], 'a skipped event would have been re-read forever');
  assert.equal(out.skip[0].reason, 'superseded-claim');
});

test('an event whose task has vanished is skipped, not crashed on', () => {
  const out = drainOutbox([ev(1, { task_id: 'gone' })], [], { now: NOW, decide: shouldActOnEvent });
  assert.equal(out.skip[0].reason, 'task-is-gone');
  assert.deepEqual(out.mark_delivered, [1]);
});

test('the at-least-once rule is INJECTED, never re-implemented here', () => {
  // Two copies of that rule would eventually disagree, and the disagreement
  // would be silent.
  assert.throws(() => drainOutbox([], [], { now: NOW }), /requires a `decide` predicate/);
  assert.throws(() => drainOutbox([], [], { decide: shouldActOnEvent }), /requires a `now` timestamp/);
});

test('events without a usable id are dropped rather than ordered arbitrarily', () => {
  const out = drainOutbox([{ kind: 'assigned', task_id: 't1' }, ev(2)], [task()],
    { now: NOW, decide: shouldActOnEvent });
  assert.deepEqual(out.mark_delivered, [2]);
});
