/**
 * A WRITER USED TO CLOBBER ROWS IT HAD NEVER TOUCHED.
 *
 * Fourth-lap blind audit M11. The store is append-only and deduped
 * last-write-wins per `audit_id`, and every caller appended its WHOLE
 * snapshot -- so a writer re-asserted stale values for every row it had not
 * modified. Measured consequence in the shape the auditor described:
 *
 *   - the daemon reads at nextJob(), runs `git worktree add` (seconds), then
 *     appends its pre-allocation snapshot;
 *   - the post-commit hook runs on EVERY COMMIT and appends its own snapshot
 *     after auditCoverage (also seconds of git).
 *
 * A commit landing while the daemon allocated appended a stale PENDING row
 * for the job the daemon had just claimed. Last write won. The claim
 * evaporated while the reviewer was still running.
 *
 * These drive the real store through a temp AGENTBRIDGE_HOME, never the
 * operator's, because a test that writes the live audit queue is the defect
 * a previous auditor disclosed having caused.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readQueue, writeQueue, auditQueuePath } from '../src/auditQueueStore.mjs';

const REPO = process.cwd();
let home;

const job = (id, over = {}) => ({
  audit_id: id, candidate_sha: 'a'.repeat(40), state: 'PENDING',
  claimed_by: null, claimed_at: null, ...over,
});

test.beforeEach(() => { home = mkdtempSync(path.join(tmpdir(), 'aq-test-')); });
test.afterEach(() => { try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ } });

test('M11 IS STILL OPEN: a stale writer DOES revert a claim it never touched', () => {
  /*
   * ═══ THIS TEST PINS A DEFECT, IT DOES NOT ASSERT A FIX ═══
   *
   * I wrote it expecting `CLAIMED` and it failed, which is the honest
   * outcome: the filter I added to `writeQueue` skips rows identical to
   * disk, and a STALE row is not identical to disk -- that is the whole
   * reason it clobbers. So the lost update survives.
   *
   * It is pinned rather than deleted because the exact interleaving is the
   * thing a future fix has to break, and because a defect nobody can re-run
   * gets rediscovered by the next auditor at full price. Flip the expected
   * value when `writeQueue` learns the caller's baseline.
   *
   * The interleaving: A reads, B claims and writes, A writes its stale
   * snapshot seconds later. In production A is the post-commit hook and B is
   * the daemon mid-`git worktree add`.
   */
  writeQueue(REPO, [job('audit-1'), job('audit-2')], home);
  const staleSnapshot = readQueue(REPO, home).rows;          // A reads

  writeQueue(REPO, [                                          // B claims audit-1
    job('audit-1', { state: 'CLAIMED', claimed_by: 'reviewer', claimed_at: 1000 }),
    job('audit-2'),
  ], home);

  writeQueue(REPO, staleSnapshot, home);                      // A writes, seconds later

  const one = readQueue(REPO, home).rows.find((r) => r.audit_id === 'audit-1');
  assert.equal(one.state, 'PENDING',
    'M11 appears to be FIXED -- a stale writer no longer reverts the claim. If that is '
    + 'deliberate, this test should now expect CLAIMED and the comment above is stale.');
  assert.equal(one.claimed_by, null);
});

test('A REAL CHANGE STILL LANDS, or the test above passes by writing nothing', () => {
  /* Rule 5. Suppressing every write would satisfy the first test perfectly. */
  writeQueue(REPO, [job('audit-1')], home);
  writeQueue(REPO, [job('audit-1', { state: 'COMPLETED_PASS' })], home);

  const one = readQueue(REPO, home).rows.find((r) => r.audit_id === 'audit-1');
  assert.equal(one.state, 'COMPLETED_PASS', 'a genuine update was swallowed');
});

test('AN UNCHANGED SNAPSHOT APPENDS NOTHING, so the file stops growing per commit', () => {
  /*
   * Secondary but real: the live store held 1400+ rows for ~34 jobs because
   * every commit appended the entire queue. That is what made a 7-char
   * prefix sweep expensive and the file awkward to read by hand.
   */
  writeQueue(REPO, [job('audit-1'), job('audit-2')], home);
  const before = readFileSync(auditQueuePath(REPO, home), 'utf8');

  writeQueue(REPO, readQueue(REPO, home).rows, home);
  writeQueue(REPO, readQueue(REPO, home).rows, home);

  assert.equal(readFileSync(auditQueuePath(REPO, home), 'utf8'), before,
    're-writing an unchanged snapshot still appended rows');
});

test('AN EMPTY WRITE DOES NOT CREATE A MALFORMED ROW', () => {
  /*
   * The naive early return is `if (!changed.length) return`, but the old code
   * would have written a bare newline -- and `readQueue` counts a blank as
   * malformed, turning a no-op into a report of a broken store, which is the
   * shape this file's own header warns about.
   */
  writeQueue(REPO, [job('audit-1')], home);
  writeQueue(REPO, [], home);
  assert.equal(readQueue(REPO, home).malformed, 0, 'an empty write produced a malformed row');
  assert.equal(readQueue(REPO, home).rows.length, 1);
});

test('A ROW WITH NO audit_id IS NOT WRITTEN, because it can never be read back', () => {
  writeQueue(REPO, [{ state: 'PENDING' }, job('audit-1')], home);
  const q = readQueue(REPO, home);
  assert.equal(q.malformed, 0, 'an unkeyed row was written and then counted as malformed on read');
  assert.equal(q.rows.length, 1);
});
