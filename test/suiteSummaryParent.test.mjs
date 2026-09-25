/**
 * A MISSING OR TRUNCATED PARENT SUMMARY IS REFUSED, WHATEVER CHILD BLOCKS FOLLOW. (T-288, B-06)
 *
 * T-276 F1: with the parent's own summary truncated or absent, exactly one child
 * block left in the text was reported as ok:true with the CHILD's numbers (tests 7,
 * fail 1 for a 2992-test run). v3 refused that shape; v4 (9214163) lost it.
 *
 * THE FIXTURES ARE NODE'S REAL ORDER, MEASURED on node v24.19.0 with a real
 * parent/child pair (live/T-288/work/realorder.mjs, realorder2.mjs), because an
 * earlier fixture used an order node never prints (T-277; rule 9):
 *
 *   - a test file's stdout is printed at column zero BEFORE that file's result
 *     lines, so a child's block (and, for a red child, its own marker and detail)
 *     precedes the result line of the test that printed it;
 *   - the parent's summary follows every result line, then `✖ failing tests:`,
 *     then detail whose column-zero lines are `test at <loc>` + one `✖` line.
 *
 * The grid is generated, not listed: {parent complete / truncated / absent} x
 * {0, 1, 2 child blocks} x {child red / green} x {CRLF / LF} x {parent red / green}.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSuiteSummary } from '../src/suiteSummary.mjs';

const I = '\u2139';
const block = ({ tests, pass, fail = 0, skipped = 0 }) => [
  `${I} tests ${tests}`, `${I} suites 0`, `${I} pass ${pass}`, `${I} fail ${fail}`,
  `${I} cancelled 0`, `${I} skipped ${skipped}`, `${I} todo 0`, `${I} duration_ms 50.0981`,
];
const failingDetail = (loc, name, msg) => [
  '', '\u2716 failing tests:', '', `test at ${loc}`, `\u2716 ${name}`, `  ${msg}`,
  `      at TestContext.<anonymous> (file:///C:/x/${loc.replace(/:.*$/, '')}:3:33)`,
];

/** A child `node --test` run's whole output, as a test prints it to stdout (column zero). */
function childOutput(n, red) {
  const tests = n === 1 ? 7 : 5;
  const lines = [`\u2714 child${n} ok (0.4186ms)`];
  if (red) lines.push(`\u2716 child${n} bad (0.1258ms)`);
  lines.push(...block({ tests, pass: red ? tests - 1 : tests, fail: red ? 1 : 0 }));
  if (red) lines.push(...failingDetail(`child${n}.test.mjs:3:1`, `child${n} bad (0.1258ms)`, `Error: child${n} boom`));
  return lines;
}

const PARENT_RED = { tests: 2992, pass: 2985, fail: 1, skipped: 6 };
const PARENT_GREEN = { tests: 2992, pass: 2986, fail: 0, skipped: 6 };

/** The parent run, in node's order: earlier results, the spawning file's stdout, its results, then the summary. */
function parentRun({ parent, children, childRed, runRed }) {
  const lines = ['\u2714 an earlier file passes (1.2ms)'];
  for (let n = 1; n <= children; n += 1) lines.push(...childOutput(n, childRed));
  lines.push('\u2714 spawns a child test run (88.1391ms)');
  if (runRed) lines.push('\u2716 NO COMMAND PRINTS A RUNTIME ASSERTION (100163.8315ms)');
  const own = block(runRed ? PARENT_RED : PARENT_GREEN);
  if (parent === 'complete') {
    lines.push(...own);
    if (runRed) lines.push(...failingDetail('test\\probe.test.mjs:198:1', 'NO COMMAND PRINTS A RUNTIME ASSERTION (100163.8315ms)', 'AssertionError [ERR_ASSERTION]: boom'));
  } else if (parent === 'truncated') {
    lines.push(...own.slice(0, 3)); // tests, suites, pass -- cut before `fail`
  }
  return lines;
}

