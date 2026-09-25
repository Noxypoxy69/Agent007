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
 * git-dependent part is two integration tests at the bottom, each on a
 * hermetic repo the test builds (one linear, one with merges; T-249).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('THE AHEAD CLAUSE MAKES NO TEMPORAL CLAIM -- the exact sentence, pinned', () => {
  /*
   * T-249. The ahead clause used to read "i.e. newer than anything
   * examined". `ahead` is reach(HEAD) minus reach(tip): a set of commits,
   * not a date. On this repository's own merge history 2 of the 26 ahead
   * commits predate the newest examined one, so the gloss was false. Pinned
   * POSITIVELY (the exact sentence), and then negatively for any time word.
   */
  const s = describeWindow({ behind: 788, ahead: 26, kind: 'two-dot' });
  assert.equal(s,
    'A WINDOW, NOT THE BRANCH: 788 behind it, and 26 AHEAD of it (reachable from HEAD, not from its tip).',
    'the ahead clause is not the measured, topological sentence');
  assert.doesNotMatch(s, /\b(newer|older|later|earlier|after|before)\b/i,
    'the banner makes a temporal claim that nothing in the module measures');

  /* the bare-rev form carries the same clause */
  assert.equal(describeWindow({ behind: 0, ahead: 3, kind: 'bare' }),
    'A WINDOW, NOT THE BRANCH: 3 AHEAD of it (reachable from HEAD, not from its tip).');
});

/*
 * ═══ AGAINST REAL GIT, ON A HISTORY THE TEST BUILDS ═══
 *
 * Rule 17 -- the arithmetic above is a separate claim from the wiring. The
 * previous version ran against the checkout's OWN HEAD with `HEAD~50` and
 * `HEAD~10`, and typed "ten commits lie ahead of HEAD~10 by definition". That
 * is a first-parent intuition: on the trunk merge the answer was 26 (10
 * first-parent + 16 merged in), so the verdict depended on whichever repo ran
 * the suite (T-249). Now every git call runs in a hermetic temp repo whose
 * shape is built here, with explicit shas, and every expected set comes from
 * the builder's own record -- cross-checked against `rev-list` LISTS by set
 * arithmetic, never from `rev-list --count` with `^`, which is windowSpan's own
 * formula (hollow gate 2).
 */
/* NODE_TEST* and GIT_* stripped CASE-INSENSITIVELY (Windows env names). */
const cleanEnv = () => {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    const u = k.toUpperCase();
    if (u.startsWith('GIT_') || u.startsWith('NODE_TEST')) continue;
    out[k] = v;
  }
  return out;
};

/** A git runner bound to one directory: cwd is the fixture for every call. */
const gitIn = (dir) => (args, extraEnv = {}, input) => String(execFileSync('git', args, {
  cwd: dir, encoding: 'utf8', input, windowsHide: true, timeout: 60_000,
  stdio: ['pipe', 'pipe', 'pipe'], env: { ...cleanEnv(), ...extraEnv },
})).trim();

/**
 * Build a repo from a list of [name, parents[], epochSeconds]. Commits are made
 * with commit-tree on the empty tree, so no hook, index or signing is involved.
 * Returns the sha of every name, and the dir.
 */
