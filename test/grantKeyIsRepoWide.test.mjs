/**
 * A GRANT IS ABOUT A REPOSITORY, NOT A DIRECTORY.
 *
 * overridePath keyed on sha(path.resolve(repoRoot)), and a worktree is a
 * different root. Measured on the operator's machine before the fix, across
 * every root git knew about:
 *
 *   HAS GRANT  c6e20b3e89303f44   C:/Users/DANNY GARCIA/Agent007   (main)
 *   NO GRANT   f9d997f2d8cd6ee6   C:/Users/DANNY GARCIA/Documents/wt-code-a
 *   NO GRANT   ...15 more agent worktrees, each with its own key
 *
 * Every grant the owner had written applied to exactly one directory, and not
 * the one the agents were in. They ran with no grant at all and kept routing
 * blocked writes back to him, which read as a policy decision and was a hash.
 *
 * These tests build their OWN repository and worktrees in a temp dir. Asserting
 * against the operator's checkout would make the suite depend on how many
 * worktrees happen to exist tonight.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { overridePath, overrideKeySource, readOverride } from '../src/guardSession.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const keyOf = (root) => overridePath(root, join(tmpdir(), 'ab-grant-home')).split(/[\\/]/).pop();

async function repoWithWorktrees(t, n) {
  const dir = await mkdtemp(join(tmpdir(), 'ab-grantkey-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const main = join(dir, 'main');
  await mkdir(main);
  git(main, 'init', '-q');
  git(main, 'config', 'user.email', 't@example.invalid');
  git(main, 'config', 'user.name', 'T');
  await writeFile(join(main, 'a.txt'), 'a');
  git(main, 'add', 'a.txt');
  git(main, 'commit', '-q', '-m', 'init');

  const trees = [];
  for (let i = 0; i < n; i += 1) {
    const wt = join(dir, `wt${i}`);
    git(main, 'worktree', 'add', '-q', '--detach', wt);
    trees.push(wt);
  }
  return { dir, main, trees };
}

test('every worktree of one repository resolves to ONE grant key', async (t) => {
  const { main, trees } = await repoWithWorktrees(t, 3);

  const keys = new Set([main, ...trees].map(keyOf));
  assert.equal(keys.size, 1,
    `expected one key for the repo, got ${keys.size}: ${[...keys].join(' ')}`);
});

test('a DIFFERENT repository gets a DIFFERENT key', async (t) => {
  // THE NEGATIVE THAT MAKES THE POSITIVE MEAN SOMETHING. An implementation that
  // returned a constant would pass the test above and would be a single global
  // grant for every repository on the machine.
  const a = await repoWithWorktrees(t, 1);
  const b = await repoWithWorktrees(t, 1);

  assert.notEqual(keyOf(a.main), keyOf(b.main), 'two unrelated repos share a grant key');
  assert.notEqual(keyOf(a.trees[0]), keyOf(b.trees[0]), 'two unrelated worktrees share a grant key');
});

test('a subdirectory of the repo resolves to the repo key, not its own', async (t) => {
  const { main } = await repoWithWorktrees(t, 0);
  const sub = join(main, 'nested', 'deeper');
  await mkdir(sub, { recursive: true });
  assert.equal(keyOf(sub), keyOf(main));
});

test('case and 8.3 spellings of one path are one key, not three', async (t) => {
  const { main } = await repoWithWorktrees(t, 0);
  const canonical = overrideKeySource(main);

  assert.equal(overrideKeySource(main.toUpperCase()), canonical,
    'an upper-case spelling produced a different key');
  assert.equal(overrideKeySource(main.toLowerCase()), canonical,
    'a lower-case spelling produced a different key');

  // A hash makes every spelling difference total, and this is the same class
  // that let CLAUDE~1/settings.json past isProtectedPath. On a non-Windows
  // filesystem the case variants above are genuinely different paths, so this
  // assertion only means anything where the filesystem is case-insensitive.
  if (process.platform !== 'win32') return;
  assert.ok(!canonical.includes('~'), 'the canonical key still carries an 8.3 alias');
});

test('a directory that is not a repository grants NOTHING and does not throw', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ab-notrepo-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // Must not throw: readOverride promises a parse error cannot open the gate,
  // and an exception out of this path exits the hook non-zero with empty stdout,
  // which Claude Code reads as NON-BLOCKING. That is a disarm, not a refusal.
  assert.doesNotThrow(() => overridePath(dir));
  assert.equal(readOverride(dir), null);
});

test('the key is stable across repeated calls', async (t) => {
  const { main, trees } = await repoWithWorktrees(t, 1);
  assert.equal(keyOf(main), keyOf(main));
  assert.equal(keyOf(trees[0]), keyOf(trees[0]));
});

test('a grant written for the main checkout is READ from a worktree', async (t) => {
  // The far end (rule 4): the point is not that two strings match, it is that a
  // grant the owner writes is actually honoured by an agent in a worktree.
  const { main, trees } = await repoWithWorktrees(t, 1);
  const home = await mkdtemp(join(tmpdir(), 'ab-grant-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  const file = overridePath(main, home);
  await mkdir(join(home, 'overrides'), { recursive: true });
  await writeFile(file, JSON.stringify({
    paths: ['src/claudeGuard.mjs'],
    reason: 'test grant',
    granted_by: 'danny',
    expires_at: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
  }));

  // readOverride resolves its home from the ambient env, not an argument, so
  // the env has to be pointed at the temp home for BOTH reads -- otherwise the
  // "main checkout" read looks in the real store and this test reports a code
  // defect that is its own setup.
  const prev = process.env.AGENTBRIDGE_HOME;
  process.env.AGENTBRIDGE_HOME = home;
  try {
    // RULE 5: the positive first. If the grant is not readable from the main
    // checkout, "unreadable from a worktree" proves nothing about the key.
    const fromMain = readOverride(main);
    assert.ok(fromMain, 'the grant is not readable from the main checkout');

    // Before the fix this was null: the worktree hashed to a different key.
    const fromWorktree = readOverride(trees[0]);
    assert.ok(fromWorktree, 'a worktree cannot see the grant written for its repo');
    assert.deepEqual(fromWorktree.paths, ['src/claudeGuard.mjs']);
  } finally {
    if (prev === undefined) delete process.env.AGENTBRIDGE_HOME;
    else process.env.AGENTBRIDGE_HOME = prev;
  }
});
