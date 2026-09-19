/**
 * A CHECKLIST ITEM MUST NOT BE SATISFIABLE BY SAYING SO.
 *
 * Task Gate exists because on 2026-09-18/19 three agents each certified their
 * own work and all three were wrong -- a launcher gate satisfiable by the
 * launcher PRINTING the words, a commit fence defeated by dropping one
 * character, a gate matching its own subject's error message. 101 commits were
 * pushed with 13 audited, and the detector for that only warned.
 *
 * So the properties under test here are not "does the evaluator compute a
 * number". They are the ones that failed in reality:
 *
 *   - no input marks an item VERIFIED; only evidence does
 *   - evidence from another attempt or another candidate is not weak, it is
 *     inadmissible -- this repo has already shipped a coordinator that judged
 *     attempt 7 and accepted attempt 8
 *   - a blind review produced by the worker is refused (rule 20, mechanical)
 *   - a worker cannot waive its own required item (the forged-grant shape)
 *   - a refusal NAMES what is missing (rule 15)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ITEM_STATES,
  MAKER_MAY_NOT_PRODUCE,
  evidenceMatches,
  admissibleEvidence,
  evaluateTask,
  canAdvance,
} from '../src/taskGate.mjs';

const TEMPLATE = Object.freeze({
  id: 'normal-bug-v1',
  phases: ['reproduce', 'verify', 'blind-review'],
  requirements: {
    reproduce: ['reproduction_result'],
    verify: ['positive_test_result', 'mutation_verifier_result'],
    'blind-review': ['blind_review_result'],
  },
});

const TASK = Object.freeze({
  task_id: 't-1',
  attempt: 3,
  candidate_sha: 'cafe1234',
  worker_id: 'fixer',
  worker_session: 'sess-worker',
});

const ev = (over = {}) => ({
  evidence_id: `e-${Math.random().toString(16).slice(2, 8)}`,
  type: 'reproduction_result',
  task_id: 't-1',
  attempt: 3,
  candidate_sha: 'cafe1234',
  producer_session: 'sess-worker',
  status: 'passed',
  ...over,
});

/* ── the property the whole module exists for ───────────────────────────── */

test('NOTHING a caller can pass marks an item VERIFIED except evidence', () => {
  /*
   * The hostile input is a caller trying every shape of "it is done": a
   * checklist row asserting its own state, and a task claiming completion.
   * Neither is an input the evaluator reads.
   */
  const r = evaluateTask({
    task: { ...TASK, state: 'SHIPPED', checklist_complete: true },
    template: TEMPLATE,
    evidence: [],
    waivers: [],
  });

  assert.equal(r.items.length, 4, 'precondition: the template produced four required items');
  for (const item of r.items) {
    assert.equal(item.state, ITEM_STATES.PENDING,
      `${item.item_id} went green with no evidence -- a box was checked by assertion`);
  }
});

test('a passing proof of the right type, task, attempt and candidate VERIFIES its item', () => {
  const r = evaluateTask({ task: TASK, template: TEMPLATE, evidence: [ev()] });
  const item = r.items.find((i) => i.item_id === 'reproduce:reproduction_result');
  assert.equal(item.state, ITEM_STATES.VERIFIED, 'the positive control: real evidence must work');
  assert.equal(item.evidence_ids.length, 1, 'and the receipt must be recorded');
});

/* ── identity: the attempt-7-accepted-attempt-8 class ───────────────────── */

test('evidence from another ATTEMPT is inadmissible, not merely stale', () => {
  const r = evaluateTask({ task: TASK, template: TEMPLATE, evidence: [ev({ attempt: 2 })] });
  const item = r.items.find((i) => i.item_id === 'reproduce:reproduction_result');
  assert.equal(item.state, ITEM_STATES.PENDING);
  assert.match(item.rejected[0].why, /wrong task, attempt or candidate/);
});

test('evidence against another CANDIDATE sha is inadmissible', () => {
  const r = evaluateTask({ task: TASK, template: TEMPLATE, evidence: [ev({ candidate_sha: 'dead9999' })] });
  assert.equal(r.items.find((i) => i.phase === 'reproduce').state, ITEM_STATES.PENDING);
});