const GRID = [];
for (const parent of ['complete', 'truncated', 'absent']) {
  for (const children of [0, 1, 2]) {
    for (const childRed of [true, false]) {
      for (const eol of ['LF', 'CRLF']) {
        for (const runRed of [true, false]) GRID.push({ parent, children, childRed, eol, runRed });
      }
    }
  }
}

test('precondition: the grid has every combination, 3 x 3 x 2 x 2 x 2', () => {
  assert.equal(GRID.length, 72);
  assert.equal(new Set(GRID.map((c) => JSON.stringify(c))).size, 72);
});

for (const c of GRID) {
  const name = `grid: parent=${c.parent} children=${c.children} child=${c.childRed ? 'red' : 'green'} eol=${c.eol} run=${c.runRed ? 'red' : 'green'}`;
  test(name, () => {
    const lines = parentRun(c);
    const text = lines.join(c.eol === 'CRLF' ? '\r\n' : '\n');
    if (c.eol === 'CRLF') assert.ok(text.includes('\r\n'), 'precondition: the CRLF fixture carries CRLF');
    else assert.ok(!text.includes('\r'), 'precondition: the LF fixture carries no CR');
    const status = c.runRed ? 1 : 0;
    const r = readSuiteSummary(text, status);
    const own = c.runRed ? PARENT_RED : PARENT_GREEN;

    if (c.parent === 'complete' && c.children === 0) {
      /* The positive first (rule 5): the parent's own block, alone, is read. */
      assert.equal(r.ok, true, `REFUSED A HEALTHY RUN: ${r.why}`);
      assert.deepEqual([r.tests, r.pass, r.fail, r.skipped], [own.tests, own.pass, own.fail, own.skipped],
        'the healthy run was read with numbers that are not its own');
      return;
    }
    assert.equal(r.ok, false, `ok:true WITH ANOTHER RUN'S NUMBERS: tests ${r.tests} fail ${r.fail} (${r.why})`);
    assert.deepEqual([r.tests, r.pass, r.fail, r.skipped], [null, null, null, null], 'a refusal still quoted numbers');
    if (c.parent === 'complete') {
      assert.match(r.why, /complete summaries are present/, 'two summaries were not refused as two');
    } else {
      assert.match(r.why, /parent summary is missing or truncated/, `THE REFUSAL DOES NOT NAME THE MISSING PARENT: ${r.why}`);
    }
  });
}

test('T-276 probe shape: a red child block after the marker, no parent summary, is refused', () => {
  /*
   * Not node's order (detail is indented, so this block would not parse in a real
   * run), but it is the exact text T-276 F1 was measured with, and it must stay
   * refused. Nothing follows the block, so only the look-back (B) can refuse it.
   */
  const text = ['\u2716 failing tests:', '', 'test at test/x.test.mjs:1:1', '\u2716 parent test (5ms)',
    ...block({ tests: 7, pass: 6, fail: 1 })].join('\n');
  const r = readSuiteSummary(text, 1);
  assert.equal(r.ok, false, `B MISSED: ok:true with tests ${r.tests} fail ${r.fail}`);
  assert.equal(r.tests, null);
  assert.match(r.why, /parent summary is missing or truncated/, `B: the refusal does not name the parent: ${r.why}`);
  assert.match(r.why, /inside failing-test detail/, `B: wrong reason: ${r.why}`);
});

test('T-276 probe shape: a block directly after the marker is refused', () => {
  const text = ['\u2716 failing tests:', ...block({ tests: 7, pass: 7, fail: 0 })].join('\n');
  const r = readSuiteSummary(text, 1);
  assert.equal(r.ok, false);
  assert.match(r.why, /parent summary is missing or truncated/, `B2: the refusal does not name the parent: ${r.why}`);
});

