/**
 * A TAP CHILD'S BLOCK IS NOT THE RUN'S OWN, AND EVERY REFUSAL OF A KILLED RUN SAYS SO. (T-307, B-27; T-303 F1 + F2)
 *
 * F1: DURATION_LINE carries two alternatives, `ℹ` and `#`. The `#` one was untested: mutating the
 * regex to spec-only left every test green (T-303). It matters in exactly one shape -- a TAP child's
 * block, which ends in `# duration_ms`, followed by a capture cut 1-3 bytes into the next parent line.
 * Without `#`, parentProblem takes the cut for the child block's OWN duration line still being
 * written (the T-299 carve-out) and reads the child's numbers as this run's.
 *
 * F2: a killed run (non-integer status) was refused on every path, but only the one-well-placed-block
 * path said it was killed. With 0 blocks, 2+ blocks, or a misplaced one, the reason named something
 * else and the kill -- the one fact that makes every number in the text untrustworthy -- was silent.
 *
 * THE FIXTURES ARE REAL node v24.19.0 OUTPUT, captured by live/T-307/work/capture-tapchild.mjs: a
 * parent `node --test` with stdout piped and no reporter flag (so the SPEC reporter), one of whose
 * tests spawns `node --test --test-reporter=tap <child>` and writes the child's stdout to its own.
 * Node prints that at column zero, before the parent's result lines. The only edit: the scratch path
 * became `C:/x` (the script checks no column-zero line changed). Child counts (5) differ from the
 * parent's (3), so a wrong reading cannot equal the truth by coincidence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSuiteSummary, locatedBlocks } from '../src/suiteSummary.mjs';

const TAP_CHILD_GREEN = {"status":0,"text":"TAP version 13\n# Subtest: tg1\nok 1 - tg1\n  ---\n  duration_ms: 0.5324\n  type: 'test'\n  ...\n# Subtest: tg2\nok 2 - tg2\n  ---\n  duration_ms: 0.089\n  type: 'test'\n  ...\n# Subtest: tg3\nok 3 - tg3\n  ---\n  duration_ms: 0.0676\n  type: 'test'\n  ...\n# Subtest: tg4\nok 4 - tg4\n  ---\n  duration_ms: 0.0615\n  type: 'test'\n  ...\n# Subtest: tg5\nok 5 - tg5\n  ---\n  duration_ms: 0.0711\n  type: 'test'\n  ...\n1..5\n# tests 5\n# suites 0\n# pass 5\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 66.8168\n✔ p_before (0.4956ms)\n✔ p_spawn (110.7212ms)\n✔ p_after (0.6031ms)\nℹ tests 3\nℹ suites 0\nℹ pass 3\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 170.146\n"};
const TAP_CHILD_RED = {"status":0,"text":"TAP version 13\n# Subtest: tr1\nok 1 - tr1\n  ---\n  duration_ms: 0.5223\n  type: 'test'\n  ...\n# Subtest: tr2\nnot ok 2 - tr2\n  ---\n  duration_ms: 0.5878\n  type: 'test'\n  location: 'C:/x\\\\red.child.mjs:3:1'\n  failureType: 'testCodeFailure'\n  error: '1 == 2'\n  code: 'ERR_ASSERTION'\n  name: 'AssertionError'\n  expected: 2\n  actual: 1\n  operator: '=='\n  stack: |-\n    TestContext.<anonymous> (file:///C:/x/red.child.mjs:3:28)\n    Test.runInAsyncScope (node:async_hooks:227:14)\n    Test.run (node:internal/test_runner/test:1382:25)\n    Test.processPendingSubtests (node:internal/test_runner/test:960:18)\n    Test.postRun (node:internal/test_runner/test:1522:19)\n    Test.run (node:internal/test_runner/test:1447:12)\n    async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3)\n  ...\n# Subtest: tr3\nok 3 - tr3\n  ---\n  duration_ms: 0.0754\n  type: 'test'\n  ...\n# Subtest: tr4\nok 4 - tr4\n  ---\n  duration_ms: 0.0602\n  type: 'test'\n  ...\n# Subtest: tr5\nok 5 - tr5\n  ---\n  duration_ms: 0.5206\n  type: 'test'\n  ...\n1..5\n# tests 5\n# suites 0\n# pass 4\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 59.854\n✔ p_before (0.5271ms)\n✔ p_spawn (110.5811ms)\n✔ p_after (0.8339ms)\nℹ tests 3\nℹ suites 0\nℹ pass 3\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 177.1786\n"};

const withEol = (text, eol) => (eol === 'CRLF' ? text.replace(/\n/g, '\r\n') : text);
const complete = (text) => locatedBlocks(text).map((b) => b.fields).filter((b) => b.tests !== undefined && b.fail !== undefined);
/** The text cut `extra` bytes past `anchor` (a column-zero line start), decoded as a capture would be. */
function cutAfter(text, anchor, extra) {
  const at = text.indexOf(anchor);
  assert.ok(at > 0, `precondition: the fixture carries ${JSON.stringify(anchor)}`);
  const bytes = Buffer.from(text, 'utf8');
  return bytes.subarray(0, Buffer.byteLength(text.slice(0, at)) + extra).toString('utf8');
}
const lines = (text) => text.split('\n').map((l) => l.replace(/\r$/, ''));
const lastLine = (text) => lines(text).pop();

