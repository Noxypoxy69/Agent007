/**
 * THE SCOPING TOOL HAD NO TESTS AT ALL, AND IT DECIDES WHAT GETS TESTED.
 *
 * `scripts/diff-suite.mjs` selects which test files run for a change. It is in
 * PROTECTED_PATHS, it is on the path of every scoped verification, and until
 * this file nothing exercised it. A silent mis-scope there removes coverage
 * everywhere downstream while still printing a green summary, which is the
 * most expensive shape of hollow gate available: not one wrong answer, but a
 * whole suite that was never asked.
 *
 * THE MEASURED DEFECT, 2026-09-20. The flag is `--since`. An invocation read
 *
 *     node scripts/diff-suite.mjs --base 553724b --print
 *
 * and nothing complained. Both unknown flags were ignored, the scope fell back
 * to "working tree against HEAD", and the run reported 66/66 GREEN having
 * selected SIX of the thirty-three test files the intended range needed. The
 * honest run was 431 tests. A narrower green than was asked for, announced as
 * a pass -- and nothing in the output distinguished it from the real thing.
 *
 * So these assert on the REFUSAL and on the SCOPE, never on "it exited 0".
 * Rule 4: an exit code is a proxy for what a tool selected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCRIPT = path.join(REPO, 'scripts', 'diff-suite.mjs');

const run = (args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO, encoding: 'utf8', timeout: 120_000,
  });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
};

test('AN UNKNOWN FLAG IS REFUSED, not absorbed into a default scope', () => {
  const r = run(['--base', 'HEAD~1', '--list']);

  /*
   * The exact code, not `notEqual(0)`. Rule 3: a non-zero exit is evidence a
   * process was unhappy, and a crash would satisfy notEqual(0) just as well.
   */
  assert.equal(r.code, 2,
    `expected the documented refusal code 2, got ${r.code}. stderr: ${r.err}`);

  assert.match(r.err, /--base/,
    'the refusal must NAME the flag it did not recognise, or the operator has '
    + 'to guess which of their arguments was dropped');
  assert.match(r.err, /--since/,
    'and it must name the flag they probably meant');

  /*
   * A NEGATIVE NEEDS THE POSITIVE (rule 5). A script that exits 2 on
   * everything would satisfy every assertion above, so prove it did not even
   * begin selecting: the refusal happens before any scope is computed.
   */
  assert.doesNotMatch(`${r.out}${r.err}`, /changed:/,
    'it refused but still computed a scope first, so a later edit could let '
    + 'that scope be used');
});

test('--since WITH NO REVISION is refused too -- the same defect, second spelling', () => {
  /*
   * Fixing only the unknown-NAME case would be rule 8: patching the strings a
   * prober happened to try rather than the way the option is read. `--since`
   * as the final argument, or followed by another flag, makes the option
   * reader return its default, which is the HEAD fallback again.
   */
  /*
   * BOTH SHAPES CARRY `--list`, AND THAT IS NOT COSMETIC. Watching this test
   * fail means running the script with the refusal removed, and without
   * `--list` the trailing-`--since` case then falls through to an ACTUAL
   * suite run nested inside this one. Node's recursion guard caught it, which
   * is luck, not design. `--list` keeps the mutation cheap; the shapes under
   * test -- a trailing flag, and a flag where a revision should be -- are
   * unchanged.
   */
  for (const args of [['--list', '--since'], ['--since', '--list']]) {
    const r = run(args);
    assert.equal(r.code, 2,
      `${JSON.stringify(args)} should be refused, got ${r.code}. stderr: ${r.err}`);
    assert.match(r.err, /--since needs a revision/,
      `${JSON.stringify(args)} was refused for the wrong reason: ${r.err}`);
  }
});

test('EVERY ARGUMENT MUST BE CLAIMED -- short flags and bare positionals too', () => {
  /*
   * RULE 8, APPLIED TO THE PREVIOUS FIX IN THIS FILE. That fix refused
   * unrecognised LONG-FLAG NAMES and its commit message said the class was
   * closed. Measured afterwards, all of these exited 0 and selected the 6
   * whole-repo gates instead of the 39 the range needed -- a green run that
   * tested almost nothing:
   *
   *     -s <rev>        short flag, never inspected
   *     <rev>           bare positional, ignored
   *
   * The defect was never "unknown long-flag names", it was "an argument this
   * script does not understand is silently discarded". These assert the
   * PROPERTY -- consume-and-check -- so a spelling nobody has thought of is
   * covered too.
   */
  for (const args of [['-s', 'HEAD', '--list'], ['HEAD', '--list'], ['--list', 'extra']]) {
    const r = run(args);
    assert.equal(r.code, 2,
      `${JSON.stringify(args)} was absorbed instead of refused, got ${r.code}. stderr: ${r.err}`);
    assert.match(r.err, /unrecognised argument/,
      `${JSON.stringify(args)} was refused for the wrong reason: ${r.err}`);
    assert.doesNotMatch(`${r.out}${r.err}`, /changed:/,
      `${JSON.stringify(args)} computed a scope before refusing`);
  }
});

