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
 *   remove. On Windows an orphan holding `cwd` also blocks fixture cleanup with
 *   EPERM, which `rmSync(force)` does NOT suppress; that is a real failure
 *   already observed in this suite.
 *
 * The cancellation test asserts the ORPHAN IS GONE by removing the directory
 * the child was running in. That is the far end (rule 4), not a proxy: a
 * surviving child holds `cwd` and the removal fails.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
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

/** A repository whose only test never finishes on its own. */
async function slowRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), 'verify-cancel-'));
  await mkdir(path.join(dir, 'test'), { recursive: true });
  await writeFile(
    path.join(dir, 'test', 'slow.test.mjs'),
    "import test from 'node:test';\n"
    + "test('slow', async () => { await new Promise((r) => setTimeout(r, 120000)); });\n",
  );
  return dir;
}

test('ABORTING A RUN KILLS ITS CHILDREN, so nothing is orphaned', async (t) => {
  const root = await slowRepo();
  const home = await mkdtemp(path.join(tmpdir(), 'verify-cancel-home-'));
  t.after(async () => { await rm(home, { recursive: true, force: true }); });

  const control = new AbortController();
  const started = Date.now();
  const run = runVerification({
    root, key: 'k'.repeat(32), identity: { t: 1 }, shards: 1, concurrency: 1, home, signal: control.signal,
  });

  await new Promise((r) => { setTimeout(r, 1500); });
  control.abort();
  const reaped = killLiveShards();

  await run;
  const elapsed = Date.now() - started;

  /*
   * THE PRECONDITION IS ASSERTED, NOT GUARDED ON (rule 6). If the child never
   * started, this test proves nothing about killing it and must fail rather
   * than pass quietly.
   */
  assert.ok(reaped >= 1, `no live shard was tracked, so nothing was killed and nothing is proved (reaped=${reaped})`);
  assert.ok(elapsed < 60_000, `the run outlived its cancellation by ${elapsed}ms: the abort did not stop it`);

  /*
   * THE FAR END. A surviving child holds `cwd` and this removal fails with
   * EPERM on Windows -- which is the exact symptom that was observed in this
   * suite, and which rmSync's `force` does NOT suppress.
   */
  assert.doesNotThrow(
    () => rmSync(root, { recursive: true, force: true }),
    'the working directory could not be removed, so a suite process is still holding it',
  );
});

test('A CANCELLED RUN DOES NOT RECORD A PASS', async (t) => {
  /*
   * The dangerous half. Killing the children is only half the fix: if the
   * killed shards then aggregate to green, the cancellation has manufactured
   * the very approval the deadline was refusing to give.
   */
  const root = await slowRepo();
  const home = await mkdtemp(path.join(tmpdir(), 'verify-cancel-home-'));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  const control = new AbortController();
  const run = runVerification({
    root, key: 'm'.repeat(32), identity: { t: 1 }, shards: 1, concurrency: 1, home, signal: control.signal,
  });
  await new Promise((r) => { setTimeout(r, 1500); });
  control.abort();
  killLiveShards();

  const rec = await run;
  assert.notEqual(rec.state, VERIFY.PASSED,
    'a run that was cancelled mid-flight recorded a PASS: the deadline manufactured an approval');
});

test('A RUN ABORTED BEFORE IT STARTS NEVER SPAWNS, and still is not a pass', async (t) => {
  const root = await slowRepo();
  const home = await mkdtemp(path.join(tmpdir(), 'verify-cancel-home-'));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  const control = new AbortController();
  control.abort();
  const rec = await runVerification({
    root, key: 'p'.repeat(32), identity: { t: 1 }, shards: 1, concurrency: 1, home, signal: control.signal,
  });
  assert.notEqual(rec.state, VERIFY.PASSED, 'an already-aborted run produced a pass having executed nothing');
});
