import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyUpstreamSatisfaction,
  satisfactionIsUsable,
  shouldStart,
  SATISFIED_AT_BASE,
  SATISFIED_UPSTREAM,
  VERIFIABLE_EVIDENCE,
  CHECKPOINTS,
} from '../src/schedule.mjs';

/**
 * THE RACE THIS EXISTS FOR, AS IT ACTUALLY HAPPENED.
 *
 * d-sync-resolver-contract was cut at base fa9d5dc. The behaviour it asked for
 * was implemented upstream as 2c36a72 — AFTER the base — while the contract sat
 * assigned to a worker who had not started. The worker read the integration
 * tree, found it done, and said so. That worked only because a person looked.
 *
 * Every case below is paired with the nearest one that must stay RUNNABLE. A
 * checker that closes contracts too eagerly is worse than none: the work
 * silently belongs to nobody, and unlike a false collision there is no wait to
 * make anyone notice.
 */

const BASE = 'fa9d5dc451c75d28bc083e9a59d6ee7c00a7ad79';
const FIX = '2c36a72aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const UNRELATED = 'd0b745baaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** The real shape: the fix descends from the base, and both are integrated. */
const ancestry = {
  isAncestor: (a, b) => a === BASE && b === FIX,
  inIntegration: (sha) => sha === FIX || sha === BASE || sha === UNRELATED,
};

const contract = (over = {}) => ({ id: 'd-sync-resolver-contract', base_sha: BASE, ...over });
const evidence = (over = {}) => ({
  verified: true,
  sha: FIX,
  evidence: 'test/syncContract.test.mjs: an ASYNC resolver is refused',
  kind: 'test',
  ...over,
});

/* ── the two closures are distinguished ──────────────────────────────── */

test('satisfied ONLY AFTER the base is already_satisfied_upstream', () => {
  const v = classifyUpstreamSatisfaction(contract(), evidence(), ancestry);
  assert.equal(v.satisfied, true);
  assert.equal(v.closure, SATISFIED_UPSTREAM);
  assert.equal(v.satisfying_sha, FIX);
  assert.match(v.reasons[0], /AFTER the contract base/);
});

test('satisfied AT the base is already_satisfied_at_base — a different fault', () => {
  /*
   * Direction decides it. Here the fix does NOT descend from the base, so the
   * behaviour was present when the contract was written: an assignment error,
   * not a race. Reporting the race as this one blames whoever wrote the
   * contract for something nobody could have seen.
   */
  const atBase = { isAncestor: () => false, inIntegration: () => true };
  const v = classifyUpstreamSatisfaction(contract(), evidence(), atBase);
  assert.equal(v.closure, SATISFIED_AT_BASE);
  assert.match(v.reasons[0], /should not have been issued/);
});

test('the two closures are never the same string', () => {
  assert.notEqual(SATISFIED_AT_BASE, SATISFIED_UPSTREAM);
});

/* ── unsatisfied work stays runnable ─────────────────────────────────── */

test('NEAREST CLEAN: no evidence at all leaves the contract runnable', () => {
  const v = classifyUpstreamSatisfaction(contract(), null, ancestry);
  assert.equal(v.satisfied, false);
  assert.equal(shouldStart(contract(), null, ancestry).start, true);
});

test('an UNRELATED upstream commit does not close anything', () => {
  // Master moving is not the same as the task being done. Treating any upstream
  // movement as satisfaction would close every contract on the next merge.
  const v = classifyUpstreamSatisfaction(contract(), evidence({ sha: UNRELATED }), {
    isAncestor: (a, b) => a === BASE && b === FIX, // UNRELATED does not descend from BASE
    inIntegration: () => true,
  });
  assert.equal(v.closure, SATISFIED_AT_BASE, 'still a closure, but not the upstream one');
  const runnable = classifyUpstreamSatisfaction(contract(), null, ancestry);
  assert.equal(runnable.satisfied, false);
});

test('a contract with no evidence is runnable however much master moved', () => {
  const r = shouldStart(contract(), undefined, ancestry);
  assert.equal(r.start, true);
  assert.equal(r.consumes_worker, true);
});

/* ── evidence must be machine-verifiable, never a filename ───────────── */

test('A FILENAME IS NOT EVIDENCE', () => {
  /*
   * The failure this repository keeps hitting. A name-based check announced a
   * working function orphaned because it grepped the wrong identifier, and a
   * commit titled "8.3 spellings included" covered the producer while the
   * scanner stayed blind. Presence is not proof.
   */
  const r = satisfactionIsUsable(evidence({ kind: 'filename' }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /not machine-verifiable/.test(e)), r.errors.join('; '));
});

test('a grep hit is not evidence either', () => {
  assert.equal(satisfactionIsUsable(evidence({ kind: 'grep' })).ok, false);
});

test('NEAREST CLEAN: every verifiable kind is accepted', () => {
  for (const kind of VERIFIABLE_EVIDENCE) {
    assert.equal(satisfactionIsUsable(evidence({ kind })).ok, true, `${kind} should be usable`);
  }
});

