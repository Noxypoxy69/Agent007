/**
 * A COMMIT THAT NAMES NOTHING TAKES WHATEVER IS IN THE INDEX.
 *
 * THE MEASURED CASE, from CLAUDE.md's own two-agents-one-clone section: the
 * index is shared, another session can stage between your `add` and your
 * `commit`, and both halves land in your commit. The sweep selectors close
 * `-a`, `--all` and `.`; they cannot close `git commit -m "msg"`, which
 * carries no selector at all and is the quiet spelling of the same thing.
 *
 * TWO HALVES, AND THE SECOND IS THE ONE THAT KEEPS BEING MISSING. The decision
 * is `commitNamesItsPaths` in src/gitIndexLease.mjs and is tested here for what
 * it decides. The WIRING -- that the rail actually asks it -- is a separate
 * claim with its own tests at the bottom of this file, because a guard nobody
 * consults is the failure rule 17 exists for and it has happened here three
 * times.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { commitNamesItsPaths, writesIndex, gitSubcommand, INDEX_WRITERS } from '../src/gitIndexLease.mjs';
import { judgeShellCommand } from '../src/shellAllowlist.mjs';

const argv = (s) => s.split(' ');

/* ── the decision ─────────────────────────────────────────────────────── */

test('THE POSITIVE FIRST: a commit that names its paths is recognised', () => {
  /*
   * Rule 5. Every refusal below is satisfied by a function that returns false
   * for everything, which would refuse every commit in the repository and get
   * the whole rail switched off within the hour.
   */
  for (const c of [
    'git commit src/a.mjs -m message',
    'git commit -m message src/a.mjs',
    'git commit src/a.mjs src/b.mjs -m message',
    'git commit -m message -- src/a.mjs',
    'git commit --message=message src/a.mjs',
    'git commit -F notes.txt src/a.mjs',
    'git commit -C abc123 src/a.mjs',
    'git commit --fixup=abc123 src/a.mjs',
    'git commit -S src/a.mjs',
    'git -C other commit src/a.mjs -m message',
  ]) {
    assert.equal(commitNamesItsPaths(argv(c)), true, `a compliant commit was not recognised: ${c}`);
  }
});

test('a commit with NO pathspec is the shape that takes the whole index', () => {
  for (const c of [
    'git commit',
    'git commit -m message',
    'git commit --message=message',
    'git commit -m message --no-verify',
    'git commit -F notes.txt',
    'git commit --amend',
    'git commit --amend -m message',
    'git -C other commit -m message',
  ]) {
    assert.equal(commitNamesItsPaths(argv(c)), false, `an unnamed commit passed as narrow: ${c}`);
  }
});

test('A FLAG THAT RE-OPENS THE WINDOW BEATS A PATHSPEC SITTING BESIDE IT', () => {
  /*
   * THE TRAP THIS EXISTS FOR. `-i`/`--include` commits the named paths IN
   * ADDITION TO whatever is already staged -- which is precisely the other
   * session's work -- and `-a` commits every tracked modification. If a
   * pathspec were enough on its own, the fence would be satisfiable by adding
   * a file name to the exact command that breaks it.
   *
   * `--amend` rewrites a commit that already exists rather than recording the
   * named paths, so the paths do not bound what it touches either.
   */
  for (const c of [
    'git commit -a src/a.mjs -m message',
    'git commit --all src/a.mjs -m message',
    'git commit -i src/a.mjs -m message',
    'git commit --include src/a.mjs -m message',
    'git commit --amend src/a.mjs -m message',
    'git commit -am message src/a.mjs',
  ]) {
    assert.equal(commitNamesItsPaths(argv(c)), false, `a widening flag was overridden by a pathspec: ${c}`);
  }
});

test('AFTER `--` NOTHING IS A FLAG, which is git\'s own rule', () => {
  // A file legitimately named `-a` is a path, not a sweep.
  assert.equal(commitNamesItsPaths(argv('git commit -m message -- -a')), true,
    'a path after the separator was read as a flag');
  // And the separator does not launder a widening flag that came BEFORE it.
  assert.equal(commitNamesItsPaths(argv('git commit -a -m message -- src/a.mjs')), false,
    'the separator laundered a -a that preceded it');
});

test('THE MESSAGE IS NOT A PATHSPEC, which the rail has already got wrong once', () => {
  /*
   * `git commit -m test` named test/claudeGuard.test.mjs to the pathspec
   * resolver and a one-word commit message was refused as a protected path.
   * The same arity table that fixed it is why `-m`'s value is skipped here.
   */
  assert.equal(commitNamesItsPaths(argv('git commit -m test')), false,
    'the commit message was counted as a pathspec');
  assert.equal(commitNamesItsPaths(argv('git commit -m src/claudeGuard.mjs')), false,
    'a message that looks like a path was counted as one');
});

test('the subcommand survives global options -- not argv[1] alone', () => {
  /*
   * `git -C other add .` and `git --no-pager add .` are the same command as
   * `git add .`. Reading argv[1] blindly misses both, which is the tokens[1]
   * mistake already measured on the node branch of this rail.
   */
  assert.equal(gitSubcommand(argv('git -C other add .')), 'add');
  assert.equal(gitSubcommand(argv('git --no-pager add .')), 'add');
  assert.equal(gitSubcommand(argv('git -c user.name=x commit -m y')), 'commit');
  assert.equal(gitSubcommand(argv('git --git-dir other/.git status')), 'status');
  assert.equal(gitSubcommand(argv('git')), null);
  assert.equal(gitSubcommand(argv('git --no-pager')), null);
});

