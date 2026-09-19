/**
 * AN AUDIT THAT FINISHES IS NOT THEREBY AN AUDIT THAT WAS VALID.
 *
 * REPRODUCED WITHOUT TRYING, while the module this tests was being written.
 * Four audits ran in one session against a branch three sessions were pushing
 * to. Between assigning a piece of work at 8e9908e and starting it, HEAD moved
 * SEVEN commits to 4a5cedb; one auditor reported in its own findings that the
 * shared worktree changed under it mid-pass, and another that the branch went
 * from 15 to 18 commits ahead while it read. Every verdict was returned with no
 * check that the thing judged still existed.
 *
 * The verdict looks identical either way, which is what makes this the shape
 * CLAUDE.md is about: not a check that failed, a check that answered a question
 * about something that had moved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { capturePin, verifyPin, admitVerdict, PIN } from '../src/auditPin.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

const good = {
  audit_id: 'audit-1',
  task_id: 't-fence',
  attempt: 7,
  base_sha: A,
  candidate_sha: B,
  candidate_tree_sha: C,
};

/* ── capture ──────────────────────────────────────────────────────────── */

test('THE POSITIVE FIRST: a complete capture is accepted and normalised', () => {
  /*
   * Rule 5. Every refusal below is satisfied by a capture that rejects
   * everything, which would make pinning unusable and get it routed around.
   */
  const r = capturePin({ ...good, candidate_sha: B.toUpperCase() });
  assert.equal(r.ok, true, `a complete capture was refused: ${r.errors?.join('; ')}`);
  assert.equal(r.pin.candidate_sha, B, 'a sha was not normalised to lower case');
  assert.equal(r.pin.attempt, 7);
});

test('AN INCOMPLETE CAPTURE IS REFUSED, not silently partial', () => {
  /*
   * A pin missing its candidate cannot detect anything, and one that degrades
   * to "whatever I could read" is worse than none: it produces an OK at the far
   * end meaning only that two unknowns matched.
   */
  for (const [why, patch] of Object.entries({
    'no audit_id': { audit_id: '' },
    'no candidate_sha': { candidate_sha: null },
    'no candidate_tree_sha': { candidate_tree_sha: undefined },
    'a short candidate sha': { candidate_sha: 'abc1234' },
    'a non-hex sha': { candidate_sha: 'z'.repeat(40) },
  })) {
    const r = capturePin({ ...good, ...patch });
    assert.equal(r.ok, false, `accepted a capture with ${why}`);
    assert.ok(r.errors.length > 0, `${why} was refused without saying why`);
  }
  assert.equal(capturePin().ok, false, 'an empty capture was accepted');
});

test('task, attempt and base are OPTIONAL, because an honest audit may have none', () => {
  /*
   * An audit of a branch range or of a working tree has no single task or
   * attempt. Demanding them would make the honest cases unpinnable, which is
   * how a control ends up bypassed by the work it was meant to cover.
   */
  const r = capturePin({ audit_id: 'a', candidate_sha: B, candidate_tree_sha: C });
  assert.equal(r.ok, true, `a range audit could not be pinned: ${r.errors?.join('; ')}`);
  assert.equal(r.pin.task_id, null);
  assert.equal(r.pin.attempt, null);
});

test('BUT A MALFORMED OPTIONAL IS AN ERROR, not a silent drop', () => {
  assert.equal(capturePin({ ...good, attempt: 'seven' }).ok, false);
  assert.equal(capturePin({ ...good, base_sha: 'abc' }).ok, false);
});

/* ── the STALE case: the whole point ──────────────────────────────────── */

test('A MOVED CANDIDATE IS STALE, and the reason names what moved', () => {
  const { pin } = capturePin(good);
  const v = verifyPin(pin, { ...good, candidate_sha: 'd'.repeat(40) });
  assert.equal(v.state, PIN.STALE);
  assert.deepEqual(v.moved, ['candidate_sha']);
  assert.match(v.why, /different candidate/);
});

