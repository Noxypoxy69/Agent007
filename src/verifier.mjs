/**
 * THE AUTHORITY. It takes a job id and nothing else from the worker.
 *
 * The prototype's verifyCandidate() accepted authoritativeRepo, baselineRef,
 * candidateWorkspace, skipSuite and policyVersion from its caller. Measured
 * consequences: passing candidateWorkspace === authoritativeRepo made a
 * candidate certify itself (decision: approve), and skipSuite: true minted a
 * production approval artifact with no suite run at all.
 *
 * Those are not five separate bugs. They are one: the party being judged was
 * supplying the basis of the judgment. So the production entry point is
 *
 *     verifyJob(jobId)
 *
 * and every value that decides the outcome is resolved from trusted job state
 * the worker cannot write. There is no skipSuite. A test that wants to avoid a
 * real suite run passes a validation runner through createVerifier(), which is
 * a construction-time dependency of the authority and is not reachable from a
 * job payload.
 */
import path from 'node:path';
import { rmSync } from 'node:fs';
import { candidateIdentity, materializeTree, resolveBaseline, treeDrift, buildCandidateTree, repoIdentity, IdentityError } from './candidateTree.mjs';
import { isProtectedRelPath, isBaselineTestPath } from './policy.mjs';
import { createApprovalStore, ApprovalStoreError } from './approvalStore.mjs';
import { runValidation } from './validationRunner.mjs';
import { execFileSync } from 'node:child_process';
import { runGit } from './safeGit.mjs';

/* The hardening list moved to src/safeGit.mjs; it was duplicated here. */

/**
 * Fetch the approved tree's objects into the authoritative repository and record
 * it as a commit under refs/agentbridge/promoted/. Never touches a branch.
 */
function writeApprovedTree({ repoRoot, candidateWorkspace, treeSha, parentCommit, candidateId }) {
  const git = (args, opts = {}) => runGit(args, { cwd: repoRoot, ...opts });
  /*
   * ANCHOR THE TREE BEFORE FETCHING IT. write-tree leaves a LOOSE object in the
   * candidate's store, reachable from no branch -- so fetching refs/heads/*
   * transfers every branch and not the one object that matters, and commit-tree
   * then fails with "not a valid object". Measured while writing these proofs.
   *
   * So the verifier anchors the tree under its own ref namespace in the
   * candidate repository and fetches exactly that. The anchor is created by the
   * verifier, from the tree SHA it computed; nothing about it is taken from the
   * candidate.
   */
  const anchorRef = `refs/agentbridge/anchor/${treeSha}`;
  const candGit = (args, opts = {}) => runGit(args, { cwd: candidateWorkspace, ...opts });
  const anchorCommit = candGit(['commit-tree', treeSha, '-m', `anchor ${treeSha}`], {
    env: {
      GIT_AUTHOR_NAME: 'agentbridge-verifier', GIT_AUTHOR_EMAIL: 'verifier@agentbridge.local',
      GIT_COMMITTER_NAME: 'agentbridge-verifier', GIT_COMMITTER_EMAIL: 'verifier@agentbridge.local',
    },
  }).trim();
  candGit(['update-ref', anchorRef, anchorCommit]);
  git(['fetch', '--no-tags', '--quiet', candidateWorkspace, `+${anchorRef}:${anchorRef}`]);
  const commit = git(['commit-tree', treeSha, '-p', parentCommit, '-m', `promoted candidate ${candidateId}`], {
    env: {
      GIT_AUTHOR_NAME: 'agentbridge-verifier', GIT_AUTHOR_EMAIL: 'verifier@agentbridge.local',
      GIT_COMMITTER_NAME: 'agentbridge-verifier', GIT_COMMITTER_EMAIL: 'verifier@agentbridge.local',
    },
  }).trim();
  const ref = `refs/agentbridge/promoted/${candidateId}`;
  git(['update-ref', ref, commit]);
  return ref;
}

export const POLICY_VERSION = '2026-09-18-v2';

/*
 * THE JOB'S REPOSITORY MUST STILL BE THE REPOSITORY THE JOB WAS OPENED AGAINST.
 *
 * A job stores an absolute path, and a path is not an identity: the directory it
 * names can be replaced between the controller opening the job and anyone acting
 * on it. Everything downstream would then agree with itself perfectly while
 * describing a repository nobody authorised. The store binds the identity at
 * creation precisely so there is something here to disagree with.
 *
 * A repository that cannot be identified at all is a refusal, not a pass --
 * absent is not equal.
 */
function repoStillMatches(job) {
  try {
    return repoIdentity(job.repoRoot) === job.repoIdentity;
  } catch {
    return false;
  }
}

