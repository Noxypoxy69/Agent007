/**
 * A TERMINAL WRITE MUST PIN THE ROW IT JUDGED, NOT JUST ITS STATE.
 *
 * REPRODUCED AT THE DATABASE, 2026-09-19, before this existed:
 *
 *   a task returned by ATTEMPT 8 with commit bbbb…
 *   a coordinator that had judged ATTEMPT 7
 *   UPDATE … WHERE task_id = … AND state IN ('returned')
 *   → rows_changed: 1
 *
 * The reviewer accepted a commit it had never seen, and every surface reported
 * success. State could not catch it because the row was legitimately back in
 * the same state — returned → reassigned → returned again is an ordinary
 * lifecycle, and the second `returned` is indistinguishable from the first by
 * state alone.
 *
 * With the attempt pinned, the same two updates give 0 and 1 respectively.
 * That is the property these tests hold at the layer the suite can reach:
 * `claim_task` and `return_with_lease` already fence through their own SQL
 * parameters, and these two paths went through PostgREST instead.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { taskWriteFilter, TASK_WRITE_EXPECTS } from '../supabase/functions/mcp/_shared.js';

const ID = 't-fence';

test('THE POSITIVE FIRST: a fenced filter still selects the row it judged', () => {
  /*
   * Rule 5. Every refusal below is satisfied by a function that throws on
   * everything, which would take accept and cancel out of service entirely.
   */
  const f = taskWriteFilter(ID, TASK_WRITE_EXPECTS.accept, { attempt: 8 });
  assert.match(f, /task_id=eq\.t-fence/, 'the task id is not pinned');
  assert.match(f, /state=in\.\(returned\)/, 'the expected state is not pinned');
  assert.match(f, /attempt=eq\.8/, 'the attempt is not pinned — this is the whole fix');
});

test('A FENCE IS REQUIRED, because an optional one is the one everybody forgets', () => {
  /*
   * The same judgement the expected-state list already makes: defaulting to
   * "any attempt" would reintroduce the hole quietly, and quietly is how it
   * survived in the first place. A future call site that omits the fence gets
   * a TypeError at the call, not a silent stale write in production.
   */
  for (const bad of [undefined, null, {}, { attempt: null }, { attempt: '8' },
    { attempt: 8.5 }, { attempt: NaN }, { lease_token: 'x' }, 'fence', 42]) {
    assert.throws(
      () => taskWriteFilter(ID, TASK_WRITE_EXPECTS.accept, bad),
      /fence with the integer attempt/,
      `fence ${JSON.stringify(bad)} was accepted`,
    );
  }
  // attempt 0 is legal — a task that has never been claimed.
  assert.match(taskWriteFilter(ID, TASK_WRITE_EXPECTS.cancel, { attempt: 0 }), /attempt=eq\.0/,
    'attempt 0 was rejected, but an unclaimed task legitimately has it');
});

test('lease_token AND assigned_session ARE PINNED WHEN PRESENT, not demanded', () => {
  /*
   * A returned task holds neither — the lease is released on return — so
   * demanding them would make accept impossible. Ignoring them when they DO
   * exist would waste a fence already in hand.
   */
  const bare = taskWriteFilter(ID, TASK_WRITE_EXPECTS.cancel, { attempt: 3 });
  assert.ok(!bare.includes('lease_token'), 'a null lease was pinned, which no returned task can satisfy');
  assert.ok(!bare.includes('assigned_session'), 'an absent session was pinned');

  const full = taskWriteFilter(ID, TASK_WRITE_EXPECTS.cancel, {
    attempt: 3, lease_token: '11111111-2222-3333-4444-555555555555', assigned_session: 'danny-win-b1',
  });
  assert.match(full, /lease_token=eq\.11111111-2222-3333-4444-555555555555/, 'a live lease was not pinned');
  assert.match(full, /assigned_session=eq\.danny-win-b1/, 'the holding session was not pinned');

  for (const empty of [null, undefined, '', '   ']) {
    const f = taskWriteFilter(ID, TASK_WRITE_EXPECTS.cancel, { attempt: 3, lease_token: empty });
    assert.ok(!f.includes('lease_token'), `lease_token ${JSON.stringify(empty)} produced a predicate`);
  }
});

test('TWO ATTEMPTS PRODUCE DIFFERENT PREDICATES — the discrimination itself', () => {
  /*
   * The defect in one assertion: if attempt 7 and attempt 8 build the same
   * filter, the stale write lands. This is what the database probe measured as
   * 0 rows versus 1.
   */
  const judged7 = taskWriteFilter(ID, TASK_WRITE_EXPECTS.accept, { attempt: 7 });
  const judged8 = taskWriteFilter(ID, TASK_WRITE_EXPECTS.accept, { attempt: 8 });
  assert.notEqual(judged7, judged8,
    'a write judged against attempt 7 builds the same predicate as one judged against 8');
});

test('EVERY VALUE IS ESCAPED, including the ones that are not caller-supplied today', () => {
  /*
   * The states come from a frozen table and the attempt is an integer, so none
   * of this is reachable now. The day one becomes a parameter is the day it
   * matters, and that day will not announce itself — the same reasoning the
   * original function already applied to the state list.
   */
  const f = taskWriteFilter('t&evil=1', TASK_WRITE_EXPECTS.cancel, {
    attempt: 1, assigned_session: 'sess&limit=1',
  });
  assert.ok(!f.includes('t&evil=1'), 'an injected task id survived into the predicate');
  assert.ok(!f.includes('sess&limit=1'), 'an injected session survived into the predicate');
  assert.match(f, /t%26evil%3D1/, 'the task id was not percent-encoded');
});

test('THE ORIGINAL GUARANTEES SURVIVE: id and state are still required', () => {
  assert.throws(() => taskWriteFilter('', TASK_WRITE_EXPECTS.accept, { attempt: 1 }),
    /requires a task_id/, 'an empty task id was accepted');
  assert.throws(() => taskWriteFilter(ID, [], { attempt: 1 }),
    /at least one expected state/, 'an empty expected-state list was accepted');
  assert.throws(() => taskWriteFilter(ID, undefined, { attempt: 1 }),
    /at least one expected state/, 'a missing expected-state list was accepted');
});

test('THE CONTROL: this gate can actually fail', () => {
  /*
   * Rule 1. If the matcher were inert, every assertion above would pass for a
   * function that returned a constant.
   */
  const a = taskWriteFilter(ID, TASK_WRITE_EXPECTS.accept, { attempt: 1 });
  const b = taskWriteFilter(ID, TASK_WRITE_EXPECTS.cancel, { attempt: 1 });
  assert.notEqual(a, b, 'the expected-state list no longer affects the predicate');
  assert.ok(/attempt=eq\.1/.test(a) && !/attempt=eq\.2/.test(a), 'the attempt matcher is inert');
});
