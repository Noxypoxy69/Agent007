#!/usr/bin/env node
/**
 * WORKER-FACING VERIFICATION. TAKES A JOB ID AND NOTHING ELSE.
 *
 *   agentbridge-verify --job <jobId>
 *
 * There is no --repo, no --baseline, no --workspace, no --policy and no
 * --skip-suite, and their absence is the point. The prototype accepted all of
 * them from its caller, and a candidate that named ITSELF as the authoritative
 * repository was approved. Everything that decides the verdict is resolved from
 * trusted job state this process reads by id.
 *
 * THIS FILE DOES NOT IMPORT promoteApproval. Promotion lives in
 * bin/agentbridge-integrate.mjs, a separate executable. The prototype exposed
 * both through one command and gated promotion on a caller-supplied
 * actorRole string -- so a worker typing "integration-owner" promoted its own
 * candidate. Authority cannot come from the payload, so the capability is not
 * present in the binary a worker runs.
 *
 * On this machine that is a weak boundary: same OS user, and a determined worker
 * can import the module directly. It is the honest prototype shape of "authority
 * comes from the execution boundary", not a claim to have built one.
 *
 * Exit 0 ONLY on an approval. A run that verified nothing must not read as one.
 */
import { workerPlane } from '../src/verificationControl.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? null;
};

const jobId = flag('--job');
if (!jobId) {
  process.stderr.write('usage: agentbridge-verify --job <jobId>\n');
  process.exit(2);
}

const { verifyJob } = workerPlane();
const result = verifyJob(jobId);

/*
 * THE STORE'S FILESYSTEM PATHS NEVER TRAVEL. A worker learning where approvals
 * live is a worker one step from writing one.
 */
process.stdout.write(`${JSON.stringify({
  decision: result.decision,
  reason: result.reason,
  candidateId: result.candidateId ?? null,
  candidateTreeSha: result.candidateTreeSha ?? null,
  approvalId: result.approvalId ?? null,
  validation: result.validation?.counts ?? null,
  provenance: { jobId },
}, null, 2)}\n`);

process.exit(result.decision === 'approve' ? 0 : 1);
