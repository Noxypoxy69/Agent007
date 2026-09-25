/**
 * A KILLED RUN, AND A CUT BEFORE A LINE'S SPACE, ARE REFUSED. (T-299, B-21; T-290 F2 + F3)
 *
 * F2: readSuiteSummary(text, null) with fail > 0 was ok:true. null is not 0, so
 * both exit cross-checks let it through, and a run killed after a test printed a
 * red child's output was read as the child's `tests 3, fail 1`.
 *
 * F3: a capture cut 1-3 bytes into the first parent line after a child block --
 * a split glyph (one U+FFFD) or a glyph with no space -- matched neither
 * RESULT_LINE nor anything else, so the child's block was read as this run's.
 *
 * THE FIXTURES ARE REAL node v24.19.0 OUTPUT, captured byte for byte by
 * live/T-299/work/realf3.mjs (two parent runs spawning a child run) and
 * live/T-299/work/killprobe.mjs + dumpfx.mjs (a parent killed by spawnSync's
 * maxBuffer, signal SIGTERM, status null). The only edit: the operator's home
 * path in INDENTED stack-frame lines became `C:/x/` (emitfx.mjs checks no
 * column-zero line changed). Child counts (5 or 3) differ from the parents'
 * (3), so a wrong reading can never equal the truth by coincidence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSuiteSummary, summaryBlocks } from '../src/suiteSummary.mjs';

const GREEN_PARENT = {"status":0,"text":"✔ cg1 (0.4859ms)\n✔ cg2 (0.0829ms)\n✔ cg3 (0.0739ms)\n✔ cg4 (0.0511ms)\n✔ cg5 (0.0695ms)\nℹ tests 5\nℹ suites 0\nℹ pass 5\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 62.5278\n✔ p_before (0.446ms)\n✔ p_spawn (112.5382ms)\n✔ p_after (1.0935ms)\nℹ tests 3\nℹ suites 0\nℹ pass 3\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 174.8654\n"};
const RED_PARENT = {"status":1,"text":"✔ cr1 (0.5009ms)\n✖ cr2 (0.5736ms)\n✔ cr3 (0.0742ms)\n✔ cr4 (0.0634ms)\n✔ cr5 (0.5269ms)\nℹ tests 5\nℹ suites 0\nℹ pass 4\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 86.0094\n\n✖ failing tests:\n\ntest at red.child.mjs:2:24\n✖ cr2 (0.5736ms)\n  AssertionError [ERR_ASSERTION]: 1 == 2\n      at TestContext.<anonymous> (file:///C:/x/red.child.mjs:2:51)\n      at Test.runInAsyncScope (node:async_hooks:227:14)\n      at Test.run (node:internal/test_runner/test:1382:25)\n      at Test.processPendingSubtests (node:internal/test_runner/test:960:18)\n      at Test.postRun (node:internal/test_runner/test:1522:19)\n      at Test.run (node:internal/test_runner/test:1447:12)\n      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {\n    generatedMessage: true,\n    code: 'ERR_ASSERTION',\n    actual: 1,\n    expected: 2,\n    operator: '==',\n    diff: 'simple'\n  }\n✔ p_before (0.4624ms)\n✖ p_spawn (132.1893ms)\n✔ p_after (0.638ms)\nℹ tests 3\nℹ suites 0\nℹ pass 2\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 192.5227\n\n✖ failing tests:\n\ntest at pred.test.mjs:6:1\n✖ p_spawn (132.1893ms)\n  AssertionError [ERR_ASSERTION]: parent fails\n      at TestContext.<anonymous> (file:///C:/x/pred.test.mjs:9:10)\n      at Test.runInAsyncScope (node:async_hooks:227:14)\n      at Test.run (node:internal/test_runner/test:1382:25)\n      at Test.processPendingSubtests (node:internal/test_runner/test:960:18)\n      at Test.postRun (node:internal/test_runner/test:1522:19)\n      at Test.run (node:internal/test_runner/test:1447:12)\n      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {\n    generatedMessage: false,\n    code: 'ERR_ASSERTION',\n    actual: undefined,\n    expected: undefined,\n    operator: 'fail',\n    diff: 'simple'\n  }\n"};
const KILLED = {"status":null,"signal":"SIGTERM","text":"✔ cr1 (0.499ms)\n✖ cr2 (0.5735ms)\n✔ cr3 (0.0906ms)\nℹ tests 3\nℹ suites 0\nℹ pass 2\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 61.483\n\n✖ failing tests:\n\ntest at child_red.child.mjs:2:24\n✖ cr2 (0.5735ms)\n  AssertionError [ERR_ASSERTION]: 1 == 2\n      at TestContext.<anonymous> (file:///C:/x/child_red.child.mjs:2:51)\n      at Test.runInAsyncScope (node:async_hooks:227:14)\n      at Test.run (node:internal/test_runner/test:1382:25)\n      at Test.processPendingSubtests (node:internal/test_runner/test:960:18)\n      at Test.postRun (node:internal/test_runner/test:1522:19)\n      at Test.run (node:internal/test_runner/test:1447:12)\n      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {\n    generatedMessage: true,\n    code: 'ERR_ASSERTION',\n    actual: 1,\n    expected: 2,\n    operator: '==',\n    diff: 'simple'\n  }\n"};

const withEol = (text, eol) => (eol === 'CRLF' ? text.replace(/\n/g, '\r\n') : text);
const complete = (text) => summaryBlocks(text).filter((b) => b.tests !== undefined && b.fail !== undefined);
/** The text cut `extra` bytes past `anchor` (a column-zero line start), decoded as a capture would be. */
function cutAfter(text, anchor, extra) {
  const at = text.indexOf(anchor);
  assert.ok(at > 0, `precondition: the fixture carries ${JSON.stringify(anchor)}`);
  const bytes = Buffer.from(text, 'utf8');
  return bytes.subarray(0, Buffer.byteLength(text.slice(0, at)) + extra).toString('utf8');
}
const lastLine = (text) => text.split('\n').pop().replace(/\r$/, '');

