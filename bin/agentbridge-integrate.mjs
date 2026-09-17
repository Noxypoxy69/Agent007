#!/usr/bin/env node
/**
 * TRUSTED INTEGRATION. CONSUMES AN OPAQUE APPROVAL ID.
 *
 *   agentbridge-integrate --approval <approvalId> --job <jobId>
 *
 * A SEPARATE EXECUTABLE FROM THE WORKER'S VERIFY COMMAND, and that separation IS
 * the authority claim. There is no --role flag and no field in the input that
 * asserts an identity, because the prototype had exactly that and a worker
 * promoted its own candidate by typing a string.
 *
 * It takes an approval ID, not an approval object. The prototype accepted a
 * caller-supplied artifact whose "signature" was SHA256 of public values, so a
 * forged artifact for a candidate that was never verified promoted successfully
 * and overwrote CLAUDE.md in the authoritative repository. An id is a reference
 * to something the verifier stored; an artifact is a claim the caller made.
 *
 * Promotion re-checks the baseline, re-derives the candidate identity, spends
 * the approval atomically, and writes the EXACT approved tree with commit-tree
 * to refs/agentbridge/promoted/<candidateId>. It never touches a branch: the
 * final move is the integration owner's.
 */
import { integrationPlane } from '../src/verificationControl.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? null;
};

const approvalId = flag('--approval');
const jobId = flag('--job');
if (!approvalId || !jobId) {
  process.stderr.write('usage: agentbridge-integrate --approval <approvalId> --job <jobId>\n');
  process.exit(2);
}

const { promoteApproval } = integrationPlane();
const result = promoteApproval(approvalId, { jobId });

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.ok ? 0 : 1);
