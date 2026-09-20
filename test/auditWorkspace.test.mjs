/**
 * THE WORKSPACE IDENTITY CONTRACT: unpredictable to allocate, exact to remove.
 *
 * Three findings (D9 adopt-a-planted-directory, D10 one mkdir wedges the
 * daemon, D11 teardown removes what it did not create) all came from one
 * choice: the workspace was named `audit-<sha12>`, derived entirely from the
 * candidate, so any local process could compute it in advance.
 *
 * Danny's contract, and the second half is the one a random suffix alone
 * would have left open:
 *
 *   allocate -> returns workspace_id + absolute path
 *   reviewer runs there
 *   teardown consumes THAT allocation
 *
 * not: candidate sha -> derive the path again later. Unpredictability stops
 * somebody else occupying the path; it does nothing about cleanup guessing
 * which of several same-candidate workspaces it owns -- and a per-run id
 * makes several possible for the first time. So the three directions below
 * are each asserted, not assumed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, existsSync, mkdirSync, readdirSync,
  writeFileSync, openSync, closeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  allocateWorkspace, releaseWorkspace, workspaceName, newRunId,
} from '../src/auditWorkspace.mjs';

const SHA = 'a'.repeat(40);
let root;

/** A runGit stand-in that records calls and creates nothing real. */
const recorder = () => {
  const calls = [];
  const fn = (args) => { calls.push(args); return ''; };
  fn.calls = calls;
  return fn;
};

test.beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'ws-test-')); });
test.afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

test('1. THE SAME CANDIDATE TWICE GETS TWO DISTINCT WORKSPACES', () => {
  const a = allocateWorkspace({ candidateSha: SHA, runGit: recorder(), repoRoot: root, tmpRoot: root });
  const b = allocateWorkspace({ candidateSha: SHA, runGit: recorder(), repoRoot: root, tmpRoot: root });

  assert.equal(a.ok, true, a.why);
  assert.equal(b.ok, true, b.why);
  assert.notEqual(a.allocation.dir, b.allocation.dir,
    'two runs against one candidate collided on a single workspace, which is the '
    + 'deterministic-name defect this exists to remove');
  assert.notEqual(a.allocation.workspace_id, b.allocation.workspace_id);
  assert.ok(existsSync(a.allocation.dir) && existsSync(b.allocation.dir));
});

test('THE RUN ID IS UNPREDICTABLE, not a counter and not Math.random', () => {
  /*
   * The threat is a local process PREDICTING the path, so this is a
   * guessability property rather than a uniqueness one. Asserted as shape
   * and spread rather than by inspecting the source: 128 bits of hex, and
   * a large sample with no repeats.
   */
  const ids = new Set();
  for (let i = 0; i < 500; i += 1) {
    const id = newRunId();
    assert.match(id, /^[0-9a-f]{32}$/, `run id is not 128 bits of hex: ${id}`);
    ids.add(id);
  }
  assert.equal(ids.size, 500, 'run ids repeated within 500 draws');
});

test('2. A PLANTED DIRECTORY AT THE OLD NAME DOES NOT BLOCK OR DIVERT THE RUN', () => {
  /*
   * D10 measured: `mkdir %TEMP%/audit-<sha12>` wedged the daemon for ever,
   * because allocation refused and the head-of-queue job was re-selected on
   * every tick. D9: worse, an attacker-supplied directory was ADOPTED.
   *
   * Both are answered by the same property -- the real run never goes near
   * that name.
   */
  const planted = path.join(root, `audit-${SHA.slice(0, 12)}`);
  mkdirSync(planted, { recursive: true });

  const r = allocateWorkspace({ candidateSha: SHA, runGit: recorder(), repoRoot: root, tmpRoot: root });
  assert.equal(r.ok, true, `a planted directory blocked the run: ${r.why}`);
  assert.notEqual(r.allocation.dir, planted, 'the run adopted the planted directory');
  assert.ok(existsSync(planted), 'the run deleted a directory it did not create');
});

