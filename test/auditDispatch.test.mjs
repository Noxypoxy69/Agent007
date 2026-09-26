/**
 * AUTONOMOUS AUDIT CONSUMPTION: THE EIGHT-STEP CHAIN, END TO END.
 *
 * P0 item 2 exit criteria, Danny 2026-09-20, verbatim:
 *
 *   1. PENDING audit exists.        5. Reviewer dies.
 *   2. Eligible live reviewer.      6. Lease expires.
 *   3. Dispatcher claims, no user.  7. Job becomes claimable.
 *   4. Reviewer starts.             8. Second reviewer receives it automatically.
 *
 * "No manually started audit-daemon, no author selecting its own audit, no
 * Danny routing." The measured state that prompted it: 25 PENDING, 8 CLAIMED
 * by a daemon that was not running.
 *
 * THE LAST TEST IS THE ONE THAT MATTERS. Each step proven separately is the
 * shape that let the 8 strand in the first place -- every piece worked and
 * nothing walked the whole path. So the final test runs all eight in sequence
 * against the REAL claimJob, not a mock of it: a selector that proposes a
 * pairing claimJob would refuse is worse than no selector, because the job
 * then looks undispatchable while a legal seat sits idle.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  proposeAudit, isClaimable, UNPLACED, MAX_REVIEW_ATTEMPTS,
} from '../src/auditDispatch.mjs';
import { claimJob, CLAIM_LEASE_MS, JOB, AUTHOR_UNAVAILABLE } from '../src/auditJob.mjs';
import { nextAttempt } from '../src/daemonArgs.mjs';
import { nextAction, describeValue } from '../src/auditLoop.mjs';
import { constants as bufferConstants } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { stripComments } from '../src/moduleGraph.mjs';
import { spawnSync } from 'node:child_process';

const T0 = 1_000_000;
const SHA = 'a'.repeat(40);

const job = (over = {}) => ({
  audit_id: 'audit-1',
  candidate_sha: SHA,
  candidate_tree_sha: '1'.repeat(40),
  touched: ['src/guardSession.mjs'],
  state: JOB.PENDING,
  claimed_by: null,
  claimed_at: null,
  first_seen_at: '2026-09-20T00:00:00Z',
  ...over,
});

const seat = (id, over = {}) => ({
  session_id: id, agent_id: id, capacity: 'idle', ...over,
});

/** The roster's own predicate, injected exactly as proposeWork takes it. */
const allLive = () => true;
const noneLive = () => false;

test('A LIVE SEAT AND A PENDING JOB PRODUCE A PAIRING, with no user action', () => {
  const r = proposeAudit({
    jobs: [job()], sessions: [seat('reviewer-one')], now: T0, isLive: allLive,
  });
  assert.equal(r.proposals.length, 1, `nothing was proposed: ${JSON.stringify(r.unassigned)}`);
  assert.equal(r.proposals[0].audit_id, 'audit-1');
  assert.equal(r.proposals[0].session_id, 'reviewer-one');
  assert.equal(r.proposals[0].recovered, false);
  assert.equal(r.unassigned.length, 0);
});

test('NO LIVE SEAT IS A QUEUE WAITING, NOT A FAILURE', () => {
  /*
   * The distinction that made the 8 stranded jobs invisible for a day: a dead
   * consumer and a working one produced identical evidence. "Nobody was
   * available" and "the review failed" must never be the same record.
   */
  const r = proposeAudit({
    jobs: [job()], sessions: [seat('x')], now: T0, isLive: noneLive,
  });
  assert.equal(r.proposals.length, 0);
  assert.equal(r.unassigned.length, 1);
  assert.equal(r.unassigned[0].code, UNPLACED.NO_LIVE_SEAT);
  assert.match(r.unassigned[0].why, /not a failure/);

  /* and the job is untouched -- no state was invented for it. */
  assert.equal(r.seats.length, 0);
});

test('AN OFFLINE SEAT IS NOT A SEAT, even when isLive says yes', () => {
  /*
   * Both conditions, because they answer different questions: isLive is "has
   * it checked in", capacity is "is it accepting work". proposeWork requires
   * both and so does this -- a seat that heartbeats while shutting down would
   * otherwise be handed an audit nobody runs.
   */
  const r = proposeAudit({
    jobs: [job()], sessions: [seat('x', { capacity: 'offline' })], now: T0, isLive: allLive,
  });
  assert.equal(r.proposals.length, 0, 'an offline seat was handed an audit');
  assert.equal(r.unassigned[0].code, UNPLACED.NO_LIVE_SEAT);
});

test('THE AUTHOR IS NOT OFFERED ITS OWN CANDIDATE, and the job says why', () => {
  /*
   * Rule 11 in the comment on the module says why this is not redundant with
   * claimJob: without it the dispatcher proposes an illegal pairing, claimJob
   * refuses, and the job reads as UNDISPATCHABLE instead of "needs a
   * different seat". Same refusal, completely different outcome.
   */
  const r = proposeAudit({
    jobs: [job({ author_session: 'session_AUTHOR' })],
    sessions: [seat('session_AUTHOR')],
    now: T0,
    isLive: allLive,
  });
  assert.equal(r.proposals.length, 0, 'the author was offered its own candidate');
  assert.equal(r.unassigned[0].code, UNPLACED.ONLY_AUTHOR_AVAILABLE);

  /* THE POSITIVE BESIDE IT (rule 5): add one non-author seat and it places. */
  const withOther = proposeAudit({
    jobs: [job({ author_session: 'session_AUTHOR' })],
    sessions: [seat('session_AUTHOR'), seat('session_OTHER')],
    now: T0,
    isLive: allLive,
  });
  assert.equal(withOther.proposals.length, 1,
    'nothing was placed even with an eligible seat present, so the refusal above '
    + 'proves only that the dispatcher refuses everything');
  assert.equal(withOther.proposals[0].session_id, 'session_OTHER');
});

test('AN UNKNOWN AUTHOR FAILS CLOSED, and the branch is watched firing', () => {
  /*
   * Sixth-lap blind audit D-B: the fail-closed branch shipped with NO test.
   * No fixture anywhere constructed `author_source: 'unavailable'` and
   * handed it to proposeAudit, so deleting the whole block left the suite
   * green -- rule 1 unmet, in the same range whose sibling commit added
   * dependency injection specifically so a branch could be watched firing.
   *
   * `unavailable` means nobody established who wrote the candidate. Rule 20
   * cannot be enforced against an author you cannot name, so dispatching
   * anyway and recording the result as independent is the laundering rule
   * 20 exists to prevent.
   */
  const r = proposeAudit({
    jobs: [job({ author_source: AUTHOR_UNAVAILABLE })],
    sessions: [seat('reviewer-one'), seat('reviewer-two')],
    now: T0,
    isLive: allLive,
  });
  assert.equal(r.proposals.length, 0,
    'a candidate whose author could not be established was dispatched anyway');
  assert.equal(r.unassigned[0].code, UNPLACED.AUTHOR_UNKNOWN);

  /*
   * AND A MEASURED ABSENCE STILL DISPATCHES (rule 5). If both collapsed to
   * a refusal, every commit without a Claude-Session trailer would be
   * permanently unauditable -- an outage dressed as rigour.
   */
  const measured = proposeAudit({
    jobs: [job({ author_source: null, author_session: null })],
    sessions: [seat('reviewer-one')],
    now: T0,
    isLive: allLive,
  });
  assert.equal(measured.proposals.length, 1,
    `a commit with no trailer became unauditable: ${JSON.stringify(measured.unassigned)}`);
});

test('A SEAT HOLDING A LIVE CLAIM IS BUSY, and that is read from the QUEUE', () => {
  /*
   * Derived from the queue, never from what the seat reports about itself: a
   * reviewer claiming to be idle while holding a claim would be handed a
   * second audit and abandon the first.
   */
  const held = job({ audit_id: 'audit-held', state: JOB.CLAIMED, claimed_by: 'one', claimed_at: T0 });
  const r = proposeAudit({
    jobs: [held, job({ audit_id: 'audit-new' })],
    sessions: [seat('one', { capacity: 'idle' })],
    now: T0 + 1000,
    isLive: allLive,
  });
  assert.equal(r.proposals.length, 0, 'a seat holding a live claim was given a second audit');
  assert.equal(r.unassigned[0].code, UNPLACED.ALL_SEATS_BUSY);
});

test('ESCAPED OUTRANKS LOCAL, and the order is TOTAL so two runs agree', () => {
  const jobs = [
    job({ audit_id: 'b-local', escaped: false, first_seen_at: '2026-09-19T00:00:00Z' }),
    job({ audit_id: 'a-escaped', escaped: true, first_seen_at: '2026-09-20T00:00:00Z' }),
  ];
  const once = proposeAudit({ jobs, sessions: [seat('r')], now: T0, isLive: allLive });
  assert.equal(once.proposals[0].audit_id, 'a-escaped',
    'a local candidate outranked a pushed one, which has already left the machine');

  /* Reversed input, same verdict: the comparator is total, not input-order luck. */
  const twice = proposeAudit({
    jobs: [...jobs].reverse(), sessions: [seat('r')], now: T0, isLive: allLive,
  });
  assert.equal(twice.proposals[0].audit_id, once.proposals[0].audit_id,
    'the pairing depends on the order the queue happened to arrive in');
});

test('A STRING `now` IS REFUSED, because it would make every lease immortal', () => {
  /*
   * proposeWork takes an ISO string; this takes epoch ms. The mismatch is
   * real and the failure it would cause is silent: '2026-..' - 1000 is NaN,
   * every `> leaseMs` is false, nothing ever expires. That is the permanent
   * tombstone arriving as a type confusion.
   */
  assert.throws(() => proposeAudit({
    jobs: [job()], sessions: [seat('r')], now: '2026-09-20T00:00:00Z', isLive: allLive,
  }), /epoch milliseconds/);

  assert.throws(() => proposeAudit({ jobs: [job()], sessions: [], now: T0 }),
    /isLive/, 'a missing liveness predicate was defaulted instead of refused');
});

test('isClaimable REFUSES A NON-NUMERIC CLOCK, or every lease is immortal (H-1)', () => {
  /*
   * `proposeAudit` has always thrown on a string `now`, and the test two
   * below this one -- "A STRING `now` IS REFUSED, because it would make
   * every lease immortal" -- has always passed. `isClaimable` is exported
   * separately with no such guard, and the one call site that bypasses
   * `proposeAudit` passed `new Date().toISOString()`.
   *
   * A string minus a number is NaN, every `NaN > leaseMs` is false, so
   * every claim with a well-formed `claimed_at` read as un-expired for
   * ever. The supervised loop computed queueDepth from that, saw 0, and
   * reported "the queue is drained" over a backlog it exists to recover.
   *
   * The mechanism was known, documented and covered at one entry point
   * and not the other. Generated from the shapes a caller could plausibly
   * hold -- an ISO string is the one that actually happened.
   */
  const claimed = job({ state: JOB.CLAIMED, claimed_at: T0 });

  for (const bad of [new Date(T0).toISOString(), '1700000000000', null, undefined, NaN, {}, []]) {
    assert.throws(
      () => isClaimable(claimed, { now: bad }),
      /epoch milliseconds/,
      `now=${JSON.stringify(bad)} was accepted; every lease is immortal under it`,
    );
  }

  /* THE POSITIVE (rule 5): a real clock still decides both ways, so the
   * throw above is a guard and not an off switch. */
  assert.equal(isClaimable(claimed, { now: T0 + 1 }), false);
  assert.equal(isClaimable(claimed, { now: T0 + CLAIM_LEASE_MS + 1 }), true);

  /* AND THE BAD CLOCK IS NOT REACHED for rows that never had a claim --
   * those short-circuit above, and must keep working. */
  assert.equal(isClaimable(job(), { now: 'nonsense' }), true,
    'a PENDING row started throwing; the guard was placed too early');
});

