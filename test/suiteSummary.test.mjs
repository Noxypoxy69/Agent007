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
import { readFileSync } from 'node:fs';
import { readSuiteSummary, locatedBlocks } from '../src/suiteSummary.mjs';

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
 * THE ORDER IS THE WHOLE FIXTURE, and I got it wrong on the first attempt --
 * with the child block placed BEFORE the parent summary, all seven tests here
 * passed against the ORIGINAL broken reader. A fixture that cannot construct
 * the real case cannot fail for it (hollow gate 9), and I had node's own output
 * in front of me at the time.
 *
 * Node prints its summary FIRST and the `failing tests:` detail AFTER it. A
 * child process's own green summary is captured as that failing test's output
 * and reprinted in the detail -- so the child's block is the LAST one in the
 * text, and a per-label "last match" reads the child's `fail 0` as the suite's
 * result while `tests` still comes from the parent. That mismatch is also
 * exactly why the arithmetic stopped reconciling.
 */
const RED_WITH_EMBEDDED_CHILD = [
  '\u2714 a test that passed (1.2ms)',
  '\u2716 NO COMMAND PRINTS A RUNTIME ASSERTION (100163.8315ms)',
  block({ tests: 2992, pass: 2985, fail: 1, skipped: 6 }),
  '',
  '\u2716 failing tests:',
  '',
  'test at test\\probe.test.mjs:198:1',
  '\u2716 NO COMMAND PRINTS A RUNTIME ASSERTION (100163.8315ms)',
  '  AssertionError [ERR_ASSERTION]: the child process reported:',
  block({ tests: 7, pass: 7, fail: 0 }),
  '      at TestContext.<anonymous> (file:///C:/x/test/probe.test.mjs:198:12)',
].join('\n');

test('THE DEFECT: two summaries in one text are REFUSED, not chosen between', () => {
  /*
   * THIS ASSERTION INVERTED, and the reason is the point.
   *
   * It used to demand that the reader pick the parent's block out of two. Three
   * successive rules for picking were each broken -- last line, last block,
   * split-at-first-marker -- and the third was broken by a blind auditor for the
   * same reason as the second. A rule for choosing between two summaries can
   * only be as good as a story about where the second came from, and that story
   * (a child `node --test` reprinted in failure detail) was never verified:
   * `grep -acn spawnSync test/probe.test.mjs` is 0, so the named producer
   * cannot emit a summary at all.
   *
   * So the contract is now: more than one complete summary means some of these
   * numbers are not this run's, and nothing can say which. Refuse. It cannot
   * report a wrong number, only decline to report -- and the failing names and
   * exit status still print.
   */
  const r = readSuiteSummary(RED_WITH_EMBEDDED_CHILD, 1);
  assert.equal(r.ok, false, 'two summaries were reconciled into one confident answer');
  assert.equal(r.fail, null, 'a number was reported from an ambiguous text');
  assert.match(r.why, /2 complete summaries/);
  assert.match(r.why, /Refusing rather than picking one/);
});

test('ORDER DOES NOT MATTER ANY MORE, which is the property that was missing', () => {
  /*
   * Every previous version depended on WHERE the second block sat, and each was
   * defeated by an ordering its author had not pictured. Both arrangements must
   * now refuse identically, so no future reader can break this by discovering
   * that node emits things in a different order than I assumed.
   */
  const child = block({ tests: 7, pass: 7, fail: 0 });
  const parent = block({ tests: 2992, pass: 2985, fail: 1, skipped: 6 });
  for (const [label, text] of [
    ['child last', `${parent}\n✖ failing tests:\n${child}`],
    ['child first', `${child}\nsome output\n${parent}`],
    ['child first, with its own marker', `✖ failing tests:\n${child}\n${parent}`],
  ]) {
    const r = readSuiteSummary(text, 1);
    assert.equal(r.ok, false, `${label}: an ambiguous text produced a confident answer`);
    assert.equal(r.fail, null, `${label}: a number was reported`);
  }
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
  const found = locatedBlocks(two).map((b) => b.fields);
  assert.equal(found.length, 2, 'two summaries did not parse as two blocks');
  assert.equal(found[0].tests, 1);
  assert.equal(found[1].tests, 2);

  // back to back, with no intervening line: a repeated label must still split
  const glued = `${block({ tests: 1, pass: 1 })}\n${block({ tests: 2, pass: 2 })}`;
  assert.equal(locatedBlocks(glued).length, 2, 'adjacent summaries merged into one');
});

