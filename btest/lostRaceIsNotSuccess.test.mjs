import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  taskWriteFilter, writeLanded, TASK_WRITE_EXPECTS,
} from '../supabase/functions/mcp/_shared.js';

/**
 * A LOST RACE MUST NOT REPORT SUCCESS.
 *
 * Raised by code-d verifying Autonomous Runtime v1, and confirmed in the
 * deployed source: the coordinator's lifecycle writes read rows over HTTP,
 * decide in JavaScript, and PATCH with `task_id=eq.<id>` and nothing else. The
 * guard judges a snapshot from an earlier request; nothing revalidates at write
 * time. Two coordinators both read "runnable", both pass, both write.
 *
 * Structural rather than probabilistic -- the write carries NO predicate, so it
 * cannot refuse a stale decision under any interleaving. No demonstration is
 * needed for it to be real.
 *
 * THE SECOND HALF IS THE ONE THAT BITES. Adding the predicate makes PostgREST
 * answer a lost race with 200 and an EMPTY ARRAY. Every call site does
 * `const [row] = await patch(...)` and then returns `ok: true`. So with the
 * predicate and without this check, a lost race reports SUCCESS with an absent
 * task -- quieter than the bug it replaced, not safer.
 */

const SHA = 'a'.repeat(40);

// ── the predicate ──────────────────────────────────────────────────────────
test('the filter pins the row to the state the guard judged', () => {
  const f = taskWriteFilter('t1', ['runnable', 'returned']);
  assert.match(f, /task_id=eq\.t1/);
  assert.match(f, /state=in\.\(runnable,returned\)/,
    'without a state predicate the write cannot refuse a stale decision');
});

test('EVERY lifecycle write has an expectation, and none of them is "any state"', () => {
  /*
   * A write with no expectation is exactly the defect. If a future path is
   * added to this table with an empty list, the builder throws rather than
   * quietly degrading to the old behaviour.
   */
  assert.deepEqual(Object.keys(TASK_WRITE_EXPECTS).sort(),
    ['accept', 'assign', 'cancel', 'return']);

  for (const [name, states] of Object.entries(TASK_WRITE_EXPECTS)) {
    assert.ok(Array.isArray(states) && states.length > 0, `${name} has no expected state`);
    assert.equal(states.includes('accepted'), false, `${name} admits a terminal state`);
    assert.equal(states.includes('cancelled'), false, `${name} admits a terminal state`);
  }
});

test('the expectations match what the pure guards actually admit', () => {
  // assign admits returned work too -- a predicate of state=eq.runnable alone
  // would refuse legitimate re-assignment and look like a race that never was.
  assert.deepEqual(TASK_WRITE_EXPECTS.assign, ['runnable', 'returned']);
  assert.deepEqual(TASK_WRITE_EXPECTS.accept, ['returned']);
  assert.deepEqual(TASK_WRITE_EXPECTS.return, ['assigned']);
  assert.ok(TASK_WRITE_EXPECTS.cancel.includes('assigned'));
});

test('a write with no expectation THROWS rather than matching everything', () => {
  assert.throws(() => taskWriteFilter('t1', []), /at least one expected state/);
  assert.throws(() => taskWriteFilter('t1', undefined), /at least one expected state/);
  assert.throws(() => taskWriteFilter('', ['runnable']), /requires a task_id/);
});

test('state values are escaped even though they are not caller supplied today', () => {
  // The day one of these becomes a parameter is the day it matters, and that
  // day will not announce itself.
  assert.match(taskWriteFilter('a b', ['run nable']), /task_id=eq\.a%20b/);
  assert.match(taskWriteFilter('a b', ['run nable']), /state=in\.\(run%20nable\)/);
});

// ── THE HALF THAT MATTERS MORE ─────────────────────────────────────────────
test('AN EMPTY RESULT IS A REFUSAL, NOT A SUCCESS WITH AN ABSENT TASK', () => {
  /*
   * THE test. PostgREST answers a lost race with 200 and []. Treating that as
   * success is worse than having no predicate at all: the caller is told the
   * work was assigned, and nothing was written.
   */
  const r = writeLanded([], { task_id: 't1', expected: ['runnable', 'returned'] });

  assert.equal(r.ok, false, 'a lost race reported success');
  assert.equal(r.row, undefined);
  assert.match(r.errors.join(' '), /did not land/);
  assert.match(r.errors.join(' '), /runnable or returned/,
    'the refusal must name the state the row was expected to be in');
});

test('a row that is present is a success, and the row comes back', () => {
  const row = { task_id: 't1', state: 'assigned' };
  const r = writeLanded([row], { task_id: 't1', expected: ['runnable'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.row, row);
});

test('a null first element is a refusal, not a success carrying null', () => {
  // PostgREST will not do this, but `[undefined]` is what a mis-shaped parse
  // produces, and reporting ok:true with task:null is the same lie.
  assert.equal(writeLanded([null], { task_id: 't1', expected: ['runnable'] }).ok, false);
  assert.equal(writeLanded(undefined, { task_id: 't1', expected: ['runnable'] }).ok, false);
});

test('the refusal explains WHAT TO DO, not merely that it failed', () => {
  /*
   * A coordinator reading this has to decide between retrying and giving up.
   * "Somebody else moved it between the check and the write" says which, and
   * "re-read it and decide again" is the only correct response -- retrying the
   * same decision against a moved row is how the race becomes a loop.
   */
  const r = writeLanded([], { task_id: 't1', expected: ['returned'] });
  assert.match(r.errors.join(' '), /between the check and the write/);
  assert.match(r.errors.join(' '), /re-read it and decide again/);
});