test('isClaimable: PENDING yes, live claim no, expired yes, terminal never', () => {
  assert.equal(isClaimable(job(), { now: T0 }), true);
  assert.equal(isClaimable(job({ state: JOB.CLAIMED, claimed_at: T0 }), { now: T0 + 1 }), false);
  assert.equal(
    isClaimable(job({ state: JOB.CLAIMED, claimed_at: T0 }), { now: T0 + CLAIM_LEASE_MS + 1 }),
    true,
  );
  assert.equal(isClaimable(job({ state: JOB.CLAIMED, claimed_at: null }), { now: T0 }), true,
    'a claim with no timestamp is immortal, which is the 8 stranded jobs');

  for (const state of [JOB.COMPLETED_PASS, JOB.COMPLETED_FAIL]) {
    assert.equal(isClaimable(job({ state }), { now: T0 + 1e9 }), false,
      `${state} was re-offered; a recorded verdict is not re-openable`);
  }
});

test('THE WHOLE CHAIN: eight steps, against the REAL claimJob', () => {
  /*
   * Each step proven separately is exactly the shape that let 8 jobs strand:
   * every piece worked, nothing walked the path. Nothing is mocked here --
   * the selector proposes and claimJob disposes, so a pairing the selector
   * invents but claimJob refuses fails this test rather than production.
   */
  const AUTHOR = 'session_AUTHOR';
  let queue = [job({ author_session: AUTHOR })];
  const roster = [seat(AUTHOR), seat('reviewer-one'), seat('reviewer-two')];

  // 1 + 2: a durable PENDING job, and live seats.
  assert.equal(queue[0].state, JOB.PENDING);

  // 3: the dispatcher selects a pair with no user action.
  const first = proposeAudit({ jobs: queue, sessions: roster, now: T0, isLive: allLive });
  assert.equal(first.proposals.length, 1, `nothing dispatched: ${JSON.stringify(first.unassigned)}`);
  const pick = first.proposals[0];
  assert.notEqual(pick.session_id, AUTHOR, 'the dispatcher routed the candidate to its author');

  // 4: the reviewer starts -- the claim goes through the real authority.
  const claimed = claimJob(queue[0], {
    by: pick.session_id, authorSession: AUTHOR, now: T0,
  });
  assert.equal(claimed.ok, true,
    `the dispatcher proposed a pairing claimJob refuses: ${claimed.why}. A selector that `
    + 'does that makes a job look undispatchable while a legal seat sits idle');
  queue = [claimed.job];
  assert.equal(queue[0].state, JOB.CLAIMED);
  assert.equal(queue[0].satisfies_gate, false,
    'a freshly claimed audit already claims to satisfy a gate, before P0-5 exists');

  // 5 + 6: the reviewer dies; time passes the lease.
  const LATER = T0 + CLAIM_LEASE_MS + 1;

  // 7: the job is claimable again.
  assert.equal(isClaimable(queue[0], { now: LATER }), true, 'the dead claim never expired');

  // 8: a SECOND reviewer receives it automatically -- and it is not the first.
  const second = proposeAudit({ jobs: queue, sessions: roster, now: LATER, isLive: allLive });
  assert.equal(second.proposals.length, 1,
    `the recovered job was not re-dispatched: ${JSON.stringify(second.unassigned)}`);
  const retry = second.proposals[0];
  assert.equal(retry.recovered, true, 'the re-dispatch does not record that it was a recovery');
  assert.equal(retry.previous_holder, pick.session_id);
  assert.notEqual(retry.session_id, AUTHOR, 'recovery handed the candidate to its author');

  const reclaimed = claimJob(queue[0], {
    by: retry.session_id, authorSession: AUTHOR, now: LATER,
  });
  assert.equal(reclaimed.ok, true, `the recovered pairing was refused: ${reclaimed.why}`);
  assert.equal(reclaimed.job.claimed_by, retry.session_id, 'ownership did not transfer');

  // and the invariant that must survive all eight steps.
  assert.equal(reclaimed.job.satisfies_gate, false,
    'the round trip through recovery upgraded the trust of the verdict');
});

/*
 * ═══════════════════════════════════════════════════════════════════════
 * THE RE-REVIEW BOUND (D-4, and the fix that did not fix it)
 *
 * A review whose result cannot be attributed re-queues the job at PENDING.
 * Nothing the re-queue touches is in the sort key, so the job is
 * head-of-queue again on the next tick and is re-reviewed at full LLM cost,
 * forever, starving every other job.
 *
 * I "closed" that by writing the verdict into `last_review`. `last_review`
 * is written at audit-daemon.mjs:691 and :806 and READ BY NOTHING -- I
 * checked both call sites before writing this. So the loop was byte-for-byte
 * intact and the ledger recorded it FIXED, which is worse than leaving it
 * open because the next reader will not re-check a closed row.
 *
 * These three tests are the ones that would have gone red against that
 * "fix". Two bound the spin, and the third is the rule-5 positive that the
 * bound has not simply turned the queue off.
 * ═══════════════════════════════════════════════════════════════════════
 */

test('A JOB REVIEWED TO THE BOUND IS NOT DISPATCHED AGAIN', () => {
  const exhausted = job({
    review_attempts: 3,
    last_review: { not_recorded_because: 'worktree_dirty' },
  });
  const r = proposeAudit({
    jobs: [exhausted], sessions: [seat('reviewer-one')], now: T0, isLive: allLive,
  });

  assert.equal(r.proposals.length, 0,
    'a candidate reviewed three times without an attributable result was sent for a fourth');
  assert.equal(r.unassigned.length, 1);
  assert.equal(r.unassigned[0].code, UNPLACED.REVIEW_EXHAUSTED);
  assert.equal(r.unassigned[0].audit_id, 'audit-1');
  /* The operator has to be able to see WHY, or a silent stop is just a
   * quieter version of the spin (rule 15: the gate moves, it does not close). */
  assert.match(r.unassigned[0].why, /worktree_dirty/);
});

test('UNDER THE BOUND IT STILL DISPATCHES -- the positive, so the bound is not an off switch', () => {
  /*
   * Rule 5. "Exhausted is refused" passes just as well against a
   * dispatcher that refuses everything, and this whole subsystem exists
   * because 25 audits sat PENDING while nothing dispatched.
   *
   * Derived from MAX_REVIEW_ATTEMPTS rather than typed, so raising the
   * bound extends the coverage instead of silently skipping it (rule 7).
   */
  for (let tries = 0; tries < MAX_REVIEW_ATTEMPTS; tries += 1) {
    const r = proposeAudit({
      jobs: [job({ review_attempts: tries, last_review: tries ? { not_recorded_because: 'x' } : null })],
      sessions: [seat('reviewer-one')],
      now: T0,
      isLive: allLive,
    });
    assert.equal(r.proposals.length, 1,
      `a job with ${tries} of ${MAX_REVIEW_ATTEMPTS} attempts was refused: `
      + JSON.stringify(r.unassigned));
  }

  /* and the boundary itself is the first refusal, not one either side of it */
  const at = proposeAudit({
    jobs: [job({ review_attempts: MAX_REVIEW_ATTEMPTS })],
    sessions: [seat('reviewer-one')],
    now: T0,
    isLive: allLive,
  });
  assert.equal(at.proposals.length, 0, 'the bound is off by one');
});

test('A RE-QUEUED JOB SORTS BEHIND A FRESH ONE -- this is what makes a retry a retry', () => {
  /*
   * The starvation half, and the half `last_review` alone could never fix.
   * Even under the bound, a job with two attempts left is head-of-queue on
   * every tick until it spends them -- so with ONE seat the fresh job waits
   * behind the failing one. One seat is exactly the measured condition.
   *
   * BOTH JOBS ARE ESCAPED, because the tiebreak works WITHIN an urgency
   * class and must not reorder the classes. Blind audit L5 caught the
   * first version of this test asserting the opposite: it paired a
   * retried ESCAPED job against a fresh LOCAL one and demanded the local
   * one win, which encoded "a failed review demotes a pushed commit below
   * everything" as the desired behaviour. It is not -- escaped outranks
   * local, and the spin is bounded by MAX_REVIEW_ATTEMPTS instead.
   *
   * The retried job still holds the winning key on AGE, so this can only
   * pass if `last_review` is genuinely consulted (rule 9: the fixture is
   * the shape the re-queue actually produces, which preserves that field).
   */
  const retried = job({
    audit_id: 'audit-retried',
    escaped: true,
    first_seen_at: '2026-09-01T00:00:00Z',
    review_attempts: 1,
    last_review: { not_recorded_because: 'candidate_moved' },
  });
  const fresh = job({
    audit_id: 'audit-fresh',
    escaped: true,
    first_seen_at: '2026-09-20T00:00:00Z',
  });

  const r = proposeAudit({
    jobs: [retried, fresh], sessions: [seat('only-seat')], now: T0, isLive: allLive,
  });

  assert.equal(r.proposals.length, 1, 'the single seat took more than one job');
  assert.equal(r.proposals[0].audit_id, 'audit-fresh',
    'the already-reviewed candidate took the only seat again, which is the spin: '
    + 'it outranks an unreviewed job on escaped AND on age, so nothing else ever runs');

  /* THE PREMISE, asserted rather than assumed (rule 6): without the
   * last_review tiebreak `retried` really would win, so this test is
   * measuring the tiebreak and not an accident of the fixture. */
  const withoutRetryMark = proposeAudit({
    jobs: [{ ...retried, last_review: null, review_attempts: 0 }, fresh],
    sessions: [seat('only-seat')],
    now: T0,
    isLive: allLive,
  });
  assert.equal(withoutRetryMark.proposals[0].audit_id, 'audit-retried',
    'PREMISE FAILED: the retried job does not outrank the fresh one on the other keys, '
    + 'so the test above would pass with no tiebreak at all');
});

test('A FAILED REVIEW DOES NOT DEMOTE AN ESCAPED JOB BELOW A LOCAL ONE (L5)', () => {
  /*
   * The class order must survive the tiebreak. An escaped candidate is one
   * other clones can already build on; a failed review does not make it
   * less urgent, and demoting it below every local job is a priority
   * inversion that lasts as long as the queue does.
   *
   * This is the case my first tiebreak got backwards, so it is pinned in
   * the direction that was wrong rather than described in a comment.
   */
  const escapedRetried = job({
    audit_id: 'audit-escaped-retried',
    escaped: true,
    first_seen_at: '2026-09-20T00:00:00Z',
    review_attempts: 1,
    last_review: { not_recorded_because: 'worktree_dirty' },
  });
  const localFresh = job({
    audit_id: 'audit-local-fresh',
    escaped: false,
    first_seen_at: '2026-09-01T00:00:00Z',
  });

  const r = proposeAudit({
    jobs: [localFresh, escapedRetried], sessions: [seat('only-seat')], now: T0, isLive: allLive,
  });
  assert.equal(r.proposals[0].audit_id, 'audit-escaped-retried',
    'a single failed review pushed an ALREADY-PUSHED candidate behind a local one');
});

