import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateReleaseRisk, formatReleaseRisk, BLOCK, WARN,
} from '../src/releaseRisk.mjs';

/**
 * EVERY RULE IS PROVEN IN BOTH DIRECTIONS.
 *
 * Two checks in the previous build reported success while testing nothing: an
 * ACL assertion that matched on error text, and a process test asserting
 * something that had never been broken. Both passed with the code they guarded
 * removed. The rule that came out of it: a check is not trusted until it has
 * been watched to fire on a real violation AND to stay silent on the clean
 * case next to it.
 *
 * So for each finding code there are two tests:
 *   FIRES   — a state that must produce it
 *   SILENT  — the nearest state that must NOT, differing in one field
 *
 * The silent half is the one that catches a rule written as `if (true)`. A
 * suite of fires-only tests passes completely against a function that returns
 * every finding unconditionally.
 */

/** A clean release branch: pushed, in sync, nothing uncommitted. */
const CLEAN = {
  ok: true,
  worktree: 'C:\\w\\release',
  branch: 'release/integrate-2026-09-14',
  detached: false,
  head: 'a53bcb0690e98a7768038a09bee8aab222860312',
  baseSha: '49012be94d7731feeb119dc9eea6e146630d4b03',
  mainRef: 'origin/main',
  mainSha: '49012be94d7731feeb119dc9eea6e146630d4b03',
  upstream: 'origin/release/integrate-2026-09-14',
  unpushed: 0,
  unpushedReason: 'vs-upstream',
  aheadOfMain: 9,
  behindMain: 0,
  staged: [],
  dirty: [],
  untracked: [],
};

const codes = (r) => r.findings.map((f) => f.code);
const sevOf = (r, code) => r.findings.find((f) => f.code === code)?.severity;

// ── the control: the clean state must be clean ──────────────────────────────

test('release-risk: a clean pushed release branch produces nothing', () => {
  // If this ever fails, every "SILENT" assertion below is meaningless, because
  // the baseline itself is already firing.
  const r = evaluateReleaseRisk(CLEAN);
  assert.deepEqual(r.findings, [], `clean state produced findings: ${JSON.stringify(codes(r))}`);
  assert.equal(r.ok, true);
  assert.equal(r.blocking, 0);
});

// ── THE ACCEPTANCE CASE: Code A, 2026-09-14 ─────────────────────────────────

test('release-risk: the real Code A state is flagged deterministically', () => {
  // release/integrate-2026-09-14 @ a53bcb0690e9 as Section A actually read it:
  // nine commits, no upstream, clean tree. This is the acceptance test the
  // state was nominated for. Verbatim from the machine, not invented.
  const codeA = {
    ...CLEAN,
    upstream: null,
    unpushed: 9,
    unpushedReason: 'no-upstream:vs-merge-base',
  };
  const r = evaluateReleaseRisk(codeA);

  assert.equal(r.ok, false, 'the exact state that prompted this guard was allowed through');
  assert.ok(codes(r).includes('NO_UPSTREAM'));
  assert.ok(codes(r).includes('LOCAL_ONLY_COMMITS'));
  assert.equal(sevOf(r, 'NO_UPSTREAM'), BLOCK);
  assert.equal(sevOf(r, 'LOCAL_ONLY_COMMITS'), BLOCK);

  const local = r.findings.find((f) => f.code === 'LOCAL_ONLY_COMMITS');
  assert.equal(local.evidence.count, 9);
  assert.equal(local.evidence.basis, 'no-upstream:vs-merge-base');
  assert.equal(local.evidence.upstream, null);

  // Deterministic: same input, same output, no clock and no filesystem.
  assert.deepEqual(evaluateReleaseRisk(codeA), r);
});

// ── NO_UPSTREAM ─────────────────────────────────────────────────────────────

test('release-risk: NO_UPSTREAM fires when there is no upstream', () => {
  const r = evaluateReleaseRisk({ ...CLEAN, upstream: null });
  assert.ok(codes(r).includes('NO_UPSTREAM'));
});

test('release-risk: NO_UPSTREAM silent when an upstream exists', () => {
  assert.equal(codes(evaluateReleaseRisk(CLEAN)).includes('NO_UPSTREAM'), false);
});

// ── LOCAL_ONLY_COMMITS vs UNPUSHED_COMMITS ──────────────────────────────────