test('A alone: a child block followed directly by a truncated parent block is refused', () => {
  /*
   * In node's order a result line always sits between the two (C also fires), so
   * this is where A is not redundant (rule 11): nothing but the partial block follows.
   */
  const text = [...childOutput(1, false), ...block(PARENT_RED).slice(0, 3)].join('\n');
  // childOutput(1, false) ends with the block itself, so the partial block is what follows it.
  const r = readSuiteSummary(text, 0);
  assert.equal(r.ok, false, `A MISSED: ok:true with tests ${r.tests} fail ${r.fail}`);
  assert.match(r.why, /incomplete summary follows it/, `A: wrong reason: ${r.why}`);
});

test('C alone: a result line after the only block, nothing else, is refused', () => {
  const text = [...childOutput(1, true), '\u2716 NO COMMAND PRINTS A RUNTIME ASSERTION (100163.8315ms)'].join('\n');
  const r = readSuiteSummary(text, 1);
  assert.equal(r.ok, false, `C MISSED: ok:true with tests ${r.tests} fail ${r.fail}`);
  assert.match(r.why, /test result .* is printed after it/, `C: wrong reason: ${r.why}`);
});

test('a real rich red run (describe, nested, subtests, diagnostic, stderr noise) is still read', () => {
  /*
   * Measured output of live/T-288/work/realorder2.mjs, node v24.19.0, exit 1, with
   * two result lines left out (the skipped and todo markers) -- the summary is as
   * printed. Stack frames trimmed to one per failure. The look-back and look-forward
   * must not refuse node's own healthy shape.
   */
  const text = [
    'stderr noise at column zero', 'stdout noise', '\u25B6 suite A', '  \u2714 passes (0.4007ms)',
    '  \u2716 fails nested (0.1452ms)', '  \u25B6 inner', '    \u2716 inner fails (0.6583ms)', '  \u2716 inner (1.0278ms)',
    '\u2716 suite A (2.4726ms)', '\u25B6 with subtests', '  \u2714 sub ok (0.0984ms)', '  \u2716 sub bad (0.0841ms)',
    '\u2716 with subtests (0.4646ms)', '\u2714 diagnostic (0.4466ms)', `${I} a diagnostic line`, '\u2714 b passes (0.4939ms)',
    '\u2716 b fails (0.1283ms)',
    `${I} tests 12`, `${I} suites 2`, `${I} pass 4`, `${I} fail 5`, `${I} cancelled 0`, `${I} skipped 1`, `${I} todo 2`,
    `${I} duration_ms 67.7296`, '', '\u2716 failing tests:', '',
    'test at test\\a.test.mjs:4:3', '\u2716 fails nested (0.1452ms)', '  Error: nested boom', '  second line',
    '      at TestContext.<anonymous> (file:///C:/x/test/a.test.mjs:4:36)', '',
    'test at test\\a.test.mjs:5:29', '\u2716 inner fails (0.6583ms)', '  Error: inner',
    '      at TestContext.<anonymous> (file:///C:/x/test/a.test.mjs:5:61)', '',
    'test at test\\a.test.mjs:7:80', '\u2716 sub bad (0.0841ms)', '  Error: sub',
    '      at TestContext.<anonymous> (file:///C:/x/test/a.test.mjs:7:110)', '',
    'test at test\\b.test.mjs:3:1', '\u2716 b fails (0.1283ms)', '  Error: b',
    '      at TestContext.<anonymous> (file:///C:/x/test/b.test.mjs:3:31)', '',
  ].join('\n');
  const r = readSuiteSummary(text, 1);
  assert.equal(r.ok, true, `REFUSED NODE'S OWN HEALTHY SHAPE: ${r.why}`);
  assert.deepEqual([r.tests, r.pass, r.fail, r.skipped], [12, 4, 5, 1]);
});

test('LIMIT (pinned, not a defence): a child output with nothing after it is indistinguishable from a real run', () => {
  /*
   * A red child's output that is the LAST thing in the text, with no parent line
   * after it, is byte-identical to a real run of that child, so it is accepted.
   * Pinned so the day this changes, this goes red and the bound is re-stated.
   */
  const r = readSuiteSummary(childOutput(1, true).join('\n'), 1);
  assert.equal(r.ok, true, r.why);
  assert.equal(r.tests, 7);
});
