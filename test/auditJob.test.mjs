/**
 * §7.1 AND §7.2: THE AUDIT IS CREATED BY THE COMMIT, AND IT IS BLIND.
 *
 * "This is mandatory. The worker must not remember to request it."
 *
 * The sharp assertion in this file is the SUBJECT one. `auditCoverage` carries a
 * commit subject for every commit, and a commit subject is the maker's own
 * one-line account of the work -- written by the party under review. §7.2 lists
 * the maker summary first among the things a reviewer must not receive before
 * its first verdict. Putting it on the job would tell the reviewer what to
 * conclude before it opened the diff.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  auditJobsFor, assertBlind, auditIdFor, formatAuditJobs, REQUIRED_PROOFS,
  mergeQueue, claimJob, authorSessionFrom, independenceOf, satisfiesGate,
} from '../src/auditJob.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const TREE_A = '1'.repeat(40);
const TREE_B = '2'.repeat(40);
const NOW = '2026-09-19T21:00:00Z';

const trees = { [A]: TREE_A, [B]: TREE_B };
const treeShaFor = (s) => trees[s] ?? null;

const coverage = (over = {}) => ({
  commits: [{
    sha: A,
    subject: 'close one forgery route, and write down the bound on the rest',
    touched: ['src/guardSession.mjs'],
    audited: false,
  }],
  malformed: [],
  error: null,
  ...over,
});

const run = (over = {}) => auditJobsFor(coverage(over), { treeShaFor, now: NOW });

/* ── the blind property ───────────────────────────────────────────────── */

test('THE JOB DOES NOT CARRY THE COMMIT SUBJECT, because that IS the maker summary', () => {
  const { jobs } = run();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].subject, undefined, 'the maker\'s own account of the work reached the reviewer');
  assert.ok(!JSON.stringify(jobs[0]).includes('forgery route'),
    'the subject leaked into the job under some other field');
});

test('BUT WHAT GIT OBSERVED IS KEPT: the touched paths are not the maker\'s claim', () => {
  /*
   * Rule 5. "The job carries no prose" passes against a job carrying nothing at
   * all, which would be useless. The distinction is authorship: a path list is
   * what git measured, a subject is what the author said.
   */
  const { jobs } = run();
  assert.deepEqual(jobs[0].touched, ['src/guardSession.mjs']);
  assert.equal(jobs[0].candidate_sha, A);
  assert.equal(jobs[0].candidate_tree_sha, TREE_A);
  assert.deepEqual(jobs[0].required_proofs, REQUIRED_PROOFS);
});

test('assertBlind REFUSES EVERY FORBIDDEN FIELD, generated from the list it enforces', () => {
  /*
   * Rule 7: generated from the real list, so a field added to the forbidden set
   * extends this without anybody remembering. Each is asserted ALONE -- a loop
   * that only ever adds all of them cannot show which one is read.
   */
  for (const field of ['subject', 'summary', 'message', 'notes', 'claim', 'rootCause', 'suggestedFiles']) {
    assert.throws(
      () => assertBlind({ audit_id: 'x', [field]: 'what I changed and why it is right' }),
      /carries "/,
      `${field} was allowed onto a blind audit job`,
    );
  }
});

test('AND PROSE ARRIVING UNDER AN UNPREDICTED FIELD IS CAUGHT BY ITS CONTENT', () => {
  /*
   * The check that survives a new field. The named list catches what we thought
   * of; assertNoProse slides a window over the maker's text and finds it
   * wherever it landed -- which is the half that still works next month.
   */
  const prose = 'I rewrote the matcher so the sweep spellings are closed for good this time';
  assert.throws(() => assertBlind({ audit_id: 'x', context: prose }, prose));
  assert.throws(() => assertBlind({ audit_id: 'x', nested: { anything: prose } }, prose));
});

test('A CLEAN JOB PASSES -- the positive control for the refusals above', () => {
  const prose = 'I rewrote the matcher so the sweep spellings are closed for good this time';
  const job = { audit_id: 'x', candidate_sha: A, touched: ['src/a.mjs'] };
  assert.equal(assertBlind(job, prose), job);
});

