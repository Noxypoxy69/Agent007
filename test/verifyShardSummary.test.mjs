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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runVerification, readRecord } from '../src/verifyRunner.mjs';
import { VERIFY, aggregateShards } from '../src/verifyCache.mjs';
import { readSuiteSummary } from '../src/suiteSummary.mjs';

/** What node --test prints to a pipe: its TAP reporter, summary block at column zero. */
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
