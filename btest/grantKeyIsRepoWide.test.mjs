/**
 * A GRANT IS ABOUT A REPOSITORY, NOT A DIRECTORY.
 *
 * overridePath keyed on sha(path.resolve(repoRoot)), and a worktree is a
 * different root. Measured on the operator's machine before the fix, across
 * every root git knew about:
 *
 *   HAS GRANT  <key A>   <home>/Agent007                (the main checkout)
 *   NO GRANT   <key B>   <home>/Documents/wt-code-a     (an agent worktree)
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
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { overridePath, overrideKeySource, readOverride, overrideCovers } from '../src/guardSession.mjs';

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

test('the AMBIENT GIT ENVIRONMENT cannot redirect which repository answers', async (t) => {
  /*
   * git resolves GIT_DIR and GIT_COMMON_DIR BEFORE -C, so an inherited variable
   * silently answers for a different repository:
   *
   *   GIT_DIR=<A>/.git git -C <B> rev-parse --git-common-dir   ->  <A>/.git
   *
   * Measured through the shipped hook binary: with GIT_DIR set, three unrelated
   * repositories produced ONE key, and a grant written for repository A ALLOWED
   * a protected write in repository B. Git exports GIT_DIR into every hook
   * process it spawns, so any session launched from a git hook, a rebase --exec
   * or a filter carries it -- no attacker required, only an ordinary launch.
   */
  /*
   * EVERY PAIR IS FRESH, AND THAT IS NOT TIDINESS.
   *
   * overrideKeySource memoises git's answer per directory for the life of the
   * process. An earlier version of this test measured each repo's key with a
   * CLEAN environment first and then re-measured it with GIT_DIR set -- and the
   * second measurement was served from the cache, so the assertion passed with
   * the fix reverted. Watched: the mutation went from CAUGHT to MISSED the
   * moment caching was added. A memoised answer cannot demonstrate a property
   * about how the answer is computed.
   *
   * So each variable gets a repository pair it is the first to ask about, and
   * the claim is made WITHOUT a clean baseline: two unrelated repositories must
   * not collapse onto one key while the variable is set. If the environment
   * redirected the answer, both would resolve to A's common dir and match.
   */
  for (const varName of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE']) {
    const a = await repoWithWorktrees(t, 0);
    const b = await repoWithWorktrees(t, 0);

    const prev = process.env[varName];
    process.env[varName] = varName === 'GIT_WORK_TREE' ? a.main : join(a.main, '.git');
    try {
      assert.notEqual(keyOf(b.main), keyOf(a.main),
        `${varName} collapsed two unrelated repositories onto one grant key`);
    } finally {
      if (prev === undefined) delete process.env[varName];
      else process.env[varName] = prev;
    }
  }

  // RULE 5: the positive. Two fresh repos differ with a clean environment too,
  // or "they differ" above would say nothing about the variable.
  const c = await repoWithWorktrees(t, 0);
  const d = await repoWithWorktrees(t, 0);
  assert.notEqual(keyOf(c.main), keyOf(d.main),
    'two unrelated repositories share a key even with a clean environment');
});

test('the NON-REPOSITORY fallback keys on the directory, not one global constant', async (t) => {
  /*
   * THE SUITE PASSED WITH THIS REPLACED BY A LITERAL. An auditor mutated the
   * fallback to `return 'CONSTANT-FALLBACK'` -- behaviourally real, two unrelated
   * non-repo directories then shared one key -- and all seven tests stayed green.
   *
   * The test named "a directory that is not a repository grants NOTHING" asserts
   * readOverride(dir) === null, which is true of ANY key with no file behind it,
   * so it cannot tell "its own key" from "one global key shared by every non-repo
   * directory on the machine". Nothing covered what the fallback RETURNS. The
   * commit's stated negative control guarded only the git-success path.
   */
  const one = await mkdtemp(join(tmpdir(), 'ab-notrepo-a-'));
  const two = await mkdtemp(join(tmpdir(), 'ab-notrepo-b-'));
  t.after(() => rm(one, { recursive: true, force: true }));
  t.after(() => rm(two, { recursive: true, force: true }));

  assert.notEqual(keyOf(one), keyOf(two),
    'two unrelated non-repository directories share a grant key, so one grant would cover both');

  // And the fallback still identifies a directory with itself.
  assert.equal(keyOf(one), keyOf(one));
});

