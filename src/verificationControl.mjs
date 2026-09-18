/**
 * THE PRODUCTION SEAM. One place that knows where trusted state lives.
 *
 * bin/agentbridge-attempt.mjs (controller), bin/agentbridge-verify.mjs (worker)
 * and bin/agentbridge-integrate.mjs (trusted integration) are three processes.
 * Without this module each would have had to decide for itself where the job and
 * approval stores live -- three copies of one fact, which is the drift this
 * repository has already paid for twice.
 *
 * AGENTBRIDGE_STATE_DIR is read from the ENVIRONMENT, not from a payload, so it
 * is not a field a worker can set in a request.
 *
 * THAT IS NOT WHY THE CONTROL HOLDS, AND THE EARLIER WORDING HERE CLAIMED IT
 * WAS. It said a worker "cannot point verification at a store it prepared,
 * because the value never appears in anything the worker sends" -- which is only
 * true of the request. Under the threat model this file concedes everywhere
 * else, the worker runs as the same OS user and can set the environment
 * directly.
 *
 * What actually holds the line is that promotion happens in a SEPARATE TRUSTED
 * PROCESS, started by the integration owner, reading the real store from its own
 * environment. A worker redirecting its own verification redirects only its own
 * verification: the approval it mints lands in a store nothing trusted reads.
 *
 * The distinction matters to whoever comes next. The old reason would have
 * looked satisfied by a single merged process that still took the value from the
 * environment -- and that process would have had no control left at all.
 */
import path from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createJobStore } from './jobStore.mjs';
import { runGit } from './safeGit.mjs';
import { buildCandidateTree, materializeTree, resolveBaseline } from './candidateTree.mjs';
import { createVerifier, POLICY_VERSION } from './verifier.mjs';

export function stateDir() {
  return process.env.AGENTBRIDGE_STATE_DIR || path.join(homedir(), '.agentbridge', 'verification');
}

/*
 * TWO NARROWED CAPABILITIES, NOT ONE OBJECT WITH BOTH.
 *
 * A first version of this module exported controlPlane(), which returned the
 * whole verifier -- so bin/agentbridge-verify.mjs imported promoteApproval
 * whether it called it or not. "The worker command does not promote" would then
 * have been a statement about which line I chose to write, not about what the
 * binary can reach, and the structural test for it would have passed on a
 * technicality.
 *
 * So the seam hands out exactly one capability each. The worker plane has no
 * promote function to find.
 */
function planes(dir) {
  const jobStore = createJobStore(dir);
  const verifier = createVerifier({ jobStore, approvalStoreDir: dir });
  return { jobStore, verifier };
}

/** WORKER-FACING. verifyJob and nothing else. */
export function workerPlane(dir = stateDir()) {
  const { verifier } = planes(dir);
  return { verifyJob: (jobId) => verifier.verifyJob(jobId), policyVersion: POLICY_VERSION };
}

/** TRUSTED INTEGRATION. promoteApproval and nothing else. */
export function integrationPlane(dir = stateDir()) {
  const { verifier } = planes(dir);
  return { promoteApproval: (approvalId, ctx) => verifier.promoteApproval(approvalId, ctx) };
}

/**
 * CONTROLLER STEP. Called by the attempt runner while the candidate workspace
 * still exists. The worker never calls this -- it receives the returned id.
 *
 * IT SNAPSHOTS THE CANDIDATE, AND THAT IS NOT AN OPTIMISATION.
 *
 * The first version stored the attempt's workspace path. Running the shipped
 * binary end-to-end showed why that was dead code: the attempt pipeline
 * DESTROYS an accepted workspace before it returns, so every job named a
 * directory that no longer existed, and verification would have refused every
 * one of them with "no such workspace". The wiring was reachable and useless,
 * which is the exact failure the orphan gate exists to name and could not see,
 * because an import edge is not a working path.
 *
 * The snapshot is taken through the same two primitives the verifier uses:
 * build the tree (whose objects land in the authoritative repository's object
 * database, because an attempt workspace is a worktree of it) and materialise
 * that tree into a directory this side owns. So the bytes that survive are
 * exactly the bytes a tree can express -- and the candidate's own .git, which
 * carries executable configuration, is not among them.
 */