test('evidence ASSERTED but not verified is refused', () => {
  // Only an explicit true counts. Same rule as the payload scan and the SMS
  // limiter: a claim is not a check.
  assert.equal(satisfactionIsUsable(evidence({ verified: false })).ok, false);
  assert.equal(satisfactionIsUsable(evidence({ verified: 'yes' })).ok, false);
  assert.equal(satisfactionIsUsable({ sha: FIX, evidence: 'x' }).ok, false);
});

test('evidence with no sha is refused — a claim nobody can re-check', () => {
  assert.equal(satisfactionIsUsable(evidence({ sha: null })).ok, false);
});

test('evidence with no description is refused', () => {
  assert.equal(satisfactionIsUsable(evidence({ evidence: '' })).ok, false);
});

test('unusable evidence leaves the contract RUNNABLE, never half-closed', () => {
  const v = classifyUpstreamSatisfaction(contract(), evidence({ verified: false }), ancestry);
  assert.equal(v.satisfied, false);
  assert.equal(shouldStart(contract(), evidence({ verified: false }), ancestry).start, true);
});

/* ── the satisfying commit must still be there ───────────────────────── */

test('IF THE SATISFYING COMMIT LEAVES THE ANCESTRY, THE TASK IS RUNNABLE AGAIN', () => {
  /*
   * Reverted, dropped in a rebase, or left on an abandoned branch. A closure
   * that outlived its own evidence would leave a hole nobody is assigned to
   * fill — worse than never closing it, because the contract looks handled.
   */
  const gone = { isAncestor: ancestry.isAncestor, inIntegration: () => false };
  const v = classifyUpstreamSatisfaction(contract(), evidence(), gone);
  assert.equal(v.satisfied, false);
  assert.match(v.reasons[0], /NOT in the integration tree/);
  assert.equal(shouldStart(contract(), evidence(), gone).start, true);
});

test('...UNLESS the contract was terminally closed on the record', () => {
  /*
   * An explicit recorded state is not reopened by an ancestry change. Letting
   * it resurrect would make a cancelled contract indistinguishable from one
   * never cancelled — what the supersession ledger refuses, for the same reason.
   */
  const gone = { isAncestor: ancestry.isAncestor, inIntegration: () => false };
  for (const state of ['withdrawn', 'accepted', 'rejected']) {
    const r = shouldStart(contract({ state }), evidence(), gone);
    assert.equal(r.start, false, `${state} must not reopen`);
    assert.equal(r.reason, 'terminal-state');
  }
});

test('NEAREST CLEAN: an assigned contract is not treated as terminal', () => {
  assert.equal(shouldStart(contract({ state: 'assigned' }), null, ancestry).start, true);
});

/* ── both checkpoints, and the second is the one that matters ────────── */

test('there are TWO checkpoints: assignment and worker-start', () => {
  assert.deepEqual(CHECKPOINTS, ['assignment', 'worker-start']);
});

test('THE PRE-START RECHECK CATCHES THE RACE THAT ASSIGNMENT CANNOT', () => {
  /*
   * The exact 15 Sep sequence. At assignment there was no satisfying commit —
   * the contract was correctly issued. The fix landed while the contract waited.
   * A checker that runs only at assignment sees the first and misses the second.
   */
  const atAssignment = shouldStart(contract(), null, ancestry, { checkpoint: 'assignment' });
  assert.equal(atAssignment.start, true, 'correctly assigned: nothing satisfied it yet');

  const atStart = shouldStart(contract(), evidence(), ancestry, { checkpoint: 'worker-start' });
  assert.equal(atStart.start, false, 'the fix landed in between and must be caught here');
  assert.equal(atStart.reason, SATISFIED_UPSTREAM);
  assert.equal(atStart.checkpoint, 'worker-start');
});

test('an unknown checkpoint refuses rather than defaulting', () => {
  const r = shouldStart(contract(), null, ancestry, { checkpoint: 'whenever' });
  assert.equal(r.start, false);
  assert.equal(r.reason, 'unknown-checkpoint');
});

/* ── a closed contract must not consume worker capacity ──────────────── */

test('A SATISFIED CONTRACT CONSUMES NO WORKER', () => {
  const r = shouldStart(contract(), evidence(), ancestry);
  assert.equal(r.consumes_worker, false);
  assert.equal(r.satisfying_sha, FIX);
  assert.ok(r.evidence, 'the closure carries what was checked, so it can be re-checked');
});

test('NEAREST CLEAN: a runnable contract does consume one', () => {
  assert.equal(shouldStart(contract(), null, ancestry).consumes_worker, true);
});

/* ── it decides, it never acts ───────────────────────────────────────── */

test('the decision carries no instruction to close, edit or reassign', () => {
  const r = shouldStart(contract(), evidence(), ancestry);
  assert.doesNotMatch(JSON.stringify(r), /rebase|merge|reassign|autofix|rewrite/i);
});

test('it never mutates the contract or the evidence it is given', () => {
  const d = contract();
  const s = evidence();
  const before = JSON.stringify([d, s]);
  shouldStart(d, s, ancestry);
  assert.equal(JSON.stringify([d, s]), before);
});

test('missing ancestry helpers refuse rather than assuming satisfaction', () => {
  // Defaulting inIntegration to true would close contracts on unverifiable shas.
  const v = classifyUpstreamSatisfaction(contract(), evidence(), {});
  assert.equal(v.satisfied, false);
});
