import test from 'node:test';
import assert from 'node:assert/strict';

import { selectReviewable, NO_WORK } from '../src/reviewConsumer.mjs';

/**
 * THE FIXTURES ARE SHAPES THE SYSTEM REALLY PRODUCES, taken from the live rows
 * for t-wire-gate-scripts on 2026-09-17 rather than invented: a returned task
 * carries returned_by as a SESSION id (danny-win-d1, not code-d), a 40-hex
 * returned_head_sha, and reviewer/review_lease_expires_at that are both null
 * until claim_review writes them together.
 *
 * That matters because claim_review compares returned_by to the reviewer
 * SESSION. A fixture using agent ids would pass every test here and be refused
 * by the database on the first real call.
 */
const SHA_A = 'd8c1e0ee7db2f45156e03794949e0753fafb7362';
const SHA_B = '9ea3b3c573511b256861fb0955946420adc42263';
const ME = 'danny-win-a1';

const returnedTask = (over = {}) => ({
  task_id: 't-one',
  state: 'returned',
  returned_by: 'danny-win-d1',
  returned_at: '2026-09-17T01:12:04.734Z',
  returned_head_sha: SHA_A,
  reviewer: null,
  review_lease_expires_at: null,
  ...over,
});

const openProposal = (over = {}) => ({
  proposal_id: '40079032-1921-4659-99e2-13725363b5bb',
  kind: 'review',
  state: 'open',
  task_id: 't-one',
  prepared_at: '2026-09-17T03:20:00.855Z',
  ...over,
});

/* ── the positive, first, so every refusal below means something ───────── */

test('A RETURNED TASK FROM ANOTHER SESSION IS SELECTED', () => {
  const r = selectReviewable({ tasks: [returnedTask()], reviewerSession: ME });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.taskId, 't-one');
});

test('THE PROPOSAL ID IS CARRIED OUT, BECAUSE A FALLING RATE IS NOT EVIDENCE', () => {
  /*
   * The whole reason attribution is in the contract. On 2026-09-17 the supersede
   * rate went to zero because the task was ACCEPTED with reviewer null, not
   * because anything consumed it. A rate cannot tell those apart; a specific
   * proposal id that closed can.
   */
  const r = selectReviewable({
    tasks: [returnedTask()],
    proposals: [openProposal()],
    reviewerSession: ME,
  });
  assert.equal(r.proposalId, '40079032-1921-4659-99e2-13725363b5bb');
  assert.match(r.reason, /attributed to open proposal/);
});

test('A MISSING PROPOSAL DOES NOT BLOCK A REVIEW', () => {
  /*
   * The task row is the authority; the proposal is derived and the dispatcher
   * rewrites it every minute. Refusing real returned work because a derived row
   * is absent would let the queue drive the ledger.
   */
  const r = selectReviewable({ tasks: [returnedTask()], proposals: [], reviewerSession: ME });
  assert.equal(r.ok, true);
  assert.equal(r.proposalId, null);
  assert.match(r.reason, /does not\s+block the review/);
});

test('A SUPERSEDED PROPOSAL IS NOT ATTRIBUTION', () => {
  /* 740 of the 741 rows are superseded. Only an OPEN one names live work. */
  const r = selectReviewable({
    tasks: [returnedTask()],
    proposals: [openProposal({ state: 'superseded' })],
    reviewerSession: ME,
  });
  assert.equal(r.ok, true);
  assert.equal(r.proposalId, null, 'a superseded proposal was used as attribution');
});

/* ── the refusals, which are the point ─────────────────────────────────── */

test('NOTHING RETURNED IS NOT THE SAME EMPTY AS EVERYTHING-IS-MINE', () => {
  const idle = selectReviewable({ tasks: [], reviewerSession: ME });
  const stuck = selectReviewable({ tasks: [returnedTask({ returned_by: ME })], reviewerSession: ME });

  assert.equal(idle.ok, false);
  assert.equal(stuck.ok, false);
  assert.equal(idle.reason, NO_WORK.NONE_RETURNED);
  assert.equal(stuck.reason, NO_WORK.ALL_SELF);
  assert.notEqual(idle.reason, stuck.reason,
    'a stuck consumer and an idle one returned the same answer; the operator cannot tell '
    + 'that no other session is running');
});

test('SELF-REVIEW IS REFUSED ON THE SESSION, THE WAY claim_review COMPARES IT', () => {
  const r = selectReviewable({ tasks: [returnedTask({ returned_by: ME })], reviewerSession: ME });
  assert.equal(r.ok, false);
  assert.equal(r.reason, NO_WORK.ALL_SELF);
  assert.equal(r.counts.self, 1);
});