test('AN ALREADY-PREPARED JOB WAITS BEHIND ONE THAT IS NOT (H-1)', () => {
  /*
   * Blind audit H-1, and it was the fix for starvation creating a second
   * spin one commit later.
   *
   * The daemon's prepare-only path gives the claim back WITHOUT recording
   * a review -- correctly, none happened. But `byUrgency` sorted only on
   * escaped, last_review, first_seen_at and audit_id, so nothing the
   * release touched was in the key: the same row came back head-of-queue,
   * `tick()` returned true so the no-progress counter reset, and a
   * supervised prepare run re-prepared ONE job every cycle, leaking a
   * worktree and a nonce-bearing brief each time while reporting progress.
   *
   * Both jobs are escaped and unreviewed here, so `prepared_at` is the
   * only key that can decide -- and the prepared one holds the WINNING
   * age, so this can only pass if it is genuinely consulted (rule 9).
   */
  const prepared = job({
    audit_id: 'audit-prepared',
    escaped: true,
    first_seen_at: '2026-09-01T00:00:00Z',
    prepared_at: '2026-09-21T00:00:00Z',
  });
  const untouched = job({
    audit_id: 'audit-untouched',
    escaped: true,
    first_seen_at: '2026-09-20T00:00:00Z',
  });

  const r = proposeAudit({
    jobs: [prepared, untouched], sessions: [seat('only-seat')], now: T0, isLive: allLive,
  });
  assert.equal(r.proposals[0].audit_id, 'audit-untouched',
    'a job already prepared took the seat again -- a supervised prepare run grinds one '
    + 'row and leaks a worktree per tick instead of walking the queue');

  /* THE PREMISE (rule 6): without prepared_at the prepared job really does
   * win on age, so this measures the new key and not the fixture. */
  const { prepared_at: _drop, ...noMark } = prepared;
  const without = proposeAudit({
    jobs: [noMark, untouched], sessions: [seat('only-seat')], now: T0, isLive: allLive,
  });
  assert.equal(without.proposals[0].audit_id, 'audit-prepared',
    'PREMISE FAILED: the prepared job does not outrank the other on age');

  /*
   * AND A REVIEWING CALLER IGNORES THE KEY ENTIRELY (M-5, second half).
   *
   * `byUrgency` serves both modes. Demoting `prepared_at` in a --launch
   * run meant the daemon avoided exactly the jobs whose worktree and
   * brief it had already set up, leaving those to accumulate while it
   * prepared more. The key answers "do not prepare this twice" and says
   * nothing about reviewing.
   */
  const launching = proposeAudit({
    jobs: [prepared, untouched],
    sessions: [seat('only-seat')],
    now: T0,
    isLive: allLive,
    demotePrepared: false,
  });
  assert.equal(launching.proposals[0].audit_id, 'audit-prepared',
    'a launching caller skipped the job whose workspace already exists');

  /* AND IT RANKS BELOW last_review: a failed review is stronger evidence of
   * trouble than a pending preparation, so it must not be reordered. */
  const reviewed = job({
    audit_id: 'audit-reviewed', escaped: true, first_seen_at: '2026-09-01T00:00:00Z', last_review: { x: 1 },
  });
  const order = proposeAudit({
    jobs: [reviewed, prepared], sessions: [seat('only-seat')], now: T0, isLive: allLive,
  });
  assert.equal(order.proposals[0].audit_id, 'audit-prepared',
    'a reviewed job outranked a merely-prepared one');
});

test('AN UNREADABLE review_attempts IS EXHAUSTED, NOT ZERO (L3)', () => {
  /*
   * The bound was `Number.isFinite(tries) && tries >= MAX`, so every value
   * that means "this counter is broken" -- a string, an object, a null
   * that survived the ?? -- failed the finite test and DISPATCHED. The one
   * shape signalling corruption was the one shape that bypassed the bound.
   *
   * Generated from the hostile shapes rather than the one I happened to
   * think of (rule 7), and each is a value JSON.parse can actually yield
   * from a queue file (rule 9).
   */
  /*
   * `undefined` IS NOT IN THIS LIST, and that is deliberate: an absent
   * field is what every row written before this counter existed looks
   * like, and refusing those would stall the whole historical queue.
   * Absent is a legitimate zero; a BLANK or malformed value is not, and
   * `Number('')` being 0 is exactly the footgun that made the loose
   * version dangerous.
   *
   * `null` IS IN IT NOW. T-298, Controller ruling; pinned defect T-293 F1.
   * This test used to list null as a legitimate zero, reasoning that it
   * meant "absent". It does not: an absent key reads back as undefined,
   * and a JSON null is what `JSON.stringify(NaN)` writes -- the corruption
   * itself. The writer, `nextAttempt`, already returns the bound for null
   * (T-291 B-12), so this reader dispatching it was the two ends of one
   * counter disagreeing on the value that means "broken".
   */
  for (const bad of ['', '  ', 'three', '1.5', '-1', {}, [], true, NaN, -1, 1.5, Infinity, null]) {
    const r = proposeAudit({
      jobs: [job({ review_attempts: bad })],
      sessions: [seat('reviewer-one')],
      now: T0,
      isLive: allLive,
    });
    assert.equal(r.proposals.length, 0,
      `review_attempts ${JSON.stringify(bad)} walked past the bound and dispatched`);
    assert.equal(r.unassigned[0].code, UNPLACED.REVIEW_EXHAUSTED);
  }

  /* THE POSITIVE (rule 5): a readable count under the bound still runs,
   * including the two spellings a JSON round-trip really produces. */
  for (const ok of [0, 1, '2', undefined]) {
    const r = proposeAudit({
      jobs: [job({ review_attempts: ok })],
      sessions: [seat('reviewer-one')],
      now: T0,
      isLive: allLive,
    });
    assert.equal(r.proposals.length, 1,
      `review_attempts ${JSON.stringify(ok)} was refused: ${JSON.stringify(r.unassigned)}`);
  }
});

const ATTEMPT_TABLE = [
  /* [label, value, dispatches?] -- typed, not derived, so reader and writer
   * cannot agree with each other through a shared mistake (hollow gate 2). */
  ['undefined', undefined, true],
  ['null', null, false],
  ['0', 0, true],
  ['1', 1, true],
  ['3', 3, false],
  ['NaN', NaN, false],
  ['""', '', false],
  ['"2"', '2', true],
  /* T-305 B-25 F2: numbers that are not counts. The reader refused 1.5 while
   * nextAttempt floored it to count 1 -- the "EVERY" in the test name below
   * was not true until both sides failed closed on it. */
  ['1.5', 1.5, false],
  ['-1', -1, false],
  ['Infinity', Infinity, false],
  ['"1.5"', '1.5', false],
  /* T-316 B-28: shapes JSON.parse cannot yield but a caller can hand over.
   * 2n THREW in the dispatcher's reason builder ("Do not know how to
   * serialize a BigInt") while nextAttempt(2n) returned the bound -- so the
   * "EVERY" in the test name was not true for it. Hostile, not plausible
   * (rule 7): each one is a value the old reason builder choked on or that
   * a loose reader would coerce to a count. */
  ['2n', 2n, false],
  ['0n', 0n, false],
  ['Symbol("2")', Symbol('2'), false],
  ['[2]', [2], false],
  ['new Number(2)', new Number(2), false],
  ['new String("2")', new String('2'), false],
  ['fullwidth "２"', '２', false],
  ['" 2 "', ' 2 ', true],
  ['cyclic object', (() => { const o = {}; o.self = o; return o; })(), false],
  ['throwing toJSON', { toJSON() { throw new Error('toJSON bomb'); } }, false],
  ['revoked proxy', (() => { const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); return proxy; })(), false],
];

test('T-298 B-20: THE DISPATCHER AND nextAttempt AGREE ON EVERY COUNTER VALUE', () => {
  assert.equal(MAX_REVIEW_ATTEMPTS, 3, 'premise: the typed table below assumes a bound of 3');
  /* The writer's own reading, asked of the SHIPPED function: with a bound far
   * above any count, nextAttempt returns exactly that bound only for a value
   * it cannot read, and n + 1 for a readable n. */
  const FAR = 1000;
  for (const [label, value, dispatches] of ATTEMPT_TABLE) {
    /* A THROW IS NOT A REFUSAL (T-316 B-28): the caller gets an exception,
     * not a job left PENDING with a reason. Named, so it cannot pass as one. */
    let r;
    try {
      r = proposeAudit({
        jobs: [job({ review_attempts: value })], sessions: [seat('reviewer-one')], now: T0, isLive: allLive,
      });
    } catch (e) {
      assert.fail(`B-28: proposeAudit THREW on review_attempts ${label} instead of deciding: `
        + `${e?.constructor?.name}: ${String(e?.message).slice(0, 80)}`);
    }
    assert.equal(r.proposals.length === 1, dispatches,
      `B-20: review_attempts ${label} ${dispatches ? 'was refused' : 'dispatched'}: ${JSON.stringify(r.unassigned)}`);
    /* Unconditional (T-356 r2, hook K-5): a dispatched row leaves nothing unassigned; a refused one is EXHAUSTED. */
    assert.equal(r.unassigned[0]?.code ?? null, dispatches ? null : UNPLACED.REVIEW_EXHAUSTED,
      `B-20: review_attempts ${label}: ${JSON.stringify(r.unassigned).slice(0, 160)}`);

    const next = nextAttempt(value, FAR);
    const writerUnreadable = next === FAR;
    const writerUnderBound = !writerUnreadable && next - 1 < MAX_REVIEW_ATTEMPTS;
    assert.equal(writerUnderBound, dispatches,
      `B-20: nextAttempt reads ${label} as ${writerUnreadable ? 'unreadable' : `count ${next - 1}`} `
      + `but the dispatcher ${dispatches ? 'dispatches' : 'refuses'} it -- reader and writer disagree`);
  }
});

/*
 * ═══ T-316 / B-28: THE DISPATCHER'S REASON BUILDERS ARE TOTAL AND BOUNDED ═══
 *
 * One near-MAX_STRING_LENGTH rope, shared: `repeat` builds it lazily and the
 * first slice flattens it once (measured ~0.15 s, ~540 MB transient on node
 * 24). Derived from the running engine, not typed (rule 21).
 */
const NEAR_MAX = 'x'.repeat(bufferConstants.MAX_STRING_LENGTH - 5);
const B28_HOSTILE = () => {
  const cyclic = {}; cyclic.self = cyclic;
  const { proxy: revoked, revoke } = Proxy.revocable({}, {}); revoke();
  return [
    ['bigint', 2n],
    ['bigint', 10n ** 400n],
    ['symbol', Symbol('x')],
    ['function', () => 1],
    ['object', cyclic],
    ['object', Object.create(null)],
    ['object', { toJSON() { throw new Error('toJSON bomb'); } }],
    ['object', { toJSON() { throw new Error('bomb'); }, toString() { throw new Error('bomb'); } }],
    ['object', revoked],
    ['array', [1n]],
    ['object', { toJSON() { return undefined; }, toString() { return NEAR_MAX; } }],
    ['string', NEAR_MAX],
    ['string', 'y'.repeat(1e6)],
  ];
};
const DESCRIBED = /^([\s\S]*) \((\w+)\)$/;

