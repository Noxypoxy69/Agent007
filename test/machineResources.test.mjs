import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { readResources, isLowMemory, appendBounded, LOW_MEMORY_PCT, HISTORY_LIMIT }
  from '../src/machineResources.mjs';

/**
 * THE POINT OF THIS FILE IS THE BROKEN MACHINE, NOT THE HEALTHY ONE.
 *
 * Every branch worth having here only fires when the host is degraded — os
 * calls throwing, a platform that returns zeros, a reading that could not be
 * taken at all. None of that happens on the machine running the suite, which is
 * exactly why the façade is injected: otherwise the failure modes would be
 * untestable by construction and would first run on the night they matter.
 */

/** An `os` that answers, with whatever the test wants it to say. */
const fakeOs = (over = {}) => ({
  totalmem: () => 8 * 1024 * 1024 * 1024,
  freemem: () => 4 * 1024 * 1024 * 1024,
  loadavg: () => [1.5, 1.2, 0.9],
  platform: () => 'linux',
  cpus: () => [{}, {}, {}, {}],
  ...over,
});
const NOW = '2026-09-17T01:00:00.000Z';

test('a healthy machine reads as megabytes and a percentage', () => {
  const r = readResources(fakeOs(), { now: NOW });
  assert.equal(r.memTotalMb, 8192);
  assert.equal(r.memFreeMb, 4096);
  assert.equal(r.memFreePct, 50);
  assert.equal(r.load1, 1.5);
  assert.equal(r.cpus, 4);
  assert.equal(r.at, NOW);
});

test('AN OS CALL THAT THROWS YIELDS NULL, AND NEVER PROPAGATES', () => {
  /*
   * The whole safety property in one test. A diagnostic that can throw inside a
   * heartbeat turns a memory question into a missed beat, on the machine least
   * able to afford one. Each accessor is broken separately, because a single
   * try/catch around the lot would pass this while losing every other field.
   */
  for (const broken of ['totalmem', 'freemem', 'loadavg', 'platform', 'cpus']) {
    const o = fakeOs({ [broken]: () => { throw new Error(`${broken} exploded`); } });
    let r;
    assert.doesNotThrow(() => { r = readResources(o, { now: NOW }); }, `${broken} propagated`);
    assert.equal(r[{ totalmem: 'memTotalMb', freemem: 'memFreeMb', loadavg: 'load1',
      platform: 'platform', cpus: 'cpus' }[broken]], null, `${broken} did not read null`);
  }
  // and an os that is missing entirely is still a reading, not a crash
  assert.doesNotThrow(() => readResources(undefined, { now: NOW }));
  assert.equal(readResources(undefined, { now: NOW }).memTotalMb, null);
});

test('WINDOWS LOAD AVERAGE IS ABSENT, NOT ZERO', () => {
  /*
   * node returns [0,0,0] on win32 because the platform has no such number.
   * Storing that would record an IDLE machine for the one operating system this
   * fleet actually runs on, which is the opposite of the fact being chased.
   */
  const win = fakeOs({ platform: () => 'win32', loadavg: () => [0, 0, 0] });
  assert.equal(readResources(win, { now: NOW }).load1, null);
  // a real zero on linux is a real reading and must survive
  const idle = fakeOs({ loadavg: () => [0, 0, 0] });
  assert.equal(readResources(idle, { now: NOW }).load1, 0);
});

test('a percentage of an unknown total is unknown, not zero', () => {
  assert.equal(readResources(fakeOs({ totalmem: () => 0 }), { now: NOW }).memFreePct, null);
  assert.equal(readResources(fakeOs({ freemem: () => NaN }), { now: NOW }).memFreePct, null);
  assert.equal(readResources(fakeOs({ totalmem: () => NaN }), { now: NOW }).memTotalMb, null);
});

test('UNKNOWN IS NOT LOW: a failed reading must not read as an exhausted machine', () => {
  /*
   * The direction of this error is the whole point. A reading that could not be
   * taken, reported as an alarm, sends the operator hunting for memory they
   * have plenty of — the same shape as a refused credential reported as an
   * unreachable service, which this project has already paid for once.
   */
  assert.equal(isLowMemory({ memFreePct: null }), false);
  assert.equal(isLowMemory({}), false);
  assert.equal(isLowMemory(null), false);
  assert.equal(isLowMemory(undefined), false);

  // THE POSITIVE, or the four assertions above pass against a function that
  // always returns false and prove nothing at all.
  assert.equal(isLowMemory({ memFreePct: LOW_MEMORY_PCT - 0.1 }), true);
  assert.equal(isLowMemory({ memFreePct: LOW_MEMORY_PCT }), false, 'the threshold is exclusive');
  assert.equal(isLowMemory({ memFreePct: 3 }), true);
  assert.equal(isLowMemory({ memFreePct: 90 }), false);
  // b6's reported figure: under 1 GB free of 7.7 is about 12%
  assert.equal(isLowMemory({ memFreePct: 12 }), true, 'the case this was built for does not fire');
});

test('THE HISTORY IS BOUNDED, because a disk leak would change what it measures', () => {
  let rows = [];
  for (let i = 0; i < HISTORY_LIMIT + 50; i += 1) rows = appendBounded(rows, { n: i });
  assert.equal(rows.length, HISTORY_LIMIT);
  assert.equal(rows[0].n, 50, 'the OLDEST rows must be the ones dropped');
  assert.equal(rows[rows.length - 1].n, HISTORY_LIMIT + 49, 'the newest reading was lost');

  // a corrupt file on disk must not take the beat down with it
  assert.deepEqual(appendBounded(null, { n: 1 }), [{ n: 1 }]);
  assert.deepEqual(appendBounded('not an array', { n: 1 }), [{ n: 1 }]);
  assert.deepEqual(appendBounded([null, 'junk', { n: 0 }], { n: 1 }), [{ n: 0 }, { n: 1 }]);
});

test('and it reads the REAL machine, not only the fake one', () => {
  /*
   * The fake proves the branches; this proves the façade matches node:os. A
   * suite that only ever sees the double passes happily after the real API
   * changes shape underneath it.
   */
  const r = readResources(os, { now: NOW });
  assert.equal(typeof r.memTotalMb, 'number');
  assert.ok(r.memTotalMb > 0);
  assert.ok(r.memFreeMb >= 0 && r.memFreeMb <= r.memTotalMb);
  assert.equal(r.platform, os.platform());
});
