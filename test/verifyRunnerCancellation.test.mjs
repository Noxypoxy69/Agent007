/**
 * THE TWO FORGED PASSES AN AUDITOR FOUND IN THE VERIFY PATH.
 *
 * Both were mine, both were fail-open, and neither had any coverage -- the
 * auditor's own headline finding was that `src/verifyRunner.mjs` and
 * `src/verifyIdentity.mjs` had ZERO direct tests while being the modules the
 * whole cache-safety argument rests on.
 *
 *   A KILLED SHARD READ AS GREEN. node sets `code = null` when a child dies by
 *   signal, and `Number(null) === 0`. A suite killed by the OOM killer did not
 *   count as failed, so if any surviving shard reported tests the run
 *   aggregated to VERIFY_PASSED. The machine being under exactly the load that
 *   gets a suite killed is what produced the forged pass.
 *
 *   A DEADLINE THAT CANCELLED NOTHING. The Stop gate raced the run against its
 *   budget and answered when the timer won, then called process.exit(0) with a
 *   full `node --test` per shard still alive -- unbounded across turns, which
 *   is the duplicate-suite load the whole single-flight design exists to
 *   remove. On Windows an orphan holding `cwd` also blocks fixture cleanup
 *   with EPERM, which `rmSync(force)` does NOT suppress.
 *
 * ═══ WHY THE SPAWN IS INJECTED RATHER THAN REAL ═══
 *
 * The first four versions of this file raced cancellation against a genuinely
 * slow temp repository and measured NOTHING, every time. `aggregateShards`
 * kept saying so -- "every shard exited 0 and no test ran at all" -- and I
 * kept treating it as a fixture detail instead of reading it. Three separate
 * causes were ruled out (single-shard clamp, top-level vs nested glob, the 8.3
 * temp alias) and the real one was never found, because the rail refuses
 * `node` against any path outside the inherited repository, so a guarded
 * session cannot even diagnose it.
 *
 * A fixture that cannot construct the real case cannot fail for it, and a test
 * I cannot show going green is a countdown rather than a ratchet. So the child
 * is injected: the kill path is now watched directly, deterministically, and
 * the assertion is about the thing that was broken -- that a live child is
 * tracked and really receives SIGKILL -- rather than about a temp directory's
 * glob behaviour.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { aggregateShards, VERIFY } from '../src/verifyCache.mjs';
import { runVerification, killLiveShards } from '../src/verifyRunner.mjs';

/* ── a killed shard is not a green shard ─────────────────────────────── */

test('A SHARD KILLED BY A SIGNAL IS NOT A PASS', () => {
  /*
   * exitCode null is what node reports for a child killed by a signal. The
   * other shard is deliberately green and non-empty, so nothing else can
   * refuse this run -- if the null is not caught, the verdict is PASSED.
   */
  const v = aggregateShards([
    { index: 1, exitCode: null, tests: 40, fail: 0 },
    { index: 2, exitCode: 0, tests: 40, fail: 0 },
  ], { total: 2 });
  assert.notEqual(v.state, VERIFY.PASSED, 'a shard killed by a signal was aggregated into a pass');
});

test('THE POSITIVE CONTROL: the same shape with a real zero DOES pass', () => {
  /*
   * Rule 5. Without this the test above could be passing because
   * aggregateShards refuses everything.
   */
  const v = aggregateShards([
    { index: 1, exitCode: 0, tests: 40, fail: 0 },
    { index: 2, exitCode: 0, tests: 40, fail: 0 },
  ], { total: 2 });
  assert.equal(v.state, VERIFY.PASSED, v.why);
});

test('EVERY NON-INTEGER EXIT CODE IS A FAILURE, not just null', () => {
  /*
   * Rule 8: fix the matcher, not the one value the prober happened to try.
   * undefined, a string and NaN are all "we do not know how this ended".
   */
  for (const code of [null, undefined, 'x', NaN, {}, []]) {
    const v = aggregateShards([
      { index: 1, exitCode: code, tests: 40, fail: 0 },
      { index: 2, exitCode: 0, tests: 40, fail: 0 },
    ], { total: 2 });
    assert.notEqual(v.state, VERIFY.PASSED, `exitCode ${JSON.stringify(code)} was treated as green`);
  }
});

/* ── cancellation really kills the children ──────────────────────────── */

/**
 * A child that behaves like a long-running `node --test`: it produces nothing
 * and never exits until it is killed, and it records the signal it got.
 */