/* ── identity ─────────────────────────────────────────────────────────── */

test('THE SAME CANDIDATE PRODUCES THE SAME AUDIT, so the queue does not grow every turn', () => {
  assert.equal(run().jobs[0].audit_id, run().jobs[0].audit_id);
  assert.equal(
    auditIdFor({ candidate_sha: A, candidate_tree_sha: TREE_A }),
    auditIdFor({ candidate_sha: A, candidate_tree_sha: TREE_A }),
  );
});

test('A MOVED CANDIDATE IS A DIFFERENT AUDIT (§7.3)', () => {
  /*
   * A revised candidate gets a new identity, a new audit and a new reviewer --
   * the old reviewer is not handed "here is what I fixed", which is targeted
   * review wearing the name of a blind one.
   */
  assert.notEqual(
    auditIdFor({ candidate_sha: A, candidate_tree_sha: TREE_A }),
    auditIdFor({ candidate_sha: B, candidate_tree_sha: TREE_A }),
  );
  assert.notEqual(
    auditIdFor({ candidate_sha: A, candidate_tree_sha: TREE_A }),
    auditIdFor({ candidate_sha: A, candidate_tree_sha: TREE_B }),
  );
});

/* ── what does and does not produce a job ─────────────────────────────── */

test('AN AUDITED COMMIT PRODUCES NO JOB', () => {
  assert.equal(run({ commits: [{ ...coverage().commits[0], audited: true }] }).jobs.length, 0);
});

test('AN ERROR IS NOT AN EMPTY QUEUE', () => {
  /*
   * Returning no jobs on a failed lookup would read as "nothing needs auditing"
   * -- the shape this repository refuses for check-first, for liveness and for
   * the pin. The caller is told and decides.
   */
  const r = auditJobsFor({ commits: [], malformed: [], error: 'could not list commits' }, { treeShaFor });
  assert.equal(r.error, 'could not list commits');
  assert.equal(r.jobs.length, 0);
});

test('A CANDIDATE WHOSE TREE CANNOT BE READ IS REPORTED, NOT DROPPED', () => {
  /*
   * Silently skipping it removes the loudest commits from the queue precisely
   * when something unusual has happened to them.
   */
  const r = auditJobsFor(coverage(), { treeShaFor: () => null, now: NOW });
  assert.equal(r.jobs.length, 0);
  assert.deepEqual(r.unmeasurable, [A]);
});

test('JUNK IN THE COVERAGE OBJECT DOES NOT THROW', () => {
  // A trigger that crashes creates no audits, and none looks like none needed.
  for (const junk of [null, undefined, {}, { commits: 'nonsense' }, { commits: [null, 42] }]) {
    assert.doesNotThrow(() => auditJobsFor(junk, { treeShaFor }));
    assert.equal(auditJobsFor(junk, { treeShaFor }).jobs.length, 0);
  }
});

test('THE CONTROL: this distinguishes, in both directions', () => {
  assert.equal(run().jobs.length, 1);
  assert.equal(run({ commits: [] }).jobs.length, 0);
});

/* ── the queue, and independence as a machine predicate ──────────────── */

const job = (over = {}) => ({
  audit_id: 'audit-1', candidate_sha: A, candidate_tree_sha: TREE_A,
  touched: ['src/guardSession.mjs'], state: 'PENDING', claimed_by: null, claimed_at: null, ...over,
});

test('THE AUTHOR OF A CANDIDATE CANNOT AUDIT IT -- machine-enforced', () => {
  /*
   * Danny's correction, and the difference between a queue and a control: "the
   * author being ineligible must be a machine-enforced predicate, not reviewer
   * etiquette." The first version compared the typed claimant against nothing,
   * so an author could close its own candidate.
   *
   * The queue's own first entry audits the commit that created the queue. That
   * one in particular must not be closable by whoever wrote it.
   */
  const r = claimJob(job(), { by: 'session_AAA', authorSession: 'session_AAA', now: 1000 });
  assert.equal(r.ok, false);
  assert.match(r.why, /authored this candidate/);

  const ok = claimJob(job(), { by: 'session_BBB', authorSession: 'session_AAA', now: 1000 });
  assert.equal(ok.ok, true, 'an independent claimant was refused too, so the rule bars everyone');
});