test('T-316 B-28: THE UNREADABLE-COUNTER REASON IS TOTAL, BOUNDED, AND auditLoop\'s OWN', () => {
  /*
   * The reason used JSON.stringify(raw), which THROWS on a BigInt, a cycle or
   * a throwing toJSON, and a near-max string overflowed the concatenation
   * after it. A fail-closed branch that throws is not closed. Generated from
   * the shapes JSON.stringify cannot print (rule 8), not from the one 2n.
   */
  const s = { queueDepth: 50, consecutiveNoProgress: 1 };
  for (const [type, value] of B28_HOSTILE()) {
    let r;
    try {
      r = proposeAudit({
        jobs: [job({ review_attempts: value })], sessions: [seat('reviewer-one')], now: T0, isLive: allLive,
      });
    } catch (e) {
      assert.fail(`B-28: a ${type} review_attempts THREW in the reason builder: `
        + `${e?.constructor?.name}: ${String(e?.message).slice(0, 80)}`);
    }
    assert.equal(r.proposals.length, 0, `B-28: a ${type} review_attempts dispatched`);
    assert.equal(r.unassigned[0].code, UNPLACED.REVIEW_EXHAUSTED);
    const why = r.unassigned[0].why;
    const m = /^review_attempts is ([\s\S]*), which is not a count\. /.exec(why);
    assert.ok(m, `B-28: the reason lost its subject: ${String(why).slice(0, 120)}`);
    const d = DESCRIBED.exec(m[1]);
    assert.ok(d, `B-28: the reason does not name a type: ${m[1].slice(0, 120)}`);
    assert.equal(d[2], type, `B-28: a ${type} was described as ${d[2]}`);
    assert.ok(d[1].length <= 201, `B-28: the described ${type} is UNBOUNDED (${d[1].length} chars)`);

    /* ONE HELPER, NOT TWO (brief: do not duplicate). Asked of the shipped
     * auditLoop reason for the same value, behaviourally -- a copy that
     * drifts disagrees here. */
    let loopWhy;
    try { loopWhy = nextAction({ ...s, backoffServed: value }, { intervalMs: 1000 }).why; } catch (e) {
      assert.fail(`B-28: auditLoop's reason builder THREW on a ${type}: ${String(e?.message).slice(0, 80)}`);
    }
    const lm = /^backoffServed is ([\s\S]*), which is not a boolean\. /.exec(loopWhy);
    assert.ok(lm, `B-28: auditLoop's reason lost its subject: ${String(loopWhy).slice(0, 120)}`);
    /* T-356: ONE helper still, in two modes. A store row's plain object is
     * named without opening it (its keys cost time, see src/auditLoop.mjs),
     * while auditLoop's own sites still print `{}`. So for an object the
     * dispatcher must equal the helper's store mode, and for every other type
     * it must equal auditLoop's reason, as before. */
    const want = type === 'object' ? describeValue(value, { keys: false }) : lm[1];
    assert.equal(m[1], want, type === 'object'
      ? 'T-356: the dispatcher does not describe a store object with auditLoop\'s helper in store mode'
      : `B-28: the dispatcher and auditLoop describe a ${type} differently`);
  }
  assert.ok(proposeAudit({
    jobs: [job({ review_attempts: 2n })], sessions: [seat('reviewer-one')], now: T0, isLive: allLive,
  }).unassigned[0].why.startsWith('review_attempts is 2n (bigint), which is not a count'),
  'B-28: 2n is not shown as what it is');
});

test('T-316 B-28: THE EXHAUSTED REASON IS TOTAL TOO -- a hostile last_review.not_recorded_because', () => {
  /*
   * Same builder, other branch: `${job.last_review?.not_recorded_because}`
   * in a template THROWS on a Symbol and on an object whose toString throws,
   * and a near-max string overflows it. The count here is readable and AT
   * the bound, so this is the path every exhausted job takes.
   */
  for (const [type, value] of B28_HOSTILE()) {
    let r;
    try {
      r = proposeAudit({
        jobs: [job({ review_attempts: MAX_REVIEW_ATTEMPTS, last_review: { not_recorded_because: value } })],
        sessions: [seat('reviewer-one')], now: T0, isLive: allLive,
      });
    } catch (e) {
      assert.fail(`B-28: a ${type} not_recorded_because THREW in the exhausted reason: `
        + `${e?.constructor?.name}: ${String(e?.message).slice(0, 80)}`);
    }
    assert.equal(r.proposals.length, 0);
    assert.equal(r.unassigned[0].code, UNPLACED.REVIEW_EXHAUSTED);
    const m = /\(last: ([\s\S]*)\)\. Not re-dispatching/.exec(r.unassigned[0].why);
    assert.ok(m, `B-28: the exhausted reason lost its last-review clause: ${r.unassigned[0].why.slice(0, 160)}`);
    const d = DESCRIBED.exec(m[1]);
    assert.ok(d && d[2] === type, `B-28: a ${type} last-review cause was not named as one: ${m[1].slice(0, 120)}`);
    assert.ok(d[1].length <= 201, `B-28: the last-review cause (${type}) is UNBOUNDED (${d[1].length} chars)`);
  }
  /* THE POSITIVE (rule 5): the real cause is still shown, and absent is 'unknown'. */
  const shown = (last) => proposeAudit({
    jobs: [job({ review_attempts: MAX_REVIEW_ATTEMPTS, last_review: last })],
    sessions: [seat('reviewer-one')], now: T0, isLive: allLive,
  }).unassigned[0].why;
  assert.match(shown({ not_recorded_because: 'worktree_dirty' }), /\(last: "worktree_dirty" \(string\)\)/);
  assert.match(shown(null), /\(last: unknown\)/);
  assert.match(shown({}), /\(last: unknown\)/);
});

test('T-316 B-28: isClaimable\'s clock refusal says what it refused, whatever the clock is', () => {
  /*
   * The refusal was built with JSON.stringify(now), so a BigInt clock threw
   * "Do not know how to serialize a BigInt" -- still a throw, but not THIS
   * one: the explanation of why a non-number clock is dangerous was lost,
   * and a near-max string threw a RangeError instead of a TypeError.
   */
  const claimed = job({ state: JOB.CLAIMED, claimed_at: T0 });
  for (const [type, value] of B28_HOSTILE()) {
    let err;
    try { isClaimable(claimed, { now: value }); } catch (e) { err = e; }
    assert.ok(err instanceof TypeError,
      `B-28: a ${type} clock was not refused with isClaimable's TypeError (got ${err?.constructor?.name})`);
    assert.match(err.message, /^isClaimable needs `now` as epoch milliseconds, got /,
      `B-28: a ${type} clock lost the refusal's own explanation: ${String(err.message).slice(0, 100)}`);
    assert.ok(err.message.includes(` (${type}). `),
      `B-28: the refusal does not name the ${type}: ${err.message.slice(0, 120)}`);
    assert.ok(err.message.length < 600, `B-28: the refusal for a ${type} is UNBOUNDED (${err.message.length})`);
  }
});

/*
 * ═══ T-316 r2 / T-320 F1: last_review ITSELF HOSTILE ═══
 *
 * r1 hoisted `job.last_review?.not_recorded_because` above the
 * unreadable/exhausted split, so a last_review whose READ throws -- a revoked
 * proxy, a proxy whose get trap throws, a throwing getter -- made proposeAudit
 * THROW for review_attempts null, where 3af14ea returned REVIEW_EXHAUSTED.
 * r1's tests varied only not_recorded_because, never last_review itself.
 */
const HOSTILE_LAST_REVIEW = () => {
  const { proxy: revoked, revoke } = Proxy.revocable({}, {}); revoke();
  const { proxy: revokedArr, revoke: revokeArr } = Proxy.revocable([], {}); revokeArr();
  return [
    ['revoked proxy', revoked],
    ['revoked array proxy', revokedArr],
    ['get-trap proxy', new Proxy({}, { get() { throw new Error('get trap'); } })],
    ['throwing getter', { get not_recorded_because() { throw new Error('getter bomb'); } }],
    ...B28_HOSTILE().map(([type, v]) => [`${type} as last_review`, v]),
  ];
};

test('T-316 r2 F1a: AN UNREADABLE COUNTER NEVER READS last_review -- the 3af14ea behaviour, restored', () => {
  for (const counter of [null, 'three', 2n, NaN]) {
    /* The reason with NO last_review is the base answer; a hostile one must
     * not change it, because this branch has no business reading it. */
    const plain = proposeAudit({
      jobs: [job({ review_attempts: counter })], sessions: [seat('reviewer-one')], now: T0, isLive: allLive,
    }).unassigned[0];
    assert.equal(plain.code, UNPLACED.REVIEW_EXHAUSTED, 'premise: the counter is unreadable');
    for (const [label, last] of HOSTILE_LAST_REVIEW()) {
      let r;
      try {
        r = proposeAudit({
          jobs: [job({ review_attempts: counter, last_review: last })], sessions: [seat('reviewer-one')], now: T0, isLive: allLive,
        });
      } catch (e) {
        assert.fail(`F1a: a ${label} made proposeAudit THROW with an unreadable counter: `
          + `${e?.constructor?.name}: ${String(e?.message).slice(0, 80)}`);
      }
      assert.equal(r.proposals.length, 0);
      assert.deepEqual(r.unassigned[0], plain,
        `F1a: a ${label} changed the unreadable-counter refusal; that branch must not read last_review`);
    }
  }
});

test('T-316 r2 F1b: AT THE BOUND, A last_review THAT CANNOT BE READ IS REPORTED, NOT THROWN', () => {
  for (const [label, last] of HOSTILE_LAST_REVIEW()) {
    let r;
    try {
      r = proposeAudit({
        jobs: [job({ review_attempts: MAX_REVIEW_ATTEMPTS, last_review: last })],
        sessions: [seat('reviewer-one')], now: T0, isLive: allLive,
      });
    } catch (e) {
      assert.fail(`F1b: a ${label} made proposeAudit THROW at the bound: `
        + `${e?.constructor?.name}: ${String(e?.message).slice(0, 80)}`);
    }
    assert.equal(r.proposals.length, 0);
    assert.equal(r.unassigned[0].code, UNPLACED.REVIEW_EXHAUSTED);
    assert.match(r.unassigned[0].why, /^reviewed 3 times without the result being attributable \(last: [\s\S]*\)\. Not re-dispatching/,
      `F1b: the exhausted reason lost its shape for a ${label}`);
    assert.ok(r.unassigned[0].why.length < 600, `F1b: the reason for a ${label} is UNBOUNDED`);
  }
  /* The throwing reads are NAMED as unreadable, not passed off as 'unknown'. */
  const { proxy: revoked, revoke } = Proxy.revocable({}, {}); revoke();
  assert.match(proposeAudit({
    jobs: [job({ review_attempts: MAX_REVIEW_ATTEMPTS, last_review: revoked })],
    sessions: [seat('reviewer-one')], now: T0, isLive: allLive,
  }).unassigned[0].why, /\(last: <unreadable: reading last_review threw>\)/,
  'F1b: a last_review that threw when read was not named as unreadable');
  /* THE POSITIVE (rule 5): under the bound a hostile last_review still dispatches, as at 3af14ea. */
  for (const [label, last] of HOSTILE_LAST_REVIEW()) {
    const r = proposeAudit({
      jobs: [job({ review_attempts: 0, last_review: last })], sessions: [seat('reviewer-one')], now: T0, isLive: allLive,
    });
    assert.equal(r.proposals.length, 1, `F1b: a ${label} under the bound stopped dispatching`);
  }
});

test('T-316 r2 F3: auditDispatch DEFINES NO describeValue OF ITS OWN -- it imports auditLoop\'s', () => {
  /*
   * r1 pinned "one helper" by comparing OUTPUT, and a byte-faithful local
   * copy produces the same output (T-320 M9 survived). This asks the
   * SOURCE, comment-blanked first (rule 13) so this file's own explanatory
   * comments cannot satisfy or trip it.
   */
  const code = stripComments(readFileSync(new URL('../src/auditDispatch.mjs', import.meta.url), 'utf8'));
  /* PRECONDITION (rule 5): the helper IS used at the reason sites, so the
   * negatives below are about a real consumer, not an empty file. */
  const calls = code.match(/\bdescribeValue\(/g) ?? [];
  assert.ok(calls.length >= 3, `F3: premise: expected describeValue at 3+ reason sites, found ${calls.length}`);
  assert.match(code, /^import\s*\{[^}]*\bdescribeValue\b[^}]*\}\s*from\s*'\.\/auditLoop\.mjs';/m,
    'F3: auditDispatch does not import describeValue from ./auditLoop.mjs');
  for (const name of ['describeValue', 'capText']) {
    const local = new RegExp(`\\bfunction\\s*\\*?\\s*${name}\\b|\\b(?:const|let|var)\\s+${name}\\b|\\b${name}\\s*[:=]\\s*(?:function|\\()`);
    assert.doesNotMatch(code, local, `F3: auditDispatch DEFINES ITS OWN ${name}; the shared copy is in src/auditLoop.mjs`);
  }
});

