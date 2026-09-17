/**
 * TEST_PASS_IN_DIRTY_WORKTREE != PROMOTABLE.
 *
 * One of six identities in docs/SELF_CORRECTION_INGEST.md, each of which has
 * already cost this project a day. This module enforces that one, and it exists
 * because the author of it broke it twice in one session: a suite run green in a
 * working tree carrying uncommitted changes, and a commit pushed on the strength
 * of it. The gap was already written down -- "nothing in the repository does a
 * fresh checkout of the exact SHA and re-runs the suite" -- and being written
 * down stopped nothing, which is the argument for a gate rather than a sentence.
 *
 * THE RULE FROM THE PACK, KEPT VERBATIM BECAUSE IT IS THE WHOLE POINT:
 *
 *     bad patch can be proposed
 *     -> bad patch cannot become trusted
 *
 * We are not trying to make the model stop writing bugs. A model that writes a
 * bad patch is working as designed; a system that lets a bad patch become a
 * TRUSTED patch is not. So nothing here asks the agent to be more careful. It
 * asks for a proof, and refuses prose.
 *
 * SELF_REFLECTION != MACHINE_EVIDENCE. An agent saying "I audited this" is the
 * hollow gate in one line, and this module will not accept it in any field.
 *
 * PURE. No clone, no spawn, no clock, no filesystem. The CLI does the I/O and
 * hands the observations here. That split is what makes the REFUSAL branches
 * reachable in a millisecond instead of needing a broken repository to exist.
 */

import { createHash } from 'node:crypto';

/** Each a distinct defect, never collapsed into one "invalid". */
export const REFUSALS = Object.freeze([
  'dirty-source',
  'sha-mismatch',
  'not-a-sha',
  'deps-unavailable',
  'suite-not-run',
  'suite-failed',
  'zero-tests',
  'digest-mismatch',
]);

export const PROOF_VERSION = 1;

const isSha = (v) => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);
const isNonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const isCount = (v) => Number.isInteger(v) && v >= 0;

/**
 * The content address of a proof.
 *
 * WHY CONTENT-ADDRESSED AT ALL. "no immutable artifact records that a SHA
 * passed" was the measured gap. A proof stored as a plain JSON blob is a
 * sentence an agent can write, and REVIEW_TEXT != REVIEW_PROOF. Hashing the
 * load-bearing fields means an edited proof stops verifying, so tampering is a
 * detectable event rather than an undetectable one.
 *
 * ONLY THE FIELDS THAT DECIDE. Timings and the runner label are recorded on the
 * proof but excluded from the digest: including them would make two honest
 * verifications of one SHA produce different addresses, and a proof that cannot
 * be compared to another proof of the same commit is not much of a proof.
 */
