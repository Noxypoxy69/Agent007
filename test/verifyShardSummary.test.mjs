/**
 * A SHARD THAT PRINTED NO SUMMARY COUNTED NOTHING, AND "NOTHING" IS NOT ZERO. (T-248, P2)
 *
 * THE DEFECT, confirmed by final audit T-245 on the trunk and governing the merged
 * Stop gate (93c50a2). verifyRunner's countFrom answered 0 for a shard whose output
 * held no summary line, and aggregateShards refuses only a TOTAL of 0. So a shard
 * that exited 0 having reported nothing, beside one shard that reported tests,
 * aggregated to VERIFY_PASSED: "every shard that told us anything was green" was
 * written down as "the suite passed". Local master's gate refused that shape itself
 * (tap-summary-invalid); the merge moved the verdict into the runner and lost it.
 *
 * DRIVEN THROUGH runVerification, NOT THE PARSER ALONE (hostile checklist W): the
 * fix lives in src/suiteSummary.mjs, and a parser that is right while its caller
 * substitutes 0 for "unreadable" proves nothing. Every assertion reads the record
 * the runner PERSISTED, which is what the Stop gate consumes (rule 4).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runVerification, readRecord } from '../src/verifyRunner.mjs';
import { VERIFY, aggregateShards } from '../src/verifyCache.mjs';
import { readSuiteSummary } from '../src/suiteSummary.mjs';

/*
 * node's TAP reporter, summary block at column zero. NOT what verifyRunner's shards print: measured
 * on node v24.19.0 (live/T-295/work/measure2-results.json), `node --test` with stdout piped and no
 * reporter flag prints the SPEC reporter (`ℹ tests 5`), and `NODE_TEST_REPORTER=tap` did not change
 * that; only `--test-reporter=tap` produced TAP. These scripted TAP shards exercise the `#` branch;
 * the REAL-spawn tests at the end of this file are the ones that exercise what a shard actually prints.
 */
function tap({ tests, pass, fail = 0, cancelled = 0, skipped = 0, todo = 0 }) {
  const body = Array.from({ length: pass }, (_, i) => `ok ${i + 1} - t${i + 1}\n  ---\n  duration_ms: 1\n  ...\n`).join('');
  return `TAP version 13\n${body}1..${tests}\n# tests ${tests}\n# suites 0\n# pass ${pass}\n# fail ${fail}\n`
    + `# cancelled ${cancelled}\n# skipped ${skipped}\n# todo ${todo}\n# duration_ms 12.5\n`;
}

