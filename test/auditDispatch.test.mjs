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
   * `null` AND `undefined` ARE NOT IN THIS LIST, and that is deliberate.
   * My first version put null here and the test went red, correctly: an
   * absent field is what every row written before this counter existed
   * looks like, and refusing those would stall the whole historical
   * queue. Absent is a legitimate zero; a BLANK or malformed value is
   * not, and `Number('')` being 0 is exactly the footgun that made the
   * loose version dangerous.
   */
  for (const bad of ['', '  ', 'three', '1.5', '-1', {}, [], true, NaN, -1, 1.5, Infinity]) {
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
  for (const ok of [0, 1, '2', undefined, null]) {
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
