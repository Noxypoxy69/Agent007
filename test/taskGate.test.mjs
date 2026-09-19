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
  const bound = { task_id: 't-1', attempt: 3, candidate_sha: 'cafe1234' };
  const selfWaiver = [{ item_id: 'blind-review:blind_review_result', reason: 'busy', granted_by: 'sess-worker', ...bound }];
  const r = evaluateTask({ task: TASK, template: TEMPLATE, waivers: selfWaiver });
  assert.equal(r.items.find((i) => i.phase === 'blind-review').state, ITEM_STATES.PENDING);

  const byWorkerId = [{ item_id: 'blind-review:blind_review_result', reason: 'busy', granted_by: 'fixer', ...bound }];
  assert.equal(
    evaluateTask({ task: TASK, template: TEMPLATE, waivers: byWorkerId })
      .items.find((i) => i.phase === 'blind-review').state,
    ITEM_STATES.PENDING,
    'nor under its durable agent id',
  );
});

test('an owner waiver with a reason WAIVES the item, and one without a reason does not', () => {
  const bound = { task_id: 't-1', attempt: 3, candidate_sha: 'cafe1234' };
  const good = [{ item_id: 'blind-review:blind_review_result', reason: 'deploy frozen', granted_by: 'danny', ...bound }];
  assert.equal(
    evaluateTask({ task: TASK, template: TEMPLATE, waivers: good })
      .items.find((i) => i.phase === 'blind-review').state,
    ITEM_STATES.WAIVED,
  );

  const noReason = [{ item_id: 'blind-review:blind_review_result', granted_by: 'danny', ...bound }];
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

/* ══ the fifteen defects a blind audit found in the first version ══════════
 *
 * Every test below fails against 718847d. Each carries its positive control,
 * because half of these fixes TIGHTEN a rule, and a tightened rule that
 * refuses legitimate work is the thing people route around.
 */

test('CRITICAL: the maker rule FAILS CLOSED when either side is missing', () => {
  /*
   * The worst of the fifteen. The check was
   * `MAKER_MAY_NOT_PRODUCE.includes(type) && str(record.producer_session) && ...`
   * so an ABSENT producer short-circuited it and the worker's own blind
   * review was admitted -- with `rejected` EMPTY, so the board showed a clean
   * green review of the author's own work and no trace anything was skipped.
   *
   * Independence is a POSITIVE claim: we must be able to see two different
   * parties. If either side is absent we cannot see it, so it does not count.
   */
  for (const missing of [undefined, null, '', '   ']) {
    const r = admissibleEvidence('blind_review_result', TASK,
      [ev({ type: 'blind_review_result', producer_session: missing })]);
    assert.equal(r.admitted.length, 0,
      `producer_session ${JSON.stringify(missing)} must not clear a blind review`);
    assert.match(r.rejected[0].why, /independence cannot be established/);
  }

  const noWorker = { ...TASK, worker_session: null };
  const mirror = admissibleEvidence('blind_review_result', noWorker,
    [ev({ type: 'blind_review_result', producer_session: 'sess-worker' })]);
  assert.equal(mirror.admitted.length, 0,
    'a task naming no worker cannot establish independence either');
});

test('CRITICAL: one capital letter no longer defeats the maker rule', () => {
  const r = admissibleEvidence('blind_review_result', TASK,
    [ev({ type: 'blind_review_result', producer_session: 'SESS-WORKER' })]);
  assert.equal(r.admitted.length, 0, 'str() trimmed but did not fold, so a case variant walked through');
  assert.match(r.rejected[0].why, /not independent/);
});

test('CRITICAL: canAdvance cannot be fooled by a DUPLICATE phase name', () => {
  /*
   * It used phases.indexOf(target), which returns the FIRST index, so a
   * template whose target also appeared earlier collapsed the window and the
   * task advanced with earlier proofs still PENDING.
   */
  const dup = {
    id: 'dup',
    phases: ['verify', 'reproduce', 'verify'],
    requirements: { reproduce: ['reproduction_result'], verify: ['positive_test_result'] },
  };
  const r = canAdvance({
    task: TASK, template: dup, targetPhase: 'verify',
    evidence: [ev({ type: 'positive_test_result' })],
  });
  assert.equal(r.ok, false, 'the reproduce phase was skipped and advancement was allowed');
  assert.match(r.why, /reproduce:reproduction_result/);
});

test('CRITICAL: a waiver is bound to its task, attempt and candidate', () => {
  /*
   * Item ids are generic -- blind-review:blind_review_result is the same
   * string on every task in the repo -- and the first version checked no
   * identity at all, so ONE waiver replayed across every task forever, and
   * WAIVED counts as satisfied.
   */
  const foreign = [{
    item_id: 'blind-review:blind_review_result',
    reason: 'granted once, long ago',
    granted_by: 'danny',
    task_id: 'SOME-OTHER-TASK',
    attempt: 99,
    candidate_sha: 'deadbeef',
  }];
  assert.equal(
    evaluateTask({ task: TASK, template: TEMPLATE, waivers: foreign })
      .items.find((i) => i.phase === 'blind-review').state,
    ITEM_STATES.PENDING,
    'a waiver granted for other work must not clear this item',
  );

  for (const wrong of [{ attempt: 99 }, { candidate_sha: 'deadbeef' }, { task_id: 'other' }]) {
    const w = [{
      item_id: 'blind-review:blind_review_result',
      reason: 'r',
      granted_by: 'danny',
      task_id: 't-1',
      attempt: 3,
      candidate_sha: 'cafe1234',
      ...wrong,
    }];
    assert.equal(
      evaluateTask({ task: TASK, template: TEMPLATE, waivers: w })
        .items.find((i) => i.phase === 'blind-review').state,
      ITEM_STATES.PENDING,
      `a waiver with the wrong ${Object.keys(wrong)[0]} must not apply`,
    );
  }
});

test('HIGH: an UNKNOWN proof type satisfies nothing, and a near-alias cannot dodge rule 20', () => {
  /*
   * PROOF_TYPES was declared a closed set and enforced nowhere. The sharp
   * version: a requirement named blind_review rather than blind_review_result
   * slipped past MAKER_MAY_NOT_PRODUCE, so one missing suffix in a template
   * turned rule 20 off.
   */
  const vibes = { id: 'v', phases: ['p'], requirements: { p: ['vibes_check'] } };
  assert.equal(
    evaluateTask({ task: TASK, template: vibes, evidence: [ev({ type: 'vibes_check' })] }).items[0].state,
    ITEM_STATES.PENDING,
  );

  const alias = { id: 'a', phases: ['p'], requirements: { p: ['blind_review'] } };
  assert.equal(
    evaluateTask({ task: TASK, template: alias, evidence: [ev({ type: 'blind_review' })] }).items[0].state,
    ITEM_STATES.PENDING,
    'a near-alias must not become a self-signable review',
  );
});

test('HIGH: non-string ids do not match each other through a shared null', () => {
  /*
   * str() collapsed every non-string to null, and null === null, so evidence
   * for task 2 turned task 1 green.
   */
  const numeric = { task_id: 1, attempt: 1, worker_session: 'w' };
  const foreign = {
    evidence_id: 'from-task-2', type: 'reproduction_result',
    task_id: 2, attempt: 1, status: 'passed',
  };
  const tpl = { id: 'n', phases: ['p'], requirements: { p: ['reproduction_result'] } };
  assert.equal(
    evaluateTask({ task: numeric, template: tpl, evidence: [foreign] }).items[0].state,
    ITEM_STATES.PENDING,
    'two absences are not a match',
  );
  assert.equal(evidenceMatches(foreign, numeric), false);
});

test('MEDIUM: evidence that OMITS candidate_sha cannot satisfy a task that declares one', () => {
  const r = evaluateTask({ task: TASK, template: TEMPLATE, evidence: [ev({ candidate_sha: undefined })] });
  assert.equal(r.items.find((i) => i.phase === 'reproduce').state, ITEM_STATES.PENDING,
    'the rule was evaded by deleting the field rather than lying about it');
});

test('MEDIUM: canAdvance is NOT vacuously true for a template that requires nothing', () => {
  const empty = { id: 'e', phases: ['reproduce', 'verify'], requirements: {} };
  const r = canAdvance({ task: TASK, template: empty, targetPhase: 'verify' });
  assert.equal(r.ok, false, 'nothing was verified, so nothing is established');
  assert.match(r.why, /requires no proof/);
});

test('MEDIUM: malformed input is refused, never thrown', () => {
  /*
   * A throw inside a caller's try/catch disables the control silently -- the
   * shape this repository has already paid for in the Stop gate.
   */
  for (const bad of [null, 'nope', {}, 42]) {
    assert.doesNotThrow(() => evaluateTask({ task: TASK, template: TEMPLATE, evidence: bad }));
  }
  for (const phase of ['constructor', 'toString']) {
    const tpl = { id: 'p', phases: [phase], requirements: {} };
    assert.doesNotThrow(() => evaluateTask({ task: TASK, template: tpl, evidence: [] }));
    assert.doesNotThrow(() => canAdvance({ task: TASK, template: tpl, targetPhase: phase }));
  }
  const strReq = { id: 's', phases: ['p'], requirements: { p: 'reproduction_result' } };
  assert.equal(evaluateTask({ task: TASK, template: strReq, evidence: [] }).items.length, 0,
    'a string requirement must not iterate character by character into bogus items');
});

test('MEDIUM: a recorded FAILURE outranks a later pass on the same candidate', () => {
  /*
   * [failed, passed] for the SAME task, attempt and candidate came out
   * VERIFIED with blocked empty -- re-run-until-green against an unchanged
   * artefact, invisible on the board. Nothing about the work changed between
   * those runs, so the failure is still true. A new candidate carries a new
   * sha and is a different question.
   */
  const r = evaluateTask({
    task: TASK, template: TEMPLATE,
    evidence: [ev({ status: 'failed' }), ev({ status: 'passed' })],
  });
  assert.equal(r.items.find((i) => i.phase === 'reproduce').state, ITEM_STATES.FAILED);
  assert.equal(r.blocked.length, 1, 'the field a caller gates on must show it');
});

test('LOW: RUNNING is scoped to this task, and does not leak from another', () => {
  const other = ev({ status: 'running', task_id: 't-999' });
  assert.equal(
    evaluateTask({ task: TASK, template: TEMPLATE, evidence: [other] })
      .items.find((i) => i.phase === 'reproduce').state,
    ITEM_STATES.PENDING,
    'a board that lies about whose work is in flight is still a board that lies',
  );

  assert.equal(
    evaluateTask({ task: TASK, template: TEMPLATE, evidence: [ev({ status: 'running' })] })
      .items.find((i) => i.phase === 'reproduce').state,
    ITEM_STATES.RUNNING,
  );
});

test('LOW: a task with no attempt admits nothing, rather than everything through NaN', () => {
  const noAttempt = { ...TASK, attempt: undefined };
  assert.equal(evidenceMatches(ev(), noAttempt), false);
  assert.equal(evidenceMatches(ev({ attempt: undefined }), noAttempt), false,
    'NaN !== NaN must not become "both absent, therefore equal"');
});

test('LOW: producer_session is read once, so a changing getter cannot mislabel the receipt', () => {
  let reads = 0;
  const sneaky = {
    evidence_id: 'toctou',
    type: 'blind_review_result',
    task_id: 't-1',
    attempt: 3,
    candidate_sha: 'cafe1234',
    status: 'passed',
    get producer_session() { reads += 1; return reads <= 2 ? 'sess-auditor' : 'sess-worker'; },
  };
  const item = evaluateTask({ task: TASK, template: TEMPLATE, evidence: [sneaky] })
    .items.find((i) => i.phase === 'blind-review');
  if (item.state === ITEM_STATES.VERIFIED) {
    assert.equal(item.satisfied_by, 'sess-auditor',
      'the receipt must name the party the decision was actually made on');
  }
});

test('the window for an earlier target still includes phases declared before it', () => {
  /*
   * The regression, stated as its own claim rather than buried in the case
   * above. Target 'reproduce' sits at index 1; 'verify' is declared at index
   * 0, so it is inside the window and its proof is required.
   */
  const dup = {
    id: 'dup',
    phases: ['verify', 'reproduce', 'verify'],
    requirements: { reproduce: ['reproduction_result'], verify: ['positive_test_result'] },
  };
  const r = canAdvance({
    task: TASK, template: dup, targetPhase: 'reproduce',
    evidence: [ev({ type: 'reproduction_result' })],
  });
  assert.equal(r.ok, false,
    'advancing to reproduce was permitted with the verify declared BEFORE it still PENDING');
  assert.match(r.why, /verify:positive_test_result/);
});

test('the checklist is printed in DECLARED phase order, not reordered by a duplicate', () => {
  /*
   * The same reordering showed up on the board: de-duplicating to last moved
   * 'verify' behind 'reproduce', so the phases printed out of the order the
   * template declares them. A board that reorders itself when a template
   * repeats a name is one nobody can read against the template.
   */
  const dup = {
    id: 'dup',
    phases: ['verify', 'reproduce', 'verify'],
    requirements: { reproduce: ['reproduction_result'], verify: ['positive_test_result'] },
  };
  const { items } = evaluateTask({ task: TASK, template: dup });
  const order = [...new Set(items.map((i) => i.phase))];
  assert.deepEqual(order, ['verify', 'reproduce'],
    'phases must appear in the order the template declares them, first occurrence winning');
});
