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
 * ═══ THIS DOES NOT FIX M11, AND THE FIRST VERSION OF THIS COMMENT CLAIMED IT DID ═══
 *
 * Fourth-lap blind audit M11 is a lost update: every caller passes its WHOLE
 * snapshot, the read dedupes last-write-wins, so a writer re-asserts stale
 * values for rows it never touched. The daemon reads at `nextJob()`, spends
 * seconds in `git worktree add`, then appends its pre-allocation snapshot;
 * the post-commit hook runs on every commit and appends its own. A commit
 * landing mid-allocation reverts a claim while the reviewer is still running.
 *
 * I wrote a filter here that skipped rows identical to what is on disk, and
 * claimed it removed that "entirely". IT DOES NOT, and my own test caught it
 * before the claim shipped: A STALE ROW DIFFERS FROM DISK, which is exactly
 * why it clobbers. The filter cannot tell "I changed this" from "mine is out
 * of date" — both are differences. Distinguishing them needs the writer's
 * BASELINE (what it read), which this function is not given.
 *
 * ═══ WHAT IT ACTUALLY DOES ═══
 *
 * It stops the file growing by the entire queue on every commit — the live
 * store held 1400+ rows for ~34 jobs — and it makes a no-op write a genuine
 * no-op. Both real, neither is M11.
 *
 * ═══ M11 REMAINS OPEN, and the fix is a signature change ═══
 *
 * `writeQueue(repo, rows, {baseline})`, appending only rows that differ from
 * what the caller READ, with every caller threading its own baseline through
 * — or an advisory lock. That touches the daemon, the hook, the CLI and the
 * Stop gate, one of which no session may edit. It is a bigger change than
 * this slot, and half-doing it while the comment says otherwise is precisely
 * the failure four consecutive audits have found in this file's neighbours.
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