test('a grant covers ONE file, not the same relative path in every subdirectory', async (t) => {
  /*
   * Keying the grant on the repository made every SUBDIRECTORY share the key,
   * not just every worktree -- and the paths were still matched relative to the
   * session's cwd, which comes from the hook payload. So one grant naming
   * ".claude/settings.json" became a write permit for that path under ANY
   * directory in the repo: <repo>/.claude/settings.json,
   * <repo>/projA/.claude/settings.json, <repo>/projB/... Several different
   * files the owner named once.
   *
   * Worse for a reader: the announcement prints the RELATIVE path, so all of
   * them announce identically and the transcript cannot say which file was
   * written. src/claudeGuard.mjs states the property that breaks -- "a reader of
   * the transcript sees which path, on whose authority and until when".
   *
   * Measured through the shipped hook binary: DENY at the parent, ALLOW(granted)
   * for both subdirectories after the keying change. Found by blind audit.
   */
  const { main } = await repoWithWorktrees(t, 0);
  const home = await mkdtemp(join(tmpdir(), 'ab-subdir-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  const projA = join(main, 'projA');
  const projB = join(main, 'projB');
  await mkdir(join(projA, '.claude'), { recursive: true });
  await mkdir(join(projB, '.claude'), { recursive: true });

  await mkdir(join(home, 'overrides'), { recursive: true });
  await writeFile(overridePath(main, home), JSON.stringify({
    paths: ['.claude/settings.json'],
    reason: 'the repository root settings only',
    granted_by: 'danny',
    expires_at: new Date(Date.now() + 3600e3).toISOString(),
  }));

  const prev = process.env.AGENTBRIDGE_HOME;
  process.env.AGENTBRIDGE_HOME = home;
  try {
    // RULE 5: the positive. The grant must apply where it was written, or
    // "it does not apply in a subdirectory" is just a broken grant.
    assert.ok(overrideCovers(main, '.claude/settings.json'),
      'the grant does not apply at the repository root it was written for');

    for (const [name, dir] of [['projA', projA], ['projB', projB]]) {
      assert.equal(overrideCovers(dir, '.claude/settings.json'), null,
        `the grant reached ${name}/.claude/settings.json, a different file the owner never named`);
    }

    /*
     * A LINE THAT SAID "and a worktree still works" USED TO SIT HERE, building a
     * brand-new unrelated repository with zero worktrees and asserting the
     * helper returned zero worktrees. It touched neither the grant under test
     * nor any worktree. Deleted rather than repaired: the property it claimed to
     * cover is asserted properly by "a grant written for the main checkout is
     * READ from a worktree" below, and a comment naming a property no assertion
     * checks is worse than no comment.
     */
  } finally {
    if (prev === undefined) delete process.env.AGENTBRIDGE_HOME;
    else process.env.AGENTBRIDGE_HOME = prev;
  }
});

test('grant-path tells the owner where a grant goes, and never writes one', async (t) => {
  /*
   * The override file is named by sha(canonical git-common-dir).slice(0,16).
   * Nothing printed it and nothing documented it, so the owner was expected to
   * compute it by hand -- and every grant written at the wrong key fails in a
   * way that looks exactly like the guard being strict. Hours went to that.
   *
   * READ-ONLY IS THE POINT. An agent that writes its own permission file and
   * signs the owner's name to it has forged the grant, so this command prints a
   * path and reports whether one is live. It must not create anything.
   */
  const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agentbridge.mjs');
  const { main, trees } = await repoWithWorktrees(t, 1);
  const home = await mkdtemp(join(tmpdir(), 'ab-grantpath-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  const run = (repo) => spawnSync(process.execPath, [CLI, 'grant-path', '--repo', repo, '--json'], {
    encoding: 'utf8', env: { ...process.env, AGENTBRIDGE_HOME: home },
  });

  const atMain = run(main);
  assert.equal(atMain.status, 0, `grant-path exited ${atMain.status}: ${atMain.stderr}`);
  const mainOut = JSON.parse(atMain.stdout);

  const atTree = run(trees[0]);
  assert.equal(atTree.status, 0);
  const treeOut = JSON.parse(atTree.stdout);

  assert.equal(treeOut.file, mainOut.file,
    'a worktree was told to look somewhere other than its repository');
  assert.equal(mainOut.live, false, 'reported a live grant where none exists');

  // AND IT WROTE NOTHING. The overrides directory must not have been created.
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(join(home, 'overrides')), false,
    'grant-path created the overrides directory; it must only ever read');
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
