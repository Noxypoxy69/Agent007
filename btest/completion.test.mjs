import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  workFingerprint,
  resolveWork,
  canComplete,
  overlapping,
  normalisePath,
  normaliseGoal,
  CREATE,
  ATTACH,
  REFUSE,
  UNKNOWN,
  overlapReport,
  OVERLAP_COLLISION,
  OVERLAP_NONE,
  OVERLAP_UNREAD,
  OVERLAP_NO_PATHS,
} from '../src/completion.mjs';

/**
 * THE COMPLETION SEAM, PROVED IN BOTH DIRECTIONS.
 *
 * A duplicate guard that only refuses is a permanent block on ever re-doing
 * anything; one that only permits is decoration. The map names both cases and
 * both are asserted here: an invalidated completion MUST create a new
 * generation, and equivalent live or completed work MUST NOT create a second
 * task.
 *
 * THE TWO REAL DUPLICATIONS ARE TEST CASES, NOT ANECDOTES. `the real
 * duplications` below replays the shapes of 066d32e (65 minutes after code-a's
 * 5083feb) and the roster fix (nine minutes after code-b's). Both are asserted
 * against the mechanism that would actually have caught them -- path overlap --
 * rather than against the exact fingerprint, which would have missed both. A
 * test that credited the fingerprint with those catches would be the gate
 * agreeing with itself through the exact regression it exists to prevent.
 */

const REPO = 'agentbridge';

test('a fingerprint is stable across rewording and path spelling', () => {
  const a = workFingerprint({
    repo: REPO,
    paths: ['src/worker.mjs', 'test/worker.test.mjs'],
    goal: 'Fix the CI failure',
  });
  // Reordered paths, Windows separators, a leading ./, different case, and the
  // goal reworded with stopwords moved around. Same work, same value.
  const b = workFingerprint({
    repo: REPO,
    paths: ['./test/Worker.test.mjs', 'src\\worker.mjs'],
    goal: 'fix CI failure',
  });
  assert.equal(a, b);
});

test('a fingerprint separates work in different repositories', () => {
  const here = workFingerprint({ repo: REPO, paths: ['src/a.mjs'], goal: 'x' });
  const there = workFingerprint({ repo: 'social-sparks-app', paths: ['src/a.mjs'], goal: 'x' });
  assert.notEqual(here, there);
});

test('a fingerprint separates different files and different goals', () => {
  const base = workFingerprint({ repo: REPO, paths: ['src/a.mjs'], goal: 'wire the lease' });
  assert.notEqual(base, workFingerprint({ repo: REPO, paths: ['src/b.mjs'], goal: 'wire the lease' }));
  assert.notEqual(base, workFingerprint({ repo: REPO, paths: ['src/a.mjs'], goal: 'delete the lease' }));
});

test('workFingerprint refuses to guess a repository', () => {
  assert.throws(() => workFingerprint({ paths: ['src/a.mjs'] }), TypeError);
});

/* ---------------------------------------------------------------- REFUSALS */

test('REFUSAL: equivalent live work cannot create a second task', () => {
  const paths = ['src/dispatch.mjs'];
  const goal = 'stop the review proposal churn';
  const fp = workFingerprint({ repo: REPO, paths, goal });

  for (const state of ['runnable', 'assigned', 'returned', 'reviewing']) {
    const r = resolveWork({
      repo: REPO,
      paths,
      goal,
      active: [{ repo: REPO, work_fingerprint: fp, state, work_item_id: 'w-1', agent_id: 'code-d' }],
    });
    assert.equal(r.verdict, ATTACH, `state ${state} should attach, not create`);
    assert.equal(r.attach_to, 'w-1');
    assert.match(r.reasons.join(' '), /code-d/, 'a refusal must name who holds it');
  }
});

