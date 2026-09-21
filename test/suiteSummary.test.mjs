/**
 * THE MEASURING INSTRUMENT, MEASURED.
 *
 * `scripts/audit-workspace.mjs` is what CLAUDE.md rule 20 sends every auditor
 * to, and rule 3 tells them to assert the reported COUNT rather than the exit
 * code. So when it printed `fail 0` for a run with a named failing test, the
 * two rules combined to turn a red baseline into a green one.
 *
 * The fixtures below are the real output shapes, not invented ones: the
 * parent-summary-then-failure-detail ordering is what node emits, and the
 * child summary embedded in that detail is what this repository's tests
 * produce, because they spawn the poll supervisor, the CLI and the guard.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSuiteSummary, summaryBlocks } from '../src/suiteSummary.mjs';

/** A complete node --test summary block. */
const block = ({ tests, pass, fail = 0, skipped = 0, cancelled = 0, todo = 0 }) => [
  `\u2139 tests ${tests}`,
  '\u2139 suites 0',
  `\u2139 pass ${pass}`,
  `\u2139 fail ${fail}`,
  `\u2139 cancelled ${cancelled}`,
  `\u2139 skipped ${skipped}`,
  `\u2139 todo ${todo}`,
  '\u2139 duration_ms 4050.244',
].join('\n');

/**
 * THE EXACT SHAPE THAT PRODUCED `fail 0` ON A RED RUN.
 *
 * A child process printed its own green summary; node captured that as the
 * failing test's output and reprinted it in the detail section. Note the
 * ORDER -- the embedded block comes after some text and before the parent's
 * own summary, so a per-label "last match" reads the child for `fail` and the
 * parent for `tests`, which is also why the arithmetic stopped reconciling.
 */
const RED_WITH_EMBEDDED_CHILD = [
  '\u2714 a test that passed (1.2ms)',
  '\u2716 NO COMMAND PRINTS A RUNTIME ASSERTION (100163.8315ms)',
  '  AssertionError [ERR_ASSERTION]: the child said:',
  block({ tests: 7, pass: 7, fail: 0 }),
  '      at TestContext.<anonymous> (file:///C:/x/test/probe.test.mjs:198:12)',
  block({ tests: 2992, pass: 2985, fail: 1, skipped: 6 }),
].join('\n');

test('THE DEFECT: a child summary inside failure detail is not read as the suite result', () => {
  const r = readSuiteSummary(RED_WITH_EMBEDDED_CHILD, 1);
  assert.equal(r.fail, 1, 'the child\'s fail 0 was read as the suite\'s result');
  assert.equal(r.tests, 2992);
  assert.equal(r.pass, 2985);
  assert.equal(r.ok, true, `a well-formed red summary must still be reportable: ${r.why}`);
});

test('THE POSITIVE FIRST: an ordinary green run reports cleanly', () => {
  /*
   * Rule 5. Every refusal below is worthless if the normal path cannot be
   * read, and this is the shape 99 runs in 100 produce.
   */
  const r = readSuiteSummary(`\u2714 fine (1ms)\n${block({ tests: 3016, pass: 3010, skipped: 6 })}`, 0);
  assert.equal(r.ok, true, r.why);
  assert.deepEqual([r.tests, r.pass, r.fail, r.skipped], [3016, 3010, 0, 6]);
});

test('NUMBERS THAT DO NOT ADD UP ARE REFUSED, NOT PRINTED', () => {
  /*
   * The original output was `tests 2992 pass 2985 fail 0 skipped 6`, and
   * 2985 + 6 = 2991. It printed anyway. A number that cannot be checked is
   * worse than no number, because it gets quoted -- and this one was, as a
   * baseline, by an auditor.
   */
  const broken = [
    '\u2139 tests 2992',
    '\u2139 pass 2985',
    '\u2139 fail 0',
    '\u2139 skipped 6',
    '\u2139 duration_ms 1',
  ].join('\n');
  const r = readSuiteSummary(broken, 1);
  assert.equal(r.ok, false, 'a summary whose parts do not reconcile was reported as usable');
  assert.match(r.why, /does not add up/);
  assert.match(r.why, /none of them may be quoted/);
});

test('A NON-ZERO EXIT WITH fail 0 IS A CONTRADICTION AND IS SAID OUT LOUD', () => {
  /*
   * The cross-check that would have caught the original on its own. The exit
   * status is the half that captured child output cannot forge.
   *
   * DIFFERENCED: the identical block with status 0 must be ok, so this cannot
   * pass because something else refused.
   */
  const text = block({ tests: 10, pass: 10, fail: 0 });
  const red = readSuiteSummary(text, 1);
  assert.equal(red.ok, false, 'exit 1 with fail 0 was reported as a usable result');
  assert.match(red.why, /exited 1 while reporting fail 0/);

  assert.equal(readSuiteSummary(text, 0).ok, true,
    'the same block at exit 0 was refused, so the assertion above proves nothing');
});

test('A KILLED OR TRUNCATED RUN IS NOT A GREEN RUN', () => {
  /*
   * The Stop gate kills suites that miss the deadline, and the memory reaper
   * kills background ones. Either leaves output with no summary at all. That
   * must not read as zero failures.
   */
  for (const [label, text, status] of [
    ['no output at all', '', null],
    ['tests ran, killed before the summary', '\u2714 one (1ms)\n\u2714 two (1ms)', null],
    ['a partial block with no fail line', '\u2139 tests 10\n\u2139 pass 10', 1],
  ]) {
    const r = readSuiteSummary(text, status);
    assert.equal(r.ok, false, `${label} was reported as a usable result`);
    assert.equal(r.fail, null, `${label} produced a fail count out of nothing`);
    assert.match(r.why, /NOT a green run|did not finish/, label);
  }
});

test('BLOCKS ARE CONTIGUOUS, so a repeated label splits rather than merges', () => {
  /*
   * The mechanism, tested directly rather than only through its consumer --
   * because if blocks silently merged, every assertion above would still pass
   * on today's fixtures and fail on the next shape node emits.
   */
  const two = `${block({ tests: 1, pass: 1 })}\nsomething else\n${block({ tests: 2, pass: 2 })}`;
  const found = summaryBlocks(two);
  assert.equal(found.length, 2, 'two summaries did not parse as two blocks');
  assert.equal(found[0].tests, 1);
  assert.equal(found[1].tests, 2);

  // back to back, with no intervening line: a repeated label must still split
  const glued = `${block({ tests: 1, pass: 1 })}\n${block({ tests: 2, pass: 2 })}`;
  assert.equal(summaryBlocks(glued).length, 2, 'adjacent summaries merged into one');
});

test('NOTHING IS INVENTED FROM PROSE THAT LOOKS LIKE A SUMMARY', () => {
  /*
   * Rule 13, one layer down: a comment or a failure message quoting these
   * words must not be parsed as a result. The prefix is U+2139 and the shape
   * is exact.
   */
  const prose = 'the run said tests 99 pass 99 fail 0\n# \u2139 tests 99\n\u2139 fail not-a-number';
  assert.deepEqual(summaryBlocks(prose), [], 'prose was parsed as a summary block');
  assert.equal(readSuiteSummary(prose, 0).ok, false);
});
