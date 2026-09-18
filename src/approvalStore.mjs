/**
 * TRUSTED APPROVAL RECORDS. NOT A CRYPTOGRAPHIC AUTHORITY -- READ THIS FIRST.
 *
 * The prototype's approval carried a "signature":
 *
 *     signature = SHA256(candidateId + patchHash + policyVersion)
 *
 * with no secret anywhere. Every input is public and every function that builds
 * them is exported, so a caller can mint one. Measured: a forged artifact for a
 * candidate that was NEVER verified promoted successfully and overwrote
 * CLAUDE.md in the authoritative repository. Promotion did not merely accept a
 * weak signature -- it never required verification to have happened at all.
 *
 * The repair is not a better checksum. Any value computed from public inputs is
 * reproducible by anyone holding those inputs, so a second checksum would be the
 * same defect wearing a longer hash. Authority has to be a REFERENCE to
 * something the verifier stored, not a value the caller can derive.
 *
 * So: the approval id is 256 bits of randomness with no relationship to the
 * candidate. Knowing everything about a candidate tells you nothing about its
 * approval id. The record lives on the verifier's side and promotion looks it up.
 *
 * WHAT THIS IS NOT, STATED PLAINLY. On this machine the worker and the verifier
 * run as the same OS user with the same filesystem permissions, so a worker can
 * read and write this store directly. File persistence here is OPERATIONAL
 * BOOKKEEPING, not a trust boundary, and no test in this file should be read as
 * proving one. It closes the "derive an approval from public values" hole and
 * nothing else. A real boundary needs a separate service identity or a separate
 * OS principal, which is Step 4B.
 */
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, renameSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Fields a record must carry. Anything missing is a refusal, not a default. */
export const APPROVAL_FIELDS = Object.freeze([
  'repoIdentity',
  'baselineCommitSha',
  'candidateTreeSha',
  'candidateId',
  'policyVersion',
  'verificationResult',
  'verifiedAt',
]);

export class ApprovalStoreError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'ApprovalStoreError';
    this.code = code;
  }
}

export function createApprovalStore(rootDir) {
  const dir = path.resolve(rootDir);
  const live = path.join(dir, 'approvals');
  const spent = path.join(dir, 'consumed');
  mkdirSync(live, { recursive: true });
  mkdirSync(spent, { recursive: true });

  const livePath = (id) => path.join(live, `${id}.json`);
  const spentPath = (id) => path.join(spent, `${id}.json`);

  /** 256 bits of randomness. Deliberately unrelated to the candidate it approves. */
  const mint = () => randomBytes(32).toString('hex');

  return {
    /** Returns ONLY the opaque id. The record never leaves the store. */
    createApproval(record) {
      for (const field of APPROVAL_FIELDS) {
        if (record?.[field] === undefined || record?.[field] === null || record?.[field] === '') {
          throw new ApprovalStoreError('incomplete-record', `missing ${field}`);
        }
      }
      if (record.verificationResult !== 'approve') {
        throw new ApprovalStoreError('not-approved', `refusing to store a record whose result is ${record.verificationResult}`);
      }
      const approvalId = mint();
      const stored = { approvalId, used: false, ...Object.fromEntries(APPROVAL_FIELDS.map((f) => [f, record[f]])) };
      /*
       * 'wx' so a collision cannot silently overwrite an existing approval.
       * 0600 because a record another user can edit is not a record.
       */
      writeFileSync(livePath(approvalId), `${JSON.stringify(stored, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return approvalId;
    },

    /** Read WITHOUT consuming. Returns null when absent or already spent. */
    getApproval(approvalId) {
      if (typeof approvalId !== 'string' || !/^[0-9a-f]{64}$/.test(approvalId)) return null;
      const p = livePath(approvalId);
      if (!existsSync(p)) return null;
      try {
        const parsed = JSON.parse(readFileSync(p, 'utf8'));
        return parsed?.used === false ? parsed : null;
      } catch {
        return null;           // an unreadable record is not a valid one
      }
    },

    /**
     * Atomically spend an approval. rename() is atomic on a single filesystem,
     * so two concurrent promotions cannot both win: the loser's rename fails
     * with ENOENT because the file is already gone.
     */
    consumeApproval(approvalId) {
      if (typeof approvalId !== 'string' || !/^[0-9a-f]{64}$/.test(approvalId)) {
        throw new ApprovalStoreError('malformed-approval-id', 'approval id is not a 256-bit hex value');
      }
      const from = livePath(approvalId);
      const to = spentPath(approvalId);
      let record;
      try {
        record = JSON.parse(readFileSync(from, 'utf8'));
      } catch {
        throw new ApprovalStoreError('unknown-or-spent-approval', 'no live approval with that id');
      }
      try {
        renameSync(from, to);
      } catch {
        throw new ApprovalStoreError('unknown-or-spent-approval', 'approval was consumed by another caller');
      }
      const consumed = { ...record, used: true, consumedAt: new Date().toISOString() };
      writeFileSync(to, `${JSON.stringify(consumed, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      return consumed;
    },

    /** Test/operational visibility only. */
    liveCount() { return readdirSync(live).filter((f) => f.endsWith('.json')).length; },
    spentCount() { return readdirSync(spent).filter((f) => f.endsWith('.json')).length; },
  };
}