test('THE AUTHOR IS READ FROM THE CANDIDATE, not from git\'s author field', () => {
  /*
   * Every commit in this repository carries one git identity, so `%an` cannot
   * separate three agents. The Claude-Session trailer can, and the authoring
   * session writes it at commit time.
   */
  assert.equal(
    authorSessionFrom('a subject\n\nbody\n\nClaude-Session: https://claude.ai/code/session_01Js46oMDbKpQSxM2JhKitUp'),
    'session_01Js46oMDbKpQSxM2JhKitUp',
  );
  assert.equal(authorSessionFrom('no trailer at all'), null);
  assert.equal(authorSessionFrom(''), null);
  assert.equal(authorSessionFrom(null), null);
});

test('AN UNSIGNED CANDIDATE IS UNVERIFIABLE, and the record says so', () => {
  /*
   * An author who omits the trailer is not thereby cleared. The claim succeeds
   * -- refusing would block every commit that predates the convention -- but it
   * records `unverifiable` rather than claiming independence it did not check.
   * A record that said "independent" for all three cases would be the proxy
   * rule 4 is about: right until the one case where it matters.
   */
  assert.equal(claimJob(job(), { by: 'x', authorSession: null, now: 1 }).job.independence, 'unverifiable');
});

test('THE TRAILER CANNOT PRODUCE `enforced`, BECAUSE THE AUTHOR WRITES IT', () => {
  /*
   * THE HOLE I SHIPPED AND DANNY CAUGHT. I introduced the Claude-Session
   * trailer as the machine-enforced independence predicate. The author writes
   * that trailer: it can carry any session string, including another agent's,
   * and the comparison would then pass. Author-controlled evidence cannot
   * establish that the reviewer is not the author.
   *
   * It stays as corroboration -- cheap, and it catches the honest case -- but
   * it is capped at `asserted` however the claimant was identified.
   */
  const trailerOnly = claimJob(job(), {
    by: 'b', authorSession: 'a', authorSource: 'trailer', bySource: 'resolved', now: 1,
  });
  assert.equal(trailerOnly.job.independence, 'asserted',
    'author-written provenance was treated as authority');
  assert.equal(trailerOnly.job.satisfies_gate, false);

  /* And a defaulted authorSource is treated as the trailer, not as authority. */
  assert.equal(claimJob(job(), { by: 'b', authorSession: 'a', bySource: 'resolved', now: 1 })
    .job.independence, 'asserted');
});

test('ONLY AN AUTHORITATIVE AUTHOR PLUS A RESOLVED CLAIMANT IS `enforced`', () => {
  /*
   * Generated over the whole matrix, because the interesting property is which
   * combinations DO NOT qualify -- and a test naming only the passing one
   * cannot show that.
   */
  for (const authorSource of [null, 'trailer', 'authoritative']) {
    for (const claimantSource of ['asserted', 'resolved']) {
      const v = independenceOf({ authorSource, claimantSource });
      const expected = authorSource === null
        ? 'unverifiable'
        : (authorSource === 'authoritative' && claimantSource === 'resolved' ? 'enforced' : 'asserted');
      assert.equal(v, expected, `${authorSource} + ${claimantSource}`);
    }
  }
});

test('ONLY `enforced` MAY SATISFY A GATE', () => {
  /*
   * The mechanical failure this closes: pass --by a string that is not the
   * author, get ASSERTED, record a PASS, satisfy the control. The gate would
   * be cleared by whoever typed the most convenient name -- the trust problem
   * Layer 0 exists to remove, rebuilt one layer down.
   */
  assert.equal(satisfiesGate({ independence: 'enforced' }), true);
  assert.equal(satisfiesGate({ independence: 'asserted' }), false);
  assert.equal(satisfiesGate({ independence: 'unverifiable' }), false);
  assert.equal(satisfiesGate({}), false);
  assert.equal(satisfiesGate(null), false);
});

