import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canReturn, returnRecord, canAccept, acceptRecord, canCancel, cancelRecord,
  ACCEPTABLE_FROM, TERMINAL,
} from '../src/coordination.mjs';

/**
 * ASSIGN → RETURN → ACCEPT, AND WHY THE MIDDLE STEP IS NOT THE COORDINATOR'S.
 *
 * assign_task shipped alone: the hosted plane could hand work out and had no
 * way to take it back. Reported from the other end as "I can send but I cannot
 * complete the loop", which was exactly right.
 *
 * The quickest fix would have been three coordinator tools -- assign, mark
 * returned, accept. That closes the loop on screen and proves nothing: the same
 * party writes the worker's evidence AND signs it off, which is one actor on
 * both sides of a review. The whole value of a `returned` state is that
 * somebody else put it there.
 *
 * So `return` belongs to the worker and is bound to the SESSION the task was
 * assigned to, and `accept` refuses anything that was not returned.
 */

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

const task = (over = {}) => ({
  task_id: 't1',
  state: 'assigned',
  assigned_agent: 'code-b',
  assigned_session: 'danny-win-f1',
  ...over,
});

const worker = (over = {}) => ({ agent_id: 'code-b', session_id: 'danny-win-f1', ...over });

// ── return ─────────────────────────────────────────────────────────────────
test('a worker returns its own assigned work', () => {
  const r = canReturn(task(), worker(), { headSha: SHA });
  assert.equal(r.ok, true, r.errors?.join('; '));

  const rec = returnRecord(task(), worker(), { headSha: SHA, notes: 'tests green', at: 'T' });
  assert.equal(rec.state, 'returned');
  assert.equal(rec.returned_by, 'danny-win-f1');
  assert.equal(rec.returned_head_sha, SHA);
  assert.equal(rec.returned_notes, 'tests green');
});

test('a worker CANNOT return work assigned to another session', () => {
  /*
   * The session is what this registry exists to tell apart. Matching on agent
   * alone would let any session claiming to be code-b return code-b's work --
   * and two sessions of one agent is the normal case here, not an exotic one.
   */
  const r = canReturn(task(), worker({ session_id: 'danny-win-10' }), { headSha: SHA });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /assigned to session "danny-win-f1"/);
});

test('a session reused under a NEW agent id does not inherit the assignment', () => {
  const r = canReturn(task(), worker({ agent_id: 'code-x' }), { headSha: SHA });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /assigned to agent "code-b"/);
});

test('only ASSIGNED work can be returned', () => {
  for (const state of ['runnable', 'returned', 'accepted', 'cancelled', 'blocked']) {
    const r = canReturn(task({ state }), worker(), { headSha: SHA });
    assert.equal(r.ok, false, `${state} should not be returnable`);
    assert.match(r.errors.join(' '), /only assigned work can be returned/);
  }
});

test('a return WITHOUT a commit is refused', () => {
  /*
   * "Done" with no sha is a claim nobody can check, and it is the shape every
   * unverifiable status update in this project has taken. The reviewer needs
   * something to look at.
   */
  assert.match(canReturn(task(), worker(), {}).errors.join(' '), /requires the head sha/);
  assert.match(canReturn(task(), worker(), { headSha: '   ' }).errors.join(' '), /requires the head sha/);
  assert.match(canReturn(task(), worker(), { headSha: 'abc123' }).errors.join(' '),
    /full 40-character sha/);
});

test('a return needs a resolved worker, not a name', () => {
  assert.match(canReturn(task(), null, { headSha: SHA }).errors.join(' '), /registered session/);
  assert.match(canReturn(task(), { agent_id: 'code-b' }, { headSha: SHA }).errors.join(' '),
    /registered session/);
});

// ── accept ─────────────────────────────────────────────────────────────────
test('accept refuses anything that was never RETURNED', () => {
  // The one that matters. Accepting straight from `assigned` signs off work
  // nobody handed in.
  for (const state of ['assigned', 'runnable', 'blocked']) {
    const r = canAccept(task({ state }), { at: 'T' });
    assert.equal(r.ok, false, `${state} must not be acceptable`);
    assert.match(r.errors.join(' '), /only returned work can be accepted/);
  }
  assert.deepEqual(ACCEPTABLE_FROM, ['returned']);
});

test('accept succeeds on returned work and pins the sha FROM THE RETURN', () => {
  const t = task({ state: 'returned', returned_head_sha: SHA, returned_by: 'danny-win-f1' });
  assert.equal(canAccept(t, { at: 'T', by: 'chatgpt-work coordinator' }).ok, true);

  const rec = acceptRecord(t, { by: 'chatgpt-work coordinator', at: 'T' });
  assert.equal(rec.state, 'accepted');
  assert.equal(rec.accepted_by, 'chatgpt-work coordinator');
  assert.equal(rec.accepted_head_sha, SHA,
    'the accepted sha must come from the return, not be re-read at accept time');
  assert.notEqual(rec.accepted_head_sha, OTHER);
});

