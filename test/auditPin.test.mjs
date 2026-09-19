/**
 * AN AUDIT THAT FINISHES IS NOT THEREBY AN AUDIT THAT WAS VALID.
 *
 * REPRODUCED WITHOUT TRYING, twice, and the second time by this module's own
 * first version.
 *
 * Round one: four audits ran in one session against a branch three sessions
 * were pushing to. HEAD moved seven commits between assigning a piece of work
 * and starting it. Every verdict was returned with no check that the thing
 * judged still existed.
 *
 * Round two, which is the interesting one: the fix for that pinned
 * `git rev-parse HEAD^{tree}` -- the tree of the COMMIT -- and never looked at
 * `git status`. A blind auditor then used this very tool, pinned a clean tree,
 * and while it read, another session put 193 changed lines into
 * scripts/claude-stop-gate.mjs and more into src/auditLedger.mjs, both files
 * under its audit. It ran `--verify` three times and got
 * `state OK / the candidate is unchanged since the audit started` every time.
 *
 * AN AUDITOR READS FILES, NOT COMMITS. In a shared worktree the files are the
 * thing that moves, and a pin that certifies the commit certifies something
 * nobody looked at.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { capturePin, verifyPin, admitVerdict, PIN } from '../src/auditPin.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const CLEAN = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const DIRTY = '1'.repeat(64);

const good = {
  audit_id: 'audit-1',
  task_id: 't-fence',
  attempt: 7,
  base_sha: A,
  candidate_sha: B,
  candidate_tree_sha: C,
  worktree_digest: CLEAN,
};

/* ── the defect this module shipped with ──────────────────────────────── */

test('A DIRTY WORKING TREE IS STALE EVEN WHEN THE COMMIT HAS NOT MOVED', () => {
  /*
   * THE MEASURED FAILURE, as its own test. Same commit, same committed tree,
   * different files on disk -- which is exactly what an auditor is reading.
   * The first version compared only the three shas and returned OK here.
   */
  const { pin } = capturePin(good);
  const v = verifyPin(pin, { ...good, worktree_digest: DIRTY });
  assert.equal(v.state, PIN.STALE, 'files changed under the audit and the verdict was admitted');
  assert.deepEqual(v.moved, ['worktree_digest']);
});

test('A PIN WITHOUT A WORKTREE DIGEST IS REFUSED AT CAPTURE', () => {
  /*
   * Optional would have been useless: the caller that forgets it is the caller
   * with the problem, and a pin recording only the commit certifies something
   * no auditor reads.
   */
  const r = capturePin({ ...good, worktree_digest: undefined });
  assert.equal(r.ok, false, 'a pin with no working-tree reading was accepted');
  assert.match(r.errors.join('; '), /reads FILES/);
});

test('DECLARED FIELDS ARE NOT COMPARED, so a pin cannot be OK by restatement', () => {
  /*
   * task_id and attempt cannot be read back from a repository. The first
   * version compared them against whatever the VERIFIER passed in, so a pin
   * carrying them was UNKNOWN by default and OK only when the caller restated
   * the pin's own claim -- and could never be STALE for a reason the caller did
   * not choose. Rule 4: the recheck asserted on a value supplied by the party
   * being checked.
   */
  const { pin } = capturePin(good);
  assert.equal(pin.declared.task_id, 't-fence');
  assert.equal(pin.declared.attempt, 7);

  // A reading that says nothing about task or attempt is still OK...
  assert.equal(verifyPin(pin, {
    base_sha: A, candidate_sha: B, candidate_tree_sha: C, worktree_digest: CLEAN,
  }).state, PIN.OK, 'an unmeasurable field made an otherwise-matching audit unverifiable');

  // ...and a reading that CONTRADICTS them changes nothing, because they are
  // not evidence. The binding is recorded; it is not confirmed.
  assert.equal(verifyPin(pin, { ...good, task_id: 'someone-else', attempt: 99 }).state, PIN.OK);
});

/* ── capture ──────────────────────────────────────────────────────────── */

test('THE POSITIVE FIRST: a complete capture is accepted and normalised', () => {
  const r = capturePin({ ...good, candidate_sha: B.toUpperCase() });
  assert.equal(r.ok, true, `a complete capture was refused: ${r.errors?.join('; ')}`);
  assert.equal(r.pin.candidate_sha, B, 'a sha was not normalised to lower case');
});

test('AN INCOMPLETE CAPTURE IS REFUSED, not silently partial', () => {
  for (const [why, patch] of Object.entries({
    'no audit_id': { audit_id: '' },
    'no candidate_sha': { candidate_sha: null },
    'no candidate_tree_sha': { candidate_tree_sha: undefined },
    'a short candidate sha': { candidate_sha: 'abc1234' },
    'a non-hex sha': { candidate_sha: 'z'.repeat(40) },
    'no worktree digest': { worktree_digest: '' },
  })) {
    const r = capturePin({ ...good, ...patch });
    assert.equal(r.ok, false, `accepted a capture with ${why}`);
    assert.ok(r.errors.length > 0, `${why} was refused without saying why`);
  }
  assert.equal(capturePin().ok, false, 'an empty capture was accepted');
});

