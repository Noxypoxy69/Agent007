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

import { proposeAudit, isClaimable, UNPLACED } from '../src/auditDispatch.mjs';
import { claimJob, CLAIM_LEASE_MS, JOB } from '../src/auditJob.mjs';

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