export function openVerificationJob({ repoRoot, baselineRef, candidateWorkspace, sessionId, workerId, dir }) {
  const root = dir ?? stateDir();
  const jobStore = createJobStore(root);

  /*
   * THE JOB BINDS THE COMMIT, NOT THE WORD "HEAD".
   *
   * The controller passes a ref because that is what it has. Storing the ref is
   * storing a name that means a different tree tomorrow, so the job is resolved
   * to the immutable commit it names HERE, on the trusted side, at the moment
   * the candidate was taken. Otherwise a job created against one baseline could
   * be verified against another simply because the authoritative repository
   * moved in between -- and the approval would still look perfectly valid,
   * because every check downstream agreed with itself.
   *
   * This is the same argument candidateTree.mjs makes about its own inputs. It
   * applied just as much one level up, and did not hold there until now.
   *
   * The repository's own identity is bound too, but by the job store rather than
   * here, so that no caller of createJob can supply it. policyVersion is
   * deliberately NOT bound: a job carrying its own policy version would let an
   * old job be verified under an old policy, which is a downgrade that arrives
   * looking like provenance. The verifier uses the policy it ships with.
   */
  const baseline = resolveBaseline(repoRoot, baselineRef);
  const snapshot = snapshotCandidate(root, repoRoot, candidateWorkspace);
  try {
    return jobStore.createJob({
      repoRoot,
      baselineRef: baseline.commitSha,
      candidateWorkspace: snapshot,
      sessionId,
      workerId,
    });
  } catch (e) {
    /* No job means nothing will ever read the snapshot, and a directory nobody
     * can reach is just disk that grows. */
    rmSync(snapshot, { recursive: true, force: true });
    throw e;
  }
}

/**
 * Materialise the candidate into a directory the verification side owns.
 *
 * THE TREE IS MATERIALISED FROM THE CANDIDATE, NOT FROM THE AUTHORITATIVE REPO.
 * `buildCandidateTree` writes its objects into whatever repository the candidate
 * workspace belongs to. That is the authoritative repo when the workspace is a
 * worktree of it -- which is the production case -- and a different object
 * database entirely when it is a clone. Reading the tree back from repoRoot
 * therefore worked in production and failed everywhere else, which is the worst
 * way round: correct on the path that is hard to test and broken on the path the
 * tests take.
 *
 * THE SNAPSHOT THEN BORROWS THE AUTHORITATIVE OBJECTS THROUGH `alternates`.
 * Verification resolves the BASELINE tree from the candidate side too, so a
 * snapshot with an empty object database cannot be verified at all: the first
 * thing the verifier does with it is look up a baseline it has never seen.
 * Alternates make those objects readable without copying them and without the
 * snapshot being able to write to them.
 *
 * `git init` at all because the verifier REBUILDS the tree from this directory
 * rather than trusting a SHA it was handed, and that re-derivation is the check.
 * Tree hashing is content-only, so what it computes is the hash of what was
 * snapshotted.
 */
function snapshotCandidate(stateRoot, repoRoot, candidateWorkspace) {
  const treeSha = buildCandidateTree(candidateWorkspace);
  const materialized = materializeTree(candidateWorkspace, treeSha);
  try {
    const git = (args, cwd) => runGit(args, { cwd }).trim();
    git(['-c', 'init.defaultBranch=main', 'init', '-q', '.'], materialized);

    /*
     * BOTH PATHS ARE RESOLVED AGAINST THE REPOSITORY THEY CAME FROM.
     * `git rev-parse --git-path` answers RELATIVE to the repository it was asked
     * in (".git/objects"), so joining that answer without a base resolves it
     * against the PROCESS's working directory instead. The first version did
     * exactly that for the snapshot and wrote an alternates file into whichever
     * repository the controller happened to be running in -- pointing its object
     * store at a temporary directory that was about to be deleted.
     */
    const objectsIn = (repo) => path.resolve(repo, git(['rev-parse', '--git-path', 'objects'], repo));
    const objects = objectsIn(repoRoot);
    const alternates = path.join(objectsIn(materialized), 'info', 'alternates');
    mkdirSync(path.dirname(alternates), { recursive: true });
    writeFileSync(alternates, `${objects}\n`, 'utf8');

    const candidatesDir = path.join(path.resolve(stateRoot), 'candidates');
    mkdirSync(candidatesDir, { recursive: true });
    const slot = mkdtempSync(path.join(candidatesDir, 'cand-'));
    const dest = path.join(slot, 'workspace');
    renameSync(materialized, dest);
    return dest;
  } catch (e) {
    rmSync(materialized, { recursive: true, force: true });
    throw e;
  }
}
