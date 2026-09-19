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
