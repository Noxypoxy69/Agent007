/**
 * THE STOP GATE'S VERDICT REUSE, DRIVEN THROUGH THE REAL GATE (T-153, T-159, T-164).
 *
 * NOT PART OF THE SUITE -- deliberately. Run it with
 *
 *     npm run test:gate-integration
 *
 * It drives ~30 real gate runs, each spawning its own `node --test`. Inside the
 * Stop suite that is exactly the load F-31 describes, and the gate would be
 * running a copy of itself under its own deadline (T-160). The discovery rule it
 * stays out of: the Stop gate (guardSession.discoverTests), `npm test`'s
 * `test/**\/*.test.mjs` and validationRunner all select files ending
 * `.test.mjs`; this one ends `.integration.mjs`. src/stopVerdict.mjs keeps its
 * pure unit tests in test/stopVerdict.test.mjs, which IS in the suite.
 * COST OF LEAVING THE PATTERN, stated: the baseline-test protections (Stop's
 * baseline-test drift, the guard's immutability of inherited tests) also key on
 * `test/*.test.mjs`, so this file is not protected by them.
 *
 * NO PRECONDITION HERE IS TIMED (T-164). Every ordering the properties need --
 * "the waiter had observed its key before the tree changed", "a poll saw the
 * PASS", "the suite read the tree before it changed" -- is enforced by a BARRIER
 * and asserted, never assumed from a sleep:
 *   - inside the SUITE: the fixture test writes `<name>-readdone`, then waits for
 *     `<name>-proceed` (as T-159's I3 already did);
 *   - inside the GATE, before its suite exists: a preload injected through
 *     NODE_OPTIONS (--import) wraps fs.readFileSync for the verdict-store path.
 *     The gate reads the store immediately after computing its first key (the
 *     start-of-wait reuse check, in T-147, T-153 and T-159 alike), so the first
 *     such read is the point "key observed". When armed, it writes `observed` and
 *     blocks until `proceed`. Every store read is also counted in `storereads`.
 *     It is a no-op in every process that is not the gate, and when not armed.
 * The control files live OUTSIDE the repository, the home and the secrets dir,
 * and every gate in a test gets the SAME environment, so the instrumentation can
 * never be what separates two keys.
 *
 *   S16 KEY DRIFT. T-147 observed the key once, before the lock wait, ran the
 *   suite on the tree as it stood after the wait, and recorded the outcome under
 *   the old key; the next gate on the old (failing) tree reused it.
 *   S10 LIVENESS. One unparseable line disabled reuse forever, silently.
 *   T-159: the secrets-dir entry is keyed by CONTENT, at every interval.
 *
 * The agentbridge home lives OUTSIDE the throwaway repository: the store and the
 * lock beside it must not become untracked files inside the key they serve.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, utimesSync, statSync, appendFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* The in-gate barrier. Written next to each scratch repository, loaded with --import. */
const GATE_PRELOAD = `import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const ctl = process.env.RIG_CTL;
if (ctl && /claude-stop-gate\\.mjs$/.test(process.argv[1] ?? '')) {
  const store = path.resolve(process.env.AGENTBRIDGE_HOME ?? '', 'guard-sessions', 'stop-verdicts.jsonl');
  const original = fs.readFileSync;
  let reads = 0;
  const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  fs.readFileSync = function readFileSync(p, ...rest) {
    if (typeof p === 'string' && path.resolve(p) === store) {
      reads += 1;
      fs.appendFileSync(path.join(ctl, 'storereads'), process.pid + ' ' + reads + '\\n');
      if (reads === 1 && fs.existsSync(path.join(ctl, 'arm'))) {
        fs.writeFileSync(path.join(ctl, 'observed'), String(process.pid));
        const t0 = Date.now();
        while (!fs.existsSync(path.join(ctl, 'proceed'))) {
          if (Date.now() - t0 > 120000) throw new Error('gate barrier: no proceed within 120s');
          pause(25);
        }
      }
    }
    return original.call(this, p, ...rest);
  };
  syncBuiltinESMExports();
}
`;

