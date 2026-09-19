/**
 * SINGLE-FLIGHT VERIFICATION. THE GATE STOPS BEING A TEST RUNNER.
 *
 * MEASURED OVER ONE NIGHT: the Stop gate spawns `npm test` at every turn end,
 * a session that also runs the suite makes that two copies on one machine, and
 * the pair takes ~400-430s against a 420s budget. The gate killed its own suite
 * and reported NOTHING WAS VERIFIED five times -- every time because a second
 * copy of the same work was running beside it. A solo run is ~185s.
 *
 * The dangerous half of the fix is the CACHE, so most of this file is about
 * refusing to reuse a result. A cache that returns a PASS for a tree nobody
 * tested is not a speed-up, it is a forged verification, and every other
 * control in this repository sits behind the suite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  verifyKey, decideVerify, admitVerification, shardPlan, aggregateShards,
  VERIFY, ACTION, DEAD_AFTER_MS,
} from '../src/verifyCache.mjs';

const IDENT = Object.freeze({
  tree_digest: 'a'.repeat(64),
  command: 'node --test test/**/*.test.mjs',
  toolchain: 'node-v24.0.0-win32-x64',
  env_digest: 'b'.repeat(16),
});

const KEY = verifyKey(IDENT).key;
const NOW = 1_000_000;

const record = (over = {}) => ({
  key: KEY,
  state: VERIFY.PASSED,
  started_at: NOW - 60_000,
  heartbeat_at: NOW - 1_000,
  pid: 4242,
  ...over,
});

/* ── the key is the whole safety argument ─────────────────────────────── */

test('EVERY FIELD IS REQUIRED: a partial identity would match a tree nobody tested', () => {
  for (const missing of Object.keys(IDENT)) {
    const r = verifyKey({ ...IDENT, [missing]: undefined });
    assert.equal(r.ok, false, `${missing} was optional`);
    assert.match(r.errors.join(' '), new RegExp(missing));
  }
  assert.equal(verifyKey().ok, false);
});

test('EACH FIELD CHANGES THE KEY, ALONE -- generated, not spot-checked', () => {
  /*
   * Rule 7, and each moves alone because a loop that only ever changes one
   * field cannot show the others are read. A field that did NOT change the key
   * would be a field that can differ between the cached run and this one.
   */
  for (const field of Object.keys(IDENT)) {
    assert.notEqual(
      verifyKey({ ...IDENT, [field]: 'something-else' }).key, KEY,
      `${field} does not participate in the identity, so a result would be reused across it`,
    );
  }
});

test('THE KEY IS FRAMED, so two field sets cannot concatenate into one identity', () => {
  /*
   * Without length framing, a tree digest ending in a command's prefix produces
   * the same joined string as a shorter digest with a longer command -- and a
   * colliding key returns a PASS for the wrong tree. Same reason the digests
   * elsewhere in this repository carry NULs.
   */
  const a = verifyKey({ ...IDENT, tree_digest: 'xy', command: 'z' }).key;
  const b = verifyKey({ ...IDENT, tree_digest: 'x', command: 'yz' }).key;
  assert.notEqual(a, b);
});

test('THE SAME IDENTITY IS THE SAME KEY, or nothing is ever reused', () => {
  assert.equal(verifyKey(IDENT).key, verifyKey({ ...IDENT }).key);
});

/* ── what a caller does about an existing record ──────────────────────── */

test('NO RECORD MEANS RUN IT', () => {
  assert.equal(decideVerify(null, { now: NOW, key: KEY }).action, ACTION.START);
  assert.equal(decideVerify(undefined, { now: NOW, key: KEY }).action, ACTION.START);
  assert.equal(decideVerify('nonsense', { now: NOW, key: KEY }).action, ACTION.START);
});

test('A RECORD FOR ANOTHER IDENTITY IS NOT A RESULT ABOUT THIS ONE', () => {
  /*
   * Re-checked here rather than trusted from the lookup. A caller that fetched
   * the wrong file, or a store that collided, must not be able to hand this a
   * foreign PASS.
   */
  const d = decideVerify(record({ key: 'c'.repeat(32) }), { now: NOW, key: KEY });
  assert.equal(d.action, ACTION.START);
  assert.match(d.why, /different identity/);
});