test('precondition: the real captures are a TAP child block then the spec parent block', () => {
  assert.deepEqual(complete(TAP_CHILD_GREEN.text).map((b) => [b.tests, b.fail]), [[5, 0], [3, 0]]);
  assert.deepEqual(complete(TAP_CHILD_RED.text).map((b) => [b.tests, b.fail]), [[5, 1], [3, 0]]);
  for (const f of [TAP_CHILD_GREEN, TAP_CHILD_RED]) {
    /* the child block is TAP (`#`) and ends in its own `# duration_ms`, directly before the parent's first result */
    const ls = lines(f.text);
    const firstResult = ls.indexOf(ls.find((l) => l.startsWith('\u2714 p_before')));
    assert.match(ls[firstResult - 1], /^# duration_ms [\d.]+$/, 'precondition: the TAP child ends in # duration_ms');
    assert.equal(ls[firstResult - 8], '# tests 5', 'precondition: the TAP child block is # prefixed');
    assert.match(readSuiteSummary(f.text, f.status).why, /2 complete summaries are present/);
  }
});

/* ═══ F1 ═══ */
const F1_GRID = [];
for (const [name, f, status] of [['green', TAP_CHILD_GREEN, 0], ['red', TAP_CHILD_RED, 1]]) {
  /* red at status 1: a red child's fail 1 agrees with it, so ONLY the position check can refuse (a
   * taskkill /F from outside arrives as status 1 -- measured, T-299). green at its real status 0. */
  for (const eol of ['LF', 'CRLF']) for (const extra of [1, 2, 3]) F1_GRID.push({ name, f, status, eol, extra });
}

test('F1 precondition: the grid is 2 runs x 2 eols x 3 cuts', () => {
  assert.equal(F1_GRID.length, 12);
});

for (const { name, f, status, eol, extra } of F1_GRID) {
  test(`F1: TAP ${name} child, ${eol}, cut ${extra} byte(s) into the first parent line after its # duration_ms is refused`, () => {
    const text = cutAfter(withEol(f.text, eol), '\u2714 p_before', extra);
    assert.equal(lastLine(text), extra < 3 ? '\uFFFD' : '\u2714', 'precondition: the tail is the partial glyph');
    assert.equal(complete(text).length, 1, 'precondition: exactly the TAP child block is complete');
    assert.match(lines(text).at(-2), /^# duration_ms [\d.]+$/, 'precondition: the line before the cut is the TAP # duration_ms');
    const r = readSuiteSummary(text, status);
    assert.equal(r.ok, false, `ok:true WITH THE TAP CHILD'S NUMBERS: tests ${r.tests} fail ${r.fail} (${r.why})`);
    assert.deepEqual([r.tests, r.pass, r.fail, r.skipped], [null, null, null, null]);
    assert.match(r.why, /parent summary is missing or truncated/);
    assert.match(r.why, /ends partway into a line after it/, `F1: wrong reason: ${r.why}`);
  });
}

test('F1 bound: the same TAP child cut 0 bytes past it is the pinned LIMIT (read as the child)', () => {
  /* Rule 5: the fixture reaches both sides of the branch. With nothing after the block, it is
   * byte-identical to a real run of the child (suiteSummaryParent pins that limit). */
  const r = readSuiteSummary(cutAfter(TAP_CHILD_GREEN.text, '\u2714 p_before', 0), 0);
  assert.equal(r.ok, true, `LIMIT moved: ${r.why}`);
  assert.deepEqual([r.tests, r.fail], [5, 0]);
});

/* ═══ F2 ═══ */
const KILL = /killed \(exit status (null|undefined)\)/;

/*
 * Every refusal path of readSuiteSummary before the one-block kill check, reached with a real text.
 * Each row's `reason` is the refusal it gets at an INTEGER status, asserted below so that a row
 * cannot quietly start reaching a different path.
 */
const F2_ROWS = [
  { label: '0 blocks: no output at all', text: '', status: 1, reason: /no complete summary block was printed/ },
  { label: '0 blocks: results, then killed before the summary', text: '\u2714 one (1ms)\n\u2714 two (1ms)\n', status: 1,
    reason: /no complete summary block was printed/ },
  { label: '2 blocks: the whole TAP-child capture', text: TAP_CHILD_GREEN.text, status: 0, reason: /2 complete summaries are present/ },
  { label: '1 misplaced block: cut 2 bytes into the parent line after it', text: cutAfter(TAP_CHILD_RED.text, '\u2714 p_before', 2),
    status: 1, reason: /ends partway into a line after it/ },
  { label: '1 misplaced block: a parent result line printed after it', text: cutAfter(TAP_CHILD_RED.text, '\u2714 p_spawn', 0),
    status: 1, reason: /test result .* is printed after it/ },
];

for (const row of F2_ROWS) {
  test(`F2 differential: ${row.label} -- at an integer status the refusal is the ${row.reason} one and says nothing of a kill`, () => {
    const r = readSuiteSummary(row.text, row.status);
    assert.equal(r.ok, false, `precondition: this text must be refused on its own: ${r.why}`);
    assert.match(r.why, row.reason, `precondition: wrong path reached: ${r.why}`);
    assert.doesNotMatch(r.why, /killed/, `a run with an exit code was called killed: ${r.why}`);
  });
  for (const status of [null, undefined]) {
    test(`F2: ${row.label} -- killed (status ${status}): refused for the same reason AND naming the kill`, () => {
      const r = readSuiteSummary(row.text, status);
      assert.equal(r.ok, false, `ok:true FROM A KILLED RUN: tests ${r.tests} fail ${r.fail} (${r.why})`);
      assert.deepEqual([r.tests, r.pass, r.fail, r.skipped], [null, null, null, null]);
      assert.match(r.why, row.reason, `the original reason was lost: ${r.why}`);
      assert.match(r.why, KILL, `F2: A KILLED RUN'S REFUSAL DOES NOT NAME THE KILL: ${r.why}`);
    });
  }
}
