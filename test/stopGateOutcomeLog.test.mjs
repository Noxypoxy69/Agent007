/*
 * T-344: THE STOP GATE'S OUTCOME LOG -- ITS I/O (src/verifyRunner.mjs appendOutcome / readOutcomeLog).
 *
 * The hall-pass decision reads ONE source: a per-key, append-only log, one entry per completed run, each a file
 * named by its sequence number and PUBLISHED with an exclusive hard link, so write order is the order of events by
 * construction. The decision itself is tested in test/stopVerdict.test.mjs; the real gate in
 * test/stopGateHallPass.test.mjs. This file tests what neither can reach: the writer, and two or more writers at once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, existsSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as R from '../src/verifyRunner.mjs';
import * as SV from '../src/stopVerdict.mjs';

/* The REAL store-key shape (verifyCache.verifyKey slices to 32 hex): a 64-hex fixture once hid a log nobody could read. */
const K = 'c'.repeat(32);
const home = (t) => {
  const h = mkdtempSync(path.join(tmpdir(), 'stop-outcomes-'));
  t.after(() => rmSync(h, { recursive: true, force: true }));
  return h;
};

test('T-344 append then read: entries are numbered in write order and the LAST one is what the log says', (t) => {
  const h = home(t);
  assert.deepEqual(R.readOutcomeLog(K, h), { ok: true, count: 0, last: null }, 'POSITIVE CONTROL: no directory reads as nothing ever completed');
  assert.deepEqual(R.appendOutcome(K, { outcome: 'pass' }, h), { ok: true, seq: 1, retries: 0 });
  assert.equal(R.appendOutcome(K, { outcome: 'fail', first: 'the red one', cut: true, session: 'S' }, h).seq, 2);
  const log = R.readOutcomeLog(K, h);
  assert.equal(log.ok, true, log.why);
  assert.equal(log.count, 2);
  assert.deepEqual({ ...log.last, at: 'x' }, { seq: 2, outcome: 'fail', at: 'x', first: 'the red one', cut: true });
  const dir = R.outcomeLogDir(K, h);
  assert.deepEqual(readdirSync(dir), ['000000000001.json', '000000000002.json'], 'one file per entry, and nothing else in the key\'s directory');
  assert.deepEqual(readdirSync(path.dirname(dir)).filter((n) => n.startsWith('.tmp-')), [], 'no temp file is left behind');
  assert.equal(R.appendOutcome(K, { outcome: 'pass' }, h).seq, 3);
  assert.equal(R.readOutcomeLog(K, h).last.outcome, 'pass', 'a newer PASS is the last entry');
});