test('NOTHING THIS QUEUE PRODUCES TODAY SATISFIES A GATE, and it says so', () => {
  /*
   * Rule 9: a fixture must be a shape the system really produces. There is no
   * authoritative attempt record yet and no session resolves a principal, so
   * every claim available today is diagnostic. Asserting it here means the day
   * that changes, this test changes with it deliberately rather than silently.
   */
  const real = claimJob(job(), { by: 'session_B', authorSession: 'session_A', now: 1 });
  assert.equal(real.ok, true);
  assert.equal(real.job.independence, 'asserted');
  assert.equal(real.job.satisfies_gate, false,
    'an audit that cannot prove independence was allowed to satisfy a control');
});

test('ONE AUDITOR PER CANDIDATE, but a stale claim is reclaimable', () => {
  const held = job({ state: 'CLAIMED', claimed_by: 'first', claimed_at: 1000 });
  assert.equal(claimJob(held, { by: 'second', now: 1000 + 60_000 }).ok, false,
    'a live claim was taken from under its holder');
  assert.equal(claimJob(held, { by: 'second', now: 1000 + 2 * 60 * 60_000 }).ok, true,
    'an auditor that died holding a job parked it forever');
  assert.equal(claimJob(held, { by: 'first', now: 1000 + 60_000 }).ok, true,
    'the holder could not re-enter its own claim');
});

test('A CLAIM NEEDS A NAME, and a DONE job is not reclaimable', () => {
  assert.equal(claimJob(job(), { by: null, now: 1 }).ok, false);
  assert.equal(claimJob(job({ state: 'DONE' }), { by: 'x', now: 1 }).ok, false);
  assert.equal(claimJob(null, { by: 'x', now: 1 }).ok, false);
});

test('mergeQueue DEDUPES, PRESERVES A CLAIM, AND DROPS WHAT IS RESOLVED', () => {
  const stored = [job({ state: 'CLAIMED', claimed_by: 'someone', claimed_at: 5 })];
  const again = mergeQueue(stored, [job()], { now: 'now' });
  assert.equal(again.queue.length, 1, 'the same candidate was enqueued twice');
  assert.equal(again.queue[0].state, 'CLAIMED', 'the trigger reset a claimed job to PENDING');
  assert.equal(again.added.length, 0);

  /* Resolved: gone from the computed set, and it was only PENDING. */
  assert.equal(mergeQueue([job()], [], { now: 'now' }).queue.length, 0);
});

test('A CLAIMED JOB THAT FALLS OUT OF RANGE IS KEPT AND FLAGGED', () => {
  /*
   * The computed set is a 50-commit window. Dropping a claimed job because the
   * candidate scrolled past it would silently cancel an audit somebody is
   * running.
   */
  const held = job({ state: 'CLAIMED', claimed_by: 'someone', claimed_at: 5 });
  const m = mergeQueue([held], [], { now: 'now' });
  assert.equal(m.queue.length, 1);
  assert.equal(m.queue[0].no_longer_in_range, true);
  assert.deepEqual(m.stranded, ['audit-1']);
});

/* ── the regression this feature introduced, found by blind audit ─────── */

test('AN ORDINARY SUBJECT DOES NOT POISON THE QUEUE', () => {
  /*
   * D1, HIGH, MEASURED BY A BLIND AUDIT. `assertNoProse` compared the subject
   * against the WHOLE job -- which carries eight English REQUIRED_PROOFS
   * sentences and the touched file paths -- so the guard fired on the job's own
   * content. Three of these are verbatim required-proof entries and all of them
   * are this repository's commit idiom.
   *
   * In the Stop gate the throw was swallowed by the reporter's catch, skipping
   * `escalationBlock = block` -- so a single such commit in the window silently
   * discarded the audit-escaped BLOCK that shipped before this feature existed,
   * on every turn. A feature that disarms an older control is worse than the
   * feature not existing.
   */
  for (const subject of [
    'Harden scripts/claude-stop-gate.mjs against a silent disarm',
    'probe for bypasses rather than confirming the fix',
    'check the caller wiring, not only the logic',
    'reproduce the original failure before believing the fix',
    'run the opposite-direction test, and the mutation',
    `Revert ${B} because it regressed the gate`,
  ]) {
    const r = run({ commits: [{ ...coverage().commits[0], subject }] });
    assert.equal(r.jobs.length, 1, `subject poisoned the queue: ${subject}`);
    assert.equal(r.refused.length, 0, `subject caused a withheld job: ${subject}`);
  }
});

