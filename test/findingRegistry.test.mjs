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
  createFinding, bindRepair, transition, linkToFamily, openFindings, repairRecord,
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
  assert.match(self.errors.join(' '), /wrote a repair/);

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

test('SUPERSEDED RETIRES A FINDING, SO IT NEEDS AN INDEPENDENT PARTY TOO', () => {
  /*
   * THE DEFECT A BLIND AUDIT MEASURED, AND IT WAS THE CHEAPEST OF THE THREE.
   * NEEDS_INDEPENDENCE listed VERIFIED_FIXED and REJECTED and not SUPERSEDED,
   * which is terminal and which openFindings does not count as open. Through the
   * shipped CLI, in two commands and with NO --by at all, a finding went
   * terminal and vanished from the open list.
   *
   * The list is derived from LEGAL now -- terminal IS the property that matters
   * -- so this also pins that a terminal state added later is covered.
   */
  assert.equal(transition(make(), FINDING.SUPERSEDED, { by: null }).ok, false,
    'an unnamed actor retired a finding');
  assert.equal(transition(make(), FINDING.SUPERSEDED, { by: REVIEWER }).ok, false,
    'the reporter superseded its own finding');
  assert.equal(transition(make(), FINDING.SUPERSEDED, { by: THIRD }).ok, true,
    'an independent party could not supersede it either');

  const openF = make();
  assert.equal(openFindings([openF]).open.length, 1);
  const gone = transition(openF, FINDING.SUPERSEDED, { by: THIRD }).finding;
  assert.equal(openFindings([gone]).open.length, 0,
    'the premise fails: SUPERSEDED does not actually hide a finding');
});

test('EVERY TERMINAL STATE DEMANDS INDEPENDENCE -- generated, not listed', () => {
  /*
   * Rule 7. The previous version was three names typed by hand and one was
   * missing. Derive the expectation from the same shape the subject derives it
   * from, and a fourth terminal state is covered on the day it is added.
   */
  const all = Object.values(FINDING);

  /* Terminal means nothing can leave it -- asked of the subject, not listed. */
  const terminal = all.filter((s) => all.every(
    (to) => transition({ ...make(), status: s }, to, { by: THIRD }).ok === false,
  ));
  assert.ok(terminal.length >= 3, `expected at least three terminal states, found ${terminal.join(', ')}`);

  for (const s of terminal) {
    /*
     * Each terminal state is reachable from a different place -- VERIFIED_FIXED
     * only through RETESTING -- so the source is found rather than assumed. The
     * first draft of this test assumed OPEN and silently skipped VERIFIED_FIXED,
     * which is the fixture-cannot-reach-the-branch shape (hollow gate 9) in the
     * test written to stop a missing terminal state.
     */
    const from = all.find((f) => transition({ ...make(), status: f }, s, { by: THIRD }).ok === true);
    assert.ok(from, `no state reaches ${s}, so this proves nothing about it`);
    const at = { ...make(), status: from };
    assert.equal(transition(at, s, { by: null }).ok, false, `${s} accepted an unnamed actor`);
    assert.equal(transition(at, s, { by: REVIEWER }).ok, false, `${s} accepted the reporter`);
    assert.equal(transition(at, s, { by: THIRD }).ok, true, `${s} refused an independent party`);
  }
});