test('A LIVE LEASE HELD BY SOMEBODY ELSE BLOCKS; AN EXPIRED ONE DOES NOT', () => {
  const now = Date.parse('2026-09-17T05:00:00Z');
  const live = selectReviewable({
    tasks: [returnedTask({ reviewer: 'danny-win-c3', review_lease_expires_at: '2026-09-17T05:30:00Z' })],
    reviewerSession: ME, now,
  });
  assert.equal(live.ok, false);
  assert.equal(live.reason, NO_WORK.ALL_UNDER_REVIEW);

  /* The recovery path. An expired lease is claimable -- that is what expiry is for. */
  const expired = selectReviewable({
    tasks: [returnedTask({ reviewer: 'danny-win-c3', review_lease_expires_at: '2026-09-17T04:30:00Z' })],
    reviewerSession: ME, now,
  });
  assert.equal(expired.ok, true,
    'an expired review lease blocked a claim; work whose reviewer died would strand forever');
});

test('A RETURN THAT NAMES NO USABLE COMMIT IS NOT SELECTED', () => {
  for (const head of [null, '', 'd8c1e0e', 'not-a-sha', SHA_A.toUpperCase()]) {
    const r = selectReviewable({ tasks: [returnedTask({ returned_head_sha: head })], reviewerSession: ME });
    assert.equal(r.ok, false, `head ${JSON.stringify(head)} was selected`);
    assert.equal(r.reason, NO_WORK.ALL_UNREADABLE);
  }
});

test('ONLY returned WORK IS REVIEWABLE, MATCHING THE SQL', () => {
  for (const state of ['accepted', 'assigned', 'runnable', 'cancelled', 'blocked']) {
    const r = selectReviewable({ tasks: [returnedTask({ state })], reviewerSession: ME });
    assert.equal(r.reason, NO_WORK.NONE_RETURNED, `state ${state} was treated as reviewable`);
  }
});

/* ── ordering and mixtures ─────────────────────────────────────────────── */

test('THE OLDEST RETURN GOES FIRST, SO NOTHING STARVES', () => {
  const older = returnedTask({ task_id: 't-old', returned_at: '2026-09-17T01:00:00Z' });
  const newer = returnedTask({ task_id: 't-new', returned_at: '2026-09-17T04:00:00Z', returned_head_sha: SHA_B });
  assert.equal(selectReviewable({ tasks: [newer, older], reviewerSession: ME }).taskId, 't-old');
  assert.equal(selectReviewable({ tasks: [older, newer], reviewerSession: ME }).taskId, 't-old',
    'the result depended on input order rather than on returned_at');
});

test('ONE ELIGIBLE TASK AMONG INELIGIBLE ONES IS STILL FOUND', () => {
  const r = selectReviewable({
    tasks: [
      returnedTask({ task_id: 't-mine', returned_by: ME }),
      returnedTask({ task_id: 't-held', reviewer: 'danny-win-c3', review_lease_expires_at: '2999-01-01T00:00:00Z' }),
      returnedTask({ task_id: 't-good', returned_head_sha: SHA_B }),
    ],
    reviewerSession: ME,
  });
  assert.equal(r.ok, true);
  assert.equal(r.taskId, 't-good');
  assert.deepEqual({ self: r.counts.self, underReview: r.counts.underReview }, { self: 1, underReview: 1 });
});

test('A MIXTURE OF REFUSALS NAMES THE LARGEST CAUSE AND COUNTS ALL OF THEM', () => {
  const r = selectReviewable({
    tasks: [
      returnedTask({ task_id: 't-a', returned_by: ME }),
      returnedTask({ task_id: 't-b', returned_by: ME }),
      returnedTask({ task_id: 't-c', returned_head_sha: null }),
    ],
    reviewerSession: ME,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, NO_WORK.ALL_SELF, 'the dominant cause was not reported');
  assert.deepEqual(r.counts, { returned: 3, self: 2, underReview: 0, unreadable: 1 });
});

test('AN EMPTY REVIEWER SESSION THROWS RATHER THAN BEING REFUSED AT THE FAR END', () => {
  for (const s of [undefined, null, '', '   ']) {
    assert.throws(() => selectReviewable({ tasks: [returnedTask()], reviewerSession: s }),
      /reviewer session id is required/);
  }
});
