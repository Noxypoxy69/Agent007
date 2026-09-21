/**
 * THE WINDOW BANNER: WHAT IT LEAVES OUT, AND IN WHICH DIRECTION.
 *
 * Three bugs in two commits, each one the SAME defect the banner exists to
 * remove -- a number answering a narrower or different question than the
 * one it appears to answer:
 *
 *   D-7  every excluded commit was called OLDER. True only when the tip is
 *        HEAD, which was the default and so the only case checked.
 *   M2   for a BARE revision the window's own contents were reported as
 *        lying outside it -- 772 examined commits announced as excluded,
 *        while the 10 genuinely excluded went unmentioned.
 *   M3   79 lines of it sat in a script the suite cannot import, so none
 *        of the above had ever been watched fail.
 *
 * `count` is injected, so the arithmetic is tested without git and the
 * git-dependent part is one small integration test at the bottom.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { splitRange, windowSpan, describeWindow } from '../src/auditWindow.mjs';

/** Records what was asked of git, and answers from a table. */
const counter = (table) => {
  const asked = [];
  const fn = (...revs) => {
    asked.push(revs.join(' '));
    return Object.prototype.hasOwnProperty.call(table, revs.join(' ')) ? table[revs.join(' ')] : null;
  };
  fn.asked = asked;
  return fn;
};

test('splitRange: a bare rev has NO base, which is the whole of M2', () => {
  assert.deepEqual(splitRange('HEAD'), { base: null, tip: 'HEAD', kind: 'bare' });
  assert.deepEqual(splitRange('HEAD~10'), { base: null, tip: 'HEAD~10', kind: 'bare' });

  /* THE POSITIVE (rule 5): a two-dot range still yields both ends. */
  assert.deepEqual(splitRange('a..b'), { base: 'a', tip: 'b', kind: 'two-dot' });
  assert.deepEqual(splitRange('HEAD~50..HEAD'), { base: 'HEAD~50', tip: 'HEAD', kind: 'two-dot' });

  /* git reads an omitted side as HEAD; so does this. */
  assert.deepEqual(splitRange('a..'), { base: 'a', tip: 'HEAD', kind: 'two-dot' });
  assert.deepEqual(splitRange('..b'), { base: 'HEAD', tip: 'b', kind: 'two-dot' });

  /* Three-dot is a different question and is refused rather than answered
   * with the two-dot arithmetic -- which would be this module's own bug. */
  assert.equal(splitRange('a...b').kind, 'symmetric');
});

test('A BARE REV HAS NOTHING BEHIND IT -- M2, and the old code said 772', () => {
  /*
   * The exact measured case. `rev-list --count HEAD` was 772 and the banner
   * announced all 772 as excluded from a window that contained every one
   * of them. The bug is that `base` was set to the rev itself, so this
   * asserts on the CALLS as well as the answer: nothing may be counted
   * with the rev as a base.
   */
  const count = counter({ 'HEAD ^HEAD': 0 });
  const span = windowSpan('HEAD', count);

  assert.equal(span.behind, 0,
    'the window reaches the root, so nothing is behind it -- reporting its own '
    + 'contents as excluded is the defect this replaced');
  assert.equal(span.ahead, 0);
  assert.deepEqual(count.asked, ['HEAD ^HEAD'],
    'a bare rev was counted as if it were a base');

  /* and nothing is printed at all, rather than a false sentence */
  assert.equal(describeWindow(span), null);
});

test('A BARE REV STILL REPORTS WHAT IS AHEAD OF IT -- the half M2 suppressed', () => {
  /*
   * `HEAD~10` excludes the ten newest commits. The old code reported 762
   * (all examined) and never mentioned the 10. This is the assertion that
   * would have caught it: the number that appears must be the excluded
   * one.
   */
  const count = counter({ 'HEAD ^HEAD~10': 10 });
  const span = windowSpan('HEAD~10', count);

  assert.equal(span.behind, 0);
  assert.equal(span.ahead, 10);
  assert.match(describeWindow(span), /10 AHEAD of it/);
  assert.doesNotMatch(describeWindow(span), /behind/,
    'a bare rev claimed commits behind it');
});