test('a return with no sha cannot be accepted either', () => {
  // Belt and braces: canReturn refuses to create one, and canAccept refuses to
  // act on one that exists anyway — a row written before this guard, say.
  const r = canAccept(task({ state: 'returned' }), { at: 'T' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /nothing to accept/);
});

test('terminal states are terminal', () => {
  for (const state of TERMINAL) {
    assert.match(canAccept(task({ state }), { at: 'T' }).errors.join(' '), /already "/);
    assert.match(canCancel(task({ state }), { reason: 'x' }).errors.join(' '), /already "/);
  }
  assert.deepEqual(TERMINAL, ['accepted', 'cancelled']);
});

/*
 * NOBODY ACCEPTS THEIR OWN RETURN, AND THE ACCEPTER MUST BE NAMED.
 *
 * Written against a real row, not a hypothetical. On 2026-09-17 t-wire-gate-scripts
 * went to `accepted` with reviewer NULL and review_lease_token NULL, because
 * accept_task PATCHes the row directly and never passes through submit_review --
 * the only path that holds a review lease. The self-review bar in SQL
 * (claim_review, migration 20260915220223, "reason: self-review") guards a door
 * that path never opens.
 *
 * The deeper defect was the SIGNATURE: canAccept(task, { at }) never received the
 * accepter at all, so it was structurally incapable of refusing a self-accept
 * however carefully anyone called it. That case did not fire on 2026-09-17 --
 * code-d returned, c8 accepted -- but it was available to every caller.
 *
 * ABSENT IS NOT INNOCENT. An unnamed accepter is refused rather than waved
 * through: an optional identity check is one that silently does not run, which is
 * the hollow-gate shape this repository keeps paying for.
 */
test('accept refuses the session that returned the work', () => {
  const t = task({ state: 'returned', returned_head_sha: SHA, returned_by: 'danny-win-d1' });

  const self = canAccept(t, { at: 'T', by: 'danny-win-d1' });
  assert.equal(self.ok, false, 'a session must not accept its own return');
  assert.match(self.errors.join(' '), /returned this work/);

  // A genuine second party still passes. A gate that only refuses is an outage.
  assert.equal(canAccept(t, { at: 'T', by: 'danny-win-main' }).ok, true);
});

test('accept refuses when the accepter is not named at all', () => {
  const t = task({ state: 'returned', returned_head_sha: SHA, returned_by: 'danny-win-d1' });
  const r = canAccept(t, { at: 'T' });
  assert.equal(r.ok, false, 'an unnamed accepter is unknown, not nobody');
  assert.match(r.errors.join(' '), /not identified/);
});

test('accept requires a timestamp', () => {
  const t = task({ state: 'returned', returned_head_sha: SHA });
  assert.match(canAccept(t, {}).errors.join(' '), /timestamp is required/);
});

// ── cancel ─────────────────────────────────────────────────────────────────
test('cancelling requires a reason', () => {
  // A task that vanishes without one is indistinguishable from a bug.
  assert.match(canCancel(task(), {}).errors.join(' '), /reason is required/);
  assert.equal(canCancel(task(), { reason: 'superseded by d-x' }).ok, true);

  const rec = cancelRecord(task(), { by: 'coord', at: 'T', reason: 'superseded by d-x' });
  assert.equal(rec.state, 'cancelled');
  assert.equal(rec.cancelled_reason, 'superseded by d-x');
});

test('accepted work cannot be cancelled', () => {
  // That would erase a completed contract rather than withdraw an outstanding
  // one. Supersede it instead.
  const r = canCancel(task({ state: 'accepted' }), { reason: 'changed my mind' });
  assert.equal(r.ok, false);
});

// ── the loop, end to end ───────────────────────────────────────────────────
test('THE LOOP: assigned -> returned -> accepted, and no step can be skipped', () => {
  let t = task();

  // Cannot accept yet.
  assert.equal(canAccept(t, { at: 'T1', by: 'coord' }).ok, false);

  // The worker returns.
  assert.equal(canReturn(t, worker(), { headSha: SHA }).ok, true);
  t = { ...t, ...returnRecord(t, worker(), { headSha: SHA, at: 'T1' }) };
  assert.equal(t.state, 'returned');

  // Now the coordinator may accept, and cannot return it again.
  assert.equal(canReturn(t, worker(), { headSha: SHA }).ok, false);

  // ...but NOT the worker that just returned it. The loop has two parties in it
  // or it has none, and this is the step the accept_task door skipped entirely.
  assert.equal(canAccept(t, { at: 'T2', by: t.returned_by }).ok, false,
    'the returning session must not be able to close its own loop');

  assert.equal(canAccept(t, { at: 'T2', by: 'coord' }).ok, true);
  t = { ...t, ...acceptRecord(t, { by: 'coord', at: 'T2' }) };

  // And it is finished.
  assert.equal(t.state, 'accepted');
  assert.equal(t.accepted_head_sha, SHA);
  assert.equal(canAccept(t, { at: 'T3', by: 'coord' }).ok, false);
  assert.equal(canCancel(t, { reason: 'no' }).ok, false);
});