test('A COMPLETED RESULT IS REUSED -- including a FAILED one', () => {
  assert.equal(decideVerify(record({ state: VERIFY.PASSED }), { now: NOW, key: KEY }).action, ACTION.REUSE);
  /*
   * The half people forget. Re-running a suite to re-learn that it is red is
   * the same waste, and it is what happens on every turn while somebody fixes
   * something.
   */
  assert.equal(decideVerify(record({ state: VERIFY.FAILED }), { now: NOW, key: KEY }).action, ACTION.REUSE);
});

test('A TIMEOUT OR A PARTIAL RUN IS NOT A RESULT', () => {
  for (const state of [VERIFY.TIMED_OUT, VERIFY.PARTIAL]) {
    const d = decideVerify(record({ state }), { now: NOW, key: KEY });
    assert.equal(d.action, ACTION.START, `${state} was treated as an answer`);
  }
});

test('A LIVE RUN IS ATTACHED TO, NEVER DUPLICATED -- this is the whole fix', () => {
  const d = decideVerify(record({ state: VERIFY.RUNNING, heartbeat_at: NOW - 5_000 }), { now: NOW, key: KEY });
  assert.equal(d.action, ACTION.ATTACH);
  assert.match(d.why, /rather than starting a second copy/);
});

test('A DEAD RUN IS NOT A LIVE ONE: UNKNOWN IS NOT DEAD, BUT SILENCE IS', () => {
  /*
   * This repository spent a night unable to tell a dead watcher from a working
   * one, because absence of news read as health. A RUNNING record must keep
   * saying so; two missed beats is dead.
   */
  const stale = record({ state: VERIFY.RUNNING, heartbeat_at: NOW - (DEAD_AFTER_MS + 1) });
  const d = decideVerify(stale, { now: NOW, key: KEY });
  assert.equal(d.action, ACTION.START);
  assert.match(d.why, /dead rather than slow/);

  // And one that never beat at all is not merely slow either.
  const never = decideVerify(record({ state: VERIFY.RUNNING, heartbeat_at: null }), { now: NOW, key: KEY });
  assert.equal(never.action, ACTION.START);
  assert.match(never.why, /never beaten/);
});

test('THE BOUNDARY IS CHECKED ON BOTH SIDES, not only past it', () => {
  const at = record({ state: VERIFY.RUNNING, heartbeat_at: NOW - DEAD_AFTER_MS });
  assert.equal(decideVerify(at, { now: NOW, key: KEY }).action, ACTION.ATTACH, 'exactly at the limit is still alive');
  const past = record({ state: VERIFY.RUNNING, heartbeat_at: NOW - DEAD_AFTER_MS - 1 });
  assert.equal(decideVerify(past, { now: NOW, key: KEY }).action, ACTION.START);
});

test('AN UNRECOGNISED STATE RUNS IT, because every unclear case costs minutes not correctness', () => {
  assert.equal(decideVerify(record({ state: 'WOBBLY' }), { now: NOW, key: KEY }).action, ACTION.START);
  assert.equal(decideVerify(record({ state: null }), { now: NOW, key: KEY }).action, ACTION.START);
});

/* ── approval is a different question from "must I run one" ───────────── */

test('ATTACH IS NOT APPROVAL: a run in flight is not a result', () => {
  /*
   * The defect this separation exists to prevent. If admitVerification reused
   * decideVerify's answer, a turn would pass because somebody ELSE was still
   * running the suite -- approval by other people's work in progress.
   */
  const v = admitVerification(record({ state: VERIFY.RUNNING, heartbeat_at: NOW - 1_000 }), { now: NOW, key: KEY });
  assert.equal(v.ok, false);
  assert.equal(v.state, VERIFY.RUNNING);
  assert.match(v.why, /not a result/);
});