function scratch(t, { secret = false } = {}) {
  const top = mkdtempSync(path.join(tmpdir(), 'stop-reuse-'));
  t.after(() => rmSync(top, { recursive: true, force: true }));
  const dir = path.join(top, 'repo');
  const home = path.join(top, 'home');
  const secrets = path.join(top, 'secrets');
  const ctl = path.join(top, 'ctl'); // outside the repo, the home and the secrets dir: never keyed
  for (const d of [dir, home, secrets, ctl]) mkdirSync(d, { recursive: true });
  const preload = path.join(top, 'gate-barrier.mjs');
  writeFileSync(preload, GATE_PRELOAD);
  for (const d of ['src', 'scripts', 'bin']) cpSync(path.join(repoRoot, d), path.join(dir, d), { recursive: true });
  for (const d of ['.claude', 'docs', 'test', 'rig']) mkdirSync(path.join(dir, d), { recursive: true });
  for (const f of ['package.json', 'package-lock.json', 'CLAUDE.md', 'THIRD_PARTY_CODE.md', '.claude/settings.json']) writeFileSync(path.join(dir, f), '{}\n');
  for (const f of ['docs/ORDER.md', 'docs/ROADMAP.md', 'docs/CLAUDE_GUARD_PROVENANCE.md']) writeFileSync(path.join(dir, f), 'x\n');
  writeFileSync(path.join(dir, 'test', 'claudeGuard.test.mjs'), "import test from 'node:test';\ntest('placeholder', () => {});\n");
  // the suite's outcome is decided by a TRACKED file, i.e. by an input inside the key
  writeFileSync(path.join(dir, 'rig', 'verdict.txt'), 'pass\n');
  writeFileSync(path.join(dir, 'test', 'rig.test.mjs'), `import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
test('outcome decided by rig/verdict.txt', async () => {
  const v = readFileSync(new URL('../rig/verdict.txt', import.meta.url), 'utf8').trim();
  const ctl = process.env.RIG_CTL;
  if (ctl && existsSync(path.join(ctl, 'suite-arm'))) {
    // Read, say so, and hold the suite open until the driving test says proceed.
    writeFileSync(path.join(ctl, 'suite-readdone'), '1');
    const t0 = Date.now();
    while (!existsSync(path.join(ctl, 'suite-proceed'))) {
      if (Date.now() - t0 > 120_000) throw new Error('suite barrier: no proceed within 120s');
      await new Promise((r) => { setTimeout(r, 25); });
    }
  }
  assert.notEqual(v, 'fail');
});
`);
  if (secret) {
    /*
     * T-159: a suite whose outcome is decided by a SECRETS-DIR entry, read the way
     * test/coordinatorAuthLive.test.mjs reads one (top level, by name). With
     * RIG_POSTFLIP=1 it leaves the entry bad AFTER its read -- the same size, the
     * mtime pinned -- so the change lands after the suite measured, before the record.
     */
    writeFileSync(path.join(dir, 'test', 'secret.test.mjs'), `import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { existsSync } from 'node:fs';
test('outcome decided by the secrets-dir entry s1.txt', async () => {
  const p = path.join(process.env.AGENTBRIDGE_SECRETS_DIR, 's1.txt');
  const v = readFileSync(p, 'utf8');
  if (process.env.RIG_POSTFLIP === '1') { writeFileSync(p, ${JSON.stringify(SECRET_BAD)}); utimesSync(p, ${SECRET_MTIME_S}, ${SECRET_MTIME_S}); }
  if (process.env.RIG_BARRIER === '1') {
    // Read, say so, and hold the suite open until the test driving the gate says proceed:
    // a barrier, not a sleep, so machine load cannot move the change before the read.
    const ctl = process.env.RIG_CTL;
    writeFileSync(path.join(ctl, 'readdone'), '1');
    const t0 = Date.now();
    while (!existsSync(path.join(ctl, 'proceed'))) {
      if (Date.now() - t0 > 90_000) throw new Error('barrier: no proceed within 90s');
      await new Promise((r) => { setTimeout(r, 25); });
    }
  }
  assert.notEqual(v, ${JSON.stringify(SECRET_BAD)});
});
`);
    setSecret({ secrets }, SECRET_GOOD);
  }
  execFileSync('git', ['init', '-q', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir, stdio: 'ignore' });
  // The SAME instrumentation environment for every gate in a test: it can never separate two keys.
  const benv = { NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`, RIG_CTL: ctl };
  return { dir, home, secrets, ctl, benv, store: path.join(home, 'guard-sessions', 'stop-verdicts.jsonl'), lock: path.join(home, 'guard-sessions', 'stop-suite.lock') };
}

/*
 * NODE_TEST* IS STRIPPED: this file runs under node --test, and a gate whose
 * own `node --test` inherits NODE_TEST_CONTEXT prints no TAP summary at all.
 * So is any inherited NODE_OPTIONS: only the one a test passes may reach a gate.
 */
function gate(s, sessionId = 'reuse-session', extraEnv = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^NODE_TEST|^NODE_OPTIONS$|^GIT_|^AGENTBRIDGE_|^CLAUDE_|^RIG_/i.test(k)) env[k] = v;
  Object.assign(env, { CLAUDE_PROJECT_DIR: s.dir, AGENTBRIDGE_HOME: s.home, AGENTBRIDGE_SECRETS_DIR: s.secrets }, extraEnv);
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(s.dir, 'scripts', 'claude-stop-gate.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => {
      let j = {}; try { j = JSON.parse(out.trim().split('\n').pop() || '{}'); } catch { j = { unparsed: out }; }
      const text = `${j.reason ?? ''}${j.systemMessage ?? ''}`;
      resolve({ code, blocked: j.decision === 'block', reused: /\[agentbridge:stop-verdict-reused\]/.test(text), text, err });
    });
    c.stdin.end(JSON.stringify({ session_id: sessionId }));
  });
}
/** A gate with the test's constant instrumentation environment (plus any other constant env). */
const gateB = (s, extra = {}) => gate(s, 'reuse-session', { ...s.benv, ...extra });

/* ── barriers ── */
const ctlFile = (s, name) => path.join(s.ctl, name);
function resetCtl(s) { for (const n of readdirSync(s.ctl)) rmSync(ctlFile(s, n), { force: true }); }
/** Wait until a control file exists; the bound is only against a hang, never an ordering. */
async function reached(s, name, what) {
  const t0 = Date.now();
  while (!existsSync(ctlFile(s, name))) {
    assert.ok(Date.now() - t0 < 180_000, `barrier never reached: ${what}`);
    await new Promise((r) => { setTimeout(r, 25); });
  }
}
const storeReads = (s) => (existsSync(ctlFile(s, 'storereads')) ? readFileSync(ctlFile(s, 'storereads'), 'utf8').split('\n').filter(Boolean).length : 0);
async function readsAtLeast(s, n, what) {
  const t0 = Date.now();
  while (storeReads(s) < n) {
    assert.ok(Date.now() - t0 < 180_000, `barrier never reached: ${what} (store reads ${storeReads(s)} < ${n})`);
    await new Promise((r) => { setTimeout(r, 25); });
  }
}
/** A LIVE holder (this very test process), within its budget, holds the one-suite lock. */
function holdLock(s) {
  mkdirSync(path.dirname(s.lock), { recursive: true });
  writeFileSync(s.lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), budgetMs: 600_000 }));
}

const setVerdict = (s, v) => writeFileSync(path.join(s.dir, 'rig', 'verdict.txt'), `${v}\n`);
/*
 * T-159: THE SECRETS ATTACK IS SAME SIZE AND SAME MTIME, so only the CONTENT
 * differs. Every secret write pins the mtime; each test asserts that premise.
 */
const SECRET_GOOD = 'good';
const SECRET_BAD = 'bad_';
const SECRET_MTIME_S = 1_700_000_000;
function setSecret(s, v) {
  const p = path.join(s.secrets, 's1.txt');
  writeFileSync(p, v);
  utimesSync(p, SECRET_MTIME_S, SECRET_MTIME_S);
}
const secretMeta = (s) => { const st = statSync(path.join(s.secrets, 's1.txt')); return `${st.size}:${st.mtimeMs}`; };
const records = (s) => (existsSync(s.store) ? readFileSync(s.store, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }) : []);

test('POSITIVE CONTROL: this harness sees a reuse -- an unchanged tree reuses the PASS just recorded', async (t) => {
  const s = scratch(t);
  const mint = await gate(s);
  assert.match(mint.text, /baseline-created/, `precondition: baseline minted: ${mint.text}`);
  const first = await gate(s);
  assert.equal(first.blocked, false, `first run: ${first.text}`);
  assert.equal(first.reused, false, 'the first run must actually run');
  const second = await gate(s);
  assert.equal(second.reused, true, `an unchanged tree must reuse: ${second.text}`);
});

test('POSITIVE CONTROL: the in-gate barrier holds a gate after its key and releases it; unarmed it is inert', async (t) => {
  const s = scratch(t);
  assert.match((await gateB(s)).text, /baseline-created/);
  resetCtl(s);
  const plain = await gateB(s);                  // unarmed: runs straight through
  assert.equal(plain.blocked, false, `unarmed gate runs and passes: ${plain.text}`);
  assert.ok(storeReads(s) >= 1, 'premise: the preload is loaded in the gate and sees its store reads');
  assert.equal(existsSync(ctlFile(s, 'observed')), false, 'an unarmed gate never stops at the barrier');
  resetCtl(s); setVerdict(s, 'fail');            // a fresh key, so the armed gate cannot reuse
  writeFileSync(ctlFile(s, 'arm'), '1');
  let done = false;
  const held = gateB(s).then((r) => { done = true; return r; });
  await reached(s, 'observed', 'the armed gate reached its first store read');
  assert.equal(done, false, 'the armed gate is HELD at the barrier, not finished');
  writeFileSync(ctlFile(s, 'proceed'), '1');
  const r = await held;
  assert.equal(r.blocked, true, `released, it ran the failing tree: ${r.text}`);
});

test('S16: a PASS earned by a tree that changed during the lock wait is never recorded for the tree the waiter first saw', async (t) => {
  const s = scratch(t);
  assert.match((await gateB(s)).text, /baseline-created/);
  // state X fails -- and its key is known from the FAIL it records
  setVerdict(s, 'fail');
  const x = await gateB(s);
  assert.equal(x.blocked, true, `precondition: state X really fails: ${x.text}`);
  const kX = records(s).filter((r) => r?.outcome === 'fail').pop()?.key;
  assert.match(String(kX), /^[0-9a-f]{64}$/, 'precondition: X recorded a FAIL under its key');
  holdLock(s);
  resetCtl(s); writeFileSync(ctlFile(s, 'arm'), '1');
  const waiter = gateB(s);
  await reached(s, 'observed', 'the waiter computed its key on X');   // BARRIER: key observed on X
  setVerdict(s, 'pass');                        // the tree becomes Y AFTER the waiter's key, BEFORE its suite
  writeFileSync(ctlFile(s, 'proceed'), '1');
  rmSync(s.lock);                               // the holder finishes
  const w = await waiter;
  rmSync(ctlFile(s, 'arm'));
  assert.equal(w.blocked, false, `precondition: the waiter ran the suite on Y, which passes: ${w.text}`);
  // THE PROPERTY, in both of its forms
  assert.equal(records(s).some((r) => r?.key === kX && r.outcome === 'pass'), false,
    'a PASS was recorded under the key of X, a state that has never passed');
  setVerdict(s, 'fail');                        // back to X
  const again = await gateB(s);
  assert.equal(again.reused, false, `a PASS X never earned was REUSED for X: ${again.text}`);
  assert.equal(again.blocked, true, `the gate APPROVED failing state X: ${again.text}`);
});

test('S16b: a tree that changes DURING the suite gets no record at all -- the outcome describes no single state', async (t) => {
  const s = scratch(t);
  assert.match((await gateB(s)).text, /baseline-created/);
  resetCtl(s); writeFileSync(ctlFile(s, 'suite-arm'), '1');
  const running = gateB(s);
  await reached(s, 'suite-readdone', 'the suite read rig/verdict.txt');  // BARRIER: the suite read "pass"
  setVerdict(s, 'fail');                        // state B, mid-suite
  writeFileSync(ctlFile(s, 'suite-proceed'), '1');
  const r = await running;
  rmSync(ctlFile(s, 'suite-arm'));
  assert.equal(r.blocked, false, `precondition: the suite read the passing tree before it changed: ${r.text}`);
  assert.equal(records(s).filter((x) => x?.outcome === 'pass').length, 0,
    `a run whose inputs moved during the suite was recorded: ${JSON.stringify(records(s))}`);
  const onB = await gateB(s);
  assert.equal(onB.reused, false, `a PASS was reused for failing state B: ${onB.text}`);
  assert.equal(onB.blocked, true, `the gate APPROVED failing state B: ${onB.text}`);
});

test('S10: an unparseable store is SAID, moved aside (kept, not deleted), and reuse RECOVERS', async (t) => {
  const s = scratch(t);
  assert.match((await gate(s)).text, /baseline-created/);
  mkdirSync(path.dirname(s.store), { recursive: true });
  writeFileSync(s.store, 'this is not a verdict record\n');
  const first = await gate(s);
  assert.equal(first.blocked, false, `the full run still passes: ${first.text}`);
  assert.equal(first.reused, false, 'an unusable store gives a full run, never a reuse');
  assert.match(first.text, /\[agentbridge:stop-verdict-store-unusable\] reuse disabled: /, `the unusable store must be SAID: ${first.text}`);
  const aside = readdirSync(path.dirname(s.store)).filter((n) => n.startsWith('stop-verdicts.jsonl.unusable.'));
  assert.equal(aside.length, 1, `the corrupt store is kept under a new name: ${JSON.stringify(readdirSync(path.dirname(s.store)))}`);
  assert.equal(readFileSync(path.join(path.dirname(s.store), aside[0]), 'utf8'), 'this is not a verdict record\n', 'moved, not rewritten');
  assert.equal(records(s).length, 1, 'the run recorded into a FRESH store');
  const second = await gate(s);
  assert.equal(second.reused, true, `reuse recovers on the next gate: ${second.text}`);
  assert.doesNotMatch(second.text, /store-unusable/, 'the notice is not repeated once the store is healthy');
});

/* ── T-159: the secrets-dir entry is keyed by CONTENT (T-154, every interval) ── */

/** Mint, and prove the secret dimension decides the outcome: good passes, bad fails, metadata identical. */
async function secretRig(t, env = {}) {
  const s = scratch(t, { secret: true });
  assert.match((await gate(s, 'reuse-session', { ...s.benv, ...env })).text, /baseline-created/);
  setSecret(s, SECRET_GOOD);
  const goodMeta = secretMeta(s);
  setSecret(s, SECRET_BAD);
  assert.equal(secretMeta(s), goodMeta, 'premise: good and bad have the SAME size and mtime');
  setSecret(s, SECRET_GOOD);
  return s;
}
const sameMetaBad = (s) => { const before = secretMeta(s); setSecret(s, SECRET_BAD); assert.equal(secretMeta(s), before, 'premise: only the content changed'); };
const assertNotReusedForBad = (r, why) => {
  assert.equal(r.reused, false, `${why}: a PASS was REUSED for secret bytes the suite never read: ${r.text}`);
  assert.equal(r.blocked, true, `${why}: the gate APPROVED a failing secret: ${r.text}`);
};

test('T-159 I5: a PASS recorded for one secret content is not reused after a same-size, same-mtime change', async (t) => {
  const s = await secretRig(t);
  const first = await gateB(s);
  assert.equal(first.blocked, false, `precondition: the good secret passes: ${first.text}`);
  assert.equal(records(s).filter((r) => r?.outcome === 'pass').length, 1, 'precondition: a PASS was recorded');
  sameMetaBad(s);
  assertNotReusedForBad(await gateB(s), 'I5');
});

test('T-159 I1: a secret changed DURING the lock wait gets no reusable PASS for the content first seen', async (t) => {
  const s = await secretRig(t);
  sameMetaBad(s);                                // the waiter starts on a FAILING secret
  holdLock(s);
  resetCtl(s); writeFileSync(ctlFile(s, 'arm'), '1');
  const waiter = gateB(s);
  await reached(s, 'observed', 'the waiter computed its key on the bad secret');  // BARRIER
  setSecret(s, SECRET_GOOD);                     // good AFTER the waiter's key, BEFORE its suite
  writeFileSync(ctlFile(s, 'proceed'), '1');
  rmSync(s.lock);
  const w = await waiter;
  rmSync(ctlFile(s, 'arm'));
  assert.equal(w.blocked, false, `precondition: the waiter's suite read the good secret: ${w.text}`);
  sameMetaBad(s);
  assertNotReusedForBad(await gateB(s), 'I1');
});

