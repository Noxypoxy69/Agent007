/**
 * VERIFICATION OBSERVATIONS — AND WHY THIS IS NOT A PROMOTION GATE.
 *
 * Built to enforce TEST_PASS_IN_DIRTY_WORKTREE != PROMOTABLE. An independent
 * review of the first version found it could mint a false green, and the
 * demonstration was decisive: a commit whose package.json replaced the test
 * script with `printf "# tests 1662\n# pass 1647\n# fail 0\n"; exit 1` was
 * VERIFIED. Zero tests ran. The process exited 1. A proof was minted.
 *
 * THE FOUR LINKS IN THAT CHAIN, ALL PRESENT AT ONCE:
 *   the candidate controlled the command that defines "the suite";
 *   the exit code was parsed out of existence -- stdout was kept, status dropped;
 *   reconciliation only rejected pass+fail+skip > tests, so 1 of 1662 passed;
 *   the digest was an unkeyed hash anybody can recompute over anything.
 *
 * WHAT CHANGED, AND WHAT DELIBERATELY HAS NOT.
 *
 * The mechanical false greens are closed below: exit status, signal and timeout
 * are load-bearing, counts must reconcile EXACTLY, cancelled must be zero, the
 * version is bound into the digest, and verifyProof re-runs the whole semantic
 * validator instead of trusting a hash.
 *
 * The other three defects cannot be closed by arithmetic and are NOT pretended
 * away. A proof is unsigned, so it proves nothing about WHO ran the verification
 * or that it ran at all. The suite command still comes from the candidate. The
 * run executes candidate-controlled code on the host. Those need a credential,
 * a trusted policy store and container isolation respectively -- none of which
 * exist here yet.
 *
 * SO THIS MODULE NO LONGER CLAIMS TO PROMOTE ANYTHING. assertObserved() returns
 * an observation plus an explicit, non-empty list of promotionBlockers. Callers
 * that want a promotion decision must read `promotable`, which is false in every
 * configuration this repository can currently produce. An honest tool that
 * refuses to certify is worth more than one whose certificate is forgeable.
 *
 * PURE. No clone, no spawn, no clock. The CLI observes; this decides.
 */

import { createHash } from 'node:crypto';

/** Each a distinct defect, never collapsed into one "invalid". */
export const REFUSALS = Object.freeze([
  'dirty-source',
  'source-mutated',
  'sha-mismatch',
  'not-a-sha',
  'deps-unavailable',
  'suite-not-run',
  'suite-failed',
  'suite-nonzero-exit',
  'suite-signalled',
  'suite-timed-out',
  'counts-do-not-reconcile',
  'tests-cancelled',
  'zero-tests',
  'ambiguous-summary',
  'digest-mismatch',
  'version-mismatch',
]);

/**
 * MANDATORY, VERSIONED PROMOTION BLOCKERS. They fail CLOSED.
 *
 * Every one of these must be explicitly evaluated on every observation. A
 * blocker that is absent, unknown, or not evaluated does not mean "cleared" --
 * it means the observation cannot authorise anything, which is the opposite
 * default from the one that produced the false green.
 *
 * NONE OF THEM ARE CLEARABLE BY THE CANDIDATE. Each is decided from a trust
 * input supplied by the CALLER -- a signature, the provenance of the suite
 * command, the isolation of the execution environment. Nothing here is read out
 * of the repository under test, because a candidate that can clear its own
 * blockers has not been checked by anything.
 *
 * The version exists so a stored observation cannot be re-interpreted under a
 * later, weaker policy. An observation carrying a different policy version is
 * not promotable, full stop.
 */
export const BLOCKER_POLICY_VERSION = 1;

export const REQUIRED_BLOCKERS = Object.freeze([
  'unsigned-observation',
  'candidate-controlled-suite',
  'untrusted-execution-environment',
]);

export const PROOF_VERSION = 2;

const isSha = (v) => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);
const isNonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const isCount = (v) => Number.isInteger(v) && v >= 0;

/**
 * The content address of an observation.
 *
 * `v:` now reads the RECORD's version, not the module constant. Hashing the
 * constant meant an attacker could rewrite proof.version to anything and the
 * digest still matched -- the field was recorded but not bound. Every field the
 * verdict depends on is bound; only diagnostics (timings, local paths) are not,
 * so two honest verifications of one commit still agree.
 *
 * THIS IS AN UNKEYED HASH AND THEREFORE NOT A SIGNATURE. It detects editing. It
 * cannot establish that verification happened or who ran it, because anyone can
 * construct an object and compute its digest. Signing needs a verifier identity
 * and a credential, which is the identity slice, not this one.
 */
