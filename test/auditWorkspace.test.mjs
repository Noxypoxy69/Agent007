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
import { mkdtempSync, rmSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
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
