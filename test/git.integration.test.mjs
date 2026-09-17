import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../src/exec.mjs';
import { gitState, listWorktrees } from '../src/git.mjs';
import { discoverLocks } from '../src/locks.mjs';

let root, origin, repo, wtC;
const g = (cwd, ...args) => run('git', args, { cwd });

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ab-'));
  origin = path.join(root, 'origin.git');
  repo = path.join(root, 'repo');
  wtC = path.join(root, 'repo-code-c');

  await run('git', ['init', '--bare', '-b', 'main', origin]);
  await run('git', ['clone', origin, repo]);
  for (const [k, v] of [['user.email', 'a@b.c'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) {
    await g(repo, 'config', k, v);
  }
  await mkdir(path.join(repo, 'scripts'), { recursive: true });
  await writeFile(path.join(repo, 'scripts/check-gates-can-fail.mjs'), '// base\n');
  await writeFile(path.join(repo, 'README.md'), '# base\n');
  await g(repo, 'add', '-A');
  await g(repo, 'commit', '-m', 'base');
  await g(repo, 'push', '-u', 'origin', 'main');

  await g(repo, 'worktree', 'add', '-b', 'code-c/messaging-gates', wtC);
});

after(async () => { await rm(root, { recursive: true, force: true }); });

test('reports branch, head, base and origin/main from a real worktree', async () => {
  const s = await gitState(wtC);
  assert.equal(s.ok, true);
  assert.equal(s.branch, 'code-c/messaging-gates');
  assert.match(s.head, /^[0-9a-f]{40}$/);
  assert.equal(s.baseSha, s.mainSha, 'fresh branch: merge-base equals origin/main');
  assert.equal(s.upstream, null, 'never pushed, so no upstream');
  assert.equal(s.unpushed, 0);
});

test('counts unpushed commits on a branch with no upstream', async () => {
  await writeFile(path.join(wtC, 'scripts/check-gates-can-fail.mjs'), '// hardened\n');
  await g(wtC, 'add', '-A');
  await g(wtC, 'commit', '-m', 'harden gate harness');

  const s = await gitState(wtC);
  assert.equal(s.unpushed, 1);
  /* The COUNT is unchanged; only the question asked to obtain it changed. A
   * branch on no remote has every commit unpushed under either reading. The
   * regression at the bottom of this file covers where the two diverge. */
  assert.equal(s.unpushedReason, 'not-on-any-remote');
  assert.equal(s.aheadOfMain, 1);
  assert.equal(s.behindMain, 0);
  assert.notEqual(s.head, s.mainSha);
  assert.equal(s.baseSha, s.mainSha, 'base still pins to where the branch forked');
});

test('separates staged, dirty and untracked', async () => {
  await writeFile(path.join(wtC, 'scripts/check-gates-can-fail.mjs'), '// staged change\n');
  await g(wtC, 'add', 'scripts/check-gates-can-fail.mjs');
  await writeFile(path.join(wtC, 'README.md'), '# dirty\n');
  await writeFile(path.join(wtC, 'notes.tmp'), 'scratch\n');

  const s = await gitState(wtC);
  assert.deepEqual(s.staged.map((f) => f.path), ['scripts/check-gates-can-fail.mjs']);
  assert.deepEqual(s.dirty.map((f) => f.path), ['README.md']);
  assert.deepEqual(s.untracked.map((f) => f.path), ['notes.tmp']);
});

test('tracks upstream once the branch is pushed', async () => {
  await g(wtC, 'add', '-A');
  await g(wtC, 'commit', '-m', 'wip');
  await g(wtC, 'push', '-u', 'origin', 'code-c/messaging-gates');

  const s = await gitState(wtC);
  assert.equal(s.upstream, 'origin/code-c/messaging-gates');
  assert.equal(s.unpushed, 0);
  assert.equal(s.unpushedReason, 'not-on-any-remote');
});