test('T-316 r3 (b): THE ONLY-AUTHOR REASON IS CAPPED, UNQUOTED, AND NEVER OVERFLOWS', () => {
  /*
   * `(${author})` concatenated a validated but unbounded string: an author
   * id (== the only seat id) near MAX_STRING_LENGTH threw a RangeError, and a
   * 250-char id gave a 388-char reason. Capped WITHOUT quoting, because
   * test/daemonArgs.test.mjs pins the exact `(sess-1)` form.
   */
  const only = (id) => proposeAudit({
    jobs: [job({ author_session: id })], sessions: [seat(id)], now: T0, isLive: allLive,
  });
  for (const [label, id] of [['near-max id', NEAR_MAX], ['250-char id', 'a'.repeat(250)], ['1e6-char id', 'b'.repeat(1e6)]]) {
    let r;
    try { r = only(id); } catch (e) {
      assert.fail(`(b): a ${label} author THREW in the only-author reason: `
        + `${e?.constructor?.name}: ${String(e?.message).slice(0, 80)}`);
    }
    assert.equal(r.unassigned[0].code, UNPLACED.ONLY_AUTHOR_AVAILABLE, `(b): premise: a ${label} is the only seat`);
    const m = /^the only free seat authored this candidate \(([\s\S]*)\)\. Rule 20/.exec(r.unassigned[0].why);
    assert.ok(m, `(b): the only-author reason lost its shape for a ${label}`);
    assert.ok(m[1].length <= 201, `(b): the author shown for a ${label} is UNBOUNDED (${m[1].length} chars)`);
    assert.ok(m[1].endsWith('…'), `(b): a cut ${label} is not marked as cut`);
    assert.ok(!m[1].startsWith('"'), `(b): the author was QUOTED, breaking the (sess-1) form`);
  }
  /* THE POSITIVE (rule 5): a short id is shown exactly, unquoted -- the pinned form. */
  assert.match(only('sess-1').unassigned[0].why, /^the only free seat authored this candidate \(sess-1\)\. /);
});

/*
 * ═══ T-356 / B-28: WHAT THE JSONL STORE CAN PRODUCE NEVER THROWS OR STALLS proposeAudit ═══
 *
 * A queue row is JSON.parse of one line, and a line is bounded only by
 * MAX_STRING_LENGTH (readQueue reads the whole file as one string). Every
 * value below was produced by JSON.parse in T-356's generated table
 * (live/T-356/work/step1/), and each failed at T-316 r5:
 *  - an object with millions of keys: JSON.stringify collects every key
 *    before the visit budget applies (5e6 keys: 5.2 s, at review_attempts and
 *    at the last-cause site);
 *  - a string whose escaped form passes MAX_STRING_LENGTH: JSON.stringify
 *    escapes the WHOLE string first (and throws RangeError here, so r5 fell
 *    back to the raw, unquoted text);
 *  - first_seen_at as a deep array or as {"toString":"x"}: byUrgency's
 *    String() threw out of proposeAudit before any reason was built.
 */
const storeRow = (over) => job({ review_attempts: 0, ...over });
const reasonOf = (r, id = 'audit-1') => r.unassigned.find((u) => u.audit_id === id);

test('T-356: A STORE OBJECT IS NAMED, NOT OPENED, in every dispatcher reason', () => {
  const objects = JSON.parse('[{}, {"a":1}, {"__proto__":{"x":1}}, {"toString":"x"}, {"n":3}]');
  for (const o of objects) {
    const label = JSON.stringify(o);
    const r1 = proposeAudit({ jobs: [storeRow({ review_attempts: o })], sessions: [seat('reviewer-one')], now: T0, isLive: allLive });
    assert.equal(reasonOf(r1)?.code, UNPLACED.REVIEW_EXHAUSTED, `T-356: premise: review_attempts ${label} is not a count`);
    assert.match(reasonOf(r1).why, /^review_attempts is <object: its keys were not read> \(object\), which is not a count\. /,
      `T-356: review_attempts ${label} was opened: ${reasonOf(r1).why.slice(0, 120)}`);
    const r2 = proposeAudit({
      jobs: [storeRow({ review_attempts: MAX_REVIEW_ATTEMPTS, last_review: { not_recorded_because: o } })],
      sessions: [seat('reviewer-one')], now: T0, isLive: allLive,
    });
    assert.match(reasonOf(r2)?.why ?? '', /\(last: <object: its keys were not read> \(object\)\)\. Not re-dispatching/,
      `T-356: a last-review cause ${label} was opened: ${String(reasonOf(r2)?.why).slice(0, 160)}`);
  }
  /* isClaimable's clock refusal is this file's third describe site; same mode. */
  let clockErr;
  try { isClaimable(job({ state: JOB.CLAIMED, claimed_at: T0 }), { now: JSON.parse('{"a":1}') }); } catch (e) { clockErr = e; }
  assert.ok(clockErr instanceof TypeError, 'T-356: premise: an object clock is refused');
  assert.ok(clockErr.message.includes('got <object: its keys were not read> (object). '),
    `T-356: isClaimable opened an object clock: ${clockErr.message.slice(0, 120)}`);
  /* Nested in an array too: the array is shown by kind, the object is still not opened. */
  const nested = proposeAudit({ jobs: [storeRow({ review_attempts: JSON.parse('[1,{"a":1}]') })], sessions: [seat('reviewer-one')], now: T0, isLive: allLive });
  assert.match(reasonOf(nested).why, /^review_attempts is <array holding an object: its keys were not read> \(array\), /,
    `T-356: an object inside an array was opened: ${reasonOf(nested).why.slice(0, 120)}`);
  /* THE POSITIVE (rule 5): a string, a number and an array of scalars are still shown as they are. */
  const shown = (v) => reasonOf(proposeAudit({ jobs: [storeRow({ review_attempts: v })], sessions: [seat('reviewer-one')], now: T0, isLive: allLive })).why;
  assert.match(shown('abc'), /^review_attempts is "abc" \(string\), /);
  assert.match(shown(1.5), /^review_attempts is 1\.5 \(number\), /);
  assert.match(shown([1, 'a', null]), /^review_attempts is \[1,"a",null\] \(array\), /);
});

test('T-356: A STRING WHOSE ESCAPED FORM PASSES THE ENGINE LIMIT IS SHOWN LIKE A SHORT ONE -- quoted, cut, marked', () => {
  /* 9e7 NULs: JSON escapes each to 6 characters, 5.4e8 > MAX_STRING_LENGTH. The
   * same value JSON.parse makes from a line of "\u0000" escapes. */
  const n = Math.floor(bufferConstants.MAX_STRING_LENGTH / 6) + 10;
  const nuls = '\u0000'.repeat(n);
  const cut = `"${'\\u0000'.repeat(33)}\\`;   // the first 200 characters of JSON.stringify(nuls)
  assert.equal(cut.length, 200, 'premise: the expected prefix is 200 characters');
  for (const [site, why] of [
    ['review_attempts', () => reasonOf(proposeAudit({ jobs: [storeRow({ review_attempts: nuls })], sessions: [seat('reviewer-one')], now: T0, isLive: allLive })).why],
    ['last cause', () => reasonOf(proposeAudit({ jobs: [storeRow({ review_attempts: MAX_REVIEW_ATTEMPTS, last_review: { not_recorded_because: nuls } })], sessions: [seat('reviewer-one')], now: T0, isLive: allLive })).why],
  ]) {
    let w;
    try { w = why(); } catch (e) { assert.fail(`T-356: ${site}: a long escaped string THREW: ${e?.constructor?.name}: ${String(e?.message).slice(0, 80)}`); }
    assert.ok(w.includes(`${cut}… (string)`),
      `T-356: ${site}: the long escaped string was not shown as JSON cut at the cap: ${JSON.stringify(w.slice(0, 80))}`);
  }
});

test('T-356: first_seen_at FROM A CORRUPT ROW NEVER THROWS OUT OF THE ORDERING', () => {
  const deep = JSON.parse(`${'['.repeat(1e5)}${']'.repeat(1e5)}`);
  const values = [['a 1e5-deep array', deep], ['{"toString":"x"}', JSON.parse('{"toString":"x"}')],
    ['{"valueOf":1,"toString":1}', JSON.parse('{"valueOf":1,"toString":1}')]];
  for (const [label, v] of values) {
    let r;
    try {
      r = proposeAudit({
        jobs: [job({ audit_id: 'a', first_seen_at: v }), job({ audit_id: 'b', author_source: AUTHOR_UNAVAILABLE })],
        sessions: [seat('reviewer-one')], now: T0, isLive: allLive,
      });
    } catch (e) {
      assert.fail(`T-356: first_seen_at ${label} THREW out of proposeAudit: ${e?.constructor?.name}: ${String(e?.message).slice(0, 80)}`);
    }
    assert.equal(r.proposals.length, 1, `T-356: first_seen_at ${label} stopped the dispatch`);
    assert.equal(r.proposals[0].audit_id, 'a');
  }
  /* THE POSITIVE (rule 5): real timestamps -- and numbers -- still order oldest first. */
  const order = (a, b) => proposeAudit({
    jobs: [job({ audit_id: 'x', first_seen_at: a }), job({ audit_id: 'y', first_seen_at: b })],
    sessions: [seat('reviewer-one')], now: T0, isLive: allLive,
  }).proposals[0].audit_id;
  assert.equal(order('2026-09-21T00:00:00Z', '2026-09-20T00:00:00Z'), 'y', 'T-356: the older string timestamp no longer goes first');
  assert.equal(order('2026-09-20T00:00:00Z', '2026-09-21T00:00:00Z'), 'x');
  assert.equal(order(2, 1), 'y', 'T-356: a numeric first_seen_at no longer orders as before');
  /* A corrupt first_seen_at sorts AFTER a real one, as '[object Object]' did at base: it never jumps the queue. */
  assert.equal(order(JSON.parse('{"a":1}'), '2026-09-20T00:00:00Z'), 'y', 'T-356: a corrupt first_seen_at jumped the queue');
  assert.equal(order(deep, '2026-09-20T00:00:00Z'), 'y', 'T-356: a corrupt first_seen_at jumped the queue');
});