test('release-risk: LOCAL_ONLY_COMMITS fires only without an upstream', () => {
  const r = evaluateReleaseRisk({ ...CLEAN, upstream: null, unpushed: 3, unpushedReason: 'no-upstream:vs-merge-base' });
  assert.ok(codes(r).includes('LOCAL_ONLY_COMMITS'));
  assert.equal(codes(r).includes('UNPUSHED_COMMITS'), false, 'the two codes must not both fire');
});

test('release-risk: UNPUSHED_COMMITS fires when an upstream exists but is behind', () => {
  const r = evaluateReleaseRisk({ ...CLEAN, unpushed: 2 });
  assert.ok(codes(r).includes('UNPUSHED_COMMITS'));
  assert.equal(codes(r).includes('LOCAL_ONLY_COMMITS'), false);
});

test('release-risk: neither fires at zero unpushed', () => {
  const c = codes(evaluateReleaseRisk(CLEAN));
  assert.equal(c.includes('UNPUSHED_COMMITS'), false);
  assert.equal(c.includes('LOCAL_ONLY_COMMITS'), false);
});

// ── DETACHED_HEAD ───────────────────────────────────────────────────────────

test('release-risk: DETACHED_HEAD fires on a detached worktree', () => {
  // wt-release-verify was detached at 481f812 before it became a branch.
  const r = evaluateReleaseRisk({ ...CLEAN, branch: null, detached: true, upstream: null });
  assert.ok(codes(r).includes('DETACHED_HEAD'));
});

test('release-risk: DETACHED_HEAD silent on an attached branch', () => {
  assert.equal(codes(evaluateReleaseRisk(CLEAN)).includes('DETACHED_HEAD'), false);
});

test('release-risk: a detached head does not also claim NO_UPSTREAM', () => {
  // A detached HEAD cannot have an upstream by definition; reporting both
  // would be two findings for one fact and would inflate the block count.
  const r = evaluateReleaseRisk({ ...CLEAN, branch: null, detached: true, upstream: null });
  assert.equal(codes(r).includes('NO_UPSTREAM'), false);
});

// ── TRUNK_AHEAD_OF_REMOTE ───────────────────────────────────────────────────

test('release-risk: TRUNK_AHEAD_OF_REMOTE fires on a local main ahead of origin', () => {
  const r = evaluateReleaseRisk({ ...CLEAN, branch: 'main', aheadOfMain: 4 });
  assert.ok(codes(r).includes('TRUNK_AHEAD_OF_REMOTE'));
  assert.equal(sevOf(r, 'TRUNK_AHEAD_OF_REMOTE'), BLOCK);
});

test('release-risk: TRUNK_AHEAD_OF_REMOTE silent on a feature branch ahead of main', () => {
  // A feature branch being ahead of main is its entire purpose. Firing here
  // would make the guard noise on every branch in the repository.
  const r = evaluateReleaseRisk({ ...CLEAN, branch: 'code-c/messaging-gates', aheadOfMain: 4 });
  assert.equal(codes(r).includes('TRUNK_AHEAD_OF_REMOTE'), false);
});

test('release-risk: TRUNK_AHEAD_OF_REMOTE silent on a synced main', () => {
  const r = evaluateReleaseRisk({ ...CLEAN, branch: 'main', aheadOfMain: 0 });
  assert.equal(codes(r).includes('TRUNK_AHEAD_OF_REMOTE'), false);
});

// ── DIRTY_TREE / UNTRACKED_FILES ────────────────────────────────────────────

test('release-risk: DIRTY_TREE fires on staged or modified files', () => {
  const staged = evaluateReleaseRisk({ ...CLEAN, staged: [{ path: 'a.ts', code: 'M ' }] });
  const dirty = evaluateReleaseRisk({ ...CLEAN, dirty: [{ path: 'b.ts', code: ' M' }] });
  assert.ok(codes(staged).includes('DIRTY_TREE'));
  assert.ok(codes(dirty).includes('DIRTY_TREE'));
});

test('release-risk: DIRTY_TREE silent on a clean tree with untracked files only', () => {
  // Untracked scratch must not block a release; it warns. A guard that blocks
  // on a stray .log is a guard somebody disables.
  const r = evaluateReleaseRisk({ ...CLEAN, untracked: [{ path: 'notes.txt', code: '??' }] });
  assert.equal(codes(r).includes('DIRTY_TREE'), false);
  assert.ok(codes(r).includes('UNTRACKED_FILES'));
  assert.equal(sevOf(r, 'UNTRACKED_FILES'), WARN);
  assert.equal(r.ok, true, 'untracked files alone must not block');
});