test('auditJobsFor NEVER THROWS, whatever the subject is', () => {
  /*
   * Narrowing the comparison removes the known false positives. It is not
   * sufficient: a guard whose failure mode is "disarm a DIFFERENT control" must
   * not be able to fail that way for any input, including ones nobody has
   * thought of. The throw is contained and the job dropped.
   */
  for (const subject of [
    '', 'x', '', 'a'.repeat(5000), '  ', A, TREE_A,
    JSON.stringify({ required_proofs: REQUIRED_PROOFS }),
  ]) {
    assert.doesNotThrow(
      () => auditJobsFor(coverage({ commits: [{ ...coverage().commits[0], subject }] }), { treeShaFor }),
      `threw on subject ${JSON.stringify(subject.slice(0, 40))}`,
    );
  }
});

test('THE WIRING IS ASSERTED, not just the logic: auditJobsFor APPLIES assertBlind', () => {
  /*
   * D2. The auditor deleted `assertBlind` from the pipeline entirely -- pushing
   * the raw job -- and the suite stayed 19/19 green, because every test called
   * assertBlind DIRECTLY and nothing asserted that auditJobsFor used it. Rule
   * 17 verbatim: the wiring is a separate claim from the logic, and only the
   * logic had tests.
   *
   * A subject that IS the candidate sha is a real leak the narrowed check must
   * still catch -- candidate_sha is inside blindView -- so this fails if the
   * call is removed.
   */
  const r = run({ commits: [{ ...coverage().commits[0], subject: A }] });
  assert.equal(r.jobs.length, 0, 'a job whose field matched the subject was queued anyway');
  assert.deepEqual(r.refused, [A], 'the withheld candidate was not reported');
});

test('A WITHHELD JOB IS NAMED WITHOUT REPEATING THE PROSE', () => {
  const out = formatAuditJobs({ jobs: [], unmeasurable: [], refused: [A], error: null });
  assert.match(out, /could not be shown BLIND/);
  assert.match(out, /do not weaken the packet/);
});

test('AN UNPARSEABLE RECORD IS NOT ECHOED into the gate message', () => {
  /*
   * D6. auditCoverage splits on the record separator %x1e emits, so a subject
   * containing a literal 0x1E produces a record whose `sha` holds the PROSE.
   * The first version pushed that value into `unmeasurable` and printed its
   * first eight characters -- the one path that skipped assertBlind was the one
   * carrying unparsed text.
   */
  const leak = 'MY OWN ACCOUNT: THIS FIX IS CORRECT AND COMPLETE, TRUST IT';
  const r = auditJobsFor(coverage({
    commits: [{ sha: leak, subject: '', touched: ['src/a.mjs'], audited: false }],
  }), { treeShaFor });
  assert.equal(r.jobs.length, 0);
  assert.ok(!JSON.stringify(r).includes('MY OWN'), 'the unparsed prose survived into the result');
  assert.ok(!formatAuditJobs(r).includes('MY OWN'), 'the unparsed prose reached the gate message');
});