function fakeChildFactory(log) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = (sig) => {
      if (child.killed) return false;
      child.killed = true;
      log.push(sig);
      /* A real child closes asynchronously after the signal, with code null. */
      setImmediate(() => child.emit('close', null));
      return true;
    };
    log.spawned = (log.spawned ?? 0) + 1;
    return child;
  };
}

const fixtureHome = async () => realpathSync.native(await mkdtemp(path.join(tmpdir(), 'verify-cancel-home-')));

test('ABORTING A RUN SIGKILLS ITS CHILDREN, so nothing is orphaned', async (t) => {
  const home = await fixtureHome();
  t.after(async () => { await rm(home, { recursive: true, force: true }); });

  const log = [];
  const control = new AbortController();
  const run = runVerification({
    root: process.cwd(),
    key: 'k'.repeat(32),
    identity: { t: 1 },
    shards: 2,
    concurrency: 2,
    home,
    signal: control.signal,
    spawnFn: fakeChildFactory(log),
  });

  /* Let the workers get their children spawned before cancelling. */
  await new Promise((r) => { setImmediate(r); });
  control.abort();

  const rec = await run;

  /*
   * THE PRECONDITION IS ASSERTED, NOT GUARDED ON (rule 6). If no child was
   * ever spawned this test proves nothing about killing one, and it must fail
   * rather than pass quietly -- which is exactly how the previous four
   * versions of this file passed while measuring nothing.
   */
  assert.ok(log.spawned >= 1, 'no child was spawned, so nothing was killed and nothing is proved');
  assert.ok(log.length >= 1, `the abort killed nothing; signals sent: ${JSON.stringify(log)}`);
  assert.ok(log.every((s) => s === 'SIGKILL'),
    `a child was asked politely instead of killed: ${JSON.stringify(log)}. A test runner asked to `
    + 'terminate can outlive a budget that is already exhausted');

  /*
   * THE DANGEROUS HALF. Killing the children is only half the fix: if the
   * killed shards then aggregate to green, the cancellation has manufactured
   * the very approval the deadline was refusing to give.
   */
  assert.notEqual(rec.state, VERIFY.PASSED,
    'a cancelled run recorded a PASS: the deadline manufactured the approval it was refusing');
});

test('killLiveShards REAPS A CHILD THE ABORT DID NOT, and reports how many', async (t) => {
  /*
   * The gate calls this after aborting, as a belt to the signal's braces: if
   * the abort path ever stops firing, an orphan still gets killed and the
   * refusal still reports a truthful count.
   */
  const home = await fixtureHome();
  t.after(async () => { await rm(home, { recursive: true, force: true }); });

  const log = [];
  const run = runVerification({
    root: process.cwd(),
    key: 'r'.repeat(32),
    identity: { t: 1 },
    shards: 2,
    concurrency: 2,
    home,
    spawnFn: fakeChildFactory(log), // no signal at all
  });

  await new Promise((r) => { setImmediate(r); });
  const reaped = killLiveShards();

  await run;
  assert.ok(reaped >= 1, `killLiveShards found nothing to reap although a child was live (reaped=${reaped})`);
  assert.ok(log.every((s) => s === 'SIGKILL'), `reaping used the wrong signal: ${JSON.stringify(log)}`);
});

test('A REAPED SET IS EMPTY AFTERWARDS, so a second call cannot double-count', async (t) => {
  const home = await fixtureHome();
  t.after(async () => { await rm(home, { recursive: true, force: true }); });

  const log = [];
  const run = runVerification({
    root: process.cwd(), key: 's'.repeat(32), identity: { t: 1 }, shards: 1, concurrency: 1, home,
    spawnFn: fakeChildFactory(log),
  });
  await new Promise((r) => { setImmediate(r); });

  killLiveShards();
  assert.equal(killLiveShards(), 0, 'a second reap counted children that were already dead');
  await run;
});

test('A RUN ABORTED BEFORE IT STARTS NEVER SPAWNS, and still is not a pass', async (t) => {
  const home = await fixtureHome();
  t.after(async () => { await rm(home, { recursive: true, force: true }); });

  const log = [];
  const control = new AbortController();
  control.abort();
  const rec = await runVerification({
    root: process.cwd(),
    key: 'p'.repeat(32),
    identity: { t: 1 },
    shards: 2,
    concurrency: 2,
    home,
    signal: control.signal,
    spawnFn: fakeChildFactory(log),
  });

  assert.equal(log.spawned ?? 0, 0, 'an already-aborted run still spawned a suite');
  assert.notEqual(rec.state, VERIFY.PASSED, 'an already-aborted run produced a pass having executed nothing');
});
