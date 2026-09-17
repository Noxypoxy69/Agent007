import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertObserved, inspectObservationRecord, RECORD_VERSION, STANDING_BLOCKERS, canonicalList,
} from '../src/verificationProof.mjs';

/**
 * THE SAME DEFECT FOUR TIMES, AND THE FOURTH SETTLED THE DESIGN.
 *
 *   1 the CANDIDATE controlled verification -- a commit set its own test script
 *   2 the CALLER controlled it -- three literals cleared every blocker
 *   3 the ARTIFACT carried no non-authority context
 *   4 the ARTIFACT manufactured authority:
 *       { ...valid, promotable: true, standingBlockers: [], digest: recompute }
 *       returned { ok: true, promotable: true }
 *
 * Each repair moved the unchecked claim instead of removing it. So the promotion
 * vocabulary is deleted: no promotable field, no `ok` a caller reads as
 * permission, no adapter registry, no exported digest helper, no exit-0 path.
 * `authorization` is the literal 'none' and is not computed from anything.
 */

const CLEAN = Object.freeze({
  sha: 'a'.repeat(40),
  repoId: 'github.com/noxypoxy69/agent007',
  checkoutHead: 'a'.repeat(40),
  headAfter: 'a'.repeat(40),
  sourceClean: true,
  treeCleanAfter: true,
  depsInstalled: true,
  suiteExitCode: 0,
  terminationSignal: null,
  timedOut: false,
  ambiguousSummary: false,
  tests: 1662, pass: 1647, fail: 0, skip: 15, cancelled: 0, todo: 0,
  suiteCommand: 'npm test  (node --test "test/**/*.test.mjs")',
});

/* ------------------------------------------- THE VOCABULARY IS GONE */

test('THE FORGED RECORD: there is no promotable field to forge', () => {
  /*
   * The exact record the fourth review supplied. Under v3 it returned
   * {ok:true, promotable:true, standingBlockers:[], refusals:[]}. It is refused
   * now -- but the load-bearing change is that a well-formed record has no
   * promotable field at all, so the forgery has nothing to aim at.
   */
  const real = assertObserved(CLEAN).record;
  const forged = { ...real, promotable: true, standingBlockers: [] };
  const r = inspectObservationRecord(forged);
  assert.equal(r.integrity, 'invalid');
  assert.equal(r.authorization, 'none');
  assert.ok(r.refusals.some((x) => x.code === 'promotion-claim-present'));
  assert.ok(!('ok' in r), 'no field a caller can read as permission');
  assert.ok(!('promotable' in r));
});

test('a clean observation exposes no promotion vocabulary anywhere', () => {
  const v = assertObserved(CLEAN);
  assert.deepEqual(v.refusals, []);
  assert.equal(v.authorization, 'none');
  for (const field of ['ok', 'promotable', 'promotionBlockers', 'blockerPolicyComplete']) {
    assert.ok(!(field in v), `${field} must not exist on the verdict`);
    assert.ok(!(field in v.record), `${field} must not exist on the record`);
  }
});

test('authorization is the literal none for every input, including hostile ones', () => {
  for (const extra of [
    {}, { signature: 'x' }, { suiteSource: 'trusted-policy' }, { isolated: true },
    { authorization: 'granted' }, { promotable: true }, { blockersAtObservation: [] },
    { signature: 'x', suiteSource: 'trusted-policy', isolated: true, authorization: 'granted' },
  ]) {
    const v = assertObserved({ ...CLEAN, ...extra });
    assert.equal(v.authorization, 'none', `authorization moved for ${JSON.stringify(extra)}`);
    assert.equal(v.blockers.length, STANDING_BLOCKERS.length);
  }
});

test('the reader answers authorization none even for a refused or absent record', () => {
  assert.equal(inspectObservationRecord(null).authorization, 'none');
  assert.equal(inspectObservationRecord({}).authorization, 'none');
  assert.equal(inspectObservationRecord(assertObserved(CLEAN).record).authorization, 'none');
});

test('the digest helper is not exported', async () => {
  // A digest helper beside an observation is the tool a forger reaches for.
  const mod = await import('../src/verificationProof.mjs');
  for (const name of ['proofDigest', 'recordDigest', 'verifyProof']) {
    assert.ok(!(name in mod), `${name} must not be exported`);
  }
});

test('array fields are canonically encoded, so two lists cannot collide', () => {
  /*
   * THE PROPERTY, TESTED DIRECTLY. A first version asserted that two forged
   * records were both refused -- which they were, by the DIGEST path, whatever
   * the encoding. A mutation reverting to join(',') stayed green, so the test
   * proved nothing about canonicalisation. The encoder is exported for this;
   * the digest is not, because an encoder is not authority-adjacent.
   */
  assert.notEqual(
    canonicalList(['a,b', 'c']),
    canonicalList(['a', 'b,c']),
    "join(',') maps these to the same string; a canonical encoding must not",
  );
  assert.equal(canonicalList(['b', 'a']), canonicalList(['a', 'b']), 'order must not matter');
  assert.equal(canonicalList('nope'), 'unrecorded', 'a non-array is not silently coerced');
  assert.equal(canonicalList(undefined), 'unrecorded');
});

test('a record is intact only when nothing changed, and integrity is a STATE', () => {
  const real = assertObserved(CLEAN).record;
  const good = inspectObservationRecord(real);
  assert.equal(good.integrity, 'valid');
  assert.deepEqual(good.refusals, []);
  assert.equal(inspectObservationRecord({ ...real, pass: 9999 }).integrity, 'invalid');
  const noDigest = { ...real }; delete noDigest.digest;
  assert.equal(inspectObservationRecord(noDigest).integrity, 'invalid');
});