test('T-159 I2: a PASS for the good secret, appearing while the secret turned bad during the wait, is not reused', async (t) => {
  const s = await secretRig(t);
  assert.equal((await gateB(s)).blocked, false, 'precondition: the good secret passes');
  const goodPass = readFileSync(s.store, 'utf8').split('\n').find((l) => l.includes('"outcome":"pass"'));
  assert.ok(goodPass, 'precondition: a genuine PASS for the good secret exists');
  rmSync(s.store);
  holdLock(s);
  resetCtl(s); writeFileSync(ctlFile(s, 'arm'), '1');
  const waiter = gateB(s);
  await reached(s, 'observed', 'the waiter computed its key on the good secret');  // BARRIER: key on GOOD
  sameMetaBad(s);                                // the secret turns bad FIRST...
  writeFileSync(ctlFile(s, 'proceed'), '1');
  // ...the waiter's start-of-wait store read (read 1) must be DONE, and it must be polling, before the PASS appears:
  await readsAtLeast(s, 2, 'the waiter finished its start check and polled once');
  appendFileSync(s.store, `${goodPass}\n`);      // ...then the good PASS appears
  const seen = storeReads(s);
  await readsAtLeast(s, seen + 1, 'a poll ran AFTER the PASS appeared');  // BARRIER: a poll saw it
  rmSync(s.lock);
  const w = await waiter;
  rmSync(ctlFile(s, 'arm'));
  assertNotReusedForBad(w, 'I2');
});