test('3. TEARDOWN REMOVES ONLY THE ALLOCATION IT IS GIVEN', () => {
  const runGit = recorder();
  const mine = allocateWorkspace({ candidateSha: SHA, runGit, repoRoot: root, tmpRoot: root });
  const sibling = allocateWorkspace({ candidateSha: SHA, runGit, repoRoot: root, tmpRoot: root });

  const rel = releaseWorkspace(mine.allocation, { runGit, repoRoot: root });
  assert.equal(rel.ok, true, rel.why);

  assert.equal(existsSync(mine.allocation.dir), false, 'the allocated workspace was not removed');
  assert.equal(existsSync(sibling.allocation.dir), true,
    'teardown removed a SIBLING run of the same candidate -- the failure a per-run id '
    + 'makes possible for the first time, and the reason cleanup must consume an identity');

  /* And git was asked about the exact path, not a recomputed one. */
  const removals = runGit.calls.filter((a) => a[0] === 'worktree' && a[1] === 'remove');
  assert.equal(removals.length, 1);
  assert.equal(removals[0][3], mine.allocation.dir);
});

test('TEARDOWN REFUSES A SHA, AND A TAMPERED ALLOCATION', () => {
  /*
   * The contract is "cleanup consumes the identity allocation returned". A
   * caller that hands it something else -- a bare path, a hand-built object,
   * a mutated dir -- is the shape that reopens D11, so it is refused rather
   * than best-guessed.
   */
  const runGit = recorder();
  const mine = allocateWorkspace({ candidateSha: SHA, runGit, repoRoot: root, tmpRoot: root });

  assert.equal(releaseWorkspace(null, { runGit, repoRoot: root }).ok, false);
  assert.equal(releaseWorkspace({ dir: mine.allocation.dir }, { runGit, repoRoot: root }).ok, false,
    'an allocation with no workspace_id was accepted');

  const tampered = { ...mine.allocation, dir: path.join(root, 'somewhere-else') };
  const r = releaseWorkspace(tampered, { runGit, repoRoot: root });
  assert.equal(r.ok, false, 'a path that does not match its own identity was removed');
  assert.match(r.why, /does not match the identity/);

  /* THE POSITIVE (rule 5): the untampered one still releases. */
  assert.equal(releaseWorkspace(mine.allocation, { runGit, repoRoot: root }).ok, true);
});

test('ok:false WHEN THE DIRECTORY SURVIVES -- the whole point, and it was untested', () => {
  /*
   * Blind pass D-5. Three behaviours shipped with no test, and this is the
   * one the change existed for: `ok` is supposed to mean the workspace is
   * GONE. Every assertion in this file was `ok === true`, so the false
   * branch had never been watched fire (rule 1) -- in the fix for a defect
   * that WAS "reported success when it removed nothing".
   *
   * THE CASE HAS TO BE REAL (rule 9). The module's own comment says the
   * common cause is a dying reviewer holding handles on Windows, so that is
   * what is built: a file inside the workspace, held open, which is what
   * makes `rmSync` fail here. `existsSync` is the far end (rule 4) and the
   * only thing `ok` is allowed to mean.
   *
   * If a platform deletes it anyway the PRECONDITION assertion below fails
   * and names why, rather than the test passing by not exercising the
   * branch (rule 6). That failure is an environment finding, not a defect
   * in releaseWorkspace -- said here so an auditor does not spend a pass on
   * it (rule 21).
   */
  const runGit = recorder();
  const a = allocateWorkspace({ candidateSha: SHA, runGit, repoRoot: root, tmpRoot: root });

  const held = path.join(a.allocation.dir, 'reviewer-holds-this');
  writeFileSync(held, 'x');
  const fd = openSync(held, 'r+');
  try {
    const r = releaseWorkspace(a.allocation, { runGit, repoRoot: root });

    assert.equal(existsSync(a.allocation.dir), true,
      'PRECONDITION: this platform removed a directory with an open handle inside it, '
      + 'so the surviving-directory case could not be constructed here. Environment, not defect.');
    assert.equal(r.ok, false,
      'the workspace is still on disk and teardown reported ok -- the exact defect D-1 fixed');
    assert.match(r.why, /still present after teardown/);
  } finally { closeSync(fd); }

  /* THE POSITIVE (rule 5): with the handle released the same call succeeds. */
  const after = releaseWorkspace(a.allocation, { runGit, repoRoot: root });
  assert.equal(after.ok, true, after.why);
  assert.equal(existsSync(a.allocation.dir), false);
});

