/**
 * TRUSTED JOB STATE. The worker receives an opaque job id and nothing else.
 *
 * Everything that decides a verdict lives here: which repository is
 * authoritative, which baseline, which workspace holds the candidate. The
 * prototype took all three from the caller, which is how a candidate certified
 * itself by naming itself as the authoritative repo.
 *
 * FILE-BACKED BECAUSE THE REAL PATH CROSSES PROCESSES. The controller
 * (bin/agentbridge-attempt.mjs) creates the job; the worker runs
 * bin/agentbridge-verify.mjs as a separate process; integration runs
 * bin/agentbridge-integrate.mjs as a third. An in-memory Map would have made the
 * whole chain untestable through the shipped entry points, which is exactly the
 * wiring the orphan gate was complaining about.
 *
 * SAME CAVEAT AS THE APPROVAL STORE, AND IT IS NOT A FOOTNOTE. On this machine
 * the worker runs as the same OS user and can rewrite these files directly.
 * That makes this operational bookkeeping, not a trust boundary: it stops the
 * worker DECLARING its own authority in a payload, and it does not stop a
 * hostile worker editing the record on disk. A real boundary needs a separate
 * OS principal, which is Step 4B.
 */
import { randomBytes } from 'node:crypto';
import { repoIdentity } from './candidateTree.mjs';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/** Fields a job must carry. A missing one is a refusal, never a default. */
export const JOB_FIELDS = Object.freeze([
  'jobId',
  'repoRoot',
  'baselineRef',
  'candidateWorkspace',
  'repoIdentity',
  'sessionId',
  'workerId',
]);

export function createJobStore(rootDir) {
  const dir = path.resolve(rootDir);
  const jobsDir = path.join(dir, 'jobs');
  mkdirSync(jobsDir, { recursive: true });
  const jobPath = (id) => path.join(jobsDir, `${id}.json`);

  return {
    /**
     * CONTROLLER-SIDE ONLY. Nothing a worker can reach calls this: the verify
     * entry point takes a job id and has no way to mint one.
     */
    createJob({ repoRoot, baselineRef, candidateWorkspace, sessionId = null, workerId = null, label = null }) {
      if (!repoRoot || !baselineRef || !candidateWorkspace) {
        throw new Error('createJob requires repoRoot, baselineRef and candidateWorkspace');
      }
      const jobId = randomBytes(16).toString('hex');
      const record = {
        jobId,
        repoRoot: path.resolve(repoRoot),
        baselineRef,
        /*
         * DERIVED HERE, NEVER ACCEPTED FROM A CALLER. Binding the repository's
         * identity means a DIFFERENT repository later occupying the same path is
         * a different repository, rather than the same one with surprising
         * contents. Taking it as a parameter would have made it a claim, and a
         * claim is the thing this whole layer exists to stop accepting.
         */
        repoIdentity: repoIdentity(repoRoot),
        candidateWorkspace: path.resolve(candidateWorkspace),
        sessionId,
        workerId,
        label,
        createdAt: new Date().toISOString(),
      };
      /* 'wx' so a collision cannot overwrite a live job; 0600 for the same
       * reason the approval store uses it. */
      writeFileSync(jobPath(jobId), `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return jobId;
    },

    /** Returns a FROZEN copy, so a caller mutating what it is handed changes nothing. */
    getJob(jobId) {
      if (typeof jobId !== 'string' || !/^[0-9a-f]{32}$/.test(jobId)) return null;
      const p = jobPath(jobId);
      if (!existsSync(p)) return null;
      try {
        const parsed = JSON.parse(readFileSync(p, 'utf8'));
        for (const field of JOB_FIELDS) {
          if (parsed?.[field] === undefined) return null;   // an incomplete record is not a job
        }
        return Object.freeze({ ...parsed });
      } catch {
        return null;
      }
    },
  };
}
