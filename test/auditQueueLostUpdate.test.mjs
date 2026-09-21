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
import { auditJobsFor, mergeQueue } from '../src/auditJob.mjs';

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

test('D1: A RECOMPUTED PACKET IS NOT A CHANGED ROW -- created_at must not drift', () => {
  /*
   * Seventh-lap blind audit D1, MEASURED against the operator's live store:
   * two consecutive rows byte-identical except `created_at`, and eleven
   * whole-queue rows appended by one invocation that added and stranded
   * nothing. `auditJobsFor` stamps a fresh timestamp into every computed
   * packet and `mergeQueue`'s spread let it win, so every row differed from
   * disk on every run -- the no-op filter never fired once.
   *
   * This is the test the filter never had: it exercised only rows built by
   * hand, never a RECOMPUTED packet, which is the only shape production
   * produces. Hollow gate 9 again, in the file that gates the store.
   */
  const coverage = {
    commits: [{ sha: 'a'.repeat(40), subject: 's', touched: ['src/policy.mjs'], audited: false }],
    malformed: [],
    error: null,
  };
  const compute = (now) => auditJobsFor(coverage, { treeShaFor: () => '1'.repeat(40), now }).jobs;

  const first = mergeQueue([], compute('2026-09-21T00:00:00Z'), { now: 'a' }).queue;
  writeQueue(REPO, first, home);
  const before = readFileSync(auditQueuePath(REPO, home), 'utf8');

  /*
   * READ BACK FROM DISK, WHICH IS WHAT PRODUCTION DOES. Focused-pass
   * finding D-10: this used the in-memory array, while every real caller
   * does `mergeQueue(readQueue(...).rows, ...)`. A JSON round trip DROPS
   * UNDEFINED-VALUED KEYS and fixes key order -- and key order is exactly
   * what `writeQueue`'s `JSON.stringify` comparison is sensitive to.
   *
   * So the in-memory version could have passed while the shape production
   * actually produces failed. That is the same "the fixture is not what
   * the system makes" defect this file was written to close, one layer
   * along, and it is one line from being right.
   */
  const stored = readQueue(REPO, home).rows;
  assert.equal(stored[0].created_at, first[0].created_at,
    'the round trip through disk changed created_at, so the comparison below would '
    + 'be measuring serialisation rather than the merge');

  /* The SAME candidate, recomputed a minute later. Nothing about it changed. */
  const again = mergeQueue(stored, compute('2026-09-21T00:01:00Z'), { now: 'b' }).queue;
  assert.equal(again[0].created_at, first[0].created_at,
    'a recomputed packet moved created_at, so every row looks changed and the '
    + 'no-op filter can never fire');

  /*
   * AND A ROW THAT NEVER HAD ONE DOES NOT ACQUIRE A DRIFTING ONE. The
   * preservation is `was.created_at ?? job.created_at ?? str(now)`, and
   * `job.created_at` is a fresh timestamp from auditJobsFor -- so a stored
   * row lacking the field would take the fresh value on every merge and
   * look changed for ever. Measured as 0 of 1618 live rows today, which is
   * why it is latent rather than live; it stops being latent the moment a
   * row is written by anything that does not stamp it.
   */
  const legacy = stored.map(({ created_at, ...rest }) => rest);
  const a = mergeQueue(legacy, compute('2026-09-21T00:02:00Z'), { now: 'c' }).queue[0].created_at;
  const b = mergeQueue(legacy, compute('2026-09-21T00:03:00Z'), { now: 'd' }).queue[0].created_at;
  assert.equal(a, b,
    'a row with no created_at takes a fresh timestamp on every merge, so it looks '
    + 'changed every run and the filter never fires for it');

  /*
   * AND A ROW MISSING **BOTH** FIELDS, which is the case the strip above
   * structurally cannot reach. Blind audit L2: the fallback chain was
   * `was.created_at ?? was.first_seen_at ?? job.created_at ?? str(now)`,
   * so removing only `created_at` left `was.first_seen_at` to catch it and
   * the test passed over a defect that was still live one field along.
   *
   * A fixture that can only construct the case that was already fixed is
   * hollow gate 9, and this one was mine, written in the commit that
   * claimed to close the drift.
   */
  const barest = stored.map(({ created_at, first_seen_at, ...rest }) => rest);
  const c = mergeQueue(barest, compute('2026-09-21T00:04:00Z'), { now: 'e' }).queue[0];
  const d = mergeQueue(barest, compute('2026-09-21T00:05:00Z'), { now: 'f' }).queue[0];
  assert.equal(c.created_at, d.created_at,
    'a row carrying NEITHER created_at nor first_seen_at still drifts: it takes a fresh '
    + 'stamp on every merge, so it looks changed for ever and the no-op filter never fires');

  /* The two fields must also AGREE, or the row claims it was created before
   * the queue first saw it -- which is the inconsistency that made the
   * fallback chain read the stored field instead of the computed one. */
  assert.equal(c.created_at, c.first_seen_at,
    'created_at and first_seen_at disagree for a row that had neither, so they were '
    + 'resolved independently and can drift apart again');

  /* THE POSITIVE (rule 5): once persisted, the value is stable rather than
   * simply absent -- a row that settles on nothing would pass the equality
   * above for the wrong reason. */
  assert.ok(c.created_at, 'the row settled on no created_at at all, so the equality above is vacuous');

  writeQueue(REPO, again, home);
  assert.equal(readFileSync(auditQueuePath(REPO, home), 'utf8'), before,
    'recomputing an unchanged queue appended rows -- the store grows by the whole '
    + 'queue on every run, and a stale producer reverts live claims');
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