test('a record that does not say which blockers stood is refused', () => {
  const real = assertObserved(CLEAN).record;
  const stripped = { ...real }; delete stripped.blockersAtObservation;
  assert.equal(inspectObservationRecord(stripped).integrity, 'invalid');
});

test('a legacy version is refused as a version mismatch', () => {
  const real = assertObserved(CLEAN).record;
  assert.ok(inspectObservationRecord({ ...real, version: 3 }).refusals.some((x) => x.code === 'version-mismatch'));
  assert.equal(RECORD_VERSION, 4);
});

/* ------------------------------------------------ THE DEMONSTRATED ATTACK */

test('REGRESSION: green summary with a nonzero exit is refused', () => {
  const r = assertObserved({ ...CLEAN, suiteExitCode: 1 });
  assert.ok(r.refusals.length > 0);
  assert.equal(r.record, null, 'a refused run must not hand back an artifact');
  assert.ok(r.refusals.some((x) => x.code === 'suite-nonzero-exit'));
});

test('REGRESSION: tests 1600 / pass 1 does not reconcile', () => {
  // v1 rejected only pass+fail+skip > tests, so 1 of 1600 passed as green.
  const r = assertObserved({ ...CLEAN, tests: 1600, pass: 1, fail: 0, skip: 0 });
  assert.ok(r.refusals.length > 0);
  assert.ok(r.refusals.some((x) => x.code === 'counts-do-not-reconcile'));
});

test('a suite killed by a signal, or timed out, is refused even with green counts', () => {
  const sig = assertObserved({ ...CLEAN, suiteExitCode: null, terminationSignal: 'SIGKILL' });
  assert.ok(sig.refusals.length > 0);
  assert.ok(sig.refusals.some((x) => x.code === 'suite-signalled'));

  const late = assertObserved({ ...CLEAN, suiteExitCode: null, timedOut: true });
  assert.ok(late.refusals.length > 0);
  assert.ok(late.refusals.some((x) => x.code === 'suite-timed-out'));
});

test('an unrecorded exit status is refused, not assumed to be zero', () => {
  const r = assertObserved({ ...CLEAN, suiteExitCode: undefined });
  assert.ok(r.refusals.length > 0, 'absent is not zero, least of all for an exit code');
  assert.ok(r.refusals.some((x) => x.code === 'suite-nonzero-exit'));
});

test('cancelled tests mean the suite did not complete', () => {
  const r = assertObserved({ ...CLEAN, cancelled: 3, pass: 1644 });
  assert.ok(r.refusals.length > 0);
  assert.ok(r.refusals.some((x) => x.code === 'tests-cancelled'));
});

test('two summaries in one output cannot be adjudicated', () => {
  const r = assertObserved({ ...CLEAN, ambiguousSummary: true, tests: null, pass: null, fail: null });
  assert.ok(r.refusals.length > 0);
  assert.ok(r.refusals.some((x) => x.code === 'ambiguous-summary'));
});

test('source mutated during the run means what ran is not the commit', () => {
  const dirty = assertObserved({ ...CLEAN, treeCleanAfter: false });
  assert.ok(dirty.refusals.length > 0);
  assert.ok(dirty.refusals.some((x) => x.code === 'source-mutated'));

  const moved = assertObserved({ ...CLEAN, headAfter: 'b'.repeat(40) });
  assert.ok(moved.refusals.length > 0);
  assert.ok(moved.refusals.some((x) => x.code === 'source-mutated'));
});

test('a dirty checkout, a wrong head and a missing install are each refused', () => {
  assert.ok(assertObserved({ ...CLEAN, sourceClean: false }).refusals.some((x) => x.code === 'dirty-source'));
  assert.ok(assertObserved({ ...CLEAN, checkoutHead: 'b'.repeat(40) }).refusals.some((x) => x.code === 'sha-mismatch'));
  assert.ok(assertObserved({ ...CLEAN, depsInstalled: false }).refusals.some((x) => x.code === 'deps-unavailable'));
  assert.ok(assertObserved({ ...CLEAN, tests: 0, pass: 0, fail: 0, skip: 0 }).refusals.some((x) => x.code === 'zero-tests'));
  assert.ok(assertObserved({ ...CLEAN, suiteCommand: '' }).refusals.some((x) => x.code === 'suite-not-run'));
});

test('every reason at once, never only the first', () => {
  const r = assertObserved({ ...CLEAN, sourceClean: false, suiteExitCode: 2, fail: 3, treeCleanAfter: false });
  const codes = r.refusals.map((x) => x.code);
  for (const c of ['dirty-source', 'suite-nonzero-exit', 'suite-failed', 'source-mutated']) {
    assert.ok(codes.includes(c), `missing ${c}`);
  }
});

/* ------------------------------------------- WHAT IT REFUSES TO CLAIM */


test('the observation-supplied policy version is IGNORED, not negotiated', () => {
  /*
   * The previous code read `blockerPolicyVersion === undefined ? true : ...` and
   * the commit calling it "fail-closed" was wrong: an absent version was
   * accepted, and observation data got a say in which policy judged it. Harmless
   * only while blockers were unconditional -- dangerous the moment one could
   * clear. The field is now not read at all.
   */
  for (const v of [undefined, 0, 1, 99, 'latest', null]) {
    const r = assertObserved({ ...CLEAN, blockerPolicyVersion: v });
    assert.equal(r.authorization, 'none', `version ${JSON.stringify(v)} changed the answer`);
    assert.equal(r.blockers.length, STANDING_BLOCKERS.length);
    assert.deepEqual(r.refusals, [], 'and it is not a refusal either; it is simply ignored');
  }
});