test('A REPEATED FLAG IS REFUSED, because the FIRST one wins', () => {
  /*
   * `argv.indexOf` takes the first occurrence, so somebody correcting a typo
   * by retyping the flag gets the value they meant to replace -- and the run
   * looks fine. Refusing is the only option that cannot be silently wrong.
   */
  const r = run(['--since', 'HEAD', '--since', 'HEAD~1', '--list']);
  assert.equal(r.code, 2, `a repeated flag was resolved rather than refused: ${r.err}`);
  assert.match(r.err, /given 2 times/);
});

test('A --since THAT IS NOT A COMMIT IS REFUSED, not read as a pathspec', () => {
  /*
   * THE SHARPEST OF THE FOUR. `git diff --name-only CLAUDE.md` is a VALID
   * command: git reads an unresolvable revision as a PATHSPEC and diffs the
   * working tree against HEAD limited to that path. So `--since CLAUDE.md`
   * produced an empty scope, exit 0, and an output line reading "nothing
   * changed against HEAD" WHILE --since was on the command line -- the
   * message contradicting the invocation and still reading as a pass.
   *
   * Arity and spelling checks structurally cannot catch it: the argument is
   * present, a string, and in the right place. Only git can answer.
   */
  const r = run(['--since', 'CLAUDE.md', '--list']);
  assert.equal(r.code, 2, `a pathspec was accepted as a revision: ${r.out}${r.err}`);
  assert.match(r.err, /does not resolve to a commit/);

  /* A tree sha verifies under a bare --verify; it must still be refused. */
  const tree = run(['--since', 'HEAD^{tree}', '--list']);
  assert.equal(tree.code, 2,
    'a TREE resolved as a valid --since, and diffing against a tree is meaningless');
});

test('AND THE KNOWN FLAGS STILL WORK, so the refusal is not an outage', () => {
  /*
   * Rule 19, in miniature. A check that denies everything it does not
   * recognise is an outage, and an outage gets the tool stopped being used --
   * which loses the scoping AND the whole-repo gates it always runs.
   */
  const r = run(['--list']);
  assert.equal(r.code, 0, `plain --list must still work. stderr: ${r.err}`);
  assert.match(r.err, /test file\(s\)/,
    'a working --list reports how many test files it selected');
});

test('THE SCOPE ACTUALLY MOVES WITH --since, which is the property that matters', () => {
  /*
   * THE REFUSAL IS NOT THE POINT; the point is that a supplied revision
   * CHANGES WHAT RUNS. Assert the far end (rule 4): a wider range must select
   * a superset, not merely a different exit code.
   *
   * Derived from the repository at run time rather than pinned to a revision,
   * because a literal SHA is a fact about one machine's history -- rule 21,
   * and the 8.3 short-name test is the standing example of getting this wrong.
   */
  /*
   * ═══ THIS TEST WAS SATISFIED BY EQUALITY, WHICH IS THE BUG IT GATES ═══
   *
   * Blind audit D-E. It asserted `farSet.size >= nearSet.size` and
   * `nearSet ⊆ farSet`. BOTH HOLD WHEN THE TWO SETS ARE IDENTICAL -- that is,
   * when `--since` is ignored entirely and every run returns the six
   * whole-repo gates. The test named "THE SCOPE ACTUALLY MOVES" did not
   * assert that it moves.
   *
   * It was non-vacuous only by accident of history: `--since HEAD~5` happened
   * to span a source change. `--since HEAD~1 --list` gives 6 files, identical
   * to `--since HEAD`. Had the recent commits been doc-only -- as one in this
   * very range was -- this would have been green and proved nothing.
   *
   * So the far revision is DERIVED from the repository at run time: ask git
   * for a commit that actually touched a source file, and assert STRICT
   * inequality. Rule 21 -- a literal `HEAD~5` is a fact about one machine's
   * history, not a property of the tool.
   */
  const srcTouching = spawnSync('git', [
    'log', '-1', '--format=%H', '--', 'src',
  ], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
  assert.match(srcTouching, /^[0-9a-f]{40}$/,
    'could not find a commit touching src/, so the comparison below would be vacuous');

  const near = run(['--since', 'HEAD', '--list']);
  const far = run(['--since', `${srcTouching}~1`, '--list']);

  assert.equal(near.code, 0, `--since HEAD failed: ${near.err}`);
  assert.equal(far.code, 0, `--since HEAD~5 failed: ${far.err}`);

  const files = (s) => new Set(
    s.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('test/')),
  );
  const nearSet = files(near.out);
  const farSet = files(far.out);

  assert.ok(nearSet.size > 0, 'the always-run whole-repo gates must appear even at HEAD');

  /*
   * ASSERT THE PRECONDITION, DO NOT GUARD ON IT (rule 6). If the last five
   * commits happened to touch nothing outside the always-list, the sets would
   * be equal and this test would prove nothing -- so say that out loud rather
   * than wrapping the real assertion in an `if`.
   */
  /*
   * STRICT. Equality here means --since changed nothing, which is precisely
   * the defect this file exists to gate, and the previous `>=` accepted it.
   */
  assert.ok(farSet.size > nearSet.size,
    'a range spanning a KNOWN source change selected no more tests than HEAD did, '
    + `so --since is not moving the scope at all: HEAD gave ${nearSet.size}, `
    + `${srcTouching.slice(0, 8)}~1 gave ${farSet.size}`);

  for (const t of nearSet) {
    assert.ok(farSet.has(t),
      `${t} is selected for HEAD but dropped for the wider HEAD~5 range`);
  }
});