test('task and attempt are OPTIONAL, because an honest audit may have none', () => {
  const r = capturePin({
    audit_id: 'a', candidate_sha: B, candidate_tree_sha: C, worktree_digest: CLEAN,
  });
  assert.equal(r.ok, true, `a range audit could not be pinned: ${r.errors?.join('; ')}`);
  assert.equal(r.pin.declared.task_id, null);
});

test('BUT A MALFORMED OPTIONAL IS AN ERROR, not a silent drop', () => {
  assert.equal(capturePin({ ...good, attempt: 'seven' }).ok, false);
  assert.equal(capturePin({ ...good, base_sha: 'abc' }).ok, false);
});

/* ── the STALE case ───────────────────────────────────────────────────── */

test('EVERY MEASURED FIELD IS CHECKED, not just the commit', () => {
  /*
   * Generated from the measured set, so a field added to it extends this
   * without anybody remembering -- rule 7. Each moves alone, because a matcher
   * that only ever sees one field change cannot show it reads the rest.
   */
  const { pin } = capturePin(good);
  const moves = {
    base_sha: 'e'.repeat(40),
    candidate_sha: 'f'.repeat(40),
    candidate_tree_sha: '0'.repeat(40),
    worktree_digest: DIRTY,
  };
  for (const [field, value] of Object.entries(moves)) {
    const v = verifyPin(pin, { ...good, [field]: value });
    assert.equal(v.state, PIN.STALE, `${field} moved and the audit was still admitted`);
    assert.deepEqual(v.moved, [field], `${field} moved but was not the field reported`);
  }
});

test('THE COMMIT AND ITS TREE ARE SEPARATE, which is why both are pinned', () => {
  /*
   * Two commits can carry an identical tree -- a rebase, a cherry-pick, an
   * amend that changed only a message. An audit of the CONTENT survives those;
   * an audit of the diff does not.
   */
  const { pin } = capturePin(good);
  assert.equal(verifyPin(pin, { ...good, candidate_sha: 'd'.repeat(40) }).moved[0], 'candidate_sha');
  assert.equal(verifyPin(pin, { ...good, candidate_tree_sha: 'd'.repeat(40) }).moved[0], 'candidate_tree_sha');
});

/* ── unknown is a third answer ────────────────────────────────────────── */

test('UNKNOWN IS NOT OK AND IS NOT STALE', () => {
  const { pin } = capturePin(good);
  assert.equal(verifyPin(pin, null).state, PIN.UNKNOWN);
  assert.equal(verifyPin(pin, {}).state, PIN.UNKNOWN);
  assert.equal(verifyPin(null, good).state, PIN.UNKNOWN);
  assert.equal(verifyPin(pin, { ...good, worktree_digest: null }).state, PIN.UNKNOWN);
});

test('MOVED BEATS UNREADABLE: a partial reading that already disagrees still refuses', () => {
  const { pin } = capturePin(good);
  const v = verifyPin(pin, { ...good, candidate_sha: 'd'.repeat(40), worktree_digest: null });
  assert.equal(v.state, PIN.STALE, 'a known move was downgraded to unknown by an unreadable sibling');
});

test('AN ABSENT PIN FIELD IS NOT A WILDCARD', () => {
  const { pin } = capturePin({
    audit_id: 'a', candidate_sha: B, candidate_tree_sha: C, worktree_digest: CLEAN,
  });
  assert.equal(verifyPin(pin, { candidate_sha: B, candidate_tree_sha: C, worktree_digest: CLEAN }).state, PIN.OK);
  assert.equal(verifyPin(pin, { candidate_sha: A, candidate_tree_sha: C, worktree_digest: CLEAN }).state, PIN.STALE);
});

/* ── the one call a caller makes ──────────────────────────────────────── */

test('admitVerdict FAILS CLOSED and distinguishes the two refusals', () => {
  const { pin } = capturePin(good);
  assert.equal(admitVerdict(pin, good).ok, true);
  assert.equal(admitVerdict(pin, { ...good, candidate_sha: A }).state, PIN.STALE);
  assert.equal(admitVerdict(pin, null).state, PIN.UNKNOWN);
  assert.equal(admitVerdict(pin, null).ok, false);
});

test('THE CONTROL: this gate can actually fail, and actually pass', () => {
  const { pin } = capturePin(good);
  assert.equal(verifyPin(pin, good).state, PIN.OK);
  assert.equal(verifyPin(pin, { ...good, worktree_digest: DIRTY }).state, PIN.STALE);
});
