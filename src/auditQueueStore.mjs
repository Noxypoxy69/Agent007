/**
 * THE AUDIT QUEUE'S STORE. One implementation, two callers.
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * `readQueue` and `writeQueue` were LOCAL CLOSURES inside
 * `bin/agentbridge.mjs`. That is the real reason §7.1's trigger only ever
 * printed: the Stop gate physically could not reach them, so it imported
 * `auditJobsFor` and `formatAuditJobs`, computed the packets, and appended
 * them to the session's own notice.
 *
 * The commit that introduced the queue claimed the opposite -- "a demand that
 * lives in one session's output is a log line. This makes it a queue." It did
 * not, and a blind auditor caught it by reading the diff against the message.
 * The persisted queue existed only when a human typed `agentbridge audits`,
 * and nothing anywhere tells anyone to.
 *
 * So the store moves here rather than being copied. Two implementations of one
 * store is the pair nobody watches when they disagree, and this repository has
 * a header about losing days to exactly that.
 *
 * ═══ KEYED LIKE EVERY OTHER PER-REPO STORE ═══
 *
 * Through `repoStorePath`, not a second copy of the expression. That function
 * exists because the grant key was unprintable and undocumented for a week and
 * resolved differently in every worktree -- measured across 17 roots, exactly
 * one had a grant and it was not the one anybody was working in. A queue that
 * keyed itself would reproduce that, and the symptom would be "the audit queue
 * is empty", which is indistinguishable from "no audits are due".
 */
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { repoStorePath } from './guardSession.mjs';

export const auditQueuePath = (repoRoot, home = undefined) => repoStorePath(repoRoot, 'audits', '.jsonl', home);

/**
 * Read the queue, last write wins per audit_id.
 *
 * APPEND-ONLY ON DISK, DEDUPED ON READ. The file is appended rather than
 * rewritten so a crash mid-write cannot destroy the queue, and the cost is
 * that a row appears more than once. The last occurrence is the current state.
 *
 * A MALFORMED LINE IS COUNTED, NOT JUST SKIPPED. Silently dropping every line
 * would make `audits` print "nothing due" and exit 0 -- a broken store and an
 * empty one reporting identically, which is the exact hollow shape the queue
 * exists to remove. The caller is handed the count so it can say so.
 */
export function readQueue(repoRoot, home = undefined) {
  const file = auditQueuePath(repoRoot, home);
  if (!existsSync(file)) return { rows: [], malformed: 0, file };

  const byId = new Map();
  let malformed = 0;
  for (const line of String(readFileSync(file, 'utf8')).split('\n')) {
    if (line.trim() === '') continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && typeof row.audit_id === 'string') byId.set(row.audit_id, row);
      else malformed += 1;
    } catch {
      malformed += 1;
    }
  }
  return { rows: [...byId.values()], malformed, file };
}

/** Append the current queue. Callers pass the whole merged set. */
export function writeQueue(repoRoot, rows, home = undefined) {
  const file = auditQueuePath(repoRoot, home);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  return file;
}