test('T-356: A MULTI-MILLION-KEY STORE OBJECT IS NEVER OPENED by proposeAudit -- by trap and by ratio, not by a clock alone', { timeout: 120000 }, () => {
  /*
   * T-356 r2 (V1-F2). The first version built a 5e6-key object in a child and
   * asserted `ms < 2000` per site; in a loaded full suite the CHILD ran past
   * its 60 s limit building the object, and the test went red on a correct
   * tree -- once even on pristine code inside a mutation control. A gate that
   * goes red under load is not a gate. So the proof is now (1) a TRAP: a plain
   * object whose only property is an accessor that counts its reads -- at
   * every store site it must be read zero times and named as not read; and
   * (2) a RATIO: a JSON.parse-built 1e6-key object (the store's own shape,
   * built in this process), where each proposeAudit call must cost under a
   * twentieth of Object.keys on the same object, min of 3 on both sides, so
   * load moves both and neither alone. An absolute 2 s bar remains only as a
   * thousand-fold margin over the honest cost, never as the measurement.
   */
  const sites = (v) => [
    ['review_attempts', () => proposeAudit({ jobs: [storeRow({ review_attempts: v })], sessions: [seat('reviewer-one')], now: T0, isLive: allLive })],
    ['last cause', () => proposeAudit({ jobs: [storeRow({ review_attempts: MAX_REVIEW_ATTEMPTS, last_review: { not_recorded_because: v } })], sessions: [seat('reviewer-one')], now: T0, isLive: allLive })],
    ['[object] review_attempts', () => proposeAudit({ jobs: [storeRow({ review_attempts: [v] })], sessions: [seat('reviewer-one')], now: T0, isLive: allLive })],
  ];
  /* (1) THE TRAP. */
  let reads = 0;
  const trap = Object.defineProperty({}, 'k', { get() { reads += 1; return 0; }, enumerable: true });
  for (const [site, call] of sites(trap)) {
    reads = 0;
    const r = call();
    assert.equal(reasonOf(r)?.code, UNPLACED.REVIEW_EXHAUSTED, `T-356: premise: the ${site} row reached the exhausted reason`);
    assert.equal(reads, 0, `T-356: the ${site} site OPENED a store object: its property was read ${reads} time(s)`);
    assert.match(reasonOf(r).why, /<(?:object|array holding an object): its keys were not read>/,
      `T-356: the ${site} site did not name the object as not read: ${reasonOf(r).why.slice(0, 120)}`);
  }
  JSON.stringify(trap);
  assert.equal(reads, 1, 'premise: the trap fires when the object is serialised');
  /* (2) THE RATIO, on the store's own shape. */
  const N = 1e6;
  const parts = []; for (let i = 0; i < N; i += 1) parts.push(`"k${i}":0`);
  const huge = JSON.parse(`{${parts.join(',')}}`); parts.length = 0;
  assert.equal(Object.keys(huge).length, N, `premise: the object really has ${N} keys`);
  const minOf3 = (fn) => { let best = Infinity; for (let i = 0; i < 3; i += 1) { const t = performance.now(); fn(); best = Math.min(best, performance.now() - t); } return best; };
  const keysMs = minOf3(() => Object.keys(huge).length);
  for (const [site, call] of sites(huge)) {
    let r;
    const ms = minOf3(() => { r = call(); });
    assert.equal(reasonOf(r)?.code, UNPLACED.REVIEW_EXHAUSTED, `T-356: premise: the ${site} row reached the exhausted reason`);
    assert.ok(ms * 20 <= keysMs, `T-356: the ${site} site took ${ms.toFixed(2)} ms on a ${N}-key store object against an Object.keys baseline of ${keysMs.toFixed(1)} ms: the keys were read`);
    assert.ok(ms < 2000, `T-356: the ${site} site took ${ms.toFixed(0)} ms on a multi-million-key store object`);
  }
});

/*
 * ═══ T-356 r2 / V1-F1: A STORE STRING'S WHITESPACE IS SCANNED TO A BOUND, NEVER TRIMMED WHOLE ═══
 *
 * The blind verifier padded a store string with 1e8 spaces on each side (a
 * legal JSON string, 2e8 characters, under the line cap) and proposeAudit
 * took 2.2-6.2 s: `str` trimmed the WHOLE run on every one of its six to
 * fifteen calls per row. The round-1 table had swept string LENGTH in one
 * content class ('x'), so trim never did any work. These tests are generated
 * from the ENGINE's own whitespace set and from the operations the code
 * performs (r2/OPERATIONS.md), not from a list of characters somebody
 * remembered (HOSTILE-CHECKLIST (E), LIB-27).
 */
/* A NAMESPACE import, so that on a tree WITHOUT the bounded trim (the r1 candidate, the red-first tree) this file
 * still loads and every test below goes red for ITS OWN reason, instead of one import error that runs no assertion
 * at all (hollow gate 9). The first test asserts the exports exist. */
import * as Dispatch from '../src/auditDispatch.mjs';
import { performance } from 'node:perf_hooks';

const { boundedTrim, TRIM_OVER } = Dispatch;
const K = Dispatch.TRIM_SCAN ?? 4096;   // the fallback only sizes fixtures on a tree that has no bound; the test below names that tree

test('T-356 r2: THE BOUNDED TRIM EXISTS AND IS THE ONE THE FIXTURES ARE SIZED TO', () => {
  assert.equal(typeof boundedTrim, 'function', 'T-356 r2: src/auditDispatch.mjs exports no boundedTrim: str() is on the native trim');
  assert.equal(typeof TRIM_OVER, 'symbol', 'T-356 r2: src/auditDispatch.mjs exports no TRIM_OVER sentinel');
  assert.equal(Dispatch.TRIM_SCAN, K, 'T-356 r2: src/auditDispatch.mjs exports no TRIM_SCAN; the fixtures below are sized to a bound the code does not declare');
  assert.equal(UNPLACED.ROW_UNREADABLE, 'row_unreadable', 'T-356 r2: UNPLACED has no ROW_UNREADABLE code: an unreadable row has nowhere to surface');
});
/* Every code unit the RUNNING engine trims, asked of the engine (rule 21: derived, not typed). */
const ENGINE_WS = [];
for (let c = 0; c < 0x10000; c += 1) if (String.fromCharCode(c).trim() === '') ENGINE_WS.push(String.fromCharCode(c));
/* Look-alikes the engine does NOT trim (Unicode 8 moved U+180E out; U+200B/U+2060 are format characters; NEL is not
 * ECMAScript whitespace), lone surrogates, a pair, NUL. */
const NEAR_WS = [String.fromCharCode(0x200b), String.fromCharCode(0x180e), '\u0085', String.fromCharCode(0x2060), '\ud800', '\udfff', '\u{1F600}', '\u0000'];

test('T-356 r2: THE BOUNDED TRIM AGREES WITH THE ENGINE ON EVERY CODE UNIT', () => {
  /* Positive first (rule 5): the engine set is not empty and holds the two ends of the range. */
  assert.ok(ENGINE_WS.includes(' ') && ENGINE_WS.includes(String.fromCharCode(0xfeff)), 'premise: the engine trims a space and a BOM');
  assert.equal(ENGINE_WS.length, 25, `premise: this engine trims ${ENGINE_WS.length} code units, not the 25 the predicate was written for; re-derive isWs`);
  let checked = 0; const wrong = [];
  for (let c = 0; c < 0x10000; c += 1) {
    const ch = String.fromCharCode(c);
    const s = `${ch}a${ch}`;
    checked += 1;
    if (boundedTrim(s) !== s.trim()) wrong.push(`U+${c.toString(16).toUpperCase().padStart(4, '0')}`);
  }
  assert.equal(checked, 0x10000);
  assert.deepEqual(wrong, [], `T-356 r2: boundedTrim disagrees with String.prototype.trim on ${wrong.length} code unit(s): ${wrong.slice(0, 8).join(' ')}`);
});

test('T-356 r2: UP TO THE BOUND, boundedTrim IS String.prototype.trim -- generated over the engine set, run lengths and positions', () => {
  const cores = ['', 'a', 'a b', `a${String.fromCharCode(0x3000, 0x3000)}b`, '\ud800', '\u{1F600}', String.fromCharCode(0x180e), 'x'.repeat(100), 'PENDING'];
  /* The one place the two differ BY DESIGN: a string that is all whitespace and longer than K is refused (the
   * leading scan runs past the bound before it can learn the string holds nothing), where trim returns ''. Its
   * str() is null either way, and the next test pins the refusal. Everywhere else the answer must be trim's. */
  const want = (s) => (s.trim() === '' && s.length > K ? TRIM_OVER : s.trim());
  let cases = 0; let overs = 0; const wrong = [];
  const check = (s, label = JSON.stringify(s.slice(0, 12))) => {
    cases += 1;
    const w = want(s);
    if (w === TRIM_OVER) overs += 1;
    if (boundedTrim(s) !== w) wrong.push(label);
  };
  for (const w of [...ENGINE_WS, ...NEAR_WS]) {
    for (const core of cores) {
      for (const r of [1, 2, K - 1, K]) {
        const p = w.repeat(r);
        for (const s of [p + core, core + p, p + core + p]) check(s);
      }
    }
  }
  /* Every ordered pair of engine whitespace around one character: two different units at the two ends. */
  for (const a of ENGINE_WS) for (const b of ENGINE_WS) check(`${a}q${b}`, `pair ${JSON.stringify(a + b)}`);
  for (const s of ['', ' ', ' '.repeat(K), 'a', ' a', 'a ']) check(s);
  assert.ok(cases > 4000, `premise: only ${cases} cases were generated`);
  assert.equal(overs, 50, `premise: exactly the 25 engine units x 2 run lengths give an all-whitespace string longer than K (got ${overs})`);
  assert.deepEqual(wrong, [], `T-356 r2: ${wrong.length} of ${cases} generated strings trimmed differently from the engine: ${wrong.slice(0, 6).join(' ')}`);
});

test('T-356 r2: PAST THE BOUND THE STRING IS NOT READ -- one run of K+1 is refused, and exactly K is still trimmed', () => {
  const over = (s) => boundedTrim(s) === TRIM_OVER;
  /* THE POSITIVE FIRST (rule 5): exactly K on both ends is read whole. */
  assert.equal(boundedTrim(`${' '.repeat(K)}PENDING${' '.repeat(K)}`), 'PENDING', 'T-356 r2: a run of exactly K was refused; the bound is off by one');
  for (const w of ENGINE_WS) {
    assert.ok(over(`${w.repeat(K + 1)}PENDING`), `T-356 r2: a leading run of K+1 ${JSON.stringify(w)} was read past the bound`);
    assert.ok(over(`PENDING${w.repeat(K + 1)}`), `T-356 r2: a trailing run of K+1 ${JSON.stringify(w)} was read past the bound`);
    assert.ok(over(w.repeat(K + 1)), `T-356 r2: an all-whitespace string of K+1 ${JSON.stringify(w)} was read past the bound`);
    assert.equal(boundedTrim(w.repeat(K)), '', `T-356 r2: an all-whitespace string of exactly K ${JSON.stringify(w)} is not blank`);
  }
  /* Internal whitespace is content, at any length: never scanned, never refused. */
  const internal = `a${' '.repeat(1e6)}b`;
  assert.equal(boundedTrim(internal), internal, 'T-356 r2: an internal run was trimmed or refused');
  /* A near-miss is content too: the engine does not trim it, so neither does this, and a run of K+1 of it is read. */
  for (const w of NEAR_WS) assert.equal(boundedTrim(w.repeat(K + 1)), w.repeat(K + 1), `T-356 r2: a run of K+1 ${JSON.stringify(w)} was trimmed or refused, and the engine trims none of it`);
  /* OVER is where the row surfaces: a padded audit_id is refused and NAMED, a padded-to-K one is placed as before. */
  const plan = (id) => proposeAudit({ jobs: [job({ audit_id: id })], sessions: [seat('reviewer-one')], now: T0, isLive: allLive });
  assert.equal(plan(`${' '.repeat(K)}audit-1${' '.repeat(K)}`).proposals[0]?.audit_id, 'audit-1', 'T-356 r2: an audit_id padded to exactly K was not placed with its text unchanged');
  assert.deepEqual(plan(`${' '.repeat(K + 1)}audit-1`).unassigned.map((u) => [u.audit_id, u.code]), [[null, UNPLACED.ROW_UNREADABLE]],
    'T-356 r2: an audit_id padded past K was not surfaced as an unreadable row');
});