test('REQUIRED_PROOFS IS PINNED TO ITS CONTENT, not compared against itself', () => {
  /*
   * D3, hollow gate #2. The job took `required_proofs: REQUIRED_PROOFS` and the
   * test asserted deepEqual against the same frozen array, so deleting an entry
   * from the constant left the suite green. The eight §7.4 duties are the whole
   * substance of the demand handed to every reviewer -- they could be silently
   * emptied.
   *
   * Written out here on purpose. This is the one place a literal is right: the
   * duties are a decision about what an audit MEANS, not a value read from the
   * machine, and a second copy is what makes a deletion visible.
   */
  assert.equal(REQUIRED_PROOFS.length, 8, 'a required proof was added or removed silently');
  for (const duty of [
    'reproduce the original failure',
    'verify the claimed closure independently',
    'probe for bypasses rather than confirming the fix',
    'probe neighbouring regressions',
    'run the opposite-direction test',
    'run the required mutation and confirm a NAMED assertion fires',
    'check the caller wiring, not only the logic',
    'confirm the candidate identity did not move while you read',
  ]) {
    assert.ok(REQUIRED_PROOFS.includes(duty), `the §7.4 duty "${duty}" is no longer demanded`);
  }
});

/* ── the gate's half, which the gate itself cannot test ───────────────── */

test('formatAuditJobs NAMES THE QUEUE and points at the full packet', () => {
  const out = formatAuditJobs(run());
  assert.match(out, /audit-due/);
  assert.match(out, /src\/guardSession\.mjs/, 'the touched control was not named');
  assert.match(out, /check-audit-coverage\.mjs --jobs/, 'a reader cannot reach the packet');
});

test('AND IT STILL DOES NOT LEAK THE SUBJECT into the gate message', () => {
  /*
   * The formatter is a second place the maker summary could arrive, and it is
   * the one an operator actually reads. assertBlind guards the job; this guards
   * the rendering of it.
   */
  assert.ok(!formatAuditJobs(run()).includes('forgery route'));
});

test('NOTHING DUE PRINTS NOTHING, so the caller can interpolate without deciding', () => {
  assert.equal(formatAuditJobs({ jobs: [], unmeasurable: [], error: null }), '');
  assert.equal(formatAuditJobs({ jobs: [], unmeasurable: [] }), '');
});

test('AN UNREADABLE CANDIDATE IS SAID OUT LOUD, not silently absent from the queue', () => {
  const out = formatAuditJobs({ jobs: [], unmeasurable: [A], error: null });
  assert.match(out, /could not be read/);
  assert.match(out, /UNKNOWN, not audited/);
});

test('AN ERROR RENDERS AS UNKNOWN, never as an empty queue', () => {
  const out = formatAuditJobs({ jobs: [], unmeasurable: [], error: 'git was unreachable' });
  assert.match(out, /audit-jobs-unknown/);
  assert.match(out, /not as "none are due"/);
});

test('formatAuditJobs COERCES EVERY FIELD, because a throw here disarms the whole block', () => {
  /*
   * In the Stop gate this call sits inside a catch whose entire body is the
   * comment "a reporter must never take the gate down". A throw does not
   * surface as an error -- it surfaces as the audit block never firing, on the
   * one turn something unusual happened. formatCoverage shipped exactly this
   * defect and an audit found it; this is the same function one along.
   */
  for (const junk of [
    undefined, null, 'nonsense', 42,
    { jobs: 'not an array', unmeasurable: null },
    { jobs: [null, 42, {}], unmeasurable: [null, undefined] },
    { jobs: [{ audit_id: null, candidate_sha: null, touched: 'nope' }], unmeasurable: [] },
    { jobs: [{ touched: [null, undefined, 7] }], unmeasurable: [{}] },
  ]) {
    assert.doesNotThrow(() => formatAuditJobs(junk), `threw on ${JSON.stringify(junk)}`);
    assert.equal(typeof formatAuditJobs(junk), 'string');
  }
});

test('THE QUEUE IS CAPPED, so a long backlog cannot bury the rest of the gate', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({
    audit_id: `audit-${i}`, candidate_sha: String(i).padStart(40, '0'), touched: ['src/a.mjs'],
  }));
  const out = formatAuditJobs({ jobs: many, unmeasurable: [], error: null });
  assert.match(out, /\.\.\.and 15 more/);
  assert.ok(out.split('\n').length < 25, 'the gate message grew with the backlog');
});
