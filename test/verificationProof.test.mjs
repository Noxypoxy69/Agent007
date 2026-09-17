import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertObserved, verifyProof, proofDigest, PROOF_VERSION,
  BLOCKER_POLICY_VERSION, REQUIRED_BLOCKERS,
} from '../src/verificationProof.mjs';

/**
 * THE REGRESSION FIXTURES ARE A REAL ATTACK, NOT AN IMAGINED ONE.
 *
 * An independent review demonstrated a complete false green in v1. Reproduced
 * against a real clone before repairing: a commit whose package.json replaced
 * the test script with
 *
 *     printf "# tests 1662\n# pass 1647\n# fail 0\n# skipped 15\n"; exit 1
 *
 * was reported VERIFIED with a proof minted, having run zero tests. Four
 * independent failures had to line up and all four were present: the candidate
 * controlled the command, the exit status was discarded, reconciliation only
 * rejected `>`, and the digest was unkeyed.
 *
 * The exit-0 variant is ALSO here and it is NOT refused, because it cannot be:
 * a candidate that defines its own suite can print anything. That is what
 * `promotable: false` and the candidate-controlled-suite blocker exist to say.
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

/* ------------------------------------------------ THE DEMONSTRATED ATTACK */

test('REGRESSION: green summary with a nonzero exit is refused', () => {
  const r = assertObserved({ ...CLEAN, suiteExitCode: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.proof, null, 'a refused run must not hand back an artifact');
  assert.ok(r.refusals.some((x) => x.code === 'suite-nonzero-exit'));
});

test('REGRESSION: tests 1600 / pass 1 does not reconcile', () => {
  // v1 rejected only pass+fail+skip > tests, so 1 of 1600 passed as green.
  const r = assertObserved({ ...CLEAN, tests: 1600, pass: 1, fail: 0, skip: 0 });
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => x.code === 'counts-do-not-reconcile'));
});

test('a suite killed by a signal, or timed out, is refused even with green counts', () => {
  const sig = assertObserved({ ...CLEAN, suiteExitCode: null, terminationSignal: 'SIGKILL' });
  assert.equal(sig.ok, false);
  assert.ok(sig.refusals.some((x) => x.code === 'suite-signalled'));

  const late = assertObserved({ ...CLEAN, suiteExitCode: null, timedOut: true });
  assert.equal(late.ok, false);
  assert.ok(late.refusals.some((x) => x.code === 'suite-timed-out'));
});

test('an unrecorded exit status is refused, not assumed to be zero', () => {
  const r = assertObserved({ ...CLEAN, suiteExitCode: undefined });
  assert.equal(r.ok, false, 'absent is not zero, least of all for an exit code');
  assert.ok(r.refusals.some((x) => x.code === 'suite-nonzero-exit'));
});

test('cancelled tests mean the suite did not complete', () => {
  const r = assertObserved({ ...CLEAN, cancelled: 3, pass: 1644 });
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => x.code === 'tests-cancelled'));
});

test('two summaries in one output cannot be adjudicated', () => {
  const r = assertObserved({ ...CLEAN, ambiguousSummary: true, tests: null, pass: null, fail: null });
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => x.code === 'ambiguous-summary'));
});

