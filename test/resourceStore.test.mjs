import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe } from '../src/resourceStore.mjs';

/**
 * THE FAILURE PATHS, PROVEN AGAINST A REAL FILESYSTEM.
 *
 * machineResources.test.mjs covers the reading. This covers the writing, and
 * the only property that really matters: a diagnostic wired into a heartbeat
 * MUST NOT be able to fail the beat. Everything here is an injected filesystem
 * fault, because that is the branch that runs on the night the machine is sick
 * and never on the machine running the suite.
 *
 * AGENTBRIDGE_HOME is set before the module is imported, since config.mjs reads
 * it at module scope — an import ordering this test would silently ignore if it
 * used a static import.
 */

/**
 * EACH CASE RUNS IN ITS OWN PROCESS, and that is not ceremony.
 *
 * config.mjs resolves HOME at module scope, so a second import in the same
 * process keeps the FIRST home no matter what the environment says afterwards.
 * A query-string cache-bust on resourceStore.mjs does not help: the stale value
 * lives one module further down, in config.mjs, which stays cached.
 *
 * I wrote it that way first and three of these tests passed against the wrong
 * directory. Bending the shipped code to make it re-readable in-process would
 * have been changing production for the convenience of the suite, so instead
 * each case spawns node with the environment it means — which is also how the
 * heartbeat really invokes this.
 */
const runIn = (dir, body) => {
  const src = `
    import * as m from ${JSON.stringify(new URL('../src/resourceStore.mjs', import.meta.url).href)};
    const out = [];
    const log = (...a) => out.push(a.map(String).join(' '));
    try { await (async () => { ${body} })(); } catch (e) { log('THREW:' + e.message); }
    process.stdout.write(JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], {
    env: { ...process.env, AGENTBRIDGE_HOME: dir }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, `child exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout || '[]');
};

const scratch = (t) => {
  const d = mkdtempSync(path.join(tmpdir(), 'resstore-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

test('a sample is written, and read back', (t) => {
  const home = scratch(t);
  const out = runIn(home, `
    const r = await m.recordSample({ beatFailed: false, command: 'heartbeat' });
    log('sample', r === null ? 'null' : r.command, r === null ? '-' : typeof r.memTotalMb, r?.beatFailed);
    log('rows', (await m.readHistory()).length);
  `);
  assert.deepEqual(out, ['sample heartbeat number false', 'rows 1']);
  assert.equal(JSON.parse(readFileSync(path.join(home, 'resources.json'), 'utf8')).length, 1);
});

test('A WRITE THAT CANNOT SUCCEED RETURNS NULL AND DOES NOT THROW', async (t) => {
  /*
   * The property the heartbeat depends on. Injected by putting a DIRECTORY
   * where the file belongs, which fails on every platform and needs no
   * permission games — chmod proves nothing when the suite runs as root, which
   * is exactly how this container runs.
   */
  const home = scratch(t);
  mkdirSync(path.join(home, 'resources.json'), { recursive: true });
  const out = runIn(home, `
    const r = await m.recordSample({ command: 'heartbeat' });
    log('result', r === null ? 'null' : 'a-reading');
    log('describe', String(m.describe(null)));
  `);
  assert.deepEqual(out, ['result null', 'describe null'],
    'a failed write reported success, or threw out of the beat');
});

test('a corrupt history is replaced, not fatal', async (t) => {
  const home = scratch(t);
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, 'resources.json'), 'not json at all', 'utf8');
  const out = runIn(home, `
    log('before', (await m.readHistory()).length);
    const r = await m.recordSample({ command: 'heartbeat' });
    log('recorded', r === null ? 'null' : 'ok');
    log('after', (await m.readHistory()).length);
  `);
  assert.deepEqual(out, ['before 0', 'recorded ok', 'after 1']);
});

test('THE OPERATOR LINE SAYS UNKNOWN RATHER THAN ZERO', () => {
  // b6's reported figure — under 1 GB free of 7.7 — must read as LOW
  assert.match(describe({ memFreeMb: 900, memTotalMb: 7900, memFreePct: 11.4 }), /LOW/);
  assert.doesNotMatch(describe({ memFreeMb: 6000, memTotalMb: 7900, memFreePct: 75.9 }), /LOW/);
  assert.match(describe({ memFreeMb: null, memTotalMb: null }), /unknown/);
  assert.equal(describe(null), null);
});

test('history is capped on disk, not only in memory', async (t) => {
  const home = scratch(t);
  const out = runIn(home, `
    for (let i = 0; i < 12; i += 1) await m.recordSample({ command: 'beat-' + i });
    const rows = await m.readHistory();
    log('rows', rows.length, rows[rows.length - 1].command);
  `);
  assert.deepEqual(out, ['rows 12 beat-11']);
  assert.ok(existsSync(path.join(home, 'resources.json')));
  assert.ok(readFileSync(path.join(home, 'resources.json'), 'utf8').endsWith('\n'));
});
