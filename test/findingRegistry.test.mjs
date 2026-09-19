/**
 * LAYER 0 STEP E. A DEFECT THAT EXISTS ONLY IN PROSE DOES NOT EXIST.
 *
 * THE STATE THIS REPLACES, MEASURED ON THIS REPOSITORY: four audits recorded
 * twelve findings into the free-text `note` field of docs/audit-ledger.jsonl.
 * Some notes end "OPEN", some end "fixed in c9e3d68", some end neither. Nothing
 * can answer "which findings are still open" without a person reading forty
 * lines of English, and nothing connects a finding to the commit that claims to
 * close it.
 *
 * The assertions below are the ones that stop this becoming that. Each is
 * written so it FAILS against the obvious lazy implementation -- an object that
 * stores whatever it is handed -- rather than against nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createFinding, bindRepair, transition, linkToFamily, openFindings,
  findingId, FINDING, FAILURE_CLASSES, SEVERITY,
} from '../src/findingRegistry.mjs';

const CAND = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const NOW = '2026-09-19T18:00:00Z';

const REVIEWER = 'claude-auditor-1';
const FIXER = 'claude-fixer-1';
const THIRD = 'claude-reviewer-2';

const good = {
  task_id: 't-guard',
  audit_id: 'audit-5',
  base_sha: BASE,
  candidate_sha: CAND,
  candidate_tree_sha: TREE,
  failure_class: 'F002',
  title: 'the push fix closed --delete and left -d',
  reproduction: 'judgeShellCommand("git push origin -d main") -> ALLOW',
  expected_behavior: 'DENY, -d is git\'s documented short form of --delete',
  observed_behavior: 'ALLOW; the short matcher was an empty-matching regex',
  affected_paths: ['src/shellAllowlist.mjs'],
  severity: 'high',
  confidence: 'measured',
  created_by_reviewer_session: REVIEWER,
};

const make = (patch = {}) => {
  const r = createFinding({ ...good, ...patch }, { now: NOW });
  assert.equal(r.ok, true, `fixture was refused: ${r.errors?.join('; ')}`);
  return r.finding;
};

/* ── the positive first ───────────────────────────────────────────────── */

test('THE POSITIVE CONTROL: a complete finding is accepted and normalised', () => {
  const f = make();
  assert.equal(f.status, FINDING.OPEN);
  assert.equal(f.severity, 'HIGH', 'severity was not folded to the canonical case');
  assert.equal(f.failure_class, 'F002');
  assert.ok(f.failure_class_version, 'the class list is versioned, so a finding records which version judged it');
  assert.match(f.finding_id, /^F-[0-9a-f]{12}$/);
});

/* ── what makes it a finding rather than an opinion ───────────────────── */