test('source mutated during the run means what ran is not the commit', () => {
  const dirty = assertObserved({ ...CLEAN, treeCleanAfter: false });
  assert.equal(dirty.ok, false);
  assert.ok(dirty.refusals.some((x) => x.code === 'source-mutated'));

  const moved = assertObserved({ ...CLEAN, headAfter: 'b'.repeat(40) });
  assert.equal(moved.ok, false);
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

test('a fully clean run is OBSERVED and still NOT promotable', () => {
  const r = assertObserved(CLEAN);
  assert.equal(r.ok, true, JSON.stringify(r.refusals));
  assert.equal(r.promotable, false, 'a clean observation is not a certificate');
  const codes = r.promotionBlockers.map((b) => b.code);
  assert.deepEqual(
    codes.sort(),
    [...REQUIRED_BLOCKERS].sort(),
    'every blocker must be named on a passing run, not only on a failing one',
  );
});

test('blockers are not refusals and must not be collapsed', () => {
  const r = assertObserved(CLEAN);
  assert.deepEqual(r.refusals, [], 'nothing went wrong with this run');
  assert.ok(r.promotionBlockers.length > 0, 'and it still may not authorise promotion');
});

test('a signed, policy-sourced, isolated run WOULD be promotable', () => {
  // The positive direction, so the blockers cannot quietly become unclearable.
  const r = assertObserved({
    ...CLEAN, signature: 'sig:abc', suiteSource: 'trusted-policy', isolated: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.promotable, true);
  assert.deepEqual(r.promotionBlockers, []);
});

/* ------------------------------------------------- THE READER'S HALF */

test('REGRESSION: the record version is bound into the digest', () => {
  // v1 hashed the module CONSTANT, so proof.version could be rewritten freely.
  const proof = assertObserved(CLEAN).proof;
  const altered = { ...proof, version: 999 };
  assert.notEqual(proofDigest(altered), proof.digest, 'version must change the digest');
  assert.equal(verifyProof({ ...altered, digest: proof.digest }).ok, false);
});

test('verifyProof re-runs the whole validator, not just the hash', () => {
  // A self-consistent record of a BAD run must still be refused on content.
  const forged = {
    version: PROOF_VERSION, repoId: 'r', sha: 'a'.repeat(40),
    checkoutHead: 'a'.repeat(40), headAfter: 'a'.repeat(40),
    sourceClean: true, treeCleanAfter: true, depsInstalled: true,
    lifecycleScriptsRan: false,
    suiteExitCode: 0, terminationSignal: null, timedOut: false,
    tests: 1600, pass: 1, fail: 0, skip: 0, cancelled: 0, todo: 0,
    suiteCommand: 'npm test', suiteSource: 'candidate',
  };
  forged.digest = proofDigest(forged);
  const r = verifyProof(forged);
  assert.equal(r.ok, false, 'internally consistent is not the same as acceptable');
  assert.ok(r.refusals.some((x) => x.code === 'counts-do-not-reconcile'));
});

test('a minted record verifies, and an edited one does not', () => {
  const proof = assertObserved(CLEAN).proof;
  assert.equal(verifyProof(proof).ok, true, JSON.stringify(verifyProof(proof).refusals));
  assert.equal(verifyProof({ ...proof, pass: 9999 }).ok, false);
  assert.equal(verifyProof(null).ok, false);
  const noDigest = { ...proof }; delete noDigest.digest;
  assert.equal(verifyProof(noDigest).ok, false);
});

test('two honest observations of one commit agree on the digest', () => {
  // repoId is canonical, not a local path, so this holds across machines.
  assert.equal(assertObserved(CLEAN).proof.digest, assertObserved({ ...CLEAN }).proof.digest);
});

test('the digest is NOT a signature, and the module says so where it counts', () => {
  // Anyone can construct a record and compute its digest. This asserts the
  // property rather than pretending otherwise: forgery is detected by the
  // `unsigned` BLOCKER, never by the hash.
  const forged = { ...assertObserved(CLEAN).proof };
  forged.digest = proofDigest(forged);
  assert.equal(verifyProof(forged).ok, true, 'an unkeyed digest cannot detect authorship');
  assert.equal(assertObserved(CLEAN).promotable, false, 'which is why nothing unsigned is promotable');
});

/* ------------------------------------- MANDATORY BLOCKERS, FAILING CLOSED */

test('every required blocker is reported on a clean run, by its policy name', () => {
  const r = assertObserved(CLEAN);
  assert.equal(r.ok, true);
  assert.equal(r.blockerPolicyVersion, BLOCKER_POLICY_VERSION);
  assert.deepEqual(
    r.promotionBlockers.map((b) => b.code).sort(),
    [...REQUIRED_BLOCKERS].sort(),
    'a blocker missing from the output is indistinguishable from one that was cleared',
  );
});

test('a blocker cleared by the CANDIDATE would still not promote — trust inputs come from the caller', () => {
  /*
   * The three trust inputs are signature, suiteSource and isolated. None is read
   * from the repository under test; a candidate that could set them has not been
   * checked by anything. This asserts the module honours only those three and
   * ignores anything else offered alongside them.
   */
  const pretend = assertObserved({
    ...CLEAN,
    trusted: true, verified: true, promotable: true, skipBlockers: true,
    promotionBlockers: [], signed: true,
  });
  assert.equal(pretend.promotable, false, 'no field but the three trust inputs may clear a blocker');
  assert.equal(pretend.promotionBlockers.length, REQUIRED_BLOCKERS.length);
});

test('an unknown blocker policy version cannot produce a promotable observation', () => {
  const trusted = { ...CLEAN, signature: 'sig', suiteSource: 'trusted-policy', isolated: true };
  assert.equal(assertObserved(trusted).promotable, true, 'control: this WOULD promote');
  assert.equal(
    assertObserved({ ...trusted, blockerPolicyVersion: 99 }).promotable,
    false,
    'a stored observation must not become promotable under a policy this module does not implement',
  );
  assert.equal(
    assertObserved({ ...trusted, blockerPolicyVersion: 0 }).promotable,
    false,
  );
});

test('each trust input clears exactly one blocker and no others', () => {
  const only = (extra) => assertObserved({ ...CLEAN, ...extra }).promotionBlockers.map((b) => b.code).sort();
  assert.deepEqual(only({ signature: 'sig' }), ['candidate-controlled-suite', 'untrusted-execution-environment']);
  assert.deepEqual(only({ suiteSource: 'trusted-policy' }), ['unsigned-observation', 'untrusted-execution-environment']);
  assert.deepEqual(only({ isolated: true }), ['candidate-controlled-suite', 'unsigned-observation']);
});

test('a refused observation still reports its blockers', () => {
  // Otherwise a reader of a failing run learns nothing about why even a passing
  // one would not have been enough.
  const r = assertObserved({ ...CLEAN, suiteExitCode: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.promotable, false);
  assert.equal(r.promotionBlockers.length, REQUIRED_BLOCKERS.length);
});

/* ------------------------------------------- THE CALLER'S SIDE, STRUCTURAL */

test('the CLI never derives a trust input from the candidate repository', async () => {
  /*
   * This is a property of the CALLER, not the module, so it is checked against
   * the shipped source. Comments are stripped first: a structural gate in this
   * repository once failed against correct code by matching its own explanation.
   */
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { stripComments } = await import('../src/moduleGraph.mjs');
  const cli = stripComments(await readFile(fileURLToPath(new URL('../bin/agentbridge.mjs', import.meta.url)), 'utf8'));

  const block = cli.slice(cli.indexOf("cmd === 'observe-sha'"));
  const call = block.slice(block.indexOf('assertObserved'), block.indexOf('assertObserved') + 1200);

  // A NEGATIVE NEEDS THE POSITIVE FIRST. Asserting "no signature appears" against
  // an empty slice passes and proves nothing -- which is exactly what happened
  // when this used the string-stripping variant.
  assert.ok(block.length > 0, 'the observe-sha block must be found at all');
  assert.ok(call.length > 100, `the assertObserved call must be found; got ${call.length} chars`);

  assert.match(call, /suiteSource:\s*'candidate'/, 'suite provenance must be hardcoded, never read from the clone');
  assert.match(call, /isolated:\s*false/, 'isolation must be hardcoded false while it is false');
  assert.ok(!/signature/.test(call), 'no signature may be supplied until a verifier identity exists');
});

test('a future required blocker with no evaluator cannot read as cleared', () => {
  /*
   * The fail-closed guarantee, stated as what it actually protects. Every
   * externally producible incompleteness (a version mismatch) ALSO raises a
   * blocker, so `blockers.length` already refuses and a mutation removing the
   * policyOk term stays green -- measured, and written into the module rather
   * than covered by a test that would only appear to reach it.
   *
   * What is assertable from here: completeness is REPORTED, so adding a name to
   * REQUIRED_BLOCKERS without an evaluator is visible instead of silent.
   */
  const trusted = { ...CLEAN, signature: 'sig', suiteSource: 'trusted-policy', isolated: true };
  const r = assertObserved(trusted);
  assert.equal(r.blockerPolicyComplete, true, 'every required blocker has an evaluator today');
  assert.equal(r.promotable, true);

  const stale = assertObserved({ ...trusted, blockerPolicyVersion: 99 });
  assert.equal(stale.blockerPolicyComplete, false, 'an unimplemented policy version is incomplete');
  assert.equal(stale.promotable, false);

  assert.equal(
    assertObserved(CLEAN).blockerPolicyComplete,
    true,
    'completeness is about the POLICY, not about whether blockers stand',
  );
});