test('T-344 appendOutcome never writes into a malformed log, and never throws (checklist U, T)', (t) => {
  const h = home(t);
  R.appendOutcome(K, { outcome: 'fail', first: 'x' }, h);
  const f = path.join(R.outcomeLogDir(K, h), '000000000001.json');
  writeFileSync(f, Buffer.alloc(statSync(f).size));                 // a crash zero-filled it at its size
  const r = R.appendOutcome(K, { outcome: 'pass' }, h);
  assert.equal(r.ok, false, 'an append after an unreadable entry would be a guess');
  assert.match(r.why, /entry #1 is not one complete line/);
  assert.deepEqual(readdirSync(R.outcomeLogDir(K, h)), ['000000000001.json'], 'nothing was appended');
  assert.equal(R.readOutcomeLog(K, h).ok, false, 'and the log still refuses');
  for (const bad of [{ outcome: 'deadline' }, null, { outcome: 'PASS' }]) {
    const h2 = home(t);
    const x = R.appendOutcome(K, bad, h2);
    assert.equal(x.ok, false, `appended ${JSON.stringify(bad)}`);
    assert.equal(existsSync(R.outcomeLogDir(K, h2)) ? readdirSync(R.outcomeLogDir(K, h2)).length : 0, 0, 'no entry exists');
  }
});

test('T-344 a log directory that cannot be LISTED is not an empty log: it refuses (a file where the directory should be)', (t) => {
  const h = home(t);
  const dir = R.outcomeLogDir(K, h);
  mkdirSync(path.dirname(dir), { recursive: true });
  writeFileSync(dir, 'not a directory');
  const log = R.readOutcomeLog(K, h);
  assert.equal(log.ok, false, 'a listing error read as "none"');
  assert.match(log.why, /could not be listed/);
  const entryAsDir = home(t);
  mkdirSync(path.join(R.outcomeLogDir(K, entryAsDir), '000000000001.json'), { recursive: true });
  assert.match(R.readOutcomeLog(K, entryAsDir).why, /entry #1 could not be read/, 'an entry that is a directory refuses');
});

/*
 * T-344 r2 (verifier §5 F2a): ONLY A GENUINELY ABSENT LOG IS "NONE". On Windows, listing <file>/<key> fails with
 * ENOENT, so the log ROOT replaced by a file used to read as "nothing ever completed" -- a hall pass after a FAIL.
 * Each shape of the root and the key path is generated; the absent ones are asserted FIRST (positive controls).
 */
test('T-344 r2 F2a: the outcome log is "none" ONLY when truly absent; a file, a dangling link or a non-directory parent refuses', (t) => {
  // POSITIVE CONTROLS: genuinely absent is "none", and a root that is a junction to a real log still reads.
  const hAbsent = home(t);
  assert.deepEqual(R.readOutcomeLog(K, hAbsent), { ok: true, count: 0, last: null }, 'no root under a real home is "none"');
  const hNoKey = home(t);
  mkdirSync(path.join(hNoKey, 'verify-outcomes'));
  assert.deepEqual(R.readOutcomeLog(K, hNoKey), { ok: true, count: 0, last: null }, 'no key dir under a real root is "none"');
  const hLinked = home(t);
  const realRoot = path.join(hLinked, 'elsewhere');
  mkdirSync(realRoot);
  symlinkSync(realRoot, path.join(hLinked, 'verify-outcomes'), 'junction');
  assert.equal(R.appendOutcome(K, { outcome: 'fail', first: 'x' }, hLinked).ok, true, 'a junction to a real directory is written through');
  assert.equal(R.readOutcomeLog(K, hLinked).last?.outcome, 'fail', 'and read back: a legitimate link is not an outage');
  // THE HOSTILE SHAPES: every one refuses, and none is appended to.
  const SHAPES = {
    'the log ROOT is a file': (h) => writeFileSync(path.join(h, 'verify-outcomes'), 'x'),
    'the log ROOT is an empty file': (h) => writeFileSync(path.join(h, 'verify-outcomes'), ''),
    'the KEY path is a file': (h) => { mkdirSync(path.join(h, 'verify-outcomes')); writeFileSync(R.outcomeLogDir(K, h), 'x'); },
    'the log ROOT is a junction to nothing': (h) => { const gone = path.join(h, 'gone'); mkdirSync(gone); symlinkSync(gone, path.join(h, 'verify-outcomes'), 'junction'); rmSync(gone, { recursive: true }); },
    'the KEY path is a junction to nothing': (h) => { const gone = path.join(h, 'gone'); mkdirSync(gone); mkdirSync(path.join(h, 'verify-outcomes')); symlinkSync(gone, R.outcomeLogDir(K, h), 'junction'); rmSync(gone, { recursive: true }); },
  };
  for (const [how, make] of Object.entries(SHAPES)) {
    const h = home(t);
    make(h);
    const log = R.readOutcomeLog(K, h);
    assert.equal(log.ok, false, `${how}: read as ${JSON.stringify(log)}`);
    assert.match(log.why, /could not be listed/, `${how}: ${log.why}`);
    const a = R.appendOutcome(K, { outcome: 'fail', first: 'x' }, h);
    assert.equal(a.ok, false, `${how}: an append went through: ${JSON.stringify(a)}`);
  }
  // THE PARENT IS NOT A DIRECTORY: the "home" itself is a file, so the absent root under it is not an absence.
  const top = home(t);
  const fileHome = path.join(top, 'home-is-a-file');
  writeFileSync(fileHome, 'x');
  const lf = R.readOutcomeLog(K, fileHome);
  assert.equal(lf.ok, false, `an absent root under a FILE read as ${JSON.stringify(lf)}`);
  assert.match(lf.why, /parent that is not a directory/, lf.why);
});

test('T-344 outcomeLogDir: only a 32-hex store key names a directory, so no caller value can steer the path (checklist O)', () => {
  for (const key of ['../../x', `${'a'.repeat(31)}/`, 'A'.repeat(32), `${'a'.repeat(32)}\\..`, 'a'.repeat(64), '', null, 7]) {
    assert.throws(() => R.outcomeLogDir(key, 'C:/h'), /32-hex store key/, String(key));
    assert.equal(R.appendOutcome(key, { outcome: 'pass' }, 'C:/h').ok, false, `appended under ${String(key)}`);
    assert.equal(R.readOutcomeLog(key, 'C:/h').ok, false, `read under ${String(key)}`);
  }
  assert.equal(R.outcomeLogDir(K, 'C:/h'), path.join('C:/h', 'verify-outcomes', K));
});

test('T-344 LOST RACE, deterministic: another writer takes #N between the read and the publish -- this one becomes #N+1', (t) => {
  const h = home(t);
  R.appendOutcome(K, { outcome: 'pass' }, h);
  let stolen = 0;
  const r = R.appendOutcome(K, { outcome: 'fail', first: 'mine' }, h, {
    beforePublish: ({ seq, target }) => {
      if (stolen) return;
      stolen = seq;
      writeFileSync(target, SV.formatOutcomeEntry({ key: K, seq, outcome: 'pass', at: new Date().toISOString(), session: 'other' }), { flag: 'wx' });
    },
  });
  assert.equal(stolen, 2, 'precondition: the other writer took #2');
  assert.deepEqual([r.ok, r.seq, r.retries], [true, 3, 1], 'the loser re-read and took the next number');
  const log = R.readOutcomeLog(K, h);
  assert.equal(log.ok, true, log.why);
  assert.deepEqual([log.count, log.last.outcome, log.last.first], [3, 'fail', 'mine'], 'write order: the loser is LAST, and nothing was overwritten');
  assert.equal(JSON.parse(readFileSync(path.join(R.outcomeLogDir(K, h), '000000000002.json'), 'utf8')).session, 'other', 'the winner\'s entry is intact');
});

test('T-344 TWO OR MORE SESSIONS APPENDING AT ONCE: every entry lands exactly once, numbered 1..N with no gap', async (t) => {
  const h = home(t);
  const WRITERS = 4;
  const EACH = 25;
  const go = path.join(h, 'go');
  const child = path.join(h, 'writer.mjs');
  writeFileSync(child, `
import { existsSync } from 'node:fs';
const R = await import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL('../src/verifyRunner.mjs', import.meta.url))).href)});
const [home, key, who, each, go] = process.argv.slice(2);
while (!existsSync(go)) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); }
let retries = 0;
for (let i = 0; i < Number(each); i += 1) {
  const r = R.appendOutcome(key, { outcome: i % 2 ? 'fail' : 'pass', first: i % 2 ? who + '-' + i : null, session: who }, home, { attempts: 1000 });
  if (!r.ok) { process.stdout.write('FAILED ' + r.why + '\\n'); process.exit(3); }
  retries += r.retries;
}
process.stdout.write('RETRIES ' + retries + '\\n');
`);
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^NODE_TEST|^NODE_OPTIONS$/i.test(k)) env[k] = v;
  const runs = Array.from({ length: WRITERS }, (_, i) => new Promise((resolve) => {
    const c = spawn(process.execPath, [child, h, K, `w${i}`, String(EACH), go], { env });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
  }));
  await new Promise((r) => { setTimeout(r, 1500); });               // let every writer reach the barrier
  writeFileSync(go, 'go');
  const done = await Promise.all(runs);
  for (const d of done) assert.equal(d.code, 0, `a writer failed: ${d.out}`);
  const retries = done.reduce((n, d) => n + Number(/RETRIES (\d+)/.exec(d.out)?.[1] ?? NaN), 0);
  assert.ok(Number.isInteger(retries), 'every writer reported its retries');
  const log = R.readOutcomeLog(K, h);
  assert.equal(log.ok, true, `the log written concurrently does not read: ${log.why}`);
  assert.equal(log.count, WRITERS * EACH, 'an entry was lost or doubled');
  const dir = R.outcomeLogDir(K, h);
  const entries = readdirSync(dir).sort().map((n) => JSON.parse(readFileSync(path.join(dir, n), 'utf8')));
  assert.deepEqual(entries.map((e) => e.seq), Array.from({ length: WRITERS * EACH }, (_, i) => i + 1));
  for (let i = 0; i < WRITERS; i += 1) {
    const mine = entries.filter((e) => e.session === `w${i}`);
    assert.equal(mine.length, EACH, `writer w${i} has ${mine.length} entries`);
    // each writer's own entries appear in ITS order (its appends were sequential)
    assert.deepEqual(mine.map((e) => e.first), Array.from({ length: EACH }, (_, j) => (j % 2 ? `w${i}-${j}` : null)));
  }
  assert.deepEqual(readdirSync(path.dirname(dir)).filter((n) => n.startsWith('.tmp-')), [], 'no temp file is left behind');
  t.diagnostic(`lost races resolved by retry: ${retries}`);
});