test('precondition: the real captures are the shapes this file claims', () => {
  assert.deepEqual(complete(GREEN_PARENT.text).map((b) => [b.tests, b.fail]), [[5, 0], [3, 0]]);
  assert.deepEqual(complete(RED_PARENT.text).map((b) => [b.tests, b.fail]), [[5, 1], [3, 1]]);
  assert.deepEqual(complete(KILLED.text).map((b) => [b.tests, b.fail]), [[3, 1]]);
  assert.equal(KILLED.status, null, 'the kill fixture must carry the null status node reported');
  assert.equal(KILLED.signal, 'SIGTERM');
  /* the full parent runs hold two complete summaries and are refused as two (existing rule) */
  for (const f of [GREEN_PARENT, RED_PARENT]) {
    assert.match(readSuiteSummary(f.text, f.status).why, /2 complete summaries are present/);
  }
});

/* ═══ F3 ═══ */
const F3_GRID = [];
for (const [name, f] of [['green', GREEN_PARENT], ['red', RED_PARENT]]) {
  for (const eol of ['LF', 'CRLF']) for (const extra of [1, 2, 3]) F3_GRID.push({ name, f, eol, extra });
}

test('F3 precondition: the grid is 2 runs x 2 eols x 3 cuts', () => {
  assert.equal(F3_GRID.length, 12);
});

for (const { name, f, eol, extra } of F3_GRID) {
  test(`F3: ${name} parent, ${eol}, cut ${extra} byte(s) into the first parent line after the child is refused`, () => {
    const text = cutAfter(withEol(f.text, eol), '\u2714 p_before', extra);
    /* the cut must land where F3 lives: a split glyph, or the glyph with no space */
    assert.equal(lastLine(text), extra < 3 ? '\uFFFD' : '\u2714', 'precondition: the tail is the partial glyph');
    assert.equal(complete(text).length, 1, 'precondition: exactly the child block is complete');
    const r = readSuiteSummary(text, f.status);
    assert.equal(r.ok, false, `ok:true WITH THE CHILD'S NUMBERS: tests ${r.tests} fail ${r.fail} (${r.why})`);
    assert.deepEqual([r.tests, r.pass, r.fail, r.skipped], [null, null, null, null]);
    assert.match(r.why, /parent summary is missing or truncated/);
    assert.match(r.why, /ends partway into a line after it/, `F3: wrong reason: ${r.why}`);
  });
}

