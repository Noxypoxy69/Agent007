/**
 * STRANDED-CLAIM RECOVERY, END TO END THROUGH THE REAL MERGE.
 *
 * P0 item 1, Danny 2026-09-20, after the audits listing reported 25 PENDING,
 * 8 CLAIMED, and the consumer dead:
 *
 *     "durable READY/PENDING audit job + eligible live reviewer -> dispatcher
 *      atomically claims it -> reviewer starts it. Reviewer dies / lease
 *      expires -> claim becomes reclaimable automatically -> no permanent
 *      CLAIMED tombstone."
 *
 * WHY THIS FILE EXISTS WHEN claimJob IS ALREADY TESTED. `auditJob.test.mjs`
 * proves the PURE FUNCTION reclaims a stale claim. That is the logic, and the
 * logic was never the part in doubt. Rule 17: the wiring is a separate claim,
 * and only the logic had tests. A reviewer does not call `claimJob` on a
 * literal -- it calls it on whatever `mergeQueue` handed back after a turn, so
 * the question that matters is whether the CLOCK the staleness test reads
 * survives that round trip. If `claimed_at` is dropped or reset anywhere in
 * the merge, every claim looks fresh forever and the tombstone is permanent,
 * with `claimJob` still passing its own unit tests the whole time.
 *
 * So every case here goes through mergeQueue first, on purpose.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeQueue, claimJob, JOB, CLAIM_LEASE_MS } from '../src/auditJob.mjs';

const A = 'a'.repeat(40);
const TREE_A = '1'.repeat(40);

const job = (over = {}) => ({
  audit_id: 'audit-1',
  candidate_sha: A,
  candidate_tree_sha: TREE_A,
  touched: ['src/guardSession.mjs'],
  state: JOB.PENDING,
  claimed_by: null,
  claimed_at: null,
  ...over,
});

/** One turn of the CLI: read the store, recompute, merge, write it back. */
const aTurn = (stored, computed, now = 'now') => mergeQueue(stored, computed, { now }).queue;

test('THE FULL RECOVERY PATH: reviewer claims, dies, lease expires, a second reviewer takes it', () => {
  const CLAIMED_AT = 1_000_000;

  /* 1. A durable PENDING job is claimed by the first reviewer. */
  const enqueued = aTurn([], [job()]);
  assert.equal(enqueued.length, 1, 'the job did not become durable');
  assert.equal(enqueued[0].state, JOB.PENDING);

  const first = claimJob(enqueued[0], { by: 'reviewer-one', now: CLAIMED_AT });
  assert.equal(first.ok, true, `the first claim was refused: ${first.why}`);
  assert.equal(first.job.state, JOB.CLAIMED);
  assert.equal(first.job.claimed_by, 'reviewer-one');

  /*
   * 2. The reviewer dies without recording a verdict, and A TURN PASSES.
   *    This is the step the pure-function test cannot make: the job is
   *    written to the store and recomputed, which is where a dropped
   *    `claimed_at` would reset the staleness clock and strand it forever.
   */
  const afterATurn = aTurn([first.job], [job()]);
  assert.equal(afterATurn.length, 1);
  assert.equal(afterATurn[0].state, JOB.CLAIMED, 'the merge reset a live claim to PENDING');
  assert.equal(afterATurn[0].claimed_by, 'reviewer-one', 'the merge forgot who holds it');
  assert.equal(afterATurn[0].claimed_at, CLAIMED_AT,
    'THE STALENESS CLOCK DID NOT SURVIVE THE MERGE, and it breaks BOTH ways. '
    + 'Reset it to now on each merge and the lease never expires: a permanent '
    + 'tombstone, with claimJob still passing its own unit tests throughout. Drop it '
    + 'to null and every live claim is instantly stealable instead. Both were watched '
    + 'failing here on 2026-09-20; the first takes 5 of these 6 tests red, the second 2.');

  /* 3. Inside the lease, a second reviewer is correctly refused. */
  const tooSoon = claimJob(afterATurn[0], {
    by: 'reviewer-two', now: CLAIMED_AT + CLAIM_LEASE_MS - 1,
  });
  assert.equal(tooSoon.ok, false, 'a live claim was stolen from its holder');
  assert.match(tooSoon.why, /claimed this/);

  /*
   * 4. PAST the lease, ownership transfers. Asserted on the far end -- who
   *    actually holds it afterwards -- not on `ok` alone, which is a proxy for
   *    a transfer that may not have happened (rule 4).
   */
  const reclaimed = claimJob(afterATurn[0], {
    by: 'reviewer-two', now: CLAIMED_AT + CLAIM_LEASE_MS + 1,
  });
  assert.equal(reclaimed.ok, true, `the expired claim was not reclaimable: ${reclaimed.why}`);
  assert.equal(reclaimed.job.claimed_by, 'reviewer-two', 'ownership did not transfer');
  assert.equal(reclaimed.job.claimed_at, CLAIMED_AT + CLAIM_LEASE_MS + 1,
    'the clock did not restart for the new holder, so its own lease is already spent');
  assert.equal(reclaimed.job.state, JOB.CLAIMED);
});

