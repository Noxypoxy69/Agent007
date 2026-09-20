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

/**
 * Append the current queue. Callers pass the whole merged set.
 *
 * ═══ ONLY THE ROWS THAT ACTUALLY CHANGED ARE APPENDED ═══
 *
 * Fourth-lap blind audit M11. Every caller passes its WHOLE snapshot, and
 * the read dedupes last-write-wins -- so a writer re-asserted stale values
 * for every row it had never touched. That is a lost update, and on a
 * machine that commits constantly it is not theoretical:
 *
 *   - `scripts/audit-daemon.mjs` reads at `nextJob()`, then runs
 *     `git worktree add` (seconds), then appends its pre-allocation snapshot.
 *   - `scripts/enqueue-audit-job.mjs` runs on EVERY COMMIT and appends its
 *     own whole snapshot after `auditCoverage` (also seconds of git).
 *
 * A commit landing while the daemon allocates appended a stale PENDING row
 * for the job the daemon had just claimed, last write won, and the claim
 * evaporated while the reviewer was still running. Symmetrically, a hook run
 * could revert a row the CLI had just recorded.
 *
 * Re-reading here and filtering to genuinely-changed rows removes that
 * entirely: a writer can no longer clobber a row it did not modify, because
 * it no longer writes one. It also stops the file growing by the whole queue
 * on every commit, which is why it was 1400+ rows for ~34 jobs.
 *
 * ═══ WHAT THIS DOES NOT FIX, SAID PLAINLY ═══
 *
 * It is NOT a lock. Two writers changing THE SAME row within the same
 * read-modify-write window can still interleave, and the later append wins.
 * That window is now microseconds (a read and a compare) instead of the
 * seconds a `git worktree add` takes, but it is not zero. Closing it needs
 * an advisory lock or a compare-and-set, which is a bigger change than a
 * finding this size warrants -- and pretending otherwise in a comment is how
 * the last four of these got missed.
 */
export function writeQueue(repoRoot, rows, home = undefined) {
  const file = auditQueuePath(repoRoot, home);
  mkdirSync(dirname(file), { recursive: true });

  const current = new Map();
  for (const r of readQueue(repoRoot, home).rows) current.set(r.audit_id, JSON.stringify(r));

  const changed = (Array.isArray(rows) ? rows : []).filter((r) => {
    if (!r || typeof r.audit_id !== 'string') return false;
    return current.get(r.audit_id) !== JSON.stringify(r);
  });

  /*
   * NOTHING TO SAY IS NOT AN ERROR, and writing an empty line would add a
   * malformed row that `readQueue` then counts -- turning a no-op into a
   * report of a broken store.
   */
  if (changed.length === 0) return file;

  appendFileSync(file, `${changed.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  return file;
}