/** A fake `node --test` child per shard, in shard order: prints `out`, then closes with `code`. */
function scriptedSpawn(shards) {
  let n = 0;
  return () => {
    const { out, code } = shards[n];
    n += 1;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 20_000 + n;
    child.kill = () => true;
    setImmediate(() => {
      if (out) child.stdout.emit('data', out);
      child.emit('close', code);
    });
    return child;
  };
}

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'shard-summary-root-'));
  const home = mkdtempSync(path.join(tmpdir(), 'shard-summary-home-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  mkdirSync(path.join(root, 'test'));
  /* Two test files, so runVerification plans exactly two shards. */
  writeFileSync(path.join(root, 'test', 'a.test.mjs'), '');
  writeFileSync(path.join(root, 'test', 'b.test.mjs'), '');
  return { root, home };
}

async function verify(t, shards) {
  const { root, home } = fixture(t);
  const key = 'p2'.repeat(16);
  const spawnFn = scriptedSpawn(shards);
  await runVerification({ root, key, identity: { t: 'p2' }, shards: 2, concurrency: 1, home, spawnFn });
  const rec = readRecord(key, home);
  assert.ok(rec, 'precondition: the runner persisted a record');
  assert.equal(rec.shards?.length, 2, 'precondition: two shards were planned and reported');
  return rec;
}

test('CONTROL: two shards that each print a complete TAP summary still aggregate to VERIFY_PASSED', async (t) => {
  const rec = await verify(t, [{ out: tap({ tests: 3, pass: 3 }), code: 0 }, { out: tap({ tests: 2, pass: 2 }), code: 0 }]);
  assert.equal(rec.state, VERIFY.PASSED, `a clean two-shard run must still pass, got ${rec.state}: ${rec.why}`);
  assert.equal(rec.tests, 5, 'the counts must be the two summaries added, read from TAP');
});

test('P2: a shard that exits 0 with NO summary, beside a reporting shard, is NOT VERIFY_PASSED', async (t) => {
  const rec = await verify(t, [{ out: tap({ tests: 3, pass: 3 }), code: 0 }, { out: 'TAP version 13\n', code: 0 }]);
  assert.notEqual(rec.state, VERIFY.PASSED,
    'a shard that counted nothing was read as zero tests and the run was recorded as a PASS');
  assert.equal(rec.state, VERIFY.PARTIAL, `an unreadable shard proves nothing either way, got ${rec.state}`);
});

test('P2: a shard whose TAP summary does not add up is NOT VERIFY_PASSED', async (t) => {
  /* tests 5 but pass+fail+cancelled+skipped+todo = 3: the numbers came from more than one run. */
  const rec = await verify(t, [{ out: tap({ tests: 3, pass: 3 }), code: 0 }, { out: tap({ tests: 5, pass: 3 }), code: 0 }]);
  assert.notEqual(rec.state, VERIFY.PASSED, 'an inconsistent summary was accepted as a count');
  assert.equal(rec.state, VERIFY.PARTIAL, `got ${rec.state}`);
});

test('P2: a shard whose output carries a SECOND summary block (a passing test printing one) is NOT VERIFY_PASSED', async (t) => {
  /*
   * readSuiteSummary's "one summary or none" rule, through the TAP branch (observer O-3). A passing test's
   * stdout lands at column zero, so it can print a summary-shaped block; nothing can say which is this run's.
   */
  const injected = `# tests 999\n# suites 0\n# pass 999\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n${tap({ tests: 2, pass: 2 })}`;
  const rec = await verify(t, [{ out: tap({ tests: 3, pass: 3 }), code: 0 }, { out: injected, code: 0 }]);
  assert.notEqual(rec.state, VERIFY.PASSED, 'two summaries in one shard were resolved by picking one');
  assert.equal(rec.state, VERIFY.PARTIAL, `got ${rec.state}`);
});

test('aggregateShards: a shard whose FAIL count is null is PARTIAL even though its tests were counted', () => {
  /*
   * CLAUDE.md rule 11: the runner nulls both counts together today, so checking only `tests` would be a no-op
   * mutation (it survived, M5). This pins the aggregator's own rule where that stops being true: a caller that
   * reports tests but no fail count has not said whether anything failed.
   */
  const r = aggregateShards([
    { index: 1, exitCode: 0, tests: 3, fail: 0 },
    { index: 2, exitCode: 0, tests: 2, fail: null },
  ], { total: 2 });
  assert.notEqual(r.state, VERIFY.PASSED, 'a shard with no fail count was summed as fail 0 and passed');
  assert.equal(r.state, VERIFY.PARTIAL);
});

test('readSuiteSummary reads a node TAP summary block, and still refuses when there is none', () => {
  const ok = readSuiteSummary(tap({ tests: 4, pass: 3, fail: 1 }), 1);
  assert.equal(ok.ok, true, `a well-formed TAP block must be read: ${ok.why}`);
  assert.equal(ok.tests, 4);
  assert.equal(ok.fail, 1);
  const none = readSuiteSummary('TAP version 13\nok 1 - x\n', 0);
  assert.equal(none.ok, false, 'no summary must be a refusal, never zero');
  assert.equal(none.tests, null);
});

/*
 * ═══ REAL SHARDS PRINT THE SPEC REPORTER, SO DRIVE REAL SHARDS (T-307, B-18) ═══
 *
 * Every test above feeds runVerification scripted TAP. The shards it really spawns print the spec
 * reporter (see the comment on `tap`), so deleting the `ℹ` branch of SUMMARY_LINE left this file
 * green 6/6 (T-295) while every real shard would have read as "no summary" and every real run as
 * PARTIAL. These run the runner's OWN spawn (`node --test <shard> test/**\/*.test.mjs`, argv
 * untouched) against real test files in a temp root.
 *
 * THE ONE CHANGE TO THE SPAWN IS THE ENVIRONMENT: NODE_TEST* and NODE_OPTIONS are stripped. Under
 * `node --test` this process carries NODE_TEST_CONTEXT, and a child `node --test` that inherits it
 * does not print its own summary (the trap verifyRunner's header cites at stopGateDeadline.test.mjs).
 * The Stop gate that calls runVerification in production is not a test and does not carry it.
 */
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^NODE_TEST|^NODE_OPTIONS$/i.test(k)));