test('THE BOUNDARY IS THE LEASE, not a number this test made up', () => {
  /*
   * Derived from the shipped constant, never typed (rule 21). If somebody
   * shortens CLAIM_LEASE_MS this keeps testing the real boundary instead of
   * silently testing a point well inside it.
   */
  const t = 5_000_000;
  const held = aTurn([job({ state: JOB.CLAIMED, claimed_by: 'one', claimed_at: t })], [job()])[0];

  assert.equal(claimJob(held, { by: 'two', now: t + CLAIM_LEASE_MS }).ok, false,
    'exactly at the lease the holder still owns it');
  assert.equal(claimJob(held, { by: 'two', now: t + CLAIM_LEASE_MS + 1 }).ok, true,
    'one millisecond past the lease it is still not reclaimable');
});

test('A CLAIM WITH NO TIMESTAMP IS RECLAIMABLE, not immortal', () => {
  /*
   * `mergeQueue` writes `claimed_at: was.claimed_at ?? null`, so a job claimed
   * by an older writer can arrive with a null clock. The dangerous reading is
   * "unknown age, therefore leave it alone" -- that is the tombstone again,
   * created by the one job whose age nobody can compute. Unknown age must fail
   * TOWARD recovery here, because the cost of re-auditing is a duplicate
   * review and the cost of stranding is a control nobody ever clears.
   */
  const noClock = aTurn([job({ state: JOB.CLAIMED, claimed_by: 'ghost', claimed_at: null })], [job()])[0];
  assert.equal(noClock.claimed_at, null, 'the fixture is not the shape it claims to be');

  const r = claimJob(noClock, { by: 'somebody', now: 9_000_000 });
  assert.equal(r.ok, true,
    'a claim with no timestamp is permanently unreclaimable, which is exactly the '
    + '8 stranded jobs measured on 2026-09-20');
  assert.equal(r.job.claimed_by, 'somebody');
});

test('AND THE AUTHOR STILL CANNOT RECOVER ITS OWN STRANDED AUDIT', () => {
  /*
   * A NEGATIVE NEEDS THE POSITIVE (rule 5). Everything above widens who may
   * take a job; this is the one party that must NOT benefit from the widening.
   * Reclaiming a dead reviewer's job is recovery -- unless the party reclaiming
   * it wrote the candidate, in which case it is rule 20 defeated by waiting an
   * hour.
   */
  const t = 3_000_000;
  const stranded = aTurn(
    [job({ state: JOB.CLAIMED, claimed_by: 'dead-reviewer', claimed_at: t })],
    [job()],
  )[0];

  const byAuthor = claimJob(stranded, {
    by: 'session_AUTHOR',
    authorSession: 'session_AUTHOR',
    now: t + CLAIM_LEASE_MS + 1,
  });
  assert.equal(byAuthor.ok, false, 'the author reclaimed its own candidate by outwaiting the lease');
  assert.match(byAuthor.why, /cannot audit it/);

  /* and the positive beside it: a third party at the same instant CAN. */
  const byOther = claimJob(stranded, {
    by: 'session_OTHER',
    authorSession: 'session_AUTHOR',
    now: t + CLAIM_LEASE_MS + 1,
  });
  assert.equal(byOther.ok, true,
    `recovery is blocked for everyone, not just the author: ${byOther.why}`);
});

test('A RECOVERED CLAIM STILL CANNOT SATISFY A GATE, and says so', () => {
  /*
   * Rule 15: let a gate move rather than close. Recovery fixes AVAILABILITY.
   * It must not quietly upgrade TRUST -- a job rescued from a dead reviewer is
   * still independence=unverifiable until P0-5 lands, and the record has to
   * carry that where the verdict is read.
   */
  const t = 7_000_000;
  const stranded = aTurn([job({ state: JOB.CLAIMED, claimed_by: 'dead', claimed_at: t })], [job()])[0];
  const r = claimJob(stranded, { by: 'fresh-reviewer', now: t + CLAIM_LEASE_MS + 1 });

  assert.equal(r.ok, true);
  assert.equal(r.job.satisfies_gate, false,
    'a reclaimed job now claims to satisfy a gate. Availability was fixed and trust '
    + 'was granted along with it');
  assert.notEqual(r.job.independence, 'enforced');
});

test('A TERMINAL VERDICT THAT FALLS OUT OF RANGE -- what actually happens to it', () => {
  /*
   * mergeQueue keeps an out-of-range job only when it is CLAIMED. A PENDING
   * one is dropped deliberately and that is already tested ("resolved: gone
   * from the computed set"). COMPLETED_PASS and COMPLETED_FAIL are neither,
   * and nothing covered them.
   *
   * This test does not assert a preference. It PINS THE OBSERVED BEHAVIOUR so
   * the question stops being re-derived, and names the consequence in the
   * message either way. The durable record of a verdict is
   * docs/audit-ledger.jsonl, which the Stop gate reads -- the queue is a work
   * list -- so a dropped terminal row is a lost WORK record, not a lost
   * clearance. That distinction is the whole reason this is a pin and not a
   * failure.
   */
  for (const state of [JOB.COMPLETED_PASS, JOB.COMPLETED_FAIL]) {
    const after = mergeQueue([job({ state, recorded_by: 'someone', verdict: state })], [], { now: 'now' });
    assert.equal(after.queue.length, 0,
      `${state} survived falling out of range; if that is now intended, this pin is stale`);
    assert.equal(after.stranded.length, 0,
      `${state} was reported as stranded, which would put a finished audit back on the work list`);
  }
});