test('F3 bounds: cut 0 bytes past the child is the pinned LIMIT (read); cut 4 bytes is the result-line rule', () => {
  /* Rule 5 and rule 11: the fixture reaches the branch on both sides of the new one. */
  const at0 = cutAfter(GREEN_PARENT.text, '\u2714 p_before', 0);
  const r0 = readSuiteSummary(at0, 0);
  assert.equal(r0.ok, true, `LIMIT moved: ${r0.why}`);
  assert.equal(r0.tests, 5, 'the LIMIT reads the child, byte-identical to a real run of it');
  const r4 = readSuiteSummary(cutAfter(GREEN_PARENT.text, '\u2714 p_before', 4), 0);
  assert.equal(r4.ok, false);
  assert.match(r4.why, /a test result \("\u2714 "/);
});

test('F3 carve-out: a real run cut 1-3 bytes into its OWN duration_ms line is still read', () => {
  /*
   * The child's output is a real complete run of green.child.mjs (the LIMIT says
   * so, byte for byte). Cut into its own `ℹ duration_ms` line, the block is still
   * the last thing in the text -- that is not "something after", and refusing it
   * would turn right readings into refusals.
   */
  const alone = GREEN_PARENT.text.slice(0, GREEN_PARENT.text.indexOf('\u2714 p_before'));
  for (const eol of ['LF', 'CRLF']) {
    for (const extra of [1, 2, 3]) {
      const text = cutAfter(withEol(alone, eol), '\u2139 duration_ms', extra);
      assert.equal(lastLine(text), extra < 3 ? '\uFFFD' : '\u2139', 'precondition: the tail is the partial glyph');
      const r = readSuiteSummary(text, 0);
      assert.equal(r.ok, true, `${eol} +${extra}: REFUSED A RUN CUT IN ITS OWN LAST LINE: ${r.why}`);
      assert.deepEqual([r.tests, r.pass, r.fail], [5, 5, 0]);
    }
  }
});

test('F3 COST (pinned, not a defence): a red run cut 1-3 bytes into its OWN failing-tests marker is refused', () => {
  /*
   * The KILLED capture's text is a whole real red run of child_red.child.mjs.
   * Cut into its own marker, the tail is the same partial glyph a parent result
   * line leaves, and the text cannot say which. Refused on purpose (the sweep
   * measured 12 such right readings lost against 54 wrong ones a carve-out let
   * back in). Pinned so the day this changes, it goes red and the cost is
   * re-stated.
   */
  for (const extra of [1, 2, 3]) {
    const text = cutAfter(KILLED.text, '✖ failing tests:', extra);
    assert.equal(lastLine(text), extra < 3 ? '\uFFFD' : '\u2716', 'precondition: the tail is the partial glyph');
    assert.equal(readSuiteSummary(text, 1).ok, false, `+${extra}: the pinned cost moved`);
  }
  assert.equal(readSuiteSummary(cutAfter(KILLED.text, '✖ failing tests:', 0), 1).ok, true,
    'precondition: the same run cut just before the marker is read');
});

/* ═══ F2 ═══ */

test('F2: a real killed run (status null) whose only block is a red child is refused, naming the kill', () => {
  const r = readSuiteSummary(KILLED.text, KILLED.status);
  assert.equal(r.ok, false, `ok:true FROM A KILLED RUN: tests ${r.tests} fail ${r.fail} (${r.why})`);
  assert.deepEqual([r.tests, r.pass, r.fail, r.skipped], [null, null, null, null]);
  assert.match(r.why, /killed \(exit status null\)/, `F2: the refusal does not name the kill: ${r.why}`);
});

test('F2 differential: the SAME text with an integer status is still read, so the status is what refuses', () => {
  const r = readSuiteSummary(KILLED.text, 1);
  assert.equal(r.ok, true, `the differential arm refused for another reason: ${r.why}`);
  assert.deepEqual([r.tests, r.fail], [3, 1]);
});

test('F2: a killed run is refused even when its block is complete and green, and any non-integer status too', () => {
  const alone = GREEN_PARENT.text.slice(0, GREEN_PARENT.text.indexOf('\u2714 p_before'));
  assert.equal(readSuiteSummary(alone, 0).ok, true, 'precondition: the same text at exit 0 is read');
  for (const status of [null, undefined]) {
    const r = readSuiteSummary(alone, status);
    assert.equal(r.ok, false, `status ${status}: a run with no exit code was read`);
    assert.match(r.why, /killed \(exit status (null|undefined)\)/);
  }
});