export function proofDigest(proof) {
  const parts = [
    `v:${PROOF_VERSION}`,
    `sha:${proof?.sha ?? ''}`,
    `repo:${proof?.repo ?? ''}`,
    `clean:${proof?.sourceClean === true ? 'yes' : 'no'}`,
    `headAt:${proof?.checkoutHead ?? ''}`,
    `deps:${proof?.depsInstalled === true ? 'yes' : 'no'}`,
    `tests:${proof?.tests ?? ''}`,
    `pass:${proof?.pass ?? ''}`,
    `fail:${proof?.fail ?? ''}`,
    `skip:${proof?.skip ?? ''}`,
    `suite:${proof?.suiteCommand ?? ''}`,
  ];
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/**
 * Is this SHA promotable on the strength of this run?
 *
 * EVERY REASON AT ONCE, never the first one found. Four restarts to learn four
 * facts that were all knowable on the first is a maze, not a diagnostic -- the
 * same argument the worker config already makes.
 */
export function assertProvable({
  sha,
  repo = '',
  sourceClean,
  checkoutHead,
  depsInstalled,
  tests,
  pass,
  fail,
  skip = 0,
  suiteCommand = '',
} = {}) {
  const refusals = [];

  /*
   * DEPENDENCIES ARE PART OF "FROM CLEAN", AND SKIPPING THEM MINTS A LIE.
   *
   * Measured while building this: a fresh clone of a sound commit reports two
   * failures, both `Cannot find package '@modelcontextprotocol/sdk'`. A verifier
   * that shrugged at an install it could not perform would either refuse a good
   * commit for the wrong reason or -- worse, if the failures happened not to
   * surface -- pass a commit whose lockfile does not resolve. Absent is not zero
   * here either: an install that did not run is a refusal, not a footnote.
   */
  if (depsInstalled !== true) {
    refusals.push({
      code: 'deps-unavailable',
      detail: 'dependencies were not installed in the clean checkout; the run does not cover resolution',
    });
  }

  /*
   * A SUITE COMMAND IS PART OF THE CLAIM, SO IT MUST BE THE ONE THAT RAN.
   *
   * The first version of the CLI recorded suiteCommand "npm test" while
   * executing `node --test test/` -- which on this Node resolves `test/` as a
   * module path and fails instantly. The proof would have attested, inside its
   * own digest, to a command that never ran. An empty command is refused rather
   * than defaulted for the same reason.
   */
  if (!isNonEmpty(suiteCommand)) {
    refusals.push({ code: 'suite-not-run', detail: 'no suite command was recorded; a proof must name what ran' });
  }

  if (!isSha(sha)) refusals.push({ code: 'not-a-sha', detail: `${sha ?? 'absent'} is not a full 40-character sha` });

  /*
   * THE ONE THAT CAUGHT ITS OWN AUTHOR. A suite run against a tree with
   * uncommitted changes proves something about that tree and nothing about the
   * commit. It is not a warning: a proof produced from a dirty source is
   * refused, because the whole value of the artifact is that it describes a
   * commit somebody else can fetch.
   */
  if (sourceClean !== true) {
    refusals.push({
      code: 'dirty-source',
      detail: 'the suite ran against a tree with uncommitted changes; that proves nothing about the commit',
    });
  }

  /*
   * ABSENT IS NOT MATCHING. A missing checkoutHead must refuse rather than be
   * skipped -- "we could not confirm the checkout landed on the right commit"
   * is the same risk as "it landed on the wrong one".
   *
   * THIS FIRST BRANCH IS DEFENSIVE, NOT LOAD-BEARING, and saying so is the point
   * of the note. A mutation that deleted it alone left every test green: with a
   * valid `sha`, `undefined !== sha` is true, so the else-if below already
   * refuses an absent head. It earns its place only by giving that case a
   * specific code instead of a generic mismatch. Anyone deleting it as dead code
   * should delete BOTH branches to see the protection actually disappear -- that
   * mutation reddens two tests.
   */
  if (!isSha(checkoutHead)) {
    refusals.push({ code: 'sha-mismatch', detail: 'the verified checkout did not report a usable HEAD' });
  } else if (isSha(sha) && checkoutHead !== sha) {
    refusals.push({ code: 'sha-mismatch', detail: `verified ${checkoutHead}, asked for ${sha}` });
  }

  if (!isCount(tests) || !isCount(pass) || !isCount(fail)) {
    refusals.push({ code: 'suite-not-run', detail: 'the suite produced no usable counts' });
  } else {
    /*
     * A RUN THAT CHECKED NOTHING MUST NOT PRINT A PASS. Zero tests with zero
     * failures satisfies "no failures" and is exactly the shape of a suite whose
     * glob stopped matching. The sibling repo's gates-can-fail harness fails
     * outright when every mutation was skipped for the same reason.
     */
    if (tests === 0) refusals.push({ code: 'zero-tests', detail: 'the suite ran 0 tests; that is not a pass' });
    if (fail > 0) refusals.push({ code: 'suite-failed', detail: `${fail} failing test(s)` });
    if (pass + fail + skip > tests) {
      refusals.push({ code: 'suite-not-run', detail: `counts do not reconcile: ${pass}+${fail}+${skip} > ${tests}` });
    }
  }

  const ok = refusals.length === 0;
  if (!ok) return { ok, refusals, proof: null };

  const proof = {
    version: PROOF_VERSION,
    sha,
    repo,
    sourceClean: true,
    checkoutHead,
    depsInstalled: true,
    tests,
    pass,
    fail,
    skip,
    suiteCommand,
  };
  return { ok, refusals: [], proof: { ...proof, digest: proofDigest(proof) } };
}

/**
 * Does this proof still describe what it claims to?
 *
 * The reader's half. assertProvable MINTS a proof; this checks one that arrived
 * from somewhere else -- a file, a branch, another agent. Recomputing the digest
 * is the only reason the artifact is worth more than the sentence "it passed".
 */
export function verifyProof(proof) {
  const refusals = [];
  if (!proof || typeof proof !== 'object') {
    return { ok: false, refusals: [{ code: 'digest-mismatch', detail: 'not a proof object' }] };
  }
  if (!isNonEmpty(proof.digest)) {
    refusals.push({ code: 'digest-mismatch', detail: 'the proof carries no digest' });
  } else if (proofDigest(proof) !== proof.digest) {
    refusals.push({
      code: 'digest-mismatch',
      detail: 'the proof does not hash to its own digest; a field was changed after it was minted',
    });
  }
  if (proof.sourceClean !== true) {
    refusals.push({ code: 'dirty-source', detail: 'a proof minted from a dirty source is not a proof' });
  }
  if (proof.depsInstalled !== true) {
    refusals.push({ code: 'deps-unavailable', detail: 'the recorded run did not install dependencies' });
  }
  if (Number.isInteger(proof.fail) && proof.fail > 0) {
    refusals.push({ code: 'suite-failed', detail: `${proof.fail} failing test(s) recorded` });
  }
  if (proof.tests === 0) refusals.push({ code: 'zero-tests', detail: 'the recorded run asserted nothing' });
  return { ok: refusals.length === 0, refusals };
}