test('writesIndex is GENERATED from the table, so adding an entry extends it', () => {
  /*
   * Rule 7: generate the fixtures from the real list rather than restating a
   * few of them, so the coverage grows when the table does.
   */
  assert.ok(INDEX_WRITERS.length > 5, 'the table is too small to be the real one');
  for (const verb of INDEX_WRITERS) {
    assert.equal(writesIndex(['git', verb]), true, `${verb} is in the table but not detected`);
    assert.equal(writesIndex(['git', '-C', 'other', verb]), true,
      `${verb} is missed behind a global option`);
  }
  for (const verb of ['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'fetch', 'push']) {
    assert.equal(writesIndex(['git', verb]), false, `${verb} does not write the index`);
  }
});

test('NOT FENCED IS NOT A CLAIM OF SAFETY, and the module says so', () => {
  /*
   * Rule 8: an enumeration bounds nothing. `update-index` writes the index and
   * is deliberately absent, because an advisory fence fails open. Asserting the
   * gap keeps it honest -- if somebody later adds these, this test tells them
   * the fail-open reasoning in the module header has to change with it.
   */
  for (const plumbing of ['update-index', 'read-tree', 'apply', 'checkout-index']) {
    assert.equal(writesIndex(['git', plumbing]), false,
      `${plumbing} is now fenced; update the fail-open paragraph in src/gitIndexLease.mjs`);
  }
});

test('garbage in is false, not a throw', () => {
  for (const bad of [null, undefined, 'git commit', 42, {}, [], ['git'], [null, 'commit']]) {
    assert.equal(commitNamesItsPaths(bad), false, `${JSON.stringify(bad)} was read as a named commit`);
    assert.doesNotThrow(() => writesIndex(bad));
  }
});

/* ── THE WIRING, WHICH IS A SEPARATE CLAIM ────────────────────────────── */

const judge = (c) => judgeShellCommand(c, { pathspecCovers: () => [] });

test('THE WIRING POSITIVE: a pathspec commit is still ALLOWED through the rail', () => {
  /*
   * Rule 5 again, and it is the assertion that matters most in this file. If
   * this one fails the rail refuses every commit, every agent is blocked, and
   * the fix is to switch the hook off -- which loses every other layer with it.
   * That is rule 19's measured lesson and it is the reason this is first.
   */
  const v = judge('git commit src/a.mjs -m "a message"');
  assert.equal(v.allowed, true, `the compliant spelling was refused: ${v.reason}`);
});

test('THE WIRING NEGATIVE: the rail asks, and refuses an unnamed commit', () => {
  const v = judge('git commit -m "a message"');
  assert.equal(v.allowed, false, 'the rail does not consult the shared-index check at all');
  assert.match(v.reason, /no pathspec/,
    'the refusal does not come from the shared-index check -- something else refused, '
      + 'and a refusal from the wrong layer is a hollow gate wearing a pass');
  assert.match(v.reason, /git commit <path>/,
    'the refusal does not tell the caller what to do instead');
});

test('THE REFUSAL NAMES THE HAZARD, because a rule nobody understands gets worked around', () => {
  const { reason } = judge('git commit -m "a message"');
  assert.match(reason, /shared/i, 'the refusal does not say the index is shared');
  assert.match(reason, /session/i, 'the refusal does not say another session is involved');
});

test('THE OTHER VERBS ARE UNCHANGED -- this fence is about commit alone', () => {
  /*
   * A check that quietly widened to `add` would refuse `git add <path>`, which
   * is the documented first half of the mandated workflow. Measuring the
   * neighbours is how an over-block gets caught before it ships; the last two
   * rail changes here were both over-blocks found after the fact.
   */
  for (const c of [
    'git add src/a.mjs',
    'git status',
    'git diff --cached --name-only',
    'git log --oneline -5',
    'git rm src/a.mjs',
  ]) {
    const v = judge(c);
    assert.ok(!(v.allowed === false && /no pathspec/.test(v.reason ?? '')),
      `the shared-index check leaked onto "${c}"`);
  }
});

test('AND THE SWEEP REFUSALS STILL COME FROM THE SWEEP CHECK, not from this one', () => {
  /*
   * Rule 18: establish WHICH thing refused. `git commit -am x` is refused by
   * both checks, and if the new one shadowed the old the sweep message would
   * silently stop being reachable -- a protection that quietly stopped being
   * one, which is rule 11.
   */
  const v = judge('git commit -am "a message"');
  assert.equal(v.allowed, false);
  assert.match(v.reason, /everything selector/,
    'the sweep check no longer reaches "git commit -am" -- the shared-index check shadowed it');
});

test('A COMMIT NAMING A PROTECTED PATH IS STILL JUDGED ON THAT', () => {
  /*
   * The new check runs BEFORE the protected-path walk, so it must not turn a
   * protected-path refusal into a pathspec refusal. Both messages exist for a
   * reason and the wrong one sends the reader somewhere useless.
   */
  const v = judgeShellCommand('git commit src/claudeGuard.mjs -m "x"', {
    pathspecCovers: (t) => (t === 'src/claudeGuard.mjs' ? ['src/claudeGuard.mjs'] : []),
    isOverridden: () => false,
  });
  assert.equal(v.allowed, false);
  assert.match(v.reason, /guard or completion control/,
    'a protected-path commit was refused for the wrong reason');
});