test('EVERY PINNED FIELD IS CHECKED, not just the commit', () => {
  /*
   * Generated from the pin itself, so a field added to the capture extends this
   * without anybody remembering -- rule 7. Each is moved on its own, because a
   * matcher that only ever sees one field changed cannot show it reads the rest.
   */
  const { pin } = capturePin(good);
  const moves = {
    task_id: 't-other',
    attempt: 8,
    base_sha: 'e'.repeat(40),
    candidate_sha: 'f'.repeat(40),
    candidate_tree_sha: '0'.repeat(40),
  };
  for (const [field, value] of Object.entries(moves)) {
    const v = verifyPin(pin, { ...good, [field]: value });
    assert.equal(v.state, PIN.STALE, `${field} moved and the audit was still admitted`);
    assert.deepEqual(v.moved, [field], `${field} moved but was not the field reported`);
  }
});

test('THE TREE AND THE COMMIT ARE SEPARATE, which is why both are pinned', () => {
  /*
   * Two different commits can carry an identical tree -- a rebase, a
   * cherry-pick, an amend that changed only a message. An audit of the CONTENT
   * survives those; an audit of the diff does not. Pinning the commit alone
   * would discard a good verdict, pinning the tree alone would accept one about
   * different history. Both are recorded and both are checked.
   */
  const { pin } = capturePin(good);
  assert.equal(verifyPin(pin, { ...good, candidate_sha: 'd'.repeat(40) }).moved[0], 'candidate_sha');
  assert.equal(verifyPin(pin, { ...good, candidate_tree_sha: 'd'.repeat(40) }).moved[0], 'candidate_tree_sha');
});

/* ── unknown is a third answer ────────────────────────────────────────── */

test('UNKNOWN IS NOT OK AND IS NOT STALE', () => {
  /*
   * If the recheck could not be taken, nobody knows. Folding that into OK
   * admits a verdict on an unverified identity -- the failure this exists to
   * stop. Folding it into STALE discards good audits whenever a command
   * hiccups. The same three-way split this repository already makes for a null
   * heartbeat and a failed check-first lookup.
   */
  const { pin } = capturePin(good);
  assert.equal(verifyPin(pin, null).state, PIN.UNKNOWN);
  assert.equal(verifyPin(pin, {}).state, PIN.UNKNOWN);
  assert.equal(verifyPin(null, good).state, PIN.UNKNOWN);
  assert.equal(verifyPin(pin, { ...good, candidate_tree_sha: null }).state, PIN.UNKNOWN);
});

test('MOVED BEATS UNREADABLE: a partial reading that already disagrees still refuses', () => {
  const { pin } = capturePin(good);
  const v = verifyPin(pin, { ...good, candidate_sha: 'd'.repeat(40), candidate_tree_sha: null });
  assert.equal(v.state, PIN.STALE, 'a known move was downgraded to unknown by an unreadable sibling');
});

test('AN ABSENT PIN FIELD IS NOT A WILDCARD', () => {
  /*
   * A range audit pins no task. That must not mean "any task matches" at the
   * far end -- it means the field was never claimed, so it is not compared. The
   * distinction matters because the opposite reading turns an unpinned audit
   * into one that always passes.
   */
  const { pin } = capturePin({ audit_id: 'a', candidate_sha: B, candidate_tree_sha: C });
  assert.equal(verifyPin(pin, { task_id: 'anything', candidate_sha: B, candidate_tree_sha: C }).state, PIN.OK);
  assert.equal(verifyPin(pin, { task_id: 'anything', candidate_sha: A, candidate_tree_sha: C }).state, PIN.STALE);
});

/* ── the one call a caller makes ──────────────────────────────────────── */

test('admitVerdict FAILS CLOSED and distinguishes the two refusals', () => {
  /*
   * They call for opposite responses: STALE means re-run against the new
   * candidate, UNKNOWN means find out why the recheck failed before spending
   * another audit. A single "no" would send the reader to the wrong one.
   */
  const { pin } = capturePin(good);
  assert.equal(admitVerdict(pin, good).ok, true);
  assert.equal(admitVerdict(pin, { ...good, candidate_sha: A }).state, PIN.STALE);
  assert.equal(admitVerdict(pin, null).state, PIN.UNKNOWN);
  assert.equal(admitVerdict(pin, null).ok, false);
});

test('THE CONTROL: this gate can actually fail, and actually pass', () => {
  /*
   * Rule 1, held permanently. Every assertion above is satisfied by a verifier
   * returning a constant. Both verdicts are demanded here from the same call.
   */
  const { pin } = capturePin(good);
  assert.equal(verifyPin(pin, good).state, PIN.OK);
  assert.equal(verifyPin(pin, { ...good, candidate_tree_sha: A }).state, PIN.STALE);
});