test('A FAILING git REMOVAL IS REPORTED, not swallowed into ok:true', () => {
  /*
   * The case the module's own comment calls ROUTINE on Windows. git fails,
   * the directory removal still runs, and the caller must be able to tell
   * whether git deregistered it -- the previous version returned a literal
   * true and reported nothing.
   */
  const throwing = (args) => {
    if (args[0] === 'worktree' && args[1] === 'remove') {
      throw Object.assign(new Error('fail'), { stderr: 'fatal: still in use' });
    }
    return '';
  };
  const a = allocateWorkspace({ candidateSha: SHA, runGit: recorder(), repoRoot: root, tmpRoot: root });
  const r = releaseWorkspace(a.allocation, { runGit: throwing, repoRoot: root });

  /* The directory still goes, so ok is true -- but gitRemoved says the rest. */
  assert.equal(existsSync(a.allocation.dir), false, 'the directory survived a git failure');
  assert.equal(r.ok, true);
  assert.equal(r.gitRemoved, false,
    'a failed git deregistration was reported as removed, so a stale admin record is invisible');
});

test('NO REPO-GLOBAL PRUNE, ever -- this repository already ruled on it', () => {
  /*
   * I added `git worktree prune` here and the blind pass caught it as two
   * mistakes at once. It is DANGEROUS -- test/startAgentLauncher.test.mjs
   * records an auditor watching a repo-global prune destroy a prunable
   * registration the run never created, on a checkout that now carries 41
   * of them. And it was a NO-OP for its stated purpose, because the stale
   * records it cited are not prunable: their directories still exist.
   *
   * Asserted on the git calls rather than the source, so a future edit
   * that reintroduces it by any spelling fails here.
   */
  const runGit = recorder();
  const a = allocateWorkspace({ candidateSha: SHA, runGit, repoRoot: root, tmpRoot: root });
  releaseWorkspace(a.allocation, { runGit, repoRoot: root });

  const failing = (args) => {
    if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('fail');
    runGit(args);
    return '';
  };
  const b = allocateWorkspace({ candidateSha: SHA, runGit, repoRoot: root, tmpRoot: root });
  releaseWorkspace(b.allocation, { runGit: failing, repoRoot: root });

  const prunes = runGit.calls.filter((c) => c[0] === 'worktree' && c[1] === 'prune');
  assert.deepEqual(prunes, [],
    'a repo-global `git worktree prune` was issued. It removes EVERY prunable '
    + 'registration, including live worktrees belonging to other sessions');
});

test('A FAILED worktree add LEAVES NOTHING BEHIND', () => {
  /*
   * The directory is created before git is asked, so a git failure must not
   * leak it -- that is how the original thirteen accumulated.
   */
  const failing = () => { const e = new Error('fatal: invalid reference'); e.stderr = 'fatal'; throw e; };
  const before = allocateWorkspace({ candidateSha: SHA, runGit: failing, repoRoot: root, tmpRoot: root });
  assert.equal(before.ok, false);
  assert.match(before.why, /fatal/);

  const leftovers = existsSync(root)
    ? readdirSync(root).filter((n) => n.startsWith('audit-'))
    : [];
  assert.deepEqual(leftovers, [], 'a failed allocation left its directory behind');
});

test('A BAD CANDIDATE IS REFUSED BEFORE ANYTHING IS CREATED', () => {
  for (const bad of [null, '', 'HEAD', '../escape', 'a'.repeat(6), 'g'.repeat(40)]) {
    const r = allocateWorkspace({ candidateSha: bad, runGit: recorder(), repoRoot: root, tmpRoot: root });
    assert.equal(r.ok, false, `allocated a workspace for ${JSON.stringify(bad)}`);
  }
  /* and the name cannot be steered out of the root by the sha (rule 5 positive) */
  const ok = allocateWorkspace({ candidateSha: SHA, runGit: recorder(), repoRoot: root, tmpRoot: root });
  assert.equal(ok.ok, true);
  assert.equal(path.dirname(ok.allocation.dir), root, 'the workspace escaped its root');
});

test('workspaceName KEEPS THE SHA READABLE, so a leftover says whose it is', () => {
  const id = newRunId();
  const name = workspaceName(SHA, id);
  assert.ok(name.startsWith(`audit-${SHA.slice(0, 12)}-`), name);
  assert.ok(name.endsWith(id), name);
});