test('T-356 r2 (V1-F1): 1e8 SPACES A SIDE COST proposeAudit NO TRIM AT ALL -- the verifier\'s rig, gated by a trim count and an output shape', { timeout: 180000 }, (t) => {
  /* live/T-356/work/verify1/F1-whitespace-stall.json: JSON.parse('"' + ' '.repeat(N) + '3' + ' '.repeat(N) + '"'),
   * N = 1e8, at audit_id / state / seat.session_id / seat.agent_id; base and candidate 2.0-2.6 s per call. */
  const N = 1e8;
  const padded = JSON.parse(`"${' '.repeat(N)}3${' '.repeat(N)}"`);
  assert.equal(padded.length, 2 * N + 1, 'premise: the padded string was built through JSON.parse at the recorded size');
  const trim = t.mock.method(String.prototype, 'trim');
  const rowSites = ['audit_id', 'state', 'claimed_by', 'author_session', 'author_source', 'candidate_sha'];
  const cases = [
    ...rowSites.map((f) => [f, () => proposeAudit({
      jobs: [job(f === 'claimed_by' ? { state: JOB.CLAIMED, claimed_at: T0 - 1, [f]: padded } : { [f]: padded })],
      sessions: [seat('reviewer-one')], now: T0, isLive: allLive,
    })]),
    ['seat.session_id', () => proposeAudit({ jobs: [job()], sessions: [seat('reviewer-one', { session_id: padded })], now: T0, isLive: allLive })],
    ['seat.agent_id', () => proposeAudit({ jobs: [job()], sessions: [seat('reviewer-one', { agent_id: padded })], now: T0, isLive: allLive })],
    ['review_attempts', () => proposeAudit({ jobs: [job({ review_attempts: padded })], sessions: [seat('reviewer-one')], now: T0, isLive: allLive })],
  ];
  /* THE OUTPUT SHAPE per kind of site, exactly (Controller decision: a corrupt row surfaces, it is never dropped).
   * One expectation per site kind, looked up rather than branched, and every site is asserted by exactly one. */
  const shape = {
    seat: (r, site) => {
      const field = site.slice(5);
      assert.deepEqual(r.seats, [{ session_id: field === 'session_id' ? null : 'reviewer-one', agent_id: field === 'agent_id' ? null : 'reviewer-one', busy: true, unreadable: [field] }],
        `V1-F1: a seat whose ${field} is padded past the bound is not marked busy and unreadable`);
      assert.deepEqual(r.proposals, [], `V1-F1: a seat whose ${field} could not be read was offered work`);
      assert.equal(r.unassigned[0]?.code, UNPLACED.ALL_SEATS_BUSY);
      assert.match(r.unassigned[0].why, /1 seat\(s\) with more than 4096 whitespace characters around an id are not offered work/,
        'V1-F1: the job\'s reason does not say the seat could not be read');
    },
    counter: (r) => {
      assert.deepEqual(r.proposals, []);
      assert.equal(r.unassigned[0]?.code, UNPLACED.REVIEW_EXHAUSTED);
      assert.match(r.unassigned[0].why, /^review_attempts is " {199}… \(string\), which is not a count\. /, 'V1-F1: a padded counter was not shown cut and named as not a count');
    },
    row: (r, site) => {
      assert.deepEqual(r.proposals, [], `V1-F1: a row whose ${site} could not be read was dispatched`);
      assert.equal(r.unassigned.length, 1, `V1-F1: the row whose ${site} could not be read did not surface exactly once: ${JSON.stringify(r.unassigned).slice(0, 200)}`);
      assert.deepEqual([r.unassigned[0].audit_id, r.unassigned[0].code], [site === 'audit_id' ? null : 'audit-1', UNPLACED.ROW_UNREADABLE],
        `V1-F1: the row whose ${site} could not be read was not surfaced as ROW_UNREADABLE with its id`);
      assert.ok(r.unassigned[0].why.startsWith(`${site} is a string with more than ${K} whitespace characters at one end, so the text was not read`),
        `V1-F1: the reason does not name the field: ${r.unassigned[0].why.slice(0, 120)}`);
    },
  };
  const kindOf = (site) => (site.startsWith('seat.') ? 'seat' : site === 'review_attempts' ? 'counter' : 'row');
  let asserted = 0;
  for (const [site, call] of cases) {
    trim.mock.resetCalls();
    const t0 = performance.now();
    const r = call();
    const ms = performance.now() - t0;
    /* THE STRUCTURE: the whole call made no native trim. On the r1 candidate this was 6-15 calls per row. */
    assert.equal(trim.mock.callCount(), 0, `V1-F1: ${site} padded with 1e8 spaces a side made proposeAudit call String.prototype.trim ${trim.mock.callCount()} time(s): the scan is not bounded`);
    /* THE CLOCK, a thousand-fold over the honest cost (about 20 us): a bar this far from the cost is not load noise. */
    assert.ok(ms < 2000, `V1-F1: ${site} padded with 1e8 spaces a side took ${ms.toFixed(0)} ms`);
    shape[kindOf(site)](r, site);
    asserted += 1;
  }
  assert.equal(asserted, cases.length, 'premise: every padded site was asserted');
  /* THE POSITIVE (rule 5): the mock sees a trim when one happens, so zero above is a count and not a dead mock. */
  ' x '.trim();
  assert.equal(trim.mock.callCount(), 1, 'premise: the trim mock does not count calls');
});

test('T-356 r2: EVERY TEXT FIELD PAST THE BOUND REFUSES THE ROW WHOLE AND NAMES ITSELF -- and a row padded within it is placed unchanged', () => {
  const pad = (s) => `${' '.repeat(K + 1)}${s}`;
  const rowSites = {
    audit_id: { audit_id: pad('audit-1') },
    state: { state: pad(JOB.PENDING) },
    claimed_by: { state: JOB.CLAIMED, claimed_at: T0 - 1, claimed_by: pad('reviewer-one') },
    author_session: { author_session: pad('somebody-else') },
    author_source: { author_source: pad('trailer') },
    candidate_sha: { candidate_sha: pad(SHA) },
  };
  for (const [field, over] of Object.entries(rowSites)) {
    const r = proposeAudit({ jobs: [job(over), job({ audit_id: 'audit-2' })], sessions: [seat('reviewer-one')], now: T0, isLive: allLive });
    /* T-356 r3 (V2-F1): the claimed_by case is a LIVE claim whose holder cannot be read, and that blocks every
     * seat (the V2-F1 test pins the shape); every other field lets the well-formed row take the seat. */
    const blocksAll = field === 'claimed_by';
    assert.deepEqual(r.proposals.map((p) => p.audit_id), blocksAll ? [] : ['audit-2'],
      blocksAll ? 'T-356 r3: a live claim with an unreadable holder let the well-formed row take the seat' : `T-356 r2: with ${field} past the bound the well-formed row was not the one placed`);
    const refused = r.unassigned.filter((u) => u.code === UNPLACED.ROW_UNREADABLE);
    assert.deepEqual(refused.map((u) => u.audit_id), [field === 'audit_id' ? null : 'audit-1'],
      `T-356 r2: the row whose ${field} is past the bound did not surface as ROW_UNREADABLE: ${JSON.stringify(r.unassigned).slice(0, 160)}`);
    assert.deepEqual(r.unassigned.filter((u) => u.code !== UNPLACED.ROW_UNREADABLE).map((u) => [u.audit_id, u.code]), blocksAll ? [['audit-2', UNPLACED.ALL_SEATS_BUSY]] : [],
      `T-356 r2: unexpected other reasons for ${field}: ${JSON.stringify(r.unassigned).slice(0, 160)}`);
    assert.ok(refused[0].why.startsWith(`${field} is a string with more than ${K} whitespace`), `T-356 r2: the reason for ${field} does not name it`);
  }
  /* Two fields at once are both named. */
  const two = proposeAudit({ jobs: [job({ state: pad(JOB.PENDING), author_session: pad('x') })], sessions: [seat('reviewer-one')], now: T0, isLive: allLive });
  assert.ok(two.unassigned[0].why.startsWith('state, author_session are strings with more than'), `T-356 r2: two unreadable fields are not both named: ${two.unassigned[0].why.slice(0, 80)}`);
  /* THE AUTHOR EXCLUSION CANNOT BE WALKED AROUND BY PADDING: the author's own seat, the author padded, no dispatch. */
  const laundered = proposeAudit({ jobs: [job({ author_session: pad('session_AUTHOR') })], sessions: [seat('session_AUTHOR')], now: T0, isLive: allLive });
  assert.deepEqual(laundered.proposals, [], 'T-356 r2: a padded author_session handed the candidate to its author');
  assert.equal(laundered.unassigned[0]?.code, UNPLACED.ROW_UNREADABLE);
  /* THE POSITIVE (rule 5): padding within the bound reads exactly as before, at every field, text unchanged. */
  const within = (s) => `${' '.repeat(K)}${s}${'\t'.repeat(K)}`;
  const ok = proposeAudit({
    jobs: [job({ audit_id: within('audit-1'), state: within(JOB.PENDING), candidate_sha: within(SHA), author_session: within('someone'), author_source: within('trailer') })],
    sessions: [seat('reviewer-one', { session_id: within('reviewer-one'), agent_id: within('reviewer-one') })], now: T0, isLive: allLive,
  });
  assert.deepEqual(ok.proposals.map((p) => [p.audit_id, p.candidate_sha, p.session_id, p.agent_id]), [['audit-1', SHA, 'reviewer-one', 'reviewer-one']],
    `T-356 r2: a row padded within the bound was not placed with its text unchanged: ${JSON.stringify(ok.unassigned).slice(0, 160)}`);
  assert.deepEqual(ok.seats, [{ session_id: 'reviewer-one', agent_id: 'reviewer-one', busy: false }]);
  /* A CLAIMED row whose holder is padded past the bound: EXPIRED, it marks no seat busy and says only that a
   * field this refuses could decide a lease; LIVE, it blocks every seat (T-356 r3 / V2-F1, its own test). */
  const held = proposeAudit({ jobs: [job({ state: JOB.CLAIMED, claimed_at: T0 - CLAIM_LEASE_MS - 1, claimed_by: pad('reviewer-one') }), job({ audit_id: 'audit-2' })], sessions: [seat('reviewer-one')], now: T0, isLive: allLive });
  assert.deepEqual(held.proposals.map((p) => p.audit_id), ['audit-2']);
  assert.equal(held.unassigned[0]?.code, UNPLACED.ROW_UNREADABLE);
  assert.match(held.unassigned[0].why, /a field this refuses could otherwise decide the author exclusion or a lease$/);
});

test('T-356 r2: A COUNT IS READ ONLY WHEN IT IS SHORT -- the bounded scan and a 20-character limit before the regex and Number()', () => {
  const plan = (v) => proposeAudit({ jobs: [job({ review_attempts: v })], sessions: [seat('reviewer-one')], now: T0, isLive: allLive });
  /* THE POSITIVE FIRST (rule 5): a count padded to exactly K on each side, and a 20-character zero-padded one, still read. */
  assert.equal(plan(`${' '.repeat(K)}1${' '.repeat(K)}`).proposals.length, 1, 'T-356 r2: a count padded to exactly K was refused');
  assert.equal(plan(`${'0'.repeat(19)}1`).proposals.length, 1, 'T-356 r2: a 20-character count was refused');
  /* Past either bound: unreadable, so exhausted, with the text shown cut. */
  for (const [label, v] of [['padded K+1', `${' '.repeat(K + 1)}1`], ['21 characters', `${'0'.repeat(20)}1`], ['1e6 digits', `1${'0'.repeat(1e6)}`], ['digits then x', `${'1'.repeat(30)}x`]]) {
    const r = plan(v);
    assert.deepEqual(r.proposals, [], `T-356 r2: a ${label} count was read as a number and dispatched`);
    assert.equal(r.unassigned[0]?.code, UNPLACED.REVIEW_EXHAUSTED, `T-356 r2: a ${label} count did not refuse as exhausted`);
    /* Shown as JSON text: whole and quoted when short, or the first 200 characters (the opening quote and 199
     * more) with an ellipsis when cut -- the cap of describeValue, T-316 F-A. */
    assert.match(r.unassigned[0].why, /^review_attempts is "(?:[\s\S]{0,198}"|[\s\S]{199}…) \(string\), which is not a count\. /, `T-356 r2: a ${label} count was not shown as a string that is not a count`);
  }
  /* And the reader still agrees with the writer on what a readable count is (T-298 B-20): a 21-character zero-padded
   * string is one the writer never produces, so refusing it moves no production row. */
  assert.equal(nextAttempt(`${'0'.repeat(20)}1`, 1000), 2, 'premise: nextAttempt reads the 21-character count as 1; the two ends now differ ONLY on a text the writer never writes');
});