test('A FIXER CANNOT LAUNDER ITSELF OUT BY RE-BINDING UNDER ANOTHER NAME', () => {
  /*
   * MEASURED BY BLIND AUDIT, four commands, one actor, every one exit 0. The
   * direct refusal worked; the fixer walked the finding back to OPEN, re-bound
   * it naming somebody else, and then cleared it -- because `transition`
   * compared against the CURRENT repair.fixer_session and `bindRepair` takes
   * that from a flag the same actor types.
   */
  const bound = bindRepair(make(), { task_id: 't', attempt: 1, lease_token: 'L', fixer_session: FIXER },
    { by: THIRD, now: NOW }).finding;
  const reopened = transition(bound, FINDING.OPEN, { by: FIXER, now: NOW }).finding;
  const rebound = bindRepair(reopened, {
    task_id: 't', attempt: 2, lease_token: 'L2', fixer_session: 'nobody-in-particular',
  }, { by: FIXER, now: NOW }).finding;
  const retesting = transition(rebound, FINDING.RETESTING, { by: FIXER, now: NOW }).finding;

  const laundered = transition(retesting, FINDING.VERIFIED_FIXED, { by: FIXER, now: NOW });
  assert.equal(laundered.ok, false, 'the fixer cleared its own repair by re-binding under another name');
  assert.match(laundered.errors.join(' '), /wrote a repair/);

  // And the name it hid behind is barred too, and a third party still works.
  assert.equal(transition(retesting, FINDING.VERIFIED_FIXED, { by: 'nobody-in-particular' }).ok, false);
  assert.equal(transition(retesting, FINDING.VERIFIED_FIXED, { by: THIRD }).ok, true);
});

test('THE FIXER HISTORY ONLY GROWS: re-binding can add a name, never remove one', () => {
  const a = bindRepair(make(), { task_id: 't', attempt: 1, lease_token: 'L', fixer_session: 'fix-one' },
    { by: THIRD, now: NOW }).finding;
  const b = bindRepair(transition(a, FINDING.OPEN, { by: THIRD }).finding,
    { task_id: 't', attempt: 2, lease_token: 'L2', fixer_session: 'fix-two' }, { by: THIRD, now: NOW }).finding;
  assert.deepEqual(b.repair_history, ['fix-one', 'fix-two']);
  const rt = transition(b, FINDING.RETESTING, { by: THIRD }).finding;
  for (const who of ['fix-one', 'fix-two']) {
    assert.equal(transition(rt, FINDING.VERIFIED_FIXED, { by: who }).ok, false, `${who} cleared its own repair`);
  }
});

test('A RECORD WRITTEN BEFORE repair_history EXISTED IS STILL CHECKED', () => {
  /*
   * The stored findings on disk predate the field. Falling back to the current
   * binding alone would silently exempt every one of them -- a fix that is
   * correct only for records created after it is not a fix.
   */
  const legacy = {
    ...make(),
    status: FINDING.RETESTING,
    repair: { task_id: 't', attempt: 1, lease_token: 'L', fixer_session: FIXER, bound_at: NOW },
  };
  assert.equal(transition(legacy, FINDING.VERIFIED_FIXED, { by: FIXER }).ok, false);
  assert.equal(transition(legacy, FINDING.VERIFIED_FIXED, { by: THIRD }).ok, true);
});