test('BOTH DIRECTIONS FOR A TWO-DOT RANGE, and neither is inferred by subtracting', () => {
  /* The D-7 case: a tip short of HEAD excludes the NEWEST commits. */
  const count = counter({ 'HEAD~50': 722, 'HEAD ^HEAD~10': 10 });
  const span = windowSpan('HEAD~50..HEAD~10', count);

  assert.equal(span.behind, 722);
  assert.equal(span.ahead, 10);
  const s = describeWindow(span);
  assert.match(s, /722 behind it/);
  assert.match(s, /10 AHEAD of it/);

  /* Each direction was asked of git on its own -- the old code derived the
   * total by subtraction and then labelled all of it "older". */
  assert.deepEqual(count.asked, ['HEAD~50', 'HEAD ^HEAD~10']);
});

test('THE TIP BEING HEAD MEANS NOTHING IS AHEAD, and that clause disappears', () => {
  const count = counter({ 'HEAD~50': 722, 'HEAD ^HEAD': 0 });
  const span = windowSpan('HEAD~50..HEAD', count);
  assert.equal(span.ahead, 0);
  assert.equal(describeWindow(span), 'A WINDOW, NOT THE BRANCH: 722 behind it.');
});

test('A COUNT THAT COULD NOT BE TAKEN IS UNKNOWN, NOT ZERO, AND NOT ITS NEIGHBOUR', () => {
  /*
   * The house primitive. A failed count must never be folded into the
   * other direction, and must never read as a measured zero -- that is the
   * shape the whole banner exists to prevent.
   */
  const span = windowSpan('nosuchref..HEAD', counter({ 'HEAD ^HEAD': 0 }));
  assert.equal(span.behind, null);
  assert.match(describeWindow(span), /an UNKNOWN number behind it/);

  const both = windowSpan('nosuchref..alsomissing', counter({}));
  assert.equal(both.behind, null);
  assert.equal(both.ahead, null);
  const s = describeWindow(both);
  assert.match(s, /UNKNOWN number behind it/);
  assert.match(s, /UNKNOWN number ahead of it/);

  /* A zero must NOT print as unknown, or the distinction is cosmetic. */
  assert.equal(describeWindow(windowSpan('HEAD', counter({ 'HEAD ^HEAD': 0 }))), null);
});

test('A THREE-DOT RANGE SAYS NOTHING RATHER THAN SOMETHING WRONG', () => {
  const count = counter({});
  const span = windowSpan('a...b', count);
  assert.equal(describeWindow(span), null);
  assert.deepEqual(count.asked, [], 'git was asked a two-dot question about a three-dot range');
});

test('AGAINST REAL GIT: the three counts reconcile to the branch total', async () => {
  /*
   * Rule 17 -- the arithmetic above is a separate claim from the wiring.
   * Derived entirely at run time (rule 21): no count is typed, and the
   * identity asserted is one that must hold on ANY repository with at
   * least sixty commits, not on this one.
   */
  const { runGit } = await import('../src/safeGit.mjs');
  const count = (...revs) => {
    try {
      const n = Number(String(runGit(['rev-list', '--count', ...revs], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      })).trim());
      return Number.isFinite(n) ? n : null;
    } catch { return null; }
  };

  const total = count('HEAD');
  assert.ok(total !== null && total > 60, `PRECONDITION: need >60 commits, have ${total}`);

  const span = windowSpan('HEAD~50..HEAD~10', count);
  const inWindow = count('HEAD~10', '^HEAD~50');

  assert.equal(span.behind + inWindow + span.ahead, total,
    'behind + window + ahead must be the whole branch');
  assert.equal(span.ahead, 10, 'ten commits lie ahead of HEAD~10 by definition');

  /* and the bare-rev case against real git, which is where M2 lived */
  const bare = windowSpan('HEAD', count);
  assert.equal(bare.behind, 0);
  assert.equal(bare.ahead, 0);
  assert.equal(describeWindow(bare), null,
    `a bare HEAD announced an excluded population of ${bare.behind}`);
});