test('A FINDING WITH NO REPRODUCTION IS REFUSED', () => {
  /*
   * The single most important refusal here. A defect nobody can re-run cannot
   * be confirmed fixed, so it can only ever be closed by assertion -- which is
   * the prose ledger with more ceremony.
   */
  const r = createFinding({ ...good, reproduction: '' }, { now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /reproduction is required/);
});

test('A FINDING WITH NO CANDIDATE IDENTITY IS REFUSED', () => {
  /*
   * §9.1. Without it, "is this still broken?" is unanswerable because nobody
   * knows what was being looked at. Each is checked ALONE: a loop that only
   * ever drops both cannot show that either is read.
   */
  for (const [why, patch] of Object.entries({
    'no candidate_sha': { candidate_sha: null },
    'no candidate_tree_sha': { candidate_tree_sha: undefined },
    'a short candidate sha': { candidate_sha: 'abc1234' },
    'a non-hex candidate sha': { candidate_sha: 'z'.repeat(40) },
  })) {
    assert.equal(createFinding({ ...good, ...patch }, { now: NOW }).ok, false, `accepted a finding with ${why}`);
  }
});

test('EVERY REQUIRED NARRATIVE FIELD IS CHECKED, and each alone', () => {
  for (const field of ['title', 'observed_behavior', 'expected_behavior', 'created_by_reviewer_session', 'audit_id']) {
    const r = createFinding({ ...good, [field]: '' }, { now: NOW });
    assert.equal(r.ok, false, `${field} was optional`);
    assert.match(r.errors.join(' '), new RegExp(field));
  }
});

test('AN UNKNOWN FAILURE CLASS IS REFUSED, and the refusal LISTS the classes', () => {
  /*
   * §16 and §23: an unrecognised class admitted "to be safe" cannot be grouped,
   * and a class nobody can group on kills §15 regression injection before it
   * starts. The refusal names the options, because a refusal nobody can act on
   * is an outage (rule 19).
   */
  for (const bad of ['F999', 'STALE_ATTEMPT_WRITE', 'f002', '', null, 'other']) {
    const r = createFinding({ ...good, failure_class: bad }, { now: NOW });
    assert.equal(r.ok, false, `${JSON.stringify(bad)} was accepted as a failure class`);
    assert.match(r.errors.join(' '), /F001/, 'the refusal did not say what the valid classes are');
  }
});

test('EVERY DECLARED CLASS IS ACCEPTED -- the negative above proves nothing alone', () => {
  /*
   * Rule 5: a negative needs the positive first. "F999 is refused" passes
   * against an implementation that refuses everything. Generated from the real
   * manifest, so a class added to §16 extends this without anybody remembering
   * (rule 7).
   */
  for (const cls of Object.keys(FAILURE_CLASSES)) {
    assert.equal(createFinding({ ...good, failure_class: cls }, { now: NOW }).ok, true,
      `${cls} is in the manifest but was refused`);
  }
  assert.ok(Object.keys(FAILURE_CLASSES).length >= 20, 'the class manifest did not load');
});

test('SEVERITY MUST BE ON THE SCALE, in either case', () => {
  for (const s of SEVERITY) {
    assert.equal(createFinding({ ...good, severity: s.toLowerCase() }, { now: NOW }).ok, true);
  }
  for (const bad of ['URGENT', 'p1', '', null, 5]) {
    assert.equal(createFinding({ ...good, severity: bad }, { now: NOW }).ok, false,
      `${JSON.stringify(bad)} was accepted as a severity`);
  }
});

/* ── identity: idempotent per candidate, distinct across candidates ───── */

test('RE-CAPTURING THE SAME DEFECT FROM THE SAME CANDIDATE IS IDEMPOTENT', () => {
  // Otherwise re-running an auditor doubles the backlog.
  assert.equal(make().finding_id, make().finding_id);
});

test('THE SAME FAILURE ON A DIFFERENT CANDIDATE IS A DIFFERENT FINDING (§9.2)', () => {
  /*
   * The two were observed against different code and only one of them may still
   * be true. Merging them lets evidence from the first close the second.
   */
  const a = make();
  const b = make({ candidate_sha: 'd'.repeat(40) });
  const c = make({ candidate_tree_sha: 'e'.repeat(40) });
  assert.notEqual(a.finding_id, b.finding_id, 'a new commit reused the old finding id');
  assert.notEqual(a.finding_id, c.finding_id, 'a changed tree reused the old finding id');
});

test('A DIFFERENT DEFECT ON ONE CANDIDATE IS A DIFFERENT FINDING', () => {
  const a = make();
  assert.notEqual(a.finding_id, make({ title: 'something else entirely' }).finding_id);
  assert.notEqual(a.finding_id, make({ failure_class: 'F003' }).finding_id);
});

test('linkToFamily NEVER MERGES, it links -- and does nothing on one candidate', () => {
  const prior = make();
  const repeat = make({ candidate_sha: 'd'.repeat(40) });
  const linked = linkToFamily(repeat, prior);
  assert.equal(linked.finding_id, repeat.finding_id, 'the id was rewritten; that is a merge');
  assert.equal(linked.linked_to_prior_family, prior.finding_id);

  // Same candidate is the same observation, not a duplicate.
  assert.equal(linkToFamily(prior, prior).linked_to_prior_family, null);
});

/* ── the state machine ────────────────────────────────────────────────── */

test('VERIFIED_FIXED IS UNREACHABLE WITHOUT RETESTING', () => {
  /*
   * §11: a repair is not verified because a fixer says so or a test is green.
   * If BOUND_TO_REPAIR -> VERIFIED_FIXED were legal, a commit would close a
   * finding, which is exactly what the prose ledger does badly.
   */
  const open = make();
  assert.equal(transition(open, FINDING.VERIFIED_FIXED, { by: THIRD }).ok, false,
    'an OPEN finding was closed with no repair and no retest');

  const bound = bindRepair(open, { task_id: 't-fix', attempt: 1, lease_token: 'L1', fixer_session: FIXER },
    { by: THIRD, now: NOW }).finding;
  assert.equal(transition(bound, FINDING.VERIFIED_FIXED, { by: THIRD }).ok, false,
    'committing a repair closed the finding');

  const retest = transition(bound, FINDING.RETESTING, { by: THIRD, now: NOW });
  assert.equal(retest.ok, true, retest.errors?.join('; '));
  assert.equal(transition(retest.finding, FINDING.VERIFIED_FIXED, { by: THIRD, now: NOW }).ok, true);
});

test('A TERMINAL FINDING DOES NOT REOPEN', () => {
  const done = transition(
    transition(bindRepair(make(), { task_id: 't', attempt: 1, lease_token: 'L', fixer_session: FIXER },
      { by: THIRD, now: NOW }).finding, FINDING.RETESTING, { by: THIRD }).finding,
    FINDING.VERIFIED_FIXED, { by: THIRD },
  ).finding;
  for (const to of Object.values(FINDING)) {
    assert.equal(transition(done, to, { by: THIRD }).ok, false, `a VERIFIED_FIXED finding moved to ${to}`);
  }
});

test('AN UNRECOGNISED STATUS IS REFUSED ON BOTH SIDES', () => {
  assert.equal(transition(make(), 'DONE', { by: THIRD }).ok, false);
  assert.equal(transition({ ...make(), status: 'WOBBLY' }, FINDING.REJECTED, { by: THIRD }).ok, false);
  assert.equal(transition(null, FINDING.REJECTED, { by: THIRD }).ok, false);
});

/* ── the one that matters most ────────────────────────────────────────── */

test('THE REPORTER MAY NOT RETIRE ITS OWN FINDING', () => {
  /*
   * The barred party that gets forgotten. An auditor that can mark its own
   * finding REJECTED can retract anything it decides it was wrong about with no
   * second reader, and the finding disappears without ever being answered.
   */
  const r = transition(make(), FINDING.REJECTED, { by: REVIEWER });
  assert.equal(r.ok, false, 'the reporter rejected its own finding');
  assert.match(r.errors.join(' '), /raised this finding/);

  assert.equal(transition(make(), FINDING.REJECTED, { by: THIRD }).ok, true,
    'an independent party could not reject it either -- the rule is barring everyone');
});

test('THE FIXER MAY NOT CLEAR ITS OWN REPAIR (CLAUDE.md rule 20)', () => {
  const bound = bindRepair(make(), { task_id: 't', attempt: 1, lease_token: 'L', fixer_session: FIXER },
    { by: THIRD, now: NOW }).finding;
  const retesting = transition(bound, FINDING.RETESTING, { by: THIRD }).finding;

  const self = transition(retesting, FINDING.VERIFIED_FIXED, { by: FIXER });
  assert.equal(self.ok, false, 'the fixer declared its own repair verified');
  assert.match(self.errors.join(' '), /wrote the repair/);

  assert.equal(transition(retesting, FINDING.VERIFIED_FIXED, { by: THIRD }).ok, true);
});

test('AND THE FIXER CHECK IS NOT HOLLOW: bindRepair MUST record who fixed it', () => {
  /*
   * THE DEFECT THIS MODULE SHIPPED WITH FOR ONE DRAFT. transition() compares
   * against `finding.repair.fixer_session`, and the first bindRepair never wrote
   * that field -- so the comparison was against undefined and no fixer was ever
   * refused. CLAUDE.md hollow gate #3 word for word: a guard that read a column
   * nothing ever wrote. Requiring it is what makes the test above real.
   */
  const r = bindRepair(make(), { task_id: 't', attempt: 1, lease_token: 'L' }, { by: THIRD, now: NOW });
  assert.equal(r.ok, false, 'a repair with no fixer session was bound, and rule 20 then compares against undefined');
  assert.match(r.errors.join(' '), /fixer_session/);
});

test('AN UNNAMED ACTOR CANNOT RETIRE A FINDING', () => {
  /*
   * Fail closed on a missing field. "Who did this?" going unanswered is
   * indistinguishable from the wrong party doing it -- and a null identity
   * adopting someone else's authority is a hole this repository has already
   * shipped and fixed.
   */
  for (const by of [null, undefined, '', '   ']) {
    assert.equal(transition(make(), FINDING.REJECTED, { by }).ok, false,
      `${JSON.stringify(by)} was allowed to reject a finding`);
  }
});

test('BUT A NON-VERDICT MOVE DOES NOT DEMAND INDEPENDENCE', () => {
  /*
   * Rule 19's other direction. Binding a repair and starting a retest are
   * bookkeeping; demanding a third party for those would make the loop need a
   * spare agent for every step, and a loop nobody can run gets bypassed.
   */
  assert.equal(transition(make(), FINDING.BOUND_TO_REPAIR, { by: REVIEWER }).ok, true);
});

/* ── the repair binding ───────────────────────────────────────────────── */

test('A REPAIR BINDING NEEDS THE FULL LEASE IDENTITY (§10.1)', () => {
  for (const [why, patch] of Object.entries({
    'no task_id': { task_id: '' },
    'no attempt': { attempt: null },
    'a non-integer attempt': { attempt: '1' },
    'no lease_token': { lease_token: '' },
  })) {
    const r = bindRepair(make(), { task_id: 't', attempt: 1, lease_token: 'L', fixer_session: FIXER, ...patch },
      { by: THIRD, now: NOW });
    assert.equal(r.ok, false, `bound a repair with ${why}`);
  }
});

test('ATTEMPT 0 IS A REAL ATTEMPT, not a missing one', () => {
  // The falsy-zero trap. A first attempt numbered 0 must not read as absent.
  assert.equal(bindRepair(make(), { task_id: 't', attempt: 0, lease_token: 'L', fixer_session: FIXER },
    { by: THIRD, now: NOW }).ok, true);
});

test('THE BINDING IS RECORDED ON THE FINDING, not left to a commit message', () => {
  const f = bindRepair(make(), { task_id: 't-fix', attempt: 2, lease_token: 'L9', fixer_session: FIXER },
    { by: THIRD, now: NOW }).finding;
  assert.equal(f.status, FINDING.BOUND_TO_REPAIR);
  assert.deepEqual(
    { task_id: f.repair.task_id, attempt: f.repair.attempt, lease_token: f.repair.lease_token, fixer_session: f.repair.fixer_session },
    { task_id: 't-fix', attempt: 2, lease_token: 'L9', fixer_session: FIXER },
  );
});

test('HISTORY ACCUMULATES, so the path is auditable and not just the endpoint', () => {
  const bound = bindRepair(make(), { task_id: 't', attempt: 1, lease_token: 'L', fixer_session: FIXER },
    { by: THIRD, now: NOW }).finding;
  const done = transition(transition(bound, FINDING.RETESTING, { by: THIRD, now: NOW }).finding,
    FINDING.VERIFIED_FIXED, { by: THIRD, now: NOW }).finding;
  assert.deepEqual(done.history.map((h) => `${h.from}->${h.to}`),
    ['OPEN->BOUND_TO_REPAIR', 'BOUND_TO_REPAIR->RETESTING', 'RETESTING->VERIFIED_FIXED']);
  assert.ok(done.history.every((h) => h.by && h.at), 'a history entry with no actor or time proves nothing');
});

/* ── the reader ───────────────────────────────────────────────────────── */

test('openFindings ENUMERATES, it does not merely count', () => {
  /*
   * "3 open" that nobody can list is the prose ledger again. Ranked by severity
   * so a reader gets the worst first without inventing a scale.
   */
  const lo = make({ severity: 'LOW', title: 'a' });
  const hi = make({ severity: 'CRITICAL', title: 'b' });
  const done = transition(transition(bindRepair(make({ title: 'c' }),
    { task_id: 't', attempt: 1, lease_token: 'L', fixer_session: FIXER }, { by: THIRD }).finding,
  FINDING.RETESTING, { by: THIRD }).finding, FINDING.VERIFIED_FIXED, { by: THIRD }).finding;

  const v = openFindings([lo, hi, done]);
  assert.equal(v.total, 3);
  assert.equal(v.open.length, 2, 'a closed finding was still counted as owed');
  assert.equal(v.open[0].severity, 'CRITICAL', 'the worst finding was not first');
  assert.equal(v.byStatus.VERIFIED_FIXED, 1);
  assert.equal(v.byStatus.OPEN, 2);
});

test('openFindings SURVIVES JUNK rather than throwing', () => {
  // A reporter that crashes reports nothing, and nothing looks like all-clear.
  for (const junk of [null, undefined, 'nonsense', 42, [null, undefined, 'x']]) {
    assert.equal(openFindings(junk).open.length, 0);
  }
});

test('THE CONTROL: this module distinguishes, in both directions', () => {
  assert.equal(createFinding(good, { now: NOW }).ok, true);
  assert.equal(createFinding({}, { now: NOW }).ok, false);
  assert.equal(transition(make(), FINDING.REJECTED, { by: THIRD }).ok, true);
  assert.equal(transition(make(), FINDING.REJECTED, { by: REVIEWER }).ok, false);
});

test('findingId IS DERIVED FROM THE CANDIDATE, so no shared counter is needed', () => {
  // Several sessions raise findings on one machine with no coordinator between
  // them; an allocated id would need one.
  assert.equal(
    findingId({ candidate_sha: CAND, candidate_tree_sha: TREE, failure_class: 'F002', title: 'x' }),
    findingId({ candidate_sha: CAND, candidate_tree_sha: TREE, failure_class: 'F002', title: 'x' }),
  );
});