test('ONLY A PASS FOR THIS EXACT TREE APPROVES', () => {
  assert.equal(admitVerification(record({ state: VERIFY.PASSED }), { now: NOW, key: KEY }).ok, true);
  assert.equal(admitVerification(record({ state: VERIFY.FAILED }), { now: NOW, key: KEY }).ok, false);
  assert.equal(admitVerification(record({ state: VERIFY.TIMED_OUT }), { now: NOW, key: KEY }).ok, false);
  assert.equal(admitVerification(null, { now: NOW, key: KEY }).ok, false);
  assert.equal(admitVerification(record({ key: 'd'.repeat(32) }), { now: NOW, key: KEY }).ok, false,
    'a PASS for another identity approved this tree');
});

/* ── sharding ─────────────────────────────────────────────────────────── */

test('SHARDS ARE DETERMINISTIC AND COMPLETE', () => {
  const p = shardPlan({ total: 4, files: 200 });
  assert.equal(p.ok, true);
  assert.deepEqual(p.shards.map((s) => s.arg),
    ['--test-shard=1/4', '--test-shard=2/4', '--test-shard=3/4', '--test-shard=4/4']);
});

test('MORE SHARDS THAN FILES IS REFUSED: an empty shard exits 0 having proved nothing', () => {
  const p = shardPlan({ total: 8, files: 3 });
  assert.equal(p.ok, false);
  assert.match(p.errors.join(' '), /proving nothing/);
});

test('A NON-POSITIVE SHARD COUNT IS REFUSED', () => {
  for (const total of [0, -1, 1.5, 'four', null]) {
    assert.equal(shardPlan({ total, files: 10 }).ok, false, `${JSON.stringify(total)} was accepted`);
  }
});

/* ── aggregation: the part that must not invent a pass ────────────────── */

test('A MISSING SHARD IS PARTIAL, NOT GREEN', () => {
  /*
   * The difference between "all green" and "all the ones that ran were green".
   * This repository has shipped that confusion before, in a harness that
   * counted failures and reported a caught mutation as missed.
   */
  const v = aggregateShards([
    { index: 1, exitCode: 0, tests: 100, fail: 0 },
    { index: 3, exitCode: 0, tests: 100, fail: 0 },
  ], { total: 3 });
  assert.equal(v.state, VERIFY.PARTIAL);
  assert.match(v.why, /shard\(s\) 2 of 3 never reported/);
});

test('ANY FAILING SHARD FAILS THE RUN', () => {
  const v = aggregateShards([
    { index: 1, exitCode: 0, tests: 100, fail: 0 },
    { index: 2, exitCode: 1, tests: 100, fail: 2 },
  ], { total: 2 });
  assert.equal(v.state, VERIFY.FAILED);
  assert.equal(v.fail, 2);
});

test('EVERY SHARD GREEN WITH ZERO TESTS IS NOT A PASS', () => {
  /*
   * What a broken glob looks like, and indistinguishable from success by exit
   * code alone -- rule 3. `npm test`'s pattern is expanded by node, so a
   * mistyped path yields exactly this.
   */
  const v = aggregateShards([
    { index: 1, exitCode: 0, tests: 0, fail: 0 },
    { index: 2, exitCode: 0, tests: 0, fail: 0 },
  ], { total: 2 });
  assert.equal(v.state, VERIFY.PARTIAL);
  assert.match(v.why, /no test ran at all/);
});

test('THE POSITIVE CONTROL: complete, green, non-empty is a PASS', () => {
  const v = aggregateShards([
    { index: 1, exitCode: 0, tests: 1200, fail: 0 },
    { index: 2, exitCode: 0, tests: 1300, fail: 0 },
  ], { total: 2 });
  assert.equal(v.state, VERIFY.PASSED);
  assert.equal(v.tests, 2500);
});

test('aggregateShards SURVIVES JUNK rather than throwing', () => {
  for (const junk of [null, undefined, 'nonsense', 42, [null, 'x', {}]]) {
    assert.doesNotThrow(() => aggregateShards(junk, { total: 2 }));
    assert.notEqual(aggregateShards(junk, { total: 2 }).state, VERIFY.PASSED);
  }
});