test('evidence for another TASK is inadmissible', () => {
  const r = evaluateTask({ task: TASK, template: TEMPLATE, evidence: [ev({ task_id: 't-2' })] });
  assert.equal(r.items.find((i) => i.phase === 'reproduce').state, ITEM_STATES.PENDING);
});

test('an early phase with no candidate yet is still satisfiable', () => {
  /*
   * The over-block direction. Demanding a candidate_sha match before a
   * candidate exists would make the FIRST item of every task unsatisfiable,
   * which is the kind of gate people route around.
   */
  const noCandidate = { ...TASK, candidate_sha: null };
  const r = evaluateTask({
    task: noCandidate, template: TEMPLATE, evidence: [ev({ candidate_sha: null })],
  });
  assert.equal(r.items.find((i) => i.phase === 'reproduce').state, ITEM_STATES.VERIFIED);
  assert.equal(evidenceMatches(ev({ candidate_sha: null }), noCandidate), true);
});

/* ── rule 20, mechanical ────────────────────────────────────────────────── */

test('A BLIND REVIEW PRODUCED BY THE WORKER IS REFUSED', () => {
  const selfReview = ev({ type: 'blind_review_result', producer_session: 'sess-worker' });
  const { admitted, rejected } = admissibleEvidence('blind_review_result', TASK, [selfReview]);

  assert.equal(admitted.length, 0, 'the author agreeing with themselves is not a review');
  assert.match(rejected[0].why, /not independent \(rule 20\)/);

  /* The positive control: the same artefact from a different session IS admissible. */
  const real = ev({ type: 'blind_review_result', producer_session: 'sess-auditor' });
  assert.equal(admissibleEvidence('blind_review_result', TASK, [real]).admitted.length, 1,
    'an independent reviewer must be able to satisfy it, or the gate is an outage');
});

test('the maker rule covers owner_decision too, and does NOT cover ordinary proofs', () => {
  assert.ok(MAKER_MAY_NOT_PRODUCE.includes('owner_decision'),
    'an agent recording its own owner decision is the forged-grant shape');

  /*
   * And the other direction: a worker MUST be able to produce its own test
   * results. If the maker rule applied to everything, no task could progress.
   */
  const own = ev({ type: 'positive_test_result', producer_session: 'sess-worker' });
  assert.equal(admissibleEvidence('positive_test_result', TASK, [own]).admitted.length, 1);
});

/* ── waivers ────────────────────────────────────────────────────────────── */

test('a worker cannot waive its own required item', () => {
  const selfWaiver = [{ item_id: 'blind-review:blind_review_result', reason: 'busy', granted_by: 'sess-worker' }];
  const r = evaluateTask({ task: TASK, template: TEMPLATE, waivers: selfWaiver });
  assert.equal(r.items.find((i) => i.phase === 'blind-review').state, ITEM_STATES.PENDING);

  const byWorkerId = [{ item_id: 'blind-review:blind_review_result', reason: 'busy', granted_by: 'fixer' }];
  assert.equal(
    evaluateTask({ task: TASK, template: TEMPLATE, waivers: byWorkerId })
      .items.find((i) => i.phase === 'blind-review').state,
    ITEM_STATES.PENDING,
    'nor under its durable agent id',
  );
});

test('an owner waiver with a reason WAIVES the item, and one without a reason does not', () => {
  const good = [{ item_id: 'blind-review:blind_review_result', reason: 'deploy frozen', granted_by: 'danny' }];
  assert.equal(
    evaluateTask({ task: TASK, template: TEMPLATE, waivers: good })
      .items.find((i) => i.phase === 'blind-review').state,
    ITEM_STATES.WAIVED,
  );

  const noReason = [{ item_id: 'blind-review:blind_review_result', granted_by: 'danny' }];
  assert.equal(
    evaluateTask({ task: TASK, template: TEMPLATE, waivers: noReason })
      .items.find((i) => i.phase === 'blind-review').state,
    ITEM_STATES.PENDING,
    'the reason IS the audit trail; a waiver without one records nothing',
  );
});