const buildRepo = (t, spec, headName) => {
  const dir = mkdtempSync(join(tmpdir(), 't249-auditwindow-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = gitIn(dir);
  git(['init', '-q']);
  const tree = git(['mktree'], {}, '');
  const sha = {};
  for (const [name, parents, epoch] of spec) {
    const date = `${epoch} +0000`;
    sha[name] = git(['-c', 'commit.gpgSign=false', 'commit-tree', tree,
      ...parents.flatMap((p) => ['-p', sha[p]]), '-m', name], {
      GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_DATE: date,
    });
  }
  git(['update-ref', 'refs/heads/fixture', sha[headName]]);
  git(['symbolic-ref', 'HEAD', 'refs/heads/fixture']);
  return { dir, git, sha };
};

/** The product's own git runner, as scripts/check-audit-coverage.mjs wires it, pinned to the fixture. */
const productCount = async (dir) => {
  const { runGit } = await import('../src/safeGit.mjs');
  return (...revs) => {
    try {
      const n = Number(String(runGit(['-C', dir, 'rev-list', '--count', ...revs], {
        cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      })).trim());
      return Number.isFinite(n) ? n : null;
    } catch { return null; }
  };
};

/** reach(rev) as a Set of shas, from a rev-list LIST (no --count, no ^). */
const reach = (git, rev) => new Set(git(['rev-list', rev]).split(/\r?\n/).filter(Boolean));
const minus = (a, b) => new Set([...a].filter((x) => !b.has(x)));
const shasOf = (sha, names) => new Set(names.map((n) => sha[n]));

/** The whole real-git check for one fixture, with expected sets from the builder's record. */
const checkFixture = async ({ git, sha, dir }, { base, tip, expect }) => {
  /* PRECONDITION: the builder's record IS what git reaches, by list arithmetic. */
  const rBase = reach(git, sha[base]);
  const rTip = reach(git, sha[tip]);
  const rHead = reach(git, 'HEAD');
  assert.deepEqual(rBase, shasOf(sha, expect.behind), 'PRECONDITION: the fixture behind-set is not what git reaches');
  assert.deepEqual(minus(rTip, rBase), shasOf(sha, expect.window), 'PRECONDITION: the fixture window-set is not what git reaches');
  assert.deepEqual(minus(rHead, rTip), shasOf(sha, expect.ahead), 'PRECONDITION: the fixture ahead-set is not what git reaches');

  const count = await productCount(dir);
  const total = count('HEAD');
  const span = windowSpan(`${sha[base]}..${sha[tip]}`, count);

  /* THE IDENTITY (kept from the old test): a partition whenever base ⊑ tip ⊑ HEAD, merges or not. */
  assert.equal(span.behind + expect.window.length + span.ahead, total,
    'behind + window + ahead must be the whole branch');
  assert.equal(total, rHead.size, 'total is not the size of reach(HEAD)');

  /* THE REPLACEMENT FOR THE TYPED 10: each direction equals its derived set. */
  assert.equal(span.behind, expect.behind.length, 'behind is not the size of reach(base)');
  assert.equal(span.ahead, expect.ahead.length, 'ahead is not the size of reach(HEAD) minus reach(tip)');

  /* and the sentence the auditor reads, exactly */
  assert.equal(describeWindow(span),
    `A WINDOW, NOT THE BRANCH: ${expect.behind.length} behind it, and ${expect.ahead.length} AHEAD of it (reachable from HEAD, not from its tip).`);

  /* a bare rev: nothing behind, and what is ahead of it is the same derived set */
  const bareTip = windowSpan(sha[tip], count);
  assert.equal(bareTip.behind, 0);
  assert.equal(bareTip.ahead, expect.ahead.length, 'a bare tip lost what is ahead of it');

  /* and the bare-rev case against real git, which is where M2 lived */
  const bare = windowSpan('HEAD', count);
  assert.equal(bare.behind, 0);
  assert.equal(bare.ahead, 0);
  assert.equal(describeWindow(bare), null,
    `a bare HEAD announced an excluded population of ${bare.behind}`);
  return { span, rHead, rTip };
};

const DAY = 86_400;
const T0 = 1_767_225_600; /* 2026-01-01T00:00:00Z */

test('AGAINST REAL GIT, LINEAR: the three counts reconcile to the branch total', async (t) => {
  const names = Array.from({ length: 12 }, (_, i) => `c${i}`);
  const spec = names.map((n, i) => [n, i === 0 ? [] : [names[i - 1]], T0 + i * DAY]);
  const repo = buildRepo(t, spec, 'c11');

  /* PRECONDITION: linear -- no commit has two parents. */
  assert.equal(repo.git(['rev-list', '--min-parents=2', 'HEAD']), '', 'PRECONDITION: the linear fixture has a merge');

  await checkFixture(repo, {
    base: 'c3', tip: 'c8',
    expect: { behind: names.slice(0, 4), window: names.slice(4, 9), ahead: names.slice(9) },
  });
});

test('AGAINST REAL GIT, MERGES: side commits inside the window AND ahead of it', async (t) => {
  /*
   *   t0 - t1 - t2 - t3(base) - t4(merge) - t5 - t6(tip) - t7(merge) - t8(HEAD)
   *         \    \              /                          /
   *          \    s2a - s2b ---/--------------------------'   (AHEAD, dated OLD)
   *           s1a - s1b ------'                               (INSIDE the window)
   *
   * s1 forks below base and merges between base and tip: NOT behind (not in
   * reach(base)) but in the window. s2 forks below base and merges above the
   * tip: ahead of the window, and dated older than every window commit -- so a
   * temporal gloss on "ahead" is false on this fixture (rule 9: it can fail).
   */
  const d = (n) => T0 + n * DAY;
  const spec = [
    ['t0', [], d(0)], ['t1', ['t0'], d(1)], ['t2', ['t1'], d(2)],
    ['s1a', ['t1'], d(3)], ['s1b', ['s1a'], d(4)],
    ['s2a', ['t2'], d(5)], ['s2b', ['s2a'], d(6)],
    ['t3', ['t2'], d(10)], ['t4', ['t3', 's1b'], d(11)], ['t5', ['t4'], d(12)], ['t6', ['t5'], d(13)],
    ['t7', ['t6', 's2b'], d(14)], ['t8', ['t7'], d(15)],
  ];
  const repo = buildRepo(t, spec, 't8');
  const { git, sha } = repo;

  /* PRECONDITION: both merges are real merges, read from git, not from the spec. */
  for (const m of ['t4', 't7']) {
    const parents = git(['rev-list', '--parents', '-n', '1', sha[m]]).split(' ').slice(1);
    assert.ok(parents.length >= 2, `PRECONDITION: ${m} is not a merge (parents: ${parents.length})`);
  }

  const expect = {
    behind: ['t0', 't1', 't2', 't3'],
    window: ['s1a', 's1b', 't4', 't5', 't6'],
    ahead: ['s2a', 's2b', 't7', 't8'],
  };
  /* PRECONDITION: each placement really occurs -- side commits inside the window AND ahead. */
  assert.ok(expect.window.filter((n) => n.startsWith('s')).length > 0, 'PRECONDITION: no side commit inside the window');
  assert.ok(expect.ahead.filter((n) => n.startsWith('s')).length > 0, 'PRECONDITION: no side commit ahead of the window');

  /* PRECONDITION: >=1 ahead commit is dated older than the newest window commit, read from git. */
  const ct = (n) => Number(git(['log', '-1', '--format=%ct', sha[n]]));
  const newestWindow = Math.max(...expect.window.map(ct));
  const olderAhead = expect.ahead.filter((n) => ct(n) < newestWindow);
  assert.ok(olderAhead.length >= 1,
    'PRECONDITION: no ahead commit predates the window, so a temporal gloss could not be falsified here');

  const { span } = await checkFixture(repo, { base: 't3', tip: 't6', expect });

  /* The first-parent count is a DIFFERENT number here, so this fixture can tell them apart. */
  const rTip = reach(git, sha.t6);
  const firstParentAhead = git(['rev-list', '--first-parent', 'HEAD']).split(/\r?\n/).filter(Boolean)
    .filter((s) => !rTip.has(s)).length;
  assert.notEqual(firstParentAhead, expect.ahead.length,
    'PRECONDITION: first-parent and full reachability agree on this fixture, so it cannot separate them');
  assert.equal(span.ahead, expect.ahead.length);
});