test('REFUSAL: equivalent completed work cannot create another task', () => {
  const paths = ['src/sessionCredential.mjs'];
  const goal = 'per session credentials';
  const fp = workFingerprint({ repo: REPO, paths, goal });
  const r = resolveWork({
    repo: REPO,
    paths,
    goal,
    completed: [
      { repo: REPO, work_fingerprint: fp, work_item_id: 'w-9', completed_at: '2026-09-17T05:44:00Z' },
    ],
  });
  assert.equal(r.verdict, REFUSE);
  assert.equal(r.completed_as, 'w-9');
});

test('REFUSAL: a failed lookup is UNKNOWN, never CREATE', () => {
  const r = resolveWork({
    repo: REPO,
    paths: ['src/a.mjs'],
    goal: 'anything',
    ok: false,
    errors: ['connection reset'],
  });
  assert.equal(r.verdict, UNKNOWN);
  assert.notEqual(r.verdict, CREATE);
  assert.match(r.reasons.join(' '), /not evidence of absence/);
  assert.match(r.reasons.join(' '), /connection reset/, 'the underlying error must survive');
});

test('REFUSAL: agent prose cannot assert integration', () => {
  const r = canComplete({
    workItemId: 'w-1',
    claim: 'I wired it and all tests pass',
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /accepted review/);
  assert.match(r.errors.join(' '), /verified integration/);
  assert.match(r.errors.join(' '), /a claim of completion is not evidence/);
});

test('REFUSAL: an unverified or unproved integration does not complete', () => {
  const accepted = 'r-1';

  const pending = canComplete({
    workItemId: 'w-1',
    acceptedReviewId: accepted,
    integration: {
      work_item_id: 'w-1',
      integration_state: 'pending',
      ancestry_verified_at: '2026-09-17T06:00:00Z',
    },
  });
  assert.equal(pending.ok, false);
  assert.match(pending.errors.join(' '), /not verified/);

  // Verified but nothing ever checked the commit actually landed on the target.
  const unproved = canComplete({
    workItemId: 'w-1',
    acceptedReviewId: accepted,
    integration: { work_item_id: 'w-1', integration_state: 'verified' },
  });
  assert.equal(unproved.ok, false);
  assert.match(unproved.errors.join(' '), /ancestry_verified_at/);

  // Verified, proved, and belonging to a DIFFERENT work item.
  const foreign = canComplete({
    workItemId: 'w-1',
    acceptedReviewId: accepted,
    integration: {
      work_item_id: 'w-2',
      integration_state: 'verified',
      ancestry_verified_at: '2026-09-17T06:00:00Z',
    },
  });
  assert.equal(foreign.ok, false);
  assert.match(foreign.errors.join(' '), /belongs to w-2/);
});

test('REFUSAL: a self-reviewed completion is still missing the review', () => {
  const r = canComplete({
    workItemId: 'w-1',
    acceptedReviewId: '',
    integration: {
      work_item_id: 'w-1',
      integration_state: 'verified',
      ancestry_verified_at: '2026-09-17T06:00:00Z',
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /accepted review/);
});

/* ---------------------------------------------------------------- POSITIVE */

test('POSITIVE: an invalidated completion creates a new generation', () => {
  const paths = ['src/worker.mjs'];
  const goal = 'reconcile the two loops';
  const fp = workFingerprint({ repo: REPO, paths, goal });
  const r = resolveWork({
    repo: REPO,
    paths,
    goal,
    completed: [
      {
        repo: REPO,
        work_fingerprint: fp,
        work_item_id: 'w-3',
        completed_at: '2026-09-10T00:00:00Z',
        invalidated_at: '2026-09-16T00:00:00Z',
      },
    ],
  });
  assert.equal(r.verdict, CREATE, 'invalidated work must be runnable again');
  assert.equal(r.supersedes, 'w-3');
});

test('POSITIVE: genuinely new work is created, and unrelated live work does not block it', () => {
  const r = resolveWork({
    repo: REPO,
    paths: ['src/completion.mjs'],
    goal: 'build the completion seam',
    active: [
      {
        repo: REPO,
        work_fingerprint: workFingerprint({ repo: REPO, paths: ['src/dispatch.mjs'], goal: 'churn' }),
        state: 'assigned',
        work_item_id: 'w-2',
      },
    ],
    completed: [],
  });
  assert.equal(r.verdict, CREATE);
  assert.deepEqual(r.overlaps, []);
});

test('POSITIVE: work matching a CLOSED state is not treated as live', () => {
  const paths = ['src/a.mjs'];
  const goal = 'g';
  const fp = workFingerprint({ repo: REPO, paths, goal });
  const r = resolveWork({
    repo: REPO,
    paths,
    goal,
    active: [{ repo: REPO, work_fingerprint: fp, state: 'cancelled', work_item_id: 'w-4' }],
  });
  assert.equal(r.verdict, CREATE, 'cancelled work must not block a retry');
});

test('a completion with an accepted review and a verified integration is allowed', () => {
  const r = canComplete({
    workItemId: 'w-1',
    acceptedReviewId: 'r-1',
    integration: {
      work_item_id: 'w-1',
      integration_state: 'verified',
      ancestry_verified_at: '2026-09-17T06:00:00Z',
    },
    claim: 'and the agent said so too, which changes nothing',
  });
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.deepEqual(r.errors, []);
});

/* ------------------------------------------------- THE REAL DUPLICATIONS */

test('the real duplications: overlap catches what the fingerprint cannot', () => {
  // 2026-09-16. code-a is fixing the CI failure and describes it one way; I
  // arrive 65 minutes later and describe the SAME file differently. This is the
  // measured shape of 5083feb vs 066d32e.
  const theirs = {
    repo: REPO,
    work_item_id: 'w-a',
    agent_id: 'code-a',
    state: 'assigned',
    paths: ['test/leakRegression.test.mjs'],
  };
  const myPaths = ['test/leakRegression.test.mjs'];
  const myGoal = 'stop the identity guard matching generic service accounts';

  const theirFp = workFingerprint({
    repo: REPO,
    paths: theirs.paths,
    goal: 'fix the username substring assertion on CI runners',
  });
  const myFp = workFingerprint({ repo: REPO, paths: myPaths, goal: myGoal });

  // THE POINT OF THIS TEST. Different prose, so the exact fingerprints differ
  // and an exact-match-only guard would have waved me straight through.
  assert.notEqual(theirFp, myFp);

  const r = resolveWork({
    repo: REPO,
    paths: myPaths,
    goal: myGoal,
    active: [{ ...theirs, work_fingerprint: theirFp }],
  });
  assert.equal(r.verdict, CREATE, 'the fingerprint alone cannot refuse this, and must not pretend to');
  assert.equal(r.overlaps.length, 1, 'but the overlap check must see it');
  assert.equal(r.overlaps[0].held_by, 'code-a');
  // The CALLER'S spelling, not the comparison key. Asserted as written because
  // the first version of this test asserted the folded form and so agreed with
  // the defect: the live run printed docs/order.md for docs/ORDER.md.
  assert.deepEqual(r.overlaps[0].shared_paths, ['test/leakRegression.test.mjs']);
});

test('overlap matches case-insensitively but reports the path as written', () => {
  // Two spellings of one file, one per side, neither of them lowercase.
  const hits = overlapping({
    repo: REPO,
    paths: ['docs/ORDER.md'],
    items: [{ repo: REPO, work_item_id: 'b/real-agent-launch', paths: ['Docs\\Order.MD'] }],
  });
  assert.equal(hits.length, 1, 'case and separator must not hide a collision');
  assert.deepEqual(
    hits[0].shared_paths,
    ['docs/ORDER.md'],
    'the reported path must be openable, not the folded comparison key',
  );
});

test('overlap is per repository and needs a genuinely shared file', () => {
  const items = [
    { repo: REPO, work_item_id: 'w-a', agent_id: 'code-a', paths: ['src/worker.mjs'] },
    { repo: 'other-repo', work_item_id: 'w-b', agent_id: 'code-b', paths: ['src/worker.mjs'] },
  ];
  const hits = overlapping({ repo: REPO, paths: ['src/worker.mjs'], items });
  assert.equal(hits.length, 1, 'a same-named file in another repository is not a collision');
  assert.equal(hits[0].held_by, 'code-a');

  assert.deepEqual(
    overlapping({ repo: REPO, paths: ['src/elsewhere.mjs'], items }),
    [],
    'no shared file, no overlap',
  );
  assert.deepEqual(
    overlapping({ repo: REPO, paths: [], items }),
    [],
    'an empty path contract cannot collide with anything',
  );
});

/* ------------------------------------------------------------ NORMALISERS */

test('path normalisation folds the spellings this fleet actually produces', () => {
  assert.equal(normalisePath('src\\lib\\a.mjs'), 'src/lib/a.mjs');
  assert.equal(normalisePath('./src/a.mjs'), 'src/a.mjs');
  assert.equal(normalisePath('src//a.mjs'), 'src/a.mjs');
  assert.equal(normalisePath('src/a/'), 'src/a');
  assert.equal(normalisePath('  src/A.mjs  '), 'src/a.mjs');
  assert.equal(normalisePath(null), '');
});

test('goal normalisation drops stopwords and order, keeps identity', () => {
  assert.equal(normaliseGoal('Fix the CI failure'), normaliseGoal('failure CI fix'));
  assert.notEqual(normaliseGoal('wire the lease'), normaliseGoal('delete the lease'));
  assert.equal(normaliseGoal(undefined), '');
});

/* ------------------------------------------------- THE FOUR OUTCOMES */

test('REFUSAL: an unread path contract is UNREAD, never "none"', () => {
  /*
   * THE HOLLOW-GATE FIX. The CLI test for this asserted that a HEALTHY
   * repository reports healthy, which passed against the restored bug. Here the
   * failure is a value, so the branch is reachable without breaking git.
   */
  const r = overlapReport({ overlaps: [], myPaths: [], myPathsRead: false, pathErrors: ['boom'] });
  assert.equal(r.state, OVERLAP_UNREAD);
  assert.notEqual(r.state, OVERLAP_NONE, 'nobody looked is not the same as nothing found');
  assert.notEqual(r.state, OVERLAP_NO_PATHS, 'and it is not the same as a clean tree');
  assert.equal(r.checked, false);
  assert.deepEqual(r.pathErrors, ['boom'], 'the cause must survive to the report');
});

test('an unread contract stays UNREAD even when paths happen to be present', () => {
  // A partial read that yielded something is still not a read.
  const r = overlapReport({ overlaps: [], myPaths: ['src/a.mjs'], myPathsRead: false });
  assert.equal(r.state, OVERLAP_UNREAD);
});

test('a clean tree is NO_PATHS, and a real check with no hits is NONE', () => {
  assert.equal(overlapReport({ myPaths: [], myPathsRead: true }).state, OVERLAP_NO_PATHS);
  const none = overlapReport({ myPaths: ['src/a.mjs'], myPathsRead: true, frontsChecked: 7 });
  assert.equal(none.state, OVERLAP_NONE);
  assert.equal(none.checked, true, 'NONE is the only no-collision outcome that was actually checked');
  assert.equal(none.frontsChecked, 7);
});

test('a collision outranks everything, including an unread contract', () => {
  const r = overlapReport({
    overlaps: [{ work_item_id: 'b/x', shared_paths: ['src/a.mjs'] }],
    myPaths: [],
    myPathsRead: false,
  });
  assert.equal(r.state, OVERLAP_COLLISION, 'a collision already found is not erased by a later failure');
  assert.equal(r.checked, true);
});