/* ── failure and progress reporting ─────────────────────────────────────── */

test('only status "passed" admits; absent, running and invented statuses do not', () => {
  /*
   * Found by mutation: every fixture used 'passed' or 'failed', so replacing
   * the status check with `if (false)` -- admitting anything -- left the suite
   * green. A proof that has not finished, or that carries no verdict at all,
   * must not satisfy a requirement. Absence of a verdict is not a pass, which
   * is the same rule as "a failed lookup is not an absence of prior work".
   */
  for (const status of [undefined, null, '', 'running', 'queued', 'PASSED', 'ok', 'true']) {
    const r = evaluateTask({ task: TASK, template: TEMPLATE, evidence: [ev({ status })] });
    const item = r.items.find((i) => i.phase === 'reproduce');
    assert.notEqual(item.state, ITEM_STATES.VERIFIED,
      `status ${JSON.stringify(status)} must not satisfy a requirement`);
  }

  /* Positive control: the exact token still works, so this is not a blanket refusal. */
  assert.equal(
    evaluateTask({ task: TASK, template: TEMPLATE, evidence: [ev({ status: 'passed' })] })
      .items.find((i) => i.phase === 'reproduce').state,
    ITEM_STATES.VERIFIED,
  );
});

test('a proof still running reads as RUNNING, not PENDING', () => {
  const r = evaluateTask({ task: TASK, template: TEMPLATE, evidence: [ev({ status: 'running' })] });
  assert.equal(r.items.find((i) => i.phase === 'reproduce').state, ITEM_STATES.RUNNING,
    'a reader must be able to tell "nobody has started" from "it is in flight"');
});

test('a proof that reports failure marks the item FAILED, not PENDING', () => {
  const r = evaluateTask({ task: TASK, template: TEMPLATE, evidence: [ev({ status: 'failed' })] });
  const item = r.items.find((i) => i.phase === 'reproduce');
  assert.equal(item.state, ITEM_STATES.FAILED, 'a failed proof is worse news than no proof and must read differently');
  assert.equal(r.blocked.length, 1);
});

/* ── advancement ────────────────────────────────────────────────────────── */

test('canAdvance refuses while anything earlier is outstanding, and NAMES it', () => {
  const r = canAdvance({ task: TASK, template: TEMPLATE, evidence: [ev()], targetPhase: 'verify' });
  assert.equal(r.ok, false);
  assert.match(r.why, /verify:positive_test_result/, 'rule 15: a refusal must name the half still open');
  assert.match(r.why, /verify:mutation_verifier_result/);
});

test('canAdvance cannot be satisfied by skipping an earlier phase', () => {
  /*
   * Satisfying only the TARGET phase's own items must not admit advancement,
   * or a task reaches "verified" by doing the easy checks and skipping
   * reproduction entirely.
   */
  const laterOnly = [
    ev({ type: 'positive_test_result' }),
    ev({ type: 'mutation_verifier_result' }),
  ];
  const r = canAdvance({ task: TASK, template: TEMPLATE, evidence: laterOnly, targetPhase: 'verify' });
  assert.equal(r.ok, false, 'the reproduce phase was skipped and advancement was allowed');
  assert.match(r.why, /reproduce:reproduction_result/);
});

test('canAdvance permits once every proof through the target is satisfied', () => {
  const all = [
    ev(),
    ev({ type: 'positive_test_result' }),
    ev({ type: 'mutation_verifier_result' }),
  ];
  const r = canAdvance({ task: TASK, template: TEMPLATE, evidence: all, targetPhase: 'verify' });
  assert.equal(r.ok, true, r.why);
});

test('an unknown target phase is refused rather than treated as reachable', () => {
  const r = canAdvance({ task: TASK, template: TEMPLATE, evidence: [], targetPhase: 'SHIPPED' });
  assert.equal(r.ok, false);
  assert.match(r.why, /not a phase of template normal-bug-v1/);
});