test('AN ACTOR IS THE SAME PARTY IN ANY CASE', () => {
  /*
   * MEASURED BY BLIND AUDIT: `--by code-a` was refused as the reporter and
   * `--by Code-A` exited 0 on the same finding. `str` trims and does not fold,
   * so a capital letter defeated the whole rule. CLAUDE.md hollow gate #8 --
   * a hostile property checked with three lower-case strings -- and the same
   * case-variant bypass already shipped once for `.Claude/settings.json`.
   *
   * Generated from the real identities rather than three spellings typed here.
   */
  const variants = (s) => [s.toUpperCase(), s.toLowerCase(),
    s.replace(/^./, (c) => c.toUpperCase()), ` ${s.toUpperCase()} `];

  for (const spelling of variants(REVIEWER)) {
    assert.equal(transition(make(), FINDING.REJECTED, { by: spelling }).ok, false,
      `the reporter retired its own finding spelled ${JSON.stringify(spelling)}`);
  }

  const rt = transition(bindRepair(make(), { task_id: 't', attempt: 1, lease_token: 'L', fixer_session: FIXER },
    { by: THIRD, now: NOW }).finding, FINDING.RETESTING, { by: THIRD }).finding;
  for (const spelling of variants(FIXER)) {
    assert.equal(transition(rt, FINDING.VERIFIED_FIXED, { by: spelling }).ok, false,
      `the fixer cleared its own repair spelled ${JSON.stringify(spelling)}`);
  }

  // The positive control: a genuinely different party is still allowed.
  assert.equal(transition(rt, FINDING.VERIFIED_FIXED, { by: THIRD.toUpperCase() }).ok, true);
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

/* ── §12 the repair record ────────────────────────────────────────────── */

const boundFinding = () => bindRepair(make(),
  { task_id: 't-fix', attempt: 1, lease_token: 'L1', fixer_session: FIXER },
  { by: THIRD, now: NOW }).finding;

const goodMeasured = {
  candidate_sha: 'd'.repeat(40),
  candidate_tree_sha: 'e'.repeat(40),
  files_changed: ['src/thing.mjs'],
  before: 'RED',
  after: 'GREEN',
};

test('A REPAIR WHOSE FIXTURE WAS ALREADY GREEN IS REFUSED (§11.2)', () => {
  /*
   * THE ASSERTION THIS FUNCTION EXISTS FOR. A fixture that passed at the base
   * proves the repair did nothing -- either the defect was never reproduced or
   * the fixture does not reach it. Both are the hollow gate this repository is
   * built around, and both look exactly like success in a report that records
   * only the AFTER.
   */
  const r = repairRecord(boundFinding(), { ...goodMeasured, before: 'GREEN' });
  assert.equal(r.ok, false, 'a repair was recorded whose fixture was green before it');
  assert.match(r.errors.join(' '), /not RED at the base/);
});

test('AND A REPAIR THAT IS STILL RED AFTER IS NOT A REPAIR', () => {
  const r = repairRecord(boundFinding(), { ...goodMeasured, after: 'RED' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /not a repair/);
});

test('BOTH VERDICTS ARE REQUIRED, because neither can be read from a repository', () => {
  for (const missing of ['before', 'after']) {
    const r = repairRecord(boundFinding(), { ...goodMeasured, [missing]: undefined });
    assert.equal(r.ok, false, `${missing} was optional`);
    assert.match(r.errors.join(' '), new RegExp(`${missing}_fix_result is required`));
  }
});

test('A REPAIR THAT TOUCHED NO FILE DID NOT HAPPEN', () => {
  /*
   * An empty file list with a green after is the shape a mutation harness
   * produces when the mutation never applied -- rule 2, the most common way to
   * get a wrong green.
   */
  const r = repairRecord(boundFinding(), { ...goodMeasured, files_changed: [] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /mutation-never-applied/);
});

test('THE CANDIDATE MUST HAVE MOVED off the commit the defect was observed on', () => {
  const f = boundFinding();
  const r = repairRecord(f, { ...goodMeasured, candidate_sha: f.candidate_sha });
  assert.equal(r.ok, false, 'a defect was reported fixed by the commit that has it');
});

test('AN UNBOUND FINDING HAS NO REPAIR RECORD, because it attributes the work to nobody', () => {
  const r = repairRecord(make(), goodMeasured);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /not bound to a repair/);
  assert.equal(repairRecord(null, goodMeasured).ok, false);
});

test('THE POSITIVE CONTROL: a real repair produces a record carrying the lease identity', () => {
  const r = repairRecord(boundFinding(), goodMeasured);
  assert.equal(r.ok, true, `a valid repair was refused: ${r.errors?.join('; ')}`);
  assert.equal(r.record.task_id, 't-fix');
  assert.equal(r.record.attempt, 1);
  assert.equal(r.record.fixer_session, FIXER);
  assert.equal(r.record.base_sha, CAND, 'the base is the candidate the defect was OBSERVED on');
  assert.equal(r.record.blind_audit_verdict, null, 'a record must not carry its own verdict');
  assert.equal(r.record.reproduction, good.reproduction, 'the record lost the reproduction');
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
