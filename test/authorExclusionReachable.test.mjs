/**
 * THE AUTHOR EXCLUSION READ A FIELD NOTHING WROTE.
 *
 * Blind audit D4, HIGH. `author_session` was written in exactly one place in
 * the repository -- inside `claimJob`'s RETURN value -- so on a PENDING job it
 * was always undefined, and every consumer of it was reading nothing:
 *
 *   - `proposeAudit`'s author exclusion computed null and never fired;
 *     UNPLACED.ONLY_AUTHOR_AVAILABLE was dead code in production.
 *   - `scripts/audit-daemon.mjs` passed no `authorSession` to claimJob at all,
 *     so neither the session nor the principal check could fire there. The
 *     daemon could claim, audit and record a candidate it had authored.
 *
 * That is hollow gate 3 exactly: a guard reading a column nothing ever wrote.
 *
 * ═══ WHY THE OLD TEST DID NOT CATCH IT, WHICH IS THE REAL LESSON ═══
 *
 * `test/auditDispatch.test.mjs` covers the exclusion with
 * `job({ author_session: 'session_AUTHOR' })` -- HAND-BUILT. The system could
 * not produce that shape, so the branch could not fail for the real case.
 * Hollow gate 9, in a file written to avoid hollow gates, by me.
 *
 * So every fixture below comes OUT OF `auditJobsFor`. Nothing here types
 * `author_session` into an object literal; if the producer stops producing,
 * these go red.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { auditJobsFor, claimJob } from '../src/auditJob.mjs';
import { proposeAudit, UNPLACED } from '../src/auditDispatch.mjs';

const SHA = 'a'.repeat(40);
const TREE = '1'.repeat(40);
const AUTHOR = 'session_01AUTHOR';

const coverage = () => ({
  commits: [{ sha: SHA, subject: 's', touched: ['src/guardSession.mjs'], audited: false }],
  malformed: [],
  error: null,
});

/** A job as the system really builds it, trailer and all. */
const realJob = (author = AUTHOR) => {
  const r = auditJobsFor(coverage(), {
    treeShaFor: () => TREE,
    authorSessionFor: () => author,
    now: '2026-09-20T00:00:00Z',
  });
  assert.equal(r.error, null, `auditJobsFor refused the fixture: ${r.error}`);
  assert.equal(r.jobs.length, 1, 'the fixture produced no job, so nothing below is tested');
  return r.jobs[0];
};

test('THE PRODUCER EXISTS: auditJobsFor writes author_session onto a PENDING job', () => {
  const job = realJob();
  assert.equal(job.author_session, AUTHOR,
    'author_session has no producer, so every author-exclusion consumer reads undefined');
  assert.equal(job.author_source, 'trailer',
    'the source must say trailer, because a trailer is provenance and can never grade enforced');
  assert.equal(job.state, 'PENDING');
});

test('NO TRAILER IS null, NOT AN EMPTY STRING or a manufactured source', () => {
  /*
   * "Could not determine the author" and "the author is the empty string" must
   * not be the same record -- an empty string compares equal to nothing and
   * would silently disable the check, which is the failure mode this whole
   * field exists to remove.
   */
  const job = realJob(null);
  assert.equal(job.author_session, null);
  assert.equal(job.author_source, null,
    'author_source claims a trailer was read when none was');
});

test('THE DISPATCHER NOW REFUSES THE AUTHOR, on a job it did not invent', () => {
  const job = realJob();
  const r = proposeAudit({
    jobs: [job],
    sessions: [{ session_id: AUTHOR, agent_id: AUTHOR, capacity: 'idle' }],
    now: Date.now(),
    isLive: () => true,
  });
  assert.equal(r.proposals.length, 0, 'the author was offered its own candidate');
  assert.equal(r.unassigned[0].code, UNPLACED.ONLY_AUTHOR_AVAILABLE,
    'refused for some other reason, so the exclusion still is not what fired');

  /* THE POSITIVE (rule 5): a real reviewer is still placed on the same job. */
  const ok = proposeAudit({
    jobs: [job],
    sessions: [{ session_id: 'session_01OTHER', agent_id: 'session_01OTHER', capacity: 'idle' }],
    now: Date.now(),
    isLive: () => true,
  });
  assert.equal(ok.proposals.length, 1,
    `nothing is placeable, so the refusal above proves only that everything is refused: ${JSON.stringify(ok.unassigned)}`);
});

test('AND claimJob REFUSES IT TOO, fed straight from the produced job', () => {
  /*
   * The daemon's path: take the job as built, hand claimJob the fields the
   * job carries. Before D4 was fixed the daemon passed NOTHING here, so this
   * is the assertion that the daemon can no longer audit its own work.
   */
  const job = realJob();
  const asDaemonDoes = (by) => claimJob(job, {
    by,
    bySource: 'asserted',
    authorSession: job.author_session ?? null,
    authorSource: job.author_source ?? null,
    now: Date.now(),
  });

  const self = asDaemonDoes(AUTHOR);
  assert.equal(self.ok, false, 'the daemon claimed a candidate its own session authored');
  assert.match(self.why, /authored this candidate/);

  const other = asDaemonDoes('audit-daemon@somewhere');
  assert.equal(other.ok, true, `an independent claimant was refused: ${other.why}`);
  assert.equal(other.job.satisfies_gate, false,
    'a trailer-sourced author upgraded the verdict to gate-satisfying');
  assert.notEqual(other.job.independence, 'enforced');
});

test('A RESOLVER THAT THROWS DOES NOT TAKE THE QUEUE DOWN', () => {
  /*
   * It reaches git. git fails. auditJobsFor runs inside the Stop gate's
   * reporter, where a throw does not surface as an error -- it surfaces as the
   * whole escalation never firing, which is the documented way this exact
   * function once disarmed a different control.
   */
  const r = auditJobsFor(coverage(), {
    treeShaFor: () => TREE,
    authorSessionFor: () => { throw new Error('git exploded'); },
    now: '2026-09-20T00:00:00Z',
  });
  assert.equal(r.error, null, 'a throwing author resolver took out the whole queue');
  assert.equal(r.jobs.length, 1, 'the job was dropped because its author could not be read');
  assert.equal(r.jobs[0].author_session, null, 'an unreadable author was recorded as something');
});