test('T-159 I3: a secret changed DURING the suite gets no record, so the new content is never reused', async (t) => {
  const s = scratch(t, { secret: true });
  const held = { ...s.benv, RIG_BARRIER: '1' };   // the SAME env on every gate in this test
  assert.match((await gate(s, 'reuse-session', held)).text, /baseline-created/);
  setSecret(s, SECRET_GOOD);
  const running = gate(s, 'reuse-session', held);
  await reached(s, 'readdone', 'the suite reached the secret read');
  sameMetaBad(s);                                // AFTER the suite read it, while the suite is held open
  writeFileSync(path.join(s.ctl, 'proceed'), '1');
  const r = await running;
  assert.equal(r.blocked, false, `precondition: the suite read the good secret: ${r.text}`);
  assertNotReusedForBad(await gate(s, 'reuse-session', held), 'I3');
});

test('T-159 I4: a secret changed after the suite and before the record gets no record', async (t) => {
  const post = { RIG_POSTFLIP: '1' };            // the SAME env on every gate, so env cannot be what separates keys
  const s = await secretRig(t, post);
  const r = await gateB(s, post);
  assert.equal(r.blocked, false, `precondition: the suite read the good secret: ${r.text}`);
  assert.equal(readFileSync(path.join(s.secrets, 's1.txt'), 'utf8'), SECRET_BAD, 'precondition: the suite left the secret bad');
  assertNotReusedForBad(await gateB(s, post), 'I4');
});