// ── BEHIND_TRUNK ────────────────────────────────────────────────────────────

test('release-risk: BEHIND_TRUNK warns on a release branch behind main', () => {
  const r = evaluateReleaseRisk({ ...CLEAN, behindMain: 8 });
  assert.equal(sevOf(r, 'BEHIND_TRUNK'), WARN);
  assert.equal(r.ok, true, 'being behind is a warning, not a block');
});

test('release-risk: BEHIND_TRUNK silent on a non-release branch behind main', () => {
  // code-b is 58 ahead / 8 behind and that is normal feature-branch life.
  const r = evaluateReleaseRisk({ ...CLEAN, branch: 'feature/website-ai-cloner', behindMain: 8 });
  assert.equal(codes(r).includes('BEHIND_TRUNK'), false);
});

// ── severity is branch-sensitive ────────────────────────────────────────────

test('release-risk: the same fact blocks on a release branch and warns on a feature branch', () => {
  const onRelease = evaluateReleaseRisk({ ...CLEAN, upstream: null, unpushed: 9 });
  const onFeature = evaluateReleaseRisk({ ...CLEAN, branch: 'code-c/messaging-gates', upstream: null, unpushed: 9 });
  assert.equal(sevOf(onRelease, 'LOCAL_ONLY_COMMITS'), BLOCK);
  assert.equal(sevOf(onFeature, 'LOCAL_ONLY_COMMITS'), WARN);
  assert.equal(onRelease.ok, false);
  assert.equal(onFeature.ok, true, 'an unpushed feature branch must not block a push');
});

test('release-risk: strictEverywhere promotes feature-branch warnings to blocks', () => {
  const r = evaluateReleaseRisk(
    { ...CLEAN, branch: 'code-c/messaging-gates', upstream: null, unpushed: 9 },
    { strictEverywhere: true },
  );
  assert.equal(sevOf(r, 'LOCAL_ONLY_COMMITS'), BLOCK);
  assert.equal(r.ok, false);
});

// ── fail closed ─────────────────────────────────────────────────────────────

test('release-risk: an unreadable worktree blocks rather than passing', () => {
  // "I could not tell" must never render the same as "it is fine". This is the
  // shape gitState returns for a path that is not a git worktree at all.
  for (const bad of [null, undefined, {}, { ok: false, reason: 'not-a-git-worktree', worktree: 'C:\\nope' }]) {
    const r = evaluateReleaseRisk(bad);
    assert.equal(r.ok, false, `unreadable state was approved: ${JSON.stringify(bad)}`);
    assert.equal(codes(r)[0], 'UNREADABLE_WORKTREE');
  }
});

test('release-risk: an unreadable worktree reports nothing else it cannot know', () => {
  // It must not also claim DIRTY_TREE or NO_UPSTREAM about a tree it failed to
  // read -- inventing findings is as bad as missing them.
  const r = evaluateReleaseRisk({ ok: false, reason: 'not-a-git-worktree' });
  assert.deepEqual(codes(r), ['UNREADABLE_WORKTREE']);
});

// ── the rules are read-only ─────────────────────────────────────────────────

test('release-risk: evaluating does not mutate the state it was given', () => {
  // This guard runs against OTHER agents' worktrees. It must be structurally
  // incapable of changing what it inspects.
  const input = structuredClone(CLEAN);
  const before = JSON.stringify(input);
  evaluateReleaseRisk(input);
  assert.equal(JSON.stringify(input), before, 'evaluateReleaseRisk mutated its input');
});

// ── the report a human actually reads ───────────────────────────────────────

test('release-risk: the formatted line carries the wording agreed for the warning', () => {
  const r = evaluateReleaseRisk({ ...CLEAN, upstream: null, unpushed: 9 });
  const text = formatReleaseRisk('code-a [integration]', r);
  assert.match(text, /RELEASE RISK — /);
  assert.match(text, /local-only|only on this machine/);
  assert.match(text, /no remote upstream/);
  assert.match(text, /LOCAL_ONLY_COMMITS/);
  assert.match(text, /code-a \[integration\]/);
});

test('release-risk: a clean branch formats as no risk, not as an empty block', () => {
  assert.match(formatReleaseRisk('code-c [messaging]', evaluateReleaseRisk(CLEAN)), /no release risk/);
});