export function createVerifier({ jobStore, approvalStoreDir, validationRunner = runValidation, policyVersion = POLICY_VERSION }) {
  const approvals = createApprovalStore(approvalStoreDir);

  /**
   * VERIFY. Worker-reachable. Returns a decision and, on approval, an opaque id.
   * It never returns the approval record, and it cannot promote anything.
   */
  function verifyJob(jobId) {
    const job = jobStore.getJob(jobId);
    if (!job) {
      return { decision: 'error', reason: `unknown job: ${String(jobId).slice(0, 64)}`, candidateId: null };
    }
    if (!repoStillMatches(job)) {
      return { decision: 'error', reason: 'the job\'s authoritative repository is not the one it was opened against', candidateId: null };
    }

    let identity;
    try {
      identity = candidateIdentity({
        repoRoot: job.repoRoot,                 // from trusted job state
        baselineRef: job.baselineRef,           // from trusted job state
        candidateWorkspace: job.candidateWorkspace,
        policyVersion,                          // from the verifier, not the payload
      });
    } catch (e) {
      /*
       * FAILS CLOSED. No identity means no approval and therefore no promotion.
       * The prototype substituted "__DIFF_FAILED__" here and approved.
       */
      if (e instanceof IdentityError) {
        return { decision: 'error', reason: e.message, stage: e.stage, candidateId: null };
      }
      throw e;
    }

    /*
     * A CANDIDATE MAY NOT BE ITS OWN AUTHORITY. Same tree is not the test --
     * a legitimate no-op change has the baseline's tree. The refusal is that the
     * candidate workspace IS the authoritative repository, so "verification"
     * would be the repo comparing itself with itself.
     */
    if (path.resolve(job.candidateWorkspace) === path.resolve(job.repoRoot)) {
      return { decision: 'error', reason: 'candidate workspace is the authoritative repository; a candidate cannot certify itself', candidateId: identity.candidateId };
    }

    /*
     * POLICY BEFORE EXECUTION, AND THE ORDER IS LOAD-BEARING.
     *
     * A candidate that edits a protected control or weakens an inherited test is
     * refused BEFORE its code is run at all. Checking after validation would mean
     * every rejected candidate still got to execute first -- which is precisely
     * what was measured on the prototype: a payload test ran during verification
     * and the candidate was rejected afterwards. The rejection was true and
     * useless.
     *
     * This compares TREES, not two working directories, so a mode flip, a
     * file-to-symlink swap and a deletion are all visible. A byte-hash of file
     * contents sees none of the three.
     */
    const controlDrift = treeDrift(job.candidateWorkspace, identity.baselineTreeSha, identity.candidateTreeSha, isProtectedRelPath);
    if (controlDrift.length > 0) {
      return {
        decision: 'reject',
        reason: `candidate alters protected controls: ${controlDrift.map((d) => `${d.file} (${d.status})`).join(', ')}`,
        candidateId: identity.candidateId,
        candidateTreeSha: identity.candidateTreeSha,
        protectedDrift: controlDrift,
        validation: { ran: false },
      };
    }

    /* Inherited tests may be ADDED to but not altered or removed. */
    const inheritedTestDrift = treeDrift(job.candidateWorkspace, identity.baselineTreeSha, identity.candidateTreeSha, isBaselineTestPath)
      .filter((d) => d.status !== 'added');
    if (inheritedTestDrift.length > 0) {
      return {
        decision: 'reject',
        reason: `candidate alters inherited tests: ${inheritedTestDrift.map((d) => `${d.file} (${d.status})`).join(', ')}`,
        candidateId: identity.candidateId,
        candidateTreeSha: identity.candidateTreeSha,
        baselineTestDrift: inheritedTestDrift,
        validation: { ran: false },
      };
    }

    /*
     * VALIDATION RUNS ON THE TREE, NOT ON THE WORKSPACE, and in another process.
     * Two reasons, both measured. A file on disk but not in the tree -- ignored,
     * or written after the tree was built -- would otherwise take part in a test
     * without being part of what was approved. And the prototype executed the
     * candidate's own test files inside the authority process: a payload test
     * wrote outside its workspace during verification, and did so even though
     * the candidate was ultimately REJECTED.
     */
    let checkout = null;
    let validation;
    try {
      checkout = materializeTree(job.candidateWorkspace, identity.candidateTreeSha);
      validation = validationRunner({ treeCheckout: checkout, treeSha: identity.candidateTreeSha });
    } catch (e) {
      return { decision: 'error', reason: `validation could not be established: ${e?.message ?? e}`, candidateId: identity.candidateId };
    } finally {
      if (checkout) rmSync(checkout, { recursive: true, force: true });
    }

    /*
     * THE RUNNER'S OWN RESULT IS CHECKED. A runner that returns undefined, or an
     * object without ok, or ok:true with no counts, must not read as a pass --
     * that is the "absent is not zero" failure one layer up from the tests.
     */
    if (!validation || typeof validation !== 'object' || typeof validation.ok !== 'boolean'
        || (validation.ok === true && (!validation.counts || typeof validation.counts.tests !== 'number'))) {
      return {
        decision: 'error',
        reason: 'validation runner returned a result this verifier cannot interpret',
        candidateId: identity.candidateId,
      };
    }

    if (!validation.ok) {
      return {
        decision: 'reject',
        reason: `validation failed: ${validation.error}`,
        candidateId: identity.candidateId,
        candidateTreeSha: identity.candidateTreeSha,
        validation,
      };
    }

    const approvalId = approvals.createApproval({
      repoIdentity: identity.repoIdentity,
      baselineCommitSha: identity.baselineCommitSha,
      candidateTreeSha: identity.candidateTreeSha,
      candidateId: identity.candidateId,
      policyVersion,
      verificationResult: 'approve',
      verifiedAt: new Date().toISOString(),
    });

    return {
      decision: 'approve',
      reason: 'candidate tree validated against the resolved baseline',
      candidateId: identity.candidateId,
      candidateTreeSha: identity.candidateTreeSha,
      baselineCommitSha: identity.baselineCommitSha,
      approvalId,                 // opaque; the record itself never leaves the store
      validation,
    };
  }

  /**
   * PROMOTE. NOT reachable from the worker verification command -- see
   * bin/agentbridge-verify.mjs, which does not import this function. There is no
   * actorRole parameter and no --role flag: the prototype accepted the string
   * "integration-owner" from its caller, which is a label, not an identity.
   *
   * Authority here comes from WHICH ENTRY POINT you can execute. On this machine
   * that is a weak boundary -- same OS user -- and it is not claimed to be more.
   */
  function promoteApproval(approvalId, { jobId }) {
    const job = jobStore.getJob(jobId);
    if (!job) return { ok: false, error: 'unknown-job' };
    if (!repoStillMatches(job)) return { ok: false, error: 'authoritative-repository-changed' };

    const record = approvals.getApproval(approvalId);
    if (!record) return { ok: false, error: 'unknown-or-spent-approval' };

    let identity;
    try {
      identity = candidateIdentity({
        repoRoot: job.repoRoot,
        baselineRef: job.baselineRef,
        candidateWorkspace: job.candidateWorkspace,
        policyVersion: record.policyVersion,
      });
    } catch (e) {
      return { ok: false, error: `identity-failed: ${e?.message ?? e}` };
    }

    /*
     * BASELINE FIRST, AND THE ORDER IS THE POINT. candidateId binds the baseline
     * commit, so a moved base changes the identity too -- and checking identity
     * first refused correctly while reporting 'candidate-identity-mismatch',
     * blaming the candidate for something the integration branch did. A refusal
     * that names the wrong cause sends the next person debugging the wrong thing.
     */
    let currentBaseline;
    try {
      currentBaseline = resolveBaseline(job.repoRoot, job.baselineRef);
    } catch (e) {
      return { ok: false, error: `baseline-unresolvable: ${e?.message ?? e}` };
    }
    if (currentBaseline.commitSha !== record.baselineCommitSha) {
      return {
        ok: false,
        error: 'authoritative-baseline-moved-since-verification',
        approvedBaseline: record.baselineCommitSha,
        currentBaseline: currentBaseline.commitSha,
      };
    }

    /* The exact tree that was validated, or nothing. */
    if (identity.candidateTreeSha !== record.candidateTreeSha) {
      return { ok: false, error: 'candidate-changed-since-verification' };
    }
    if (identity.candidateId !== record.candidateId) {
      return { ok: false, error: 'candidate-identity-mismatch' };
    }
    if (identity.repoIdentity !== record.repoIdentity) {
      return { ok: false, error: 'approval-issued-for-a-different-repository' };
    }

    /* Spend it BEFORE applying, so a crash mid-apply cannot leave it reusable. */
    let consumed;
    try {
      consumed = approvals.consumeApproval(approvalId);
    } catch (e) {
      if (e instanceof ApprovalStoreError) return { ok: false, error: e.code };
      throw e;
    }

    /*
     * PROMOTION WRITES THE EXACT APPROVED TREE, and writes it to a dedicated ref
     * rather than to the integration branch. Nothing here owns main, and the
     * final move is the integration owner's.
     *
     * The tree's objects live in the candidate repository, so they are fetched
     * into the authoritative one first. commit-tree then builds a commit whose
     * tree IS record.candidateTreeSha -- the same object that was validated, not
     * a patch reconstructed from it. There is no `git apply` and therefore no
     * opportunity for the applied bytes to differ from the approved bytes.
     */
    let promotedRef;
    try {
      promotedRef = writeApprovedTree({
        repoRoot: job.repoRoot,
        candidateWorkspace: job.candidateWorkspace,
        treeSha: consumed.candidateTreeSha,
        parentCommit: consumed.baselineCommitSha,
        candidateId: consumed.candidateId,
      });
    } catch (e) {
      return { ok: false, error: `promotion-write-failed: ${e?.message ?? e}`, approvalConsumed: true };
    }

    return {
      ok: true,
      promotedCandidateId: consumed.candidateId,
      promotedTreeSha: consumed.candidateTreeSha,
      baselineCommitSha: consumed.baselineCommitSha,
      promotedRef,
    };
  }

  return { verifyJob, promoteApproval, approvals, policyVersion };
}