test('T-159: no secret byte and no per-secret digest reaches the store, the lock, the state dir or any output', async (t) => {
  const s = scratch(t, { secret: true });
  const MARKER = `secret-marker-${process.pid}-7c1e`;
  const digest = createHash('sha256').update(MARKER).digest('hex');
  setSecret(s, MARKER);
  const mint = await gate(s);
  assert.match(mint.text, /baseline-created/);
  const run = await gate(s);
  const reuse = await gate(s);
  assert.equal(run.blocked, false, `precondition: the run passed: ${run.text}`);
  assert.equal(reuse.reused, true, `precondition: the store is live -- a reuse happened: ${reuse.text}`);
  const everything = [mint, run, reuse].map((r) => `${r.text}\n${r.err}`);
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [readFileSync(path.join(d, e.name), 'latin1')]));
  everything.push(...walk(s.home));
  assert.ok(everything.length >= 4, 'precondition: the state dir was read');
  for (const x of everything) {
    assert.equal(x.includes(MARKER), false, 'a secret byte was written out');
    assert.equal(x.includes(digest), false, 'a per-secret digest was written out');
  }
});

/* ── T-159: an unreadable store says a person must act, and deletes nothing ── */

test('T-159: a store that cannot be read (a directory) fails safe, says it needs removing by hand, and deletes nothing', async (t) => {
  const s = scratch(t);
  assert.match((await gate(s)).text, /baseline-created/);
  mkdirSync(s.store, { recursive: true });
  writeFileSync(path.join(s.store, 'keep.txt'), 'kept');
  for (const round of [1, 2]) {
    const r = await gate(s);
    assert.equal(r.blocked, false, `round ${round}: the full suite still runs and passes: ${r.text}`);
    assert.equal(r.reused, false, `round ${round}: never a reuse`);
    assert.ok(r.text.includes(`reuse stays disabled until this path is removed by hand: ${s.store}`), `round ${round}: ${r.text}`);
    assert.equal(readFileSync(path.join(s.store, 'keep.txt'), 'utf8'), 'kept', `round ${round}: nothing was deleted`);
  }
});