function realSpawn(seen) {
  return (cmd, args, opts) => {
    const child = spawn(cmd, args, { ...opts, env: cleanEnv });
    const row = { cmd, args, out: '' };
    child.stdout.on('data', (d) => { row.out += d; });
    child.stderr.on('data', (d) => { row.out += d; });
    seen.push(row);
    return child;
  };
}

async function verifyReal(t, files) {
  const root = mkdtempSync(path.join(tmpdir(), 'shard-real-root-'));
  const home = mkdtempSync(path.join(tmpdir(), 'shard-real-home-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  mkdirSync(path.join(root, 'test'));
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(root, 'test', name), body);
  const key = 'rs'.repeat(16);
  const seen = [];
  await runVerification({ root, key, identity: { t: 'real-spec' }, shards: 2, concurrency: 1, home, spawnFn: realSpawn(seen) });
  /* Preconditions (rule 5 and rule 9): two real shards ran, with the runner's own argv, and printed SPEC. */
  assert.equal(seen.length, 2, 'precondition: the runner spawned exactly two shards');
  for (const s of seen) {
    assert.equal(s.cmd, process.execPath, 'precondition: the shard is node itself');
    assert.equal(s.args[0], '--test', `precondition: argv is the runner's own: ${JSON.stringify(s.args)}`);
    assert.ok(!s.args.some((a) => /reporter/.test(a)), `precondition: no reporter flag: ${JSON.stringify(s.args)}`);
    assert.match(s.out, /^ℹ tests [1-9]\d*\r?$/m, `precondition: the shard printed the SPEC reporter's summary:\n${s.out}`);
    assert.doesNotMatch(s.out, /^# tests /m, `precondition: the shard printed no TAP summary:\n${s.out}`);
  }
  const rec = readRecord(key, home);
  assert.ok(rec, 'precondition: the runner persisted a record');
  assert.equal(rec.shards?.length, 2, 'precondition: two shards were planned and reported');
  return rec;
}

const passing = (names) => `import test from 'node:test';\n${names.map((n) => `test('${n}', () => {});`).join('\n')}\n`;

test('B-18: two REAL spec-reporter shards, all green, aggregate to VERIFY_PASSED with the real counts', async (t) => {
  const rec = await verifyReal(t, { 'a.test.mjs': passing(['a1', 'a2']), 'b.test.mjs': passing(['b1', 'b2', 'b3']) });
  assert.equal(rec.state, VERIFY.PASSED, `real green shards were not read as a pass: ${rec.state}: ${rec.why}`);
  assert.equal(rec.tests, 5, 'the two real spec summaries, added');
  assert.equal(rec.fail, 0);
  assert.deepEqual(rec.shards.map((s) => [s.exitCode, s.tests, s.fail]).sort(), [[0, 2, 0], [0, 3, 0]]);
});

test('B-18: a REAL spec-reporter shard with one failing test aggregates to VERIFY_FAILED, fail 1', async (t) => {
  const red = "import test from 'node:test';\nimport assert from 'node:assert';\n"
    + "test('b1', () => {});\ntest('b2', () => { assert.equal(1, 2); });\ntest('b3', () => {});\n";
  const rec = await verifyReal(t, { 'a.test.mjs': passing(['a1', 'a2']), 'b.test.mjs': red });
  assert.equal(rec.state, VERIFY.FAILED, `a real red shard was not read as a failure: ${rec.state}: ${rec.why}`);
  assert.equal(rec.tests, 5, 'the two real spec summaries, added');
  assert.equal(rec.fail, 1, 'the failing count comes from the red shard\'s spec summary');
  assert.deepEqual(rec.shards.map((s) => [s.exitCode, s.tests, s.fail]).sort(), [[0, 2, 0], [1, 3, 1]]);
});