export function proofDigest(proof) {
  const parts = [
    `v:${proof?.version ?? ''}`,
    `repo:${proof?.repoId ?? ''}`,
    `sha:${proof?.sha ?? ''}`,
    `headAt:${proof?.checkoutHead ?? ''}`,
    `headAfter:${proof?.headAfter ?? ''}`,
    `clean:${proof?.sourceClean === true ? 'yes' : 'no'}`,
    `cleanAfter:${proof?.treeCleanAfter === true ? 'yes' : 'no'}`,
    `deps:${proof?.depsInstalled === true ? 'yes' : 'no'}`,
    `scripts:${proof?.lifecycleScriptsRan === true ? 'yes' : 'no'}`,
    `exit:${proof?.suiteExitCode}`,
    `signal:${proof?.terminationSignal ?? 'none'}`,
    `timeout:${proof?.timedOut === true ? 'yes' : 'no'}`,
    `tests:${proof?.tests}`,
    `pass:${proof?.pass}`,
    `fail:${proof?.fail}`,
    `skip:${proof?.skip}`,
    `cancelled:${proof?.cancelled}`,
    `todo:${proof?.todo}`,
    `suite:${proof?.suiteCommand ?? ''}`,
    `suiteFrom:${proof?.suiteSource ?? ''}`,
  ];
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/**
 * Everything wrong with this run, all at once.
 *
 * Split out so verifyProof() can re-run the IDENTICAL semantics over a record
 * that arrived from elsewhere. The first version checked three fields on the way
 * in and a different three on the way out, so a proof could fail minting and
 * pass reading. One validator, both directions.
 */
function validate(o) {
  const refusals = [];
  const add = (code, detail) => refusals.push({ code, detail });

  if (!isSha(o.sha)) add('not-a-sha', `${o.sha ?? 'absent'} is not a full 40-character sha`);

  if (o.sourceClean !== true) {
    add('dirty-source', 'the checkout carried uncommitted changes before the run; that proves nothing about the commit');
  }
  /*
   * MEASURED AFTER THE RUN TOO. Cleanliness was checked only before npm ci and
   * the suite, so lifecycle scripts or tests could rewrite tracked source and
   * the verifier would still report it had tested the commit.
   */
  if (o.treeCleanAfter !== true) {
    add('source-mutated', 'tracked files changed during install or the suite; what ran is not the commit');
  }

  if (!isSha(o.checkoutHead)) {
    add('sha-mismatch', 'the checkout did not report a usable HEAD');
  } else if (isSha(o.sha) && o.checkoutHead !== o.sha) {
    add('sha-mismatch', `checked out ${o.checkoutHead}, asked for ${o.sha}`);
  }
  if (isSha(o.checkoutHead) && o.headAfter !== undefined && o.headAfter !== o.checkoutHead) {
    add('source-mutated', `HEAD moved during the run: ${o.checkoutHead} -> ${o.headAfter}`);
  }

  if (o.depsInstalled !== true) {
    add('deps-unavailable', 'dependencies were not installed; the run does not cover resolution');
  }

  if (!isNonEmpty(o.suiteCommand)) {
    add('suite-not-run', 'no suite command recorded; an observation must name what ran');
  }

  /*
   * THE EXIT STATUS IS LOAD-BEARING. The first version caught the failure,
   * kept stdout and dropped the status, so a suite that printed a green summary
   * and then died -- posttest failure, timeout after printing, a signal, npm
   * failing after the runner finished -- was indistinguishable from success.
   */
  if (o.suiteExitCode !== 0) {
    add('suite-nonzero-exit', `the suite exited ${o.suiteExitCode === null || o.suiteExitCode === undefined ? 'with an unrecorded status' : o.suiteExitCode}`);
  }
  if (o.terminationSignal !== null && o.terminationSignal !== undefined) {
    add('suite-signalled', `the suite was killed by ${o.terminationSignal}`);
  }
  if (o.timedOut === true) add('suite-timed-out', 'the suite did not finish inside its limit');

  /*
   * EXACTLY ONE SUMMARY. Parsing the first matching line anywhere in stdout let
   * a candidate print a convincing summary before the real runner spoke.
   */
  if (o.ambiguousSummary === true) {
    add('ambiguous-summary', 'more than one suite summary appeared in the output; which one is real cannot be decided');
  }

  const counts = ['tests', 'pass', 'fail', 'skip', 'cancelled', 'todo'];
  const missing = counts.filter((k) => !isCount(o[k]));
  if (missing.length) {
    add('suite-not-run', `the suite produced no usable counts for: ${missing.join(', ')}`);
  } else {
    if (o.tests === 0) add('zero-tests', 'the suite ran 0 tests; that is not a pass');
    if (o.fail > 0) add('suite-failed', `${o.fail} failing test(s)`);
    if (o.cancelled > 0) add('tests-cancelled', `${o.cancelled} test(s) cancelled; the suite did not complete`);
    /*
     * EXACT EQUALITY, BOTH DIRECTIONS. Rejecting only `>` accepted
     * tests 1600 / pass 1 / fail 0 -- a direct false green, and one a fake TAP
     * printer produces by accident.
     */
    const accounted = o.pass + o.fail + o.skip + o.cancelled + o.todo;
    if (accounted !== o.tests) {
      add('counts-do-not-reconcile',
        `${o.pass}+${o.fail}+${o.skip}+${o.cancelled}+${o.todo} = ${accounted}, but the suite reported ${o.tests} tests`);
    }
  }
  return refusals;
}

/**
 * Which mandatory blockers stand. TODAY THAT IS ALL OF THEM, UNCONDITIONALLY.
 *
 * THE SECOND REVIEW FOUND THE FALSE GREEN HERE, and it was mine, not the
 * candidate's. The previous version cleared each blocker from a caller-supplied
 * value -- a non-empty `signature` string, `suiteSource: 'trusted-policy'`,
 * `isolated: true`. Nothing verified a signature, loaded a policy or checked an
 * attestation. They were assertions, and assertObserved is exported, so:
 *
 *     assertObserved({ ...valid, signature: 'x',
 *                      suiteSource: 'trusted-policy', isolated: true })
 *     -> promotable: true
 *
 * I had shipped the claim "nothing in this repository can clear any of them".
 * Three literals cleared all three. Worse, the exploit was in the suite as a
 * PASSING test called "a signed, policy-sourced, isolated run WOULD be
 * promotable", written by me as the positive direction.
 *
 * The move from candidate-controlled to caller-controlled verification is not a
 * smaller defect. It is the same missing authority boundary one step up.
 *
 * SO NO INPUT CLEARS A BLOCKER. The trust fields are not read. A blocker is
 * cleared only by a VERIFIER ADAPTER -- a function registered in this module
 * that performs a real check -- and there are none, so `promotable` is false in
 * every call, for every argument, including arguments that claim otherwise.
 *
 * WHEN AN ADAPTER ARRIVES it must be one of:
 *   a cryptographically verified signature from an approved verifier identity;
 *   a suite policy loaded by id AND digest from an authority outside the
 *     candidate;
 *   a signed or container-produced isolation attestation.
 * Never a boolean. Never a string. Never anything the caller simply says.
 */
const VERIFIER_ADAPTERS = Object.freeze({
  // Deliberately empty. An entry here must perform a real verification and
  // return a boolean it has EARNED, not one it was handed.
});

const BLOCKER_DETAIL = Object.freeze({
  'unsigned-observation':
    'no verifier adapter exists: an unkeyed digest cannot establish who verified, or that anyone did',
  'candidate-controlled-suite':
    'no trusted suite policy exists: the command came from the commit under test',
  'untrusted-execution-environment':
    'no isolation attestation exists: install and suite ran on the host with ambient credentials',
});

function evaluateBlockers(o) {
  const blockers = [];
  let evaluated = 0;
  for (const code of REQUIRED_BLOCKERS) {
    evaluated += 1;
    const adapter = VERIFIER_ADAPTERS[code];
    // NO ADAPTER MEANS THE BLOCKER STANDS. Absent is not cleared, and the
    // caller is not consulted -- `o` is deliberately unused for trust.
    const cleared = typeof adapter === 'function' ? adapter(o) === true : false;
    if (!cleared) blockers.push({ code, detail: BLOCKER_DETAIL[code] ?? 'no detail recorded' });
  }

  /*
   * THE POLICY VERSION IS THIS MODULE'S, NOT THE OBSERVATION'S.
   *
   * It previously read `o.blockerPolicyVersion === undefined || ... === CURRENT`,
   * which fails OPEN: an observation carrying no version was accepted, and
   * observation data got to select which policy judged it. Data under review
   * does not choose its own reviewer. A caller-supplied version that differs is
   * now a hard mismatch; absent is fine only because it is IGNORED.
   */
  const versionOk = o.blockerPolicyVersion === undefined
    ? true
    : o.blockerPolicyVersion === BLOCKER_POLICY_VERSION;
  if (!versionOk) {
    blockers.push({
      code: 'unsigned-observation',
      detail: `observation claims blocker policy v${o.blockerPolicyVersion}; this module judges only by v${BLOCKER_POLICY_VERSION}`,
    });
  }

  return { blockers, policyOk: evaluated === REQUIRED_BLOCKERS.length && versionOk };
}

/**
 * What this run OBSERVED. Never what may be promoted.
 *
 * `promotable` is false whenever any blocker stands, and at least one always
 * does in this repository today. That is the honest state, not a placeholder:
 * the observation is real evidence and it is not a certificate.
 */
export function assertObserved(observation = {}) {
  const o = { skip: 0, cancelled: 0, todo: 0, ...observation };
  const refusals = validate(o);

  /*
   * BLOCKERS ARE NOT REFUSALS. A refusal means this run failed. A blocker means
   * even a clean run cannot authorise promotion, for reasons outside the run.
   * Collapsing them would let "nothing went wrong" read as "ship it".
   */
  const { blockers, policyOk } = evaluateBlockers(o);

  if (refusals.length > 0) {
    return { ok: false, promotable: false, blockerPolicyComplete: policyOk, blockerPolicyVersion: BLOCKER_POLICY_VERSION, refusals, promotionBlockers: blockers, proof: null };
  }

  const proof = {
    version: PROOF_VERSION,
    repoId: o.repoId ?? '',
    sha: o.sha,
    checkoutHead: o.checkoutHead,
    headAfter: o.headAfter ?? o.checkoutHead,
    sourceClean: true,
    treeCleanAfter: true,
    depsInstalled: true,
    lifecycleScriptsRan: o.lifecycleScriptsRan === true,
    suiteExitCode: 0,
    terminationSignal: null,
    timedOut: false,
    tests: o.tests,
    pass: o.pass,
    fail: o.fail,
    skip: o.skip,
    cancelled: o.cancelled,
    todo: o.todo,
    suiteCommand: o.suiteCommand,
    suiteSource: o.suiteSource ?? 'candidate',
  };
  return {
    ok: true,
    /*
     * FAILS CLOSED: clean run, COMPLETE policy, and nothing standing.
     *
     * The `policyOk` term is defence-in-depth and is NOT independently reachable
     * from outside this module -- measured, not assumed. Every externally
     * producible way to make the policy incomplete (a version mismatch) also
     * raises a blocker, so the second term already refuses. The only case where
     * policyOk alone decides is an evaluator being deleted from the map, which a
     * caller cannot do. A mutation removing this term therefore stays green, and
     * that is recorded here rather than papered over with a test that would only
     * appear to cover it: the guarantee is that a future blocker added to
     * REQUIRED_BLOCKERS without an evaluator cannot silently read as cleared.
     */
    promotable: policyOk && blockers.length === 0,
    blockerPolicyComplete: policyOk,
    blockerPolicyVersion: BLOCKER_POLICY_VERSION,
    refusals: [],
    promotionBlockers: blockers,
    proof: { ...proof, digest: proofDigest(proof) },
  };
}

/**
 * Does a record that arrived from elsewhere still describe what it claims?
 *
 * RE-RUNS THE WHOLE VALIDATOR, then checks the digest. The first version checked
 * a handful of fields and trusted the hash for the rest, so a record could carry
 * a wrong version, a mismatched head or counts that did not reconcile and still
 * read as valid. A digest proves a record is unedited; it says nothing about
 * whether the record was ever acceptable.
 */
export function verifyProof(proof) {
  if (!proof || typeof proof !== 'object') {
    return { ok: false, refusals: [{ code: 'digest-mismatch', detail: 'not a proof object' }] };
  }
  const refusals = validate({
    ...proof,
    skip: proof.skip,
    // A minted proof records these as the passing values; validate() re-checks
    // them rather than assuming the minting path was the one that produced it.
  });

  if (proof.version !== PROOF_VERSION) {
    refusals.push({ code: 'version-mismatch', detail: `proof version ${proof.version}, this reader speaks ${PROOF_VERSION}` });
  }
  if (!isNonEmpty(proof.digest)) {
    refusals.push({ code: 'digest-mismatch', detail: 'the record carries no digest' });
  } else if (proofDigest(proof) !== proof.digest) {
    refusals.push({ code: 'digest-mismatch', detail: 'the record does not hash to its own digest; a field changed after it was written' });
  }
  return { ok: refusals.length === 0, refusals };
}
