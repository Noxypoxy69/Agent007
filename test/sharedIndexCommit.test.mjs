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
 * is `commitFence` in src/gitIndexLease.mjs and is tested here for what
 * it decides. The WIRING -- that the rail actually asks it -- is a separate
 * claim with its own tests at the bottom of this file, because a guard nobody
 * consults is the failure rule 17 exists for and it has happened here three
 * times.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { commitFence } from '../src/gitIndexLease.mjs';

/**
 * The old boolean, so the cases below keep reading as "does this name its
 * paths". `commitFence` returns `{ok, why}` because the rail needs to tell a
 * caller WHICH objection it hit -- see THE TWO REFUSALS ARE DISTINGUISHABLE
 * at the bottom of this file, which is the test that reason exists.
 */
const commitNamesItsPaths = (a) => commitFence(a).ok;
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
  /*
   * THE PREFIXES AND CLUSTERS ARE HERE BECAUSE GIT ACCEPTS THEM AS THE FLAG.
   * `git commit --amen` amends; `git commit --includ` includes. An exact
   * alternation missed every one, and an independent audit found
   * `git commit --amen README.md` ALLOWED hours after I shipped the matcher.
   * Fourth enumeration mistake on a matcher in this repository; the fix is the
   * same one every time -- ask what git would resolve, not how it is spelled.
   */
  for (const c of [
    'git commit -a src/a.mjs -m message',
    'git commit --all src/a.mjs -m message',
    'git commit -i src/a.mjs -m message',
    'git commit --include src/a.mjs -m message',
    'git commit --amend src/a.mjs -m message',
    'git commit -am message src/a.mjs',
    'git commit --amen src/a.mjs -m message',
    'git commit --ame src/a.mjs -m message',
    'git commit --includ src/a.mjs -m message',
    'git commit --inc src/a.mjs -m message',
    'git commit --al src/a.mjs -m message',
    'git commit -qa src/a.mjs -m message',
    'git commit -vi src/a.mjs -m message',
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

test('THE SCOPE IS commit ALONE, and the residual is asserted rather than assumed', () => {
  /*
   * AUDIT FINDING D5. `git rebase --continue`, `git cherry-pick --continue`,
   * `git revert --continue` and a bare `git stash` all move the shared index,
   * and none of them is fenced. This file used to carry `INDEX_WRITERS`,
   * `gitSubcommand` and `writesIndex` -- three exports that identified exactly
   * those verbs, with no production caller anywhere (finding D3). Tested,
   * correct, consulted by nothing.
   *
   * They are deleted rather than wired, because refusing `git rebase --continue`
   * has NO compliant spelling -- you cannot name paths on it -- and a refusal
   * with no alternative is an outage that gets the hook switched off. The
   * reasoning lives in the module header now instead of in dead code that made
   * the gap look handled.
   *
   * SO THIS TEST PINS THE GAP RATHER THAN CLOSING IT. If somebody widens the
   * fence, this goes red and points them at the header paragraph that has to
   * change with it. A residual nothing asserts is a residual nobody will find.
   *
   * AND THE FIRST VERSION OF THIS TEST WAS ITSELF HOLLOW, found by blind audit.
   * It asserted only that the refusal reason did NOT match two phrases, which
   * meant: it passed if somebody widened the fence using any other wording; it
   * had no positive, so it also passed if the command was never judged at all;
   * and it tested `git stash --continue`, which is not a thing, while never
   * testing BARE `git stash` -- the case the commit message singles out as "the
   * same hazard, and louder". A gate asserting the absence of a string, with no
   * positive beside it, is rule 5 in one line.
   */
  const RESIDUAL = [
    'git rebase --continue', 'git cherry-pick --continue', 'git revert --continue',
    'git stash', 'git stash push', 'git merge --continue', 'git am --continue',
  ];

  for (const cmd of RESIDUAL) {
    const v = judge(cmd);
    /*
     * THE POSITIVE FIRST: the command must actually reach a verdict. Without
     * this, a `judge` that threw or returned undefined would satisfy every
     * "does not match" assertion below.
     */
    assert.equal(typeof v?.allowed, 'boolean', `${cmd} was not judged at all`);

    /*
     * Then the residual itself, stated as the property rather than as two
     * phrases: if the SHARED-INDEX fence starts refusing these, the module
     * header's argument for leaving them alone has to change with it. The
     * fence's own two reasons are the only ones that count -- a refusal from
     * the sweep check or the protected-path walk is a different mechanism and
     * is not what this pins (rule 18).
     */
    const fenceRefused = v.allowed === false
      && /no pathspec|not bounded by the paths you name/.test(v.reason ?? '');
    assert.equal(
      fenceRefused, false,
      `"${cmd}" is now refused by the shared-index fence, reason: ${v.reason}\n`
        + 'That may well be right -- but src/gitIndexLease.mjs argues these are '
        + 'deliberately unfenced because a refusal with no compliant spelling is an '
        + 'outage. Update that paragraph and this test together, or the code and its '
        + 'stated reasoning have parted company.',
    );
  }
});

test('THE RESIDUAL CONTROL: this pin can actually fire', () => {
  /*
   * Rule 1, and rule 16 -- a gate nobody has shown can go red is a decoration.
   * `git commit` IS fenced, with both of the reasons the test above watches
   * for, so pointing the same predicate at it must produce the failure. If this
   * ever passes, the matcher in the test above has stopped recognising the
   * fence's own refusals and the residual is being pinned by nothing.
   */
  const unnamed = judge('git commit -m msg');
  assert.equal(unnamed.allowed, false);
  assert.match(unnamed.reason, /no pathspec/,
    'the fence no longer produces the reason the residual test watches for');

  const widened = judge('git commit --amend README.md');
  assert.equal(widened.allowed, false);
  assert.match(widened.reason, /not bounded by the paths you name/,
    'the fence no longer produces the second reason the residual test watches for');
});

test('garbage in is a refusal, not a throw', () => {
  for (const bad of [null, undefined, 'git commit', 42, {}, [], ['git'], [null, 'commit']]) {
    assert.equal(commitNamesItsPaths(bad), false, `${JSON.stringify(bad)} was read as a named commit`);
    assert.doesNotThrow(() => commitFence(bad));
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

test('THE TWO REFUSALS ARE DISTINGUISHABLE, and the message names the right one', () => {
  /*
   * FOUND BY BLIND AUDIT, 2026-09-18. One reason string covered two different
   * objections, so a caller who wrote `git commit --amend README.md` was told
   * there was "no pathspec". README.md was right there. The advice was to add
   * something already present, which is the worst kind of refusal: it reads as
   * the guard being broken, and the reader goes looking for a way around.
   *
   * Rule 15 asks a moved gate to name the half that is still open. These are
   * genuinely different halves -- one is "you named nothing", the other is
   * "what you named does not bound this".
   */
  assert.equal(commitFence(argv('git commit -m message')).why, 'unnamed');
  assert.equal(commitFence(argv('git commit --amend README.md')).why, 'widened');
  assert.equal(commitFence(argv('git commit -a README.md -m message')).why, 'widened');
  assert.equal(commitFence(argv('git commit README.md -m message')).why, 'named');
  assert.equal(commitFence(argv('git status')).why, 'not-a-commit');

  // And the rail carries the distinction through rather than flattening it.
  const amend = judge('git commit --amend README.md');
  assert.equal(amend.allowed, false);
  assert.doesNotMatch(amend.reason, /no pathspec/,
    'an --amend refusal still tells the caller to name a path they already named');
  assert.match(amend.reason, /--amend/, 'the refusal does not name the flag it objects to');
});

test('A MESSAGE THAT IS EXACTLY A WIDENING FLAG IS STILL A MESSAGE', () => {
  /*
   * THE OTHER HALF OF THE SAME AUDIT FINDING, and the sharper one. The widening
   * test ran over every token BEFORE the arity walk knew that `-m` consumes the
   * next one, so `git commit src/x.mjs -m "-a"` was refused as though `-a` had
   * been passed.
   *
   * This module's own header warns about exactly that class -- a message token
   * read as an operand made `git commit -m test` name test/claudeGuard.test.mjs
   * -- and then committed it in the other direction two functions later. The
   * identical trap was live in shellAllowlist.mjs's raw-string selectors on the
   * same night; see test/quotedSelector.test.mjs.
   */
  for (const msg of ['-a', '-i', '--all', '--include', '--amend', '-am']) {
    const v = commitFence(argv(`git commit src/x.mjs -m ${msg}`));
    assert.equal(v.ok, true, `a commit message of exactly "${msg}" was read as the flag it names`);
    assert.equal(v.why, 'named');
  }

  // The control: a REAL widening flag in the same position still wins.
  assert.equal(commitFence(argv('git commit src/x.mjs -a -m message')).why, 'widened');
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