test('T-356 r2 (V1-F3): A NULL OR ABSENT first_seen_at SORTS FIRST, as it always did -- pinned, so a key change cannot move it', () => {
  const order = (a, b) => proposeAudit({
    jobs: [job({ audit_id: 'x', first_seen_at: a }), job({ audit_id: 'y', first_seen_at: b })],
    sessions: [seat('reviewer-one')], now: T0, isLive: allLive,
  }).proposals[0].audit_id;
  const { first_seen_at: _drop, ...absent } = job({ audit_id: 'x' });
  const orderAbsent = (b) => proposeAudit({
    jobs: [absent, job({ audit_id: 'y', first_seen_at: b })], sessions: [seat('reviewer-one')], now: T0, isLive: allLive,
  }).proposals[0].audit_id;
  assert.equal(order(null, '2026-09-20T00:00:00Z'), 'x', 'V1-F3: a null first_seen_at no longer sorts before a real timestamp');
  assert.equal(order('2026-09-20T00:00:00Z', null), 'y', 'V1-F3: a null first_seen_at no longer sorts before a real timestamp (reversed input)');
  assert.equal(orderAbsent('2026-09-20T00:00:00Z'), 'x', 'V1-F3: an absent first_seen_at no longer sorts before a real timestamp');
  assert.equal(order(null, JSON.parse('{"a":1}')), 'x', 'V1-F3: a null first_seen_at no longer sorts before a corrupt one');
  /* null and absent tie, so the id decides: x before y, and y before x when the ids swap. */
  assert.equal(orderAbsent(null), 'x', 'V1-F3: null and absent no longer tie on the timestamp key');
  assert.equal(proposeAudit({
    jobs: [job({ audit_id: 'y', first_seen_at: null }), { ...absent, audit_id: 'x' }], sessions: [seat('reviewer-one')], now: T0, isLive: allLive,
  }).proposals[0].audit_id, 'x', 'V1-F3: the id tiebreak between null and absent is not total');
  /* THE PREMISE (rule 6): the timestamp key really decides here -- a real older timestamp beats a real newer one. */
  assert.equal(order('2026-09-19T00:00:00Z', '2026-09-20T00:00:00Z'), 'x');
});

test('T-356 r3 (V2-F1): A LIVE CLAIM WHOSE HOLDER CANNOT BE READ BLOCKS EVERY SEAT -- fail closed, surfaced, said', () => {
  /*
   * The blind verifier's shape (ledger section 9, probe P1): a CLAIMED row inside its lease with
   * claimed_by padded past the bound, and a second PENDING job. Round 2
   * PROPOSED the second job to the seat holding the first (base and r1 kept
   * it busy). Unknown must fail CLOSED: every seat busy, the row surfaced,
   * both reasons saying why.
   */
  const pad = (s) => `${' '.repeat(K + 1)}${s}`;
  const held = (over) => job({ audit_id: 'audit-1', state: JOB.CLAIMED, claimed_at: T0 - 1, claimed_by: 'sess-A', ...over });
  const second = job({ audit_id: 'audit-2' });
  const plan = (rows, seats = [seat('sess-A')]) => proposeAudit({ jobs: rows, sessions: seats, now: T0, isLive: allLive });
  /* THE PREMISE (rule 6): with the holder READABLE this shape blocks the one seat -- so the padded case below
   * measures the padding, not the fixture. */
  const readable = plan([held({}), second]);
  assert.deepEqual(readable.proposals, [], 'premise: a readable live holder no longer blocks its seat');
  assert.equal(readable.unassigned[0]?.code, UNPLACED.ALL_SEATS_BUSY);
  for (const [label, over] of [['claimed_by', { claimed_by: pad('sess-A') }], ['state', { state: pad(JOB.CLAIMED) }],
    ['claimed_by and state', { claimed_by: pad('sess-A'), state: pad(JOB.CLAIMED) }]]) {
    const r = plan([held(over), second]);
    assert.deepEqual(r.proposals, [], `V2-F1: a live claim whose ${label} could not be read freed its seat: ${JSON.stringify(r.proposals.map((p) => p.audit_id))} was proposed`);
    assert.deepEqual(r.seats, [{ session_id: 'sess-A', agent_id: 'sess-A', busy: true }], `V2-F1: the seat is not marked busy when the live holder's ${label} cannot be read`);
    assert.deepEqual(r.unassigned.map((u) => [u.audit_id, u.code]), [['audit-2', UNPLACED.ALL_SEATS_BUSY], ['audit-1', UNPLACED.ROW_UNREADABLE]],
      `V2-F1: the unassigned shape is wrong for an unreadable ${label}: ${JSON.stringify(r.unassigned).slice(0, 200)}`);
    assert.match(r.unassigned[0].why, /a live claim's holder could not be read \(1 row\(s\): every seat is treated as busy until the row is repaired/,
      `V2-F1: ALL_SEATS_BUSY does not say the live holder could not be read: ${r.unassigned[0].why}`);
    assert.match(r.unassigned[1].why, /Its clock says the claim is LIVE and its holder cannot be read, so every seat is treated as busy until it is repaired/,
      `V2-F1: the refused row does not say it blocks every seat: ${r.unassigned[1].why.slice(-160)}`);
  }
  /* EVERY seat, not one: two healthy seats, both blocked. */
  const two = plan([held({ claimed_by: pad('sess-A') }), second], [seat('sess-A'), seat('sess-B')]);
  assert.deepEqual(two.proposals, [], 'V2-F1: a second seat was offered work beside an unreadable live holder');
  assert.deepEqual(two.seats.map((s) => s.busy), [true, true]);
  /* THE POSITIVE (rule 5): the clock decides. An EXPIRED claim with an unreadable holder blocks nothing (it is no
   * live claim under any reading) and neither does one with no claimed_at; the row still surfaces. */
  for (const [label, over] of [['expired', { claimed_by: pad('sess-A'), claimed_at: T0 - CLAIM_LEASE_MS - 1 }], ['no claimed_at', { claimed_by: pad('sess-A'), claimed_at: null }]]) {
    const r = plan([held(over), second]);
    assert.deepEqual(r.proposals.map((p) => p.audit_id), ['audit-2'], `V2-F1: an ${label} claim with an unreadable holder blocked the seat: ${JSON.stringify(r.unassigned).slice(0, 160)}`);
    assert.deepEqual(r.seats, [{ session_id: 'sess-A', agent_id: 'sess-A', busy: false }]);
    assert.deepEqual(r.unassigned.map((u) => [u.audit_id, u.code]), [['audit-1', UNPLACED.ROW_UNREADABLE]], `V2-F1: the ${label} row did not surface`);
    assert.doesNotMatch(r.unassigned[0].why, /every seat is treated as busy/, `V2-F1: the ${label} row claims to block seats`);
  }
  /* And an unreadable field that is NOT a holder field on a live claim blocks nothing on its own account. */
  const other = plan([held({ author_source: pad('trailer') }), second]);
  assert.equal(other.proposals.length, 0, 'premise: the readable holder still blocks its seat');
  assert.doesNotMatch(other.unassigned[1].why, /every seat is treated as busy/, 'V2-F1: a non-holder field was read as an unknown holder');
});

test('T-356 r3 (V2-F2): A SEAT WHOSE IDS ARE BOTH UNREADABLE IS STILL A SEAT -- busy and named, never "no live seat"', () => {
  /* The verifier's D10: drop `|| s.unreadable` from the seat filter and a seat with both ids past the bound
   * vanishes, so a roster of one such seat reads as NO_LIVE_SEAT ("nothing is consuming this queue") when a
   * reviewer IS there with an id nobody can read. Only this test pads both ids at once. */
  const pad = (s) => `${' '.repeat(K + 1)}${s}`;
  const both = seat('sess-A', { session_id: pad('sess-A'), agent_id: pad('sess-A') });
  const alone = proposeAudit({ jobs: [job()], sessions: [both], now: T0, isLive: allLive });
  assert.deepEqual(alone.seats, [{ session_id: null, agent_id: null, busy: true, unreadable: ['session_id', 'agent_id'] }],
    `V2-F2: a seat with both ids unreadable was dropped from seats: ${JSON.stringify(alone.seats)}`);
  assert.deepEqual(alone.proposals, []);
  assert.equal(alone.unassigned[0]?.code, UNPLACED.ALL_SEATS_BUSY, `V2-F2: a lone unreadable seat read as ${alone.unassigned[0]?.code}, not as a busy seat`);
  assert.match(alone.unassigned[0].why, /1 seat\(s\) with more than 4096 whitespace characters around an id are not offered work/);
  /* THE POSITIVE (rule 5): beside a healthy seat the job is placed there, and the unreadable seat is still listed. */
  const pair = proposeAudit({ jobs: [job()], sessions: [both, seat('sess-B')], now: T0, isLive: allLive });
  assert.deepEqual(pair.proposals.map((p) => p.session_id), ['sess-B']);
  assert.equal(pair.seats.length, 2, 'V2-F2: the unreadable seat vanished beside a healthy one');
});

test('T-298 B-20: END TO END, propose -> claim -> requeue never re-dispatches past the bound', () => {
  /*
   * The daemon's non-attributable re-queue path, serialised through JSON as
   * the JSONL queue store does, driven until the dispatcher refuses.
   */
  const run = (start) => {
    let row = start === '<absent>' ? job() : job({ review_attempts: start });
    let dispatches = 0;
    for (let i = 0; i < 20; i += 1) {
      const now = T0 + i * 10 * CLAIM_LEASE_MS;
      const r = proposeAudit({ jobs: [row], sessions: [seat('reviewer-one')], now, isLive: allLive });
      if (r.proposals.length === 0) return { dispatches, code: r.unassigned[0]?.code };
      const c = claimJob(row, { by: 'reviewer-one', now });
      assert.equal(c.ok, true, `claimJob refused a proposed pairing: ${c.why}`);
      dispatches += 1;
      row = JSON.parse(JSON.stringify({
        ...c.job, state: JOB.PENDING, claimed_by: null, claimed_at: null,
        review_attempts: nextAttempt(c.job.review_attempts, MAX_REVIEW_ATTEMPTS),
      }));
    }
    return { dispatches, code: 'NEVER_STOPPED' };
  };
  /* THE POSITIVE FIRST (rule 5): a fresh row is dispatched up to the bound. */
  assert.deepEqual(run('<absent>'), { dispatches: MAX_REVIEW_ATTEMPTS, code: UNPLACED.REVIEW_EXHAUSTED });
  const want = { null: 0, 0: 3, 1: 2, 3: 0, NaN: 0, '': 0, 2: 1 };
  for (const [label, value] of [['null', null], ['0', 0], ['1', 1], ['3', 3], ['NaN', NaN], ['""', ''], ['"2"', '2']]) {
    const key = value === null ? 'null' : Number.isNaN(value) ? 'NaN' : String(value);
    assert.deepEqual(run(value), { dispatches: want[key], code: UNPLACED.REVIEW_EXHAUSTED },
      `B-20 end to end: review_attempts ${label}`);
  }
});