test('detects being behind origin/main after someone else lands work', async () => {
  await writeFile(path.join(repo, 'other.md'), 'from another lane\n');
  await g(repo, 'add', '-A');
  await g(repo, 'commit', '-m', 'other lane');
  await g(repo, 'push', 'origin', 'main');
  await g(wtC, 'fetch', 'origin');

  const s = await gitState(wtC);
  assert.equal(s.behindMain, 1, 'origin/main moved under this branch');
  assert.ok(s.aheadOfMain >= 1);
});

test('paths with spaces survive the porcelain round trip', async () => {
  await writeFile(path.join(wtC, 'a file with spaces.ts'), 'x\n');
  const s = await gitState(wtC);
  assert.ok(s.untracked.some((f) => f.path === 'a file with spaces.ts'));
});

test('a worktree path containing shell metacharacters is inert', async () => {
  const nasty = path.join(root, "we're; rm -rf $(x) `y`");
  await g(repo, 'worktree', 'add', '-b', 'weird-lane', nasty);
  const s = await gitState(nasty);
  assert.equal(s.ok, true);
  assert.equal(s.branch, 'weird-lane');
});

test('non-git directory reports a reason instead of throwing', async () => {
  const s = await gitState(path.join(root, 'nope'));
  assert.equal(s.ok, false);
  assert.equal(s.reason, 'not-a-git-worktree');
});

test('worktree enumeration sees every registered worktree', async () => {
  const w = await listWorktrees(repo);
  const branches = w.map((x) => x.branch);
  assert.ok(branches.includes('main'));
  assert.ok(branches.includes('code-c/messaging-gates'));
});

test('REGRESSION: a branch pushed to its OWN ref is not unpushed just because it leads main', async () => {
  /*
   * THE CASE THE TWO READINGS DISAGREE ON, and the only one that does.
   *
   * gitState used to compute unpushed as `rev-list --count upstream..HEAD`.
   * When a feature branch's upstream is origin/main -- which is how several
   * worktrees on this machine are configured -- that counts the branch's whole
   * length while every one of those commits is safely on origin/<branch>.
   *
   * On 2026-09-17 that reported `unpushed 14` for d-claims-authz-b6 whose
   * origin ref was byte-identical to local HEAD. Nothing was stranded. The
   * number was read by two agents as lost work and acted on.
   *
   * The two assertions that matter are the pair: unpushed is 0, AND the old
   * expression is non-zero. Without the second this test would pass against the
   * old implementation on any branch that happened to be level with main, which
   * would make it a regression test that cannot catch the regression.
   */
  await g(wtC, 'branch', '--set-upstream-to=origin/main');

  const s = await gitState(wtC);
  assert.equal(s.upstream, 'origin/main', 'precondition: upstream must point at main for this case');

  const oldReading = Number(
    (await g(wtC, 'rev-list', '--count', 'origin/main..HEAD')).stdout.trim(),
  );
  assert.ok(
    oldReading > 0,
    'precondition: this fixture must actually lead main, or the two readings cannot diverge '
    + 'and the test proves nothing',
  );

  assert.equal(
    s.unpushed, 0,
    `unpushed reported ${s.unpushed} for a branch fully pushed to its own remote ref. `
    + `That is the ahead-of-upstream count (${oldReading}), which is a different question.`,
  );
  assert.equal(s.unpushedReason, 'not-on-any-remote');

  /* The divergence figures are still reported, and were never the bug. */
  assert.ok(s.aheadOfMain >= 1, 'ahead-of-main should still be reported alongside');
});

test('lock files are discovered with holder and age', async () => {
  await mkdir(path.join(wtC, '.agentbridge/locks'), { recursive: true });
  await writeFile(path.join(wtC, '.agentbridge/locks/gates-can-fail.json'),
    JSON.stringify({ agent: 'code-c', pid: 4242, acquiredAt: new Date().toISOString() }));
  const locks = await discoverLocks(wtC);
  assert.equal(locks.length, 1);
  assert.equal(locks[0].resource, 'gates-can-fail');
  assert.equal(locks[0].heldBy, 'code-c');
  assert.equal(locks[0].pid, 4242);
});
