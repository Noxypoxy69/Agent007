import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCollisions } from '../bridge/collisions.mjs';

const LANES = {
  messaging: ['scripts/check-gates-*.mjs', 'scripts/reply-*.ts'],
  onboarding: ['src/lib/merchantPhone.server.ts'],
};

const session = (o = {}) => ({
  agentId: 'code-c', lane: 'messaging', worktree: 'C:/wt/code-c',
  lastSeenAt: new Date().toISOString(), processProbeOk: true, locks: [], processes: [],
  git: { ok: true, branch: 'code-c/messaging-gates', head: 'a'.repeat(40), baseSha: 'b'.repeat(40),
    mainRef: 'origin/main', mainSha: 'b'.repeat(40), upstream: 'origin/code-c/messaging-gates',
    unpushed: 0, aheadOfMain: 0, behindMain: 0, staged: [], dirty: [], untracked: [] },
  ...o,
});
const has = (r, code) => r.findings.some((f) => f.code === code);

test('clean single agent produces no critical findings', () => {
  const r = detectCollisions([session()], { lanes: LANES });
  assert.equal(r.counts.critical, 0);
});

test('two agents in one worktree is critical', () => {
  const r = detectCollisions([session(), session({ agentId: 'code-a', lane: 'release' })], { lanes: LANES });
  assert.ok(has(r, 'shared-worktree'));
  assert.equal(r.findings.find((f) => f.code === 'shared-worktree').severity, 'critical');
});

test('two agents claiming one lane is critical', () => {
  const r = detectCollisions([session(), session({ agentId: 'code-x', worktree: 'C:/wt/x' })], { lanes: LANES });
  assert.ok(has(r, 'duplicate-lane'));
});

test('cross-lane uncommitted write is detected against the lane map', () => {
  const r = detectCollisions([session({
    git: { ...session().git, dirty: [{ path: 'src/lib/merchantPhone.server.ts', code: ' M', sensitive: false }] },
  })], { lanes: LANES });
  const f = r.findings.find((x) => x.code === 'cross-lane-write');
  assert.ok(f);
  assert.equal(f.evidence.files[0].owner, 'onboarding');
});

test('in-lane write is not flagged', () => {
  const r = detectCollisions([session({
    git: { ...session().git, dirty: [{ path: 'scripts/check-gates-can-fail.mjs', code: ' M', sensitive: false }] },
  })], { lanes: LANES });
  assert.equal(has(r, 'cross-lane-write'), false);
});

test('redacted paths are skipped, never guessed at', () => {
  const r = detectCollisions([session({
    git: { ...session().git, dirty: [{ path: '<<redacted:env>>', sensitive: true }] },
  })], { lanes: LANES });
  assert.equal(has(r, 'cross-lane-write'), false);
});

test('missing lane map is reported rather than read as "no collisions"', () => {
  const r = detectCollisions([session()], {});
  assert.ok(has(r, 'no-lane-map'));
});

test('lock contention and foreign locks', () => {
  const r = detectCollisions([
    session({ locks: [{ resource: 'gates-can-fail', heldBy: 'code-c', ageSeconds: 10 }] }),
    session({ agentId: 'code-a', lane: 'release', worktree: 'C:/wt/code-a',
      locks: [{ resource: 'gates-can-fail', heldBy: 'code-b', ageSeconds: 400 }] }),
  ], { lanes: LANES });
  assert.ok(has(r, 'lock-contention'));
  assert.ok(has(r, 'foreign-lock'));
});

test('unpushed work and never-pushed branch', () => {
  const r = detectCollisions([session({
    git: { ...session().git, unpushed: 3, upstream: null, unpushedReason: 'no-upstream:vs-merge-base' },
  })], { lanes: LANES });
  assert.ok(has(r, 'unpushed-commits'));
  assert.ok(has(r, 'no-upstream'));
});

test('local main ahead of remote is critical', () => {
  const r = detectCollisions([session({
    agentId: 'code-a', lane: 'release', git: { ...session().git, branch: 'main', aheadOfMain: 1 },
  })], { lanes: LANES });
  assert.ok(has(r, 'local-main-ahead'));
});

test('worktrees disagreeing on origin/main is a stale-fetch warning', () => {
  const r = detectCollisions([
    session(),
    session({ agentId: 'code-a', lane: 'release', worktree: 'C:/wt/a',
      git: { ...session().git, mainSha: 'c'.repeat(40) } }),
  ], { lanes: LANES });
  assert.ok(has(r, 'divergent-origin-main'));
});

test('stale heartbeat is surfaced', () => {
  const r = detectCollisions([session({ lastSeenAt: new Date(Date.now() - 600_000).toISOString() })],
    { lanes: LANES });
  assert.ok(has(r, 'stale-session'));
});

test('failed process probe is surfaced so silence is not read as idle', () => {
  const r = detectCollisions([session({ processProbeOk: false })], { lanes: LANES });
  assert.ok(has(r, 'process-probe-failed'));
});

test('unreadable worktree is reported, not dropped', () => {
  const r = detectCollisions([session({ git: { ok: false, reason: 'not-a-git-worktree' } })], { lanes: LANES });
  assert.ok(has(r, 'worktree-unreadable'));
});

test('findings are ordered critical first', () => {
  const r = detectCollisions([session(), session({ agentId: 'code-a', lane: 'release' })], { lanes: LANES });
  assert.equal(r.findings[0].severity, 'critical');
});