test('A NON-ZERO EXIT IS NOT THE ONLY CONTRADICTION: exit 0 with failures is refused too', () => {
  /*
   * A16. The first version checked only the half that had bitten me. A
   * one-directional consistency check agrees with the truth right up until
   * something unusual happens, which is when it is supposed to speak (rule 4).
   *
   * Differenced: the identical block at exit 1 must be ACCEPTED, so this cannot
   * pass because red summaries are refused generally.
   */
  const text = block({ tests: 10, pass: 9, fail: 1 });
  const bad = readSuiteSummary(text, 0);
  assert.equal(bad.ok, false, 'exit 0 with a counted failure was reported as usable');
  assert.match(bad.why, /exited 0 while reporting 1 failing/);

  assert.equal(readSuiteSummary(text, 1).ok, true,
    'the same block at exit 1 was refused, so the assertion above proves nothing');
});

test('THE WIRING: audit-workspace actually consults this module', () => {
  /*
   * A3, and the omission is the embarrassing part: I built exactly this gate
   * for src/watcherIdentity.mjs in this same branch, with a three-screen header
   * arguing that the wiring is a separate claim from the logic (rule 17), and
   * then did not build one here. Revert the call site to the old inline reader
   * and all of the tests above stay green.
   *
   * Read as SOURCE rather than executed, because running the script clones a
   * repository and runs a full suite. test/auditWorkspaceUsesNpmCli.test.mjs
   * already pins a different property of this same file the same way, so the
   * technique was in hand too.
   */
  /*
   * COMMENT-BLANKED BEFORE MATCHING (rule 13, three independent rediscoveries
   * in this repo already). The raw source would let a mention of
   * `readSuiteSummary` in a COMMENT satisfy this gate with the call deleted --
   * and the comment thirty lines above the call site now discusses this module
   * by name, so that is one word away rather than hypothetical. A blind auditor
   * flagged the latency before it bit.
   */
  const raw = readFileSync(new URL('../scripts/audit-workspace.mjs', import.meta.url), 'utf8');
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  // The blanking must not have eaten the file: a gate that greps an empty
  // string passes nothing and fails everything, which is its own hollow shape.
  assert.ok(src.includes('spawnSync'), 'comment-blanking removed live code; the gate is not reading source');

  assert.match(src, /readSuiteSummary/,
    'audit-workspace no longer consults the summary reader, so nothing above constrains what it prints');
  assert.match(src, /COUNTS UNRELIABLE/,
    'the refusal path is not surfaced, so an unreadable summary would print silently or not at all');

  /*
   * AND THE OLD READER MUST BE GONE, not merely unused. A dead copy beside a
   * live one is how the next editor reintroduces it -- which is not
   * hypothetical: grep found the byte-identical reader still live in
   * scripts/audit-auto.mjs, unfixed by any of this.
   */
  assert.doesNotMatch(src, /matchAll\(new RegExp\(`\^\\\\u2139/,
    'the old per-label last-match reader is still present in this file');
});

test('NOTHING IS INVENTED FROM PROSE THAT LOOKS LIKE A SUMMARY', () => {
  /*
   * Rule 13, one layer down: a comment or a failure message quoting these
   * words must not be parsed as a result. The prefix is U+2139 and the shape
   * is exact.
   */
  const prose = 'the run said tests 99 pass 99 fail 0\n# \u2139 tests 99\n\u2139 fail not-a-number';
  assert.deepEqual(locatedBlocks(prose), [], 'prose was parsed as a summary block');
  assert.equal(readSuiteSummary(prose, 0).ok, false);
});
