/*
 * T-344: THE HALL-PASS DECISION READS ONE SOURCE -- the per-key outcome log -- DRIVEN THROUGH THE REAL GATE.
 *
 * T-273 r1-r3 each added a state source to this decision and every blind verify found the hole at an interaction
 * (live/T-339/REPORT.md). The gate now appends one entry per completed run (and one for a run cut after it failed)
 * to <home>/verify-outcomes/<key>/<seq>.json, and hallPassDecision reads only the LAST entry. The harness below is
 * test/stopGateHallPass.test.mjs's, copied, so the two files fail for the same reasons; these tests live in their
 * own file so a mutant of the gate can be graded against them in minutes rather than the whole hall-pass file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as SV from '../src/stopVerdict.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* 20 s declared: ~9 s for verification after the 10 s output reserve -- inside the 5 s minimum with margin. */
const HOOK_TIMEOUT_S = 20;

const RIG_SUITE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
const mode = readFileSync(path.join(process.env.RIG_CTL, 'mode'), 'utf8').trim();
test('first rig test', () => { if (['fail', 'fail-then-slow', 'fail-then-die', 'fail-and-touch', 'tail-then-die', 'tail-then-slow'].includes(mode)) assert.fail('rig says red: ' + mode); });
// T-353 (T-344 §8 V2-F1): 120 passing tests with long names AFTER the red push it out of the 6000-character display tail.
if (mode === 'tail-then-die' || mode === 'tail-then-slow') for (let i = 0; i < 120; i += 1) test('filler rig test ' + String(i).padStart(3, '0') + ' with a deliberately long name that fills the shard output tail', () => {});
test('second rig test', async () => {
  if (mode === 'slow' || mode === 'fail-then-slow' || mode === 'tail-then-slow') await new Promise((r) => { setTimeout(r, 60_000); });
  // T-344 r2: the shard runner dies without a summary AFTER the red is printed -- a COMPLETED run that ends PARTIAL.
  if (mode === 'fail-then-die' || mode === 'die' || mode === 'tail-then-die') {
    await new Promise((r) => { setTimeout(r, 2_500); });
    process.kill(process.ppid, 'SIGKILL');
    await new Promise((r) => { setTimeout(r, 5_000); });
  }
});
test('touching rig test', async () => {
  if (mode !== 'touch' && mode !== 'fail-and-touch') return;
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path.join(process.cwd(), 'touched-during-run.txt'), String(Date.now()));   // an untracked file: the key moves
});
`;

function removeScratch(dir) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; } catch (e) {
      if (e?.code !== 'EPERM' && e?.code !== 'EBUSY') throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  process.stderr.write(`[stopGateOneSource] could not remove ${dir}: a killed child still holds it\n`);
}

function scratch(t, mode, { upstream = false } = {}) {
  const top = mkdtempSync(path.join(tmpdir(), 'stop-hallpass-'));
  t.after(() => removeScratch(top));
  const dir = path.join(top, 'repo');
  const home = path.join(top, 'home');
  const ctl = path.join(top, 'ctl');
  const secrets = path.join(top, 'secrets');
  for (const d of [dir, home, ctl, secrets]) mkdirSync(d, { recursive: true });
  for (const d of ['src', 'scripts', 'bin']) cpSync(path.join(repoRoot, d), path.join(dir, d), { recursive: true });
  for (const d of ['.claude', 'docs', 'test']) mkdirSync(path.join(dir, d), { recursive: true });
  for (const f of ['package.json', 'package-lock.json', 'CLAUDE.md', 'THIRD_PARTY_CODE.md']) writeFileSync(path.join(dir, f), '{}\n');
  for (const f of ['docs/ORDER.md', 'docs/ROADMAP.md', 'docs/CLAUDE_GUARD_PROVENANCE.md']) writeFileSync(path.join(dir, f), 'x\n');
  writeFileSync(path.join(dir, '.claude', 'settings.json'), `${JSON.stringify({
    hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/scripts/claude-stop-gate.mjs"', timeout: HOOK_TIMEOUT_S }] }] },
  }, null, 2)}\n`);
  writeFileSync(path.join(dir, 'test', 'claudeGuard.test.mjs'), RIG_SUITE);
  mkdirSync(path.join(dir, 'rig'));
  writeFileSync(path.join(dir, 'rig', 'data.txt'), 'x\n');       // a TRACKED, UNPROTECTED file (T-273 one-byte)
  execFileSync('git', ['init', '-q', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir, stdio: 'ignore' });
  if (upstream) {
    /*
     * T-273 r2 (F5): a REAL upstream, so the audit escalation can BLOCK. The init commit touches the gate and
     * src/ (controls), is PUSHED, and has no audit recorded: exactly the "audit-escaped" shape. Without an
     * upstream the escalation is always "unknown" and never blocks, so no rig could test the interaction.
     */
    const remote = path.join(top, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['push', '-q', '-u', 'origin', 'HEAD:refs/heads/main'], { cwd: dir, stdio: 'ignore' });
  }
  const s = { top, dir, home, ctl, secrets };
  setMode(s, mode);
  return s;
}
const setMode = (s, mode) => writeFileSync(path.join(s.ctl, 'mode'), mode);

/** Run the gate the way Claude Code does, WITH the killer at the declared timeout. */
function gate(s, sessionId, extraEnv = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^NODE_TEST|^NODE_OPTIONS$|^GIT_|^AGENTBRIDGE_|^CLAUDE_|^RIG_/i.test(k)) env[k] = v;
  Object.assign(env, { CLAUDE_PROJECT_DIR: s.dir, AGENTBRIDGE_HOME: s.home, AGENTBRIDGE_SECRETS_DIR: s.secrets, RIG_CTL: s.ctl }, extraEnv);
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(s.dir, 'scripts', 'claude-stop-gate.mjs')], {
    input: JSON.stringify({ session_id: sessionId }), encoding: 'utf8', env, timeout: HOOK_TIMEOUT_S * 1000, killSignal: 'SIGKILL',
  });
  let j = {};
  try { j = JSON.parse((r.stdout || '').trim().split('\n').pop() || '{}'); } catch { j = { unparsed: r.stdout }; }
  return {
    killed: r.error?.code === 'ETIMEDOUT',
    elapsedMs: Date.now() - started,
    blocked: j.decision === 'block',
    reason: j.reason ?? '',
    message: j.systemMessage ?? '',
    text: `${j.reason ?? ''}\n${j.systemMessage ?? ''}`,
  };
}
function primed(s, sessionId) {
  const first = gate(s, sessionId);
  assert.match(first.reason, /baseline-created/, `precondition: the baseline must mint first, got: ${first.text}`);
}

const stateDir = (s) => path.join(s.home, 'guard-sessions');
const debts = (s) => {
  const d = path.join(stateDir(s), 'stop-debts');
  return existsSync(d) ? readdirSync(d).map((n) => JSON.parse(readFileSync(path.join(d, n), 'utf8'))) : [];
};
/* The merged gate's store: one record per key, <home>/verify/<key>.json. */
const records = (s) => {
  const d = path.join(s.home, 'verify');
  return existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(readFileSync(path.join(d, n), 'utf8'))) : [];
};
const events = (s) => {
  const p = path.join(stateDir(s), 'stop-events.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const HALL_PASS = /^\[agentbridge:stop-hall-pass\] UNVERIFIED, STILL OWED -- this is NOT an approval and NOT a pass/;

const recFile = (s) => {
  const d = path.join(s.home, 'verify');
  const files = existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.json')) : [];
  assert.equal(files.length, 1, `precondition: exactly one verify record (${files})`);
  return path.join(d, files[0]);
};
const failureFiles = (s) => {
  const d = path.join(stateDir(s), 'stop-failures');
  return existsSync(d) ? readdirSync(d) : [];
};
const holdLock = (s) => writeFileSync(path.join(stateDir(s), 'stop-suite.lock'),
  JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), budgetMs: 600_000 }));
const dropLock = (s) => rmSync(path.join(stateDir(s), 'stop-suite.lock'), { force: true });
function failFirst(s, sid) {
  setMode(s, 'fail');
  const r = gate(s, sid);
  assert.equal(r.blocked, true, `precondition: the suite fails: ${r.text}`);
  assert.equal(JSON.parse(readFileSync(recFile(s), 'utf8')).state, 'VERIFY_FAILED', 'precondition: VERIFY_FAILED is recorded');
}

/* ── T-344: ONE SOURCE, DRIVEN THROUGH THE REAL GATE ── */

/* The outcome log the gate writes: <home>/verify-outcomes/<store key: 32 hex>/<seq>.json. Exactly one key per test. */
const logDir = (s) => {
  const root = path.join(s.home, 'verify-outcomes');
  const keys = existsSync(root) ? readdirSync(root).filter((n) => /^[0-9a-f]{32}$/.test(n)) : [];
  assert.equal(keys.length, 1, `precondition: exactly one outcome log (${keys})`);
  return path.join(root, keys[0]);
};
const logEntries = (s) => readdirSync(logDir(s)).sort().map((n) => JSON.parse(readFileSync(path.join(logDir(s), n), 'utf8')));
const lockHeldGate = (s, sid) => { holdLock(s); try { return gate(s, sid); } finally { dropLock(s); } };
const agePass = (s) => {
  const f = recFile(s);
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), finished_at: Date.now() - 2 * 3_600_000 }, null, 2));
};

test('T-344 V1: an older PASS, then a run that FAILED a test and was CUT, then a slow Stop -- refused, the test named from the LOG', (t) => {
  const s = scratch(t, 'pass');
  primed(s, 'A');
  assert.equal(gate(s, 'A').blocked, false, 'precondition: a PASS');
  agePass(s);
  setMode(s, 'fail-then-slow');
  const cut = gate(s, 'A');
  assert.match(cut.text, /No hall pass: the suite had already FAILED/, `precondition: the cut run failed first: ${cut.text}`);
  // THE PREMISE OF T-331 V1, asserted (rule 9): the record is PARTIAL and still CARRIES the older PASS.
  const r0 = JSON.parse(readFileSync(recFile(s), 'utf8'));
  assert.equal(r0.state, 'VERIFY_PARTIAL');
  assert.equal(r0.last_completed?.state, 'VERIFY_PASSED', 'premise: the record carries the OLDER pass');
  // THE FIX: the cut FAIL is the log's last entry.
  assert.deepEqual(logEntries(s).map((e) => `${e.seq}:${e.outcome}:${e.cut}`), ['1:pass:false', '2:fail:true']);
  assert.equal(logEntries(s)[1].first, 'first rig test');
  setMode(s, 'slow');
  for (const [sid, how] of [['A', 'suite-running'], ['B', 'suite-running'], ['B', 'lock-held']]) {
    if (sid === 'B' && how === 'suite-running') primed(s, 'B');
    const r = how === 'lock-held' ? lockHeldGate(s, sid) : gate(s, sid);
    assert.equal(r.killed, false, `precondition: the gate answered (${r.elapsedMs}ms)`);
    assert.doesNotMatch(r.message, /\[agentbridge:stop-hall-pass\] UNVERIFIED/, `${sid}/${how}: a HALL PASS after a run that had already failed: ${r.text}`);
    assert.equal(r.blocked, true, r.text);
    assert.match(r.text, /No hall pass: the newest completed result for these inputs is a FAIL \(outcome log entry #2, a run cut after it failed\)/, r.text);
    assert.match(r.text, /First failing test: "first rig test" -- from the recorded FAIL for these inputs \(outcome log entry #2/, r.text);
  }
  assert.equal(debts(s).length, 0, 'nothing is owed');
});

test('T-344 V2: a first-ever run FAILED and was cut, then its failure file is zeroed, emptied, cut or turned into a directory -- still refused', (t) => {
  const s = scratch(t, 'fail-then-slow');
  primed(s, 'A');
  assert.equal(gate(s, 'A').blocked, true, 'precondition: the cut failing run is refused');
  assert.equal(JSON.parse(readFileSync(recFile(s), 'utf8')).last_completed ?? null, null, 'premise: nothing completed is carried');
  assert.equal(failureFiles(s).length, 1, 'premise: one failure file');
  const ff = path.join(stateDir(s), 'stop-failures', failureFiles(s)[0]);
  const original = readFileSync(ff);
  const MANGLE = {
    'NUL-filled at the same size': () => writeFileSync(ff, Buffer.alloc(original.length)),
    empty: () => writeFileSync(ff, ''),
    'cut after 2 lines': () => writeFileSync(ff, original.toString('utf8').split('\n').slice(0, 2).join('\n')),
    'key line for another key': () => writeFileSync(ff, original.toString('utf8').replace(/^key: [0-9a-f]{16}$/m, 'key: 0123456789abcdef')),
    'a directory': () => { rmSync(ff); mkdirSync(ff); },
    deleted: () => rmSync(ff),
  };
  setMode(s, 'slow');
  primed(s, 'J');
  for (const [how, mangle] of Object.entries(MANGLE)) {
    mangle();
    const r = lockHeldGate(s, 'J');
    assert.doesNotMatch(r.message, /\[agentbridge:stop-hall-pass\] UNVERIFIED/, `failure file ${how}: a HALL PASS after a known FAIL: ${r.text}`);
    assert.equal(r.blocked, true, r.text);
    assert.match(r.text, /First failing test: "first rig test" -- from the recorded FAIL/, `failure file ${how}: the LOG names the test: ${r.text}`);
    rmSync(ff, { recursive: true, force: true });
    writeFileSync(ff, original);
  }
});

test('T-344 V4: an UNREADABLE outcome log refuses -- NUL-filled, truncated mid-entry, a gap, a stray file, not a directory', (t) => {
  const s = scratch(t, 'pass');
  primed(s, 'A');
  assert.equal(gate(s, 'A').blocked, false, 'precondition: a PASS');
  agePass(s);
  assert.deepEqual(logEntries(s).map((e) => e.outcome), ['pass'], 'precondition: the log holds one PASS');
  const dir = logDir(s);
  const e1 = path.join(dir, '000000000001.json');
  const original = readFileSync(e1);
  // POSITIVE CONTROL: the same state, uncorrupted, gets its hall pass -- so each refusal below is the log's doing.
  const control = lockHeldGate(s, 'A');
  assert.match(control.message, HALL_PASS, `POSITIVE CONTROL: a late job after a PASS gets a hall pass: ${control.text}`);
  rmSync(path.join(stateDir(s), 'stop-debts'), { recursive: true, force: true });
  const CORRUPT = {
    'the entry NUL-filled at its size': () => writeFileSync(e1, Buffer.alloc(original.length)),
    'the entry truncated mid-entry': () => writeFileSync(e1, original.subarray(0, Math.floor(original.length / 2))),
    'the entry emptied': () => writeFileSync(e1, ''),
    'a gap (#1 gone, #2 present)': () => { writeFileSync(path.join(dir, '000000000002.json'), original.toString('utf8').replace('"seq":1', '"seq":2')); rmSync(e1); },
    'a stray file in the log': () => writeFileSync(path.join(dir, 'stray.txt'), 'x'),
    'the log replaced by a file': () => { rmSync(dir, { recursive: true }); writeFileSync(dir, 'x'); },
  };
  for (const [how, corrupt] of Object.entries(CORRUPT)) {
    corrupt();
    const r = lockHeldGate(s, 'A');
    assert.doesNotMatch(r.message, /\[agentbridge:stop-hall-pass\] UNVERIFIED/, `${how}: a hall pass on an unreadable log: ${r.text}`);
    assert.equal(r.blocked, true, r.text);
    assert.match(r.text, /No hall pass: the outcome log for these inputs could not be read/, `${how}: the refusal says the log is why: ${r.text}`);
    assert.equal(debts(s).length, 0, `${how}: nothing is owed`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
    writeFileSync(e1, original);
  }
});

test('T-344 RECORDS AND FAILURE FILES ARE VIEWS: their CONTENT never decides -- only an unreadable record can veto', (t) => {
  // (a) the log says FAIL, the record is rewritten to a well-formed PASS carrying a PASS: still refused.
  const a = scratch(t, 'pass');
  primed(a, 'A');
  failFirst(a, 'A');
  const fa = recFile(a);
  const ra = JSON.parse(readFileSync(fa, 'utf8'));
  writeFileSync(fa, JSON.stringify({ ...ra, state: 'VERIFY_PASSED', finished_at: Date.now() - 2 * 3_600_000, last_completed: { state: 'VERIFY_PASSED', finished_at: Date.now() - 3 * 3_600_000 } }, null, 2));
  rmSync(path.join(stateDir(a), 'stop-failures'), { recursive: true, force: true });
  const ga = lockHeldGate(a, 'A');
  assert.doesNotMatch(ga.message, /\[agentbridge:stop-hall-pass\] UNVERIFIED/, `a record saying PASS overrode the log's FAIL: ${ga.text}`);
  assert.match(ga.text, /is a FAIL \(outcome log entry #1\)/, ga.text);
  assert.match(ga.text, /First failing test: "first rig test"/, 'named from the log, with no failure file left');
  // (b) the log says PASS; the record says FAILED (well-formed) and a failure file for this key is planted: a hall pass.
  const b = scratch(t, 'pass');
  primed(b, 'A');
  assert.equal(gate(b, 'A').blocked, false, 'precondition: a PASS');
  const fb = recFile(b);
  const rb = JSON.parse(readFileSync(fb, 'utf8'));
  writeFileSync(fb, JSON.stringify({ ...rb, state: 'VERIFY_FAILED', finished_at: Date.now() - 2 * 3_600_000, last_completed: { state: 'VERIFY_FAILED', finished_at: Date.now() - 3 * 3_600_000 } }, null, 2));
  const fdir = path.join(stateDir(b), 'stop-failures');
  mkdirSync(fdir, { recursive: true });
  writeFileSync(path.join(fdir, `2026-01-01T00-00-00-000Z-${rb.identity.tree_digest.slice(0, 8)}.txt`), `key: ${rb.identity.tree_digest.slice(0, 16)}\nnot ok - planted\n`);
  const gb = lockHeldGate(b, 'A');
  assert.match(gb.message, HALL_PASS, `a VIEW decided: a well-formed FAILED record or a failure file refused although the log's last entry is a PASS: ${gb.text}`);
  // (c) the veto: the same PASS state with the record NUL-filled refuses -- it can only refuse, never allow.
  const c = scratch(t, 'pass');
  primed(c, 'A');
  assert.equal(gate(c, 'A').blocked, false, 'precondition: a PASS');
  const fc = recFile(c);
  writeFileSync(fc, Buffer.alloc(statSync(fc).size));
  const gc = lockHeldGate(c, 'A');
  assert.doesNotMatch(gc.message, /\[agentbridge:stop-hall-pass\] UNVERIFIED/, `an unreadable record did not veto: ${gc.text}`);
  assert.match(gc.text, /No hall pass: the verify record for these inputs exists but cannot be read/, gc.text);
});

test('T-344 V3: a session that owes a debt AND meets a known FAIL is told the failing test', (t) => {
  const s = scratch(t, 'slow');
  primed(s, 'A');
  primed(s, 'B');
  assert.match(gate(s, 'A').message, HALL_PASS, 'precondition: A holds a hall pass');
  setMode(s, 'fail');
  assert.equal(gate(s, 'B').blocked, true, 'precondition: B fails these inputs');
  setMode(s, 'slow');
  const a2 = gate(s, 'A');
  assert.equal(a2.blocked, true, a2.text);
  assert.match(a2.text, /is a FAIL \(outcome log entry #1\); a known red does not get a hall pass; and this session already owes verification/, a2.text);
  assert.match(a2.text, /First failing test: "first rig test"/, `the failing test must be named although a debt is owed: ${a2.text}`);
});

test('T-344 a PASS whose inputs MOVED during the run is not an outcome-log entry', (t) => {
  const s = scratch(t, 'pass');
  primed(s, 'A');
  assert.equal(gate(s, 'A').blocked, false, 'POSITIVE CONTROL: an ordinary PASS');
  assert.deepEqual(logEntries(s).map((e) => e.outcome), ['pass'], 'POSITIVE CONTROL: and it is logged');
  const keyed = logDir(s);
  setMode(s, 'touch');
  rmSync(path.join(s.dir, 'touched-during-run.txt'), { force: true });
  // Age the PASS out so this Stop runs; the suite then writes an untracked file, so the key moves during the run.
  agePass(s);
  const moved = gate(s, 'A');
  assert.equal(moved.blocked, true, `precondition: a run whose inputs moved is refused: ${moved.text}`);
  assert.match(moved.text, /describes no single state/, `precondition: refused because the key moved: ${moved.text}`);
  assert.ok(existsSync(path.join(s.dir, 'touched-during-run.txt')), 'precondition: the suite touched the tree');
  assert.deepEqual(readdirSync(keyed).length, 1, `a PASS for inputs that moved was logged under the old key: ${JSON.stringify(logEntries(s))}`);
});

/* ── T-344 ROUND 2: the verifier's §5 F1, F2a, F2b, F4, F5, through the REAL gate ── */

const NO_HALL_PASS = /\[agentbridge:stop-hall-pass\] UNVERIFIED/;
const passedAndAged = (s) => {
  primed(s, 'A');
  assert.equal(gate(s, 'A').blocked, false, 'precondition: a PASS');
  assert.deepEqual(logEntries(s).map((e) => e.outcome), ['pass'], 'precondition: the PASS is log entry #1');
  agePass(s);
};

test('T-344 r2 F1: a COMPLETED run that printed `not ok` but ended PARTIAL is a FAIL entry -- the next slow Stop is refused, naming the test', (t) => {
  const s = scratch(t, 'pass');
  passedAndAged(s);
  setMode(s, 'fail-then-die');
  const a = gate(s, 'A');
  // THE PREMISES (rule 9: a shape a real run produces), asserted before anything is judged.
  assert.equal(a.killed, false, `premise: the run completed inside the budget (${a.elapsedMs}ms)`);
  assert.equal(a.blocked, true, a.text);
  const r0 = JSON.parse(readFileSync(recFile(s), 'utf8'));
  assert.equal(r0.state, 'VERIFY_PARTIAL', `premise: the run ended PARTIAL (${r0.state}: ${r0.why ?? ''})`);
  // The gate's runner uses the SPEC reporter ("✖ name"), not TAP: read the output with the gate's own parser, never a TAP regex.
  assert.deepEqual(SV.failingTests(String(r0.failing_output ?? '')).map((x) => x.name), ['first rig test'], `premise: its output names the failing test: ${r0.failing_output}`);
  assert.doesNotMatch(a.text, /No hall pass: the suite had already FAILED/, 'premise: the COMPLETED path, not the cut path');
  assert.match(a.text, /First failing test: "first rig test"/, `premise: the gate itself named the failing test: ${a.text}`);
  // THE FIX: the named red is in the write sequence.
  assert.deepEqual(logEntries(s).map((e) => `${e.seq}:${e.outcome}:${e.cut}`), ['1:pass:false', '2:fail:false'], `a named red was left out of the log: ${JSON.stringify(logEntries(s))}`);
  assert.equal(logEntries(s)[1].first, 'first rig test');
  setMode(s, 'slow');
  primed(s, 'B');
  for (const how of ['suite-running', 'lock-held']) {
    const r = how === 'lock-held' ? lockHeldGate(s, 'B') : gate(s, 'B');
    assert.equal(r.killed, false, `precondition: the gate answered (${r.elapsedMs}ms)`);
    assert.doesNotMatch(r.message, NO_HALL_PASS, `${how}: a HALL PASS after the gate itself named a failing test: ${r.text}`);
    assert.equal(r.blocked, true, r.text);
    assert.match(r.text, /First failing test: "first rig test" -- from the recorded FAIL for these inputs \(outcome log entry #2/, `${how}: ${r.text}`);
  }
});

test('T-344 r2 F1 guard: a PARTIAL run that named NO failing test appends nothing', (t) => {
  const s = scratch(t, 'pass');
  passedAndAged(s);
  setMode(s, 'die');
  const a = gate(s, 'A');
  assert.equal(a.killed, false, `premise: the run completed inside the budget (${a.elapsedMs}ms)`);
  const r0 = JSON.parse(readFileSync(recFile(s), 'utf8'));
  assert.equal(r0.state, 'VERIFY_PARTIAL', `premise: the run ended PARTIAL (${r0.state}: ${r0.why ?? ''})`);
  // With the gate's own parser: a TAP regex here once passed vacuously on spec-reporter output.
  assert.deepEqual(SV.failingTests(String(r0.failing_output ?? '')), [], `premise: no failing test is named: ${r0.failing_output}`);
  assert.deepEqual(logEntries(s).map((e) => e.outcome), ['pass'], `a partial run that proved nothing was logged: ${JSON.stringify(logEntries(s))}`);
});

test('T-344 r2 F4: a FAIL whose inputs MOVED during the run is still a FAIL entry (MG1)', (t) => {
  const s = scratch(t, 'pass');
  passedAndAged(s);
  const touched = path.join(s.dir, 'touched-during-run.txt');
  rmSync(touched, { force: true });
  setMode(s, 'fail-and-touch');
  const m = gate(s, 'A');
  assert.equal(m.blocked, true, m.text);
  assert.match(m.text, /describes no single state/, `premise: the key moved during the failing run: ${m.text}`);
  assert.ok(existsSync(touched), 'premise: the suite touched the tree');
  assert.deepEqual(logEntries(s).map((e) => e.outcome), ['pass', 'fail'], `a FAIL seen on a moving tree was not logged: ${JSON.stringify(logEntries(s))}`);
  rmSync(touched, { force: true });                      // the tree is back to the inputs the FAIL was logged for
  setMode(s, 'slow');
  const r = lockHeldGate(s, 'A');
  assert.doesNotMatch(r.message, NO_HALL_PASS, `a hall pass after a FAIL on these inputs: ${r.text}`);
  assert.match(r.text, /is a FAIL \(outcome log entry #2\)/, r.text);
});

test('T-344 r2 F5: a verify record the OS cannot read (a DIRECTORY at its path) VETOES the hall pass (MG2)', (t) => {
  const s = scratch(t, 'pass');
  passedAndAged(s);
  const control = lockHeldGate(s, 'A');
  assert.match(control.message, HALL_PASS, `POSITIVE CONTROL: the same state with a readable record gets its hall pass: ${control.text}`);
  rmSync(path.join(stateDir(s), 'stop-debts'), { recursive: true, force: true });
  const f = recFile(s);
  rmSync(f);
  mkdirSync(f);                                          // readFileSync -> EISDIR: an OS read error, not an absence
  const r = lockHeldGate(s, 'A');
  assert.doesNotMatch(r.message, NO_HALL_PASS, `an OS read error on the record was read as "no veto": ${r.text}`);
  assert.equal(r.blocked, true, r.text);
  assert.match(r.text, /No hall pass: the verify record for these inputs exists but cannot be read/, r.text);
});

test('T-344 r2 F2: the log ROOT replaced by a file refuses; a FAIL that cannot be appended SAYS so, exactly (PINNED LIMIT B-52)', (t) => {
  const s = scratch(t, 'pass');
  passedAndAged(s);
  const control = lockHeldGate(s, 'A');
  assert.match(control.message, HALL_PASS, `POSITIVE CONTROL: before the root is touched, a hall pass: ${control.text}`);
  rmSync(path.join(stateDir(s), 'stop-debts'), { recursive: true, force: true });
  const root = path.join(s.home, 'verify-outcomes');
  rmSync(root, { recursive: true });
  writeFileSync(root, 'x');
  // F2a: a root that is a file is not "nothing ever completed".
  const r1 = lockHeldGate(s, 'A');
  assert.doesNotMatch(r1.message, NO_HALL_PASS, `the log ROOT as a file read as "none": ${r1.text}`);
  assert.equal(r1.blocked, true, r1.text);
  assert.match(r1.text, /No hall pass: the outcome log for these inputs could not be read/, r1.text);
  // F2b, PINNED (B-52, an accepted limit): a FAIL that cannot be appended is SAID by this Stop, in these exact words.
  setMode(s, 'fail');
  const f = gate(s, 'A');
  assert.equal(f.blocked, true, `precondition: the failing run is refused: ${f.text}`);
  assert.match(f.text, /\[agentbridge:stop-outcome-unrecorded\] This run's FAIL could not be added to the outcome log for these inputs \(.+\); a later Stop will not know of it\./,
    `the unrecorded-FAIL notice changed or vanished (B-52 pins it): ${f.text}`);
  assert.match(f.text, /could not be listed \(the outcome log root is not a directory\)/, `the notice names why: ${f.text}`);
  // And while the root stays a file, the next Stop still refuses (F2a), so this FAIL is not forgotten HERE.
  setMode(s, 'slow');
  const r2 = lockHeldGate(s, 'A');
  assert.doesNotMatch(r2.message, NO_HALL_PASS, `a hall pass after an unrecorded FAIL, root still a file: ${r2.text}`);
  assert.equal(r2.blocked, true, r2.text);
});

test('T-344 PINNED LIMIT: the outcome log DELETED reads as "nothing ever completed" -- a hall pass (the "none" ruling)', (t) => {
  const s = scratch(t, 'pass');
  primed(s, 'A');
  failFirst(s, 'A');
  const refused = lockHeldGate(s, 'A');
  assert.equal(refused.blocked, true, 'POSITIVE CONTROL: the FAIL refuses while the log exists');
  rmSync(path.join(s.home, 'verify-outcomes'), { recursive: true });
  const r = lockHeldGate(s, 'A');
  assert.match(r.message, HALL_PASS, 'if this goes red, deleting the log is no longer "none": re-read the ruling and this limit');
});

/* ── T-353 (T-344 §8 V2-F1): THE DECISION READS THE WHOLE SHARD STREAM, NOT THE 6000-CHARACTER DISPLAY TAIL ── */

test('T-353 a COMPLETED run whose red is followed by 120 passing tests (out of the display tail) is a FAIL entry -- the next slow Stop is refused', (t) => {
  const s = scratch(t, 'pass');
  passedAndAged(s);
  setMode(s, 'tail-then-die');
  const a = gate(s, 'A');
  assert.equal(a.killed, false, `premise: the run completed inside the budget (${a.elapsedMs}ms)`);
  assert.equal(a.blocked, true, a.text);
  assert.doesNotMatch(a.text, /No hall pass: the suite had already FAILED/, 'premise: the COMPLETED path, not the cut path');
  const r0 = JSON.parse(readFileSync(recFile(s), 'utf8'));
  assert.equal(r0.state, 'VERIFY_PARTIAL', `premise: the run ended PARTIAL (${r0.state}: ${r0.why ?? ''})`);
  // RULE 9: the fixture reaches the defect -- the DISPLAY tail no longer names the red, and it is full.
  assert.equal(String(r0.failing_output ?? '').length, 6000, 'premise: the display tail is full (6000 characters)');
  assert.deepEqual(SV.failingTests(String(r0.failing_output ?? '')), [], 'premise: the display tail does NOT name the red');
  assert.deepEqual(SV.failuresIn(SV.decisionTexts(r0)).map((x) => x.name), ['first rig test'], `the scanned stream lost the red: ${JSON.stringify(r0.failure_excerpts)}`);
  // THE FIX: the red is in the write sequence, named.
  assert.deepEqual(logEntries(s).map((e) => `${e.seq}:${e.outcome}:${e.cut}`), ['1:pass:false', '2:fail:false'], `a red past the display tail was left out of the log: ${JSON.stringify(logEntries(s))}`);
  assert.equal(logEntries(s)[1].first, 'first rig test', 'the FAIL entry names the red from the whole stream');
  assert.match(a.text, /First failing test: "first rig test"/, `the refusal names the red: ${a.text}`);
  setMode(s, 'slow');
  primed(s, 'B');
  for (const how of ['suite-running', 'lock-held']) {
    const r = how === 'lock-held' ? lockHeldGate(s, 'B') : gate(s, 'B');
    assert.equal(r.killed, false, `precondition: the gate answered (${r.elapsedMs}ms)`);
    assert.doesNotMatch(r.message, NO_HALL_PASS, `${how}: a HALL PASS after a red that fell out of the display tail: ${r.text}`);
    assert.equal(r.blocked, true, r.text);
    assert.match(r.text, /First failing test: "first rig test" -- from the recorded FAIL for these inputs \(outcome log entry #2/, `${how}: ${r.text}`);
  }
});

test('T-353 a run CUT at the budget after a red followed by 120 passing tests: the cut path sees the red -- no hall pass for A, a FAIL entry for B', (t) => {
  const s = scratch(t, 'pass');
  passedAndAged(s);
  setMode(s, 'tail-then-slow');
  const a = gate(s, 'A');
  assert.equal(a.killed, false, `premise: the gate answered inside the hook timeout (${a.elapsedMs}ms)`);
  assert.match(a.text, /\[agentbridge:stop-run-stopped\]/, `premise: the run was CUT: ${a.text}`);
  const r0 = JSON.parse(readFileSync(recFile(s), 'utf8'));
  assert.deepEqual(SV.failingTests(String(r0.failing_output ?? '')), [], 'premise: the display tail does NOT name the red');
  assert.doesNotMatch(a.message, NO_HALL_PASS, `A, whose own run printed the red, got a HALL PASS: ${a.text}`);
  assert.match(a.text, /No hall pass: the suite had already FAILED/, `the cut path saw the red: ${a.text}`);
  assert.deepEqual(logEntries(s).map((e) => `${e.seq}:${e.outcome}:${e.cut}`), ['1:pass:false', '2:fail:true'], `the cut red was not logged: ${JSON.stringify(logEntries(s))}`);
  assert.equal(logEntries(s)[1].first, 'first rig test');
  setMode(s, 'slow');
  primed(s, 'B');
  const r = lockHeldGate(s, 'B');
  assert.equal(r.killed, false);
  assert.doesNotMatch(r.message, NO_HALL_PASS, `B: a HALL PASS after a cut red: ${r.text}`);
  assert.match(r.text, /outcome log entry #2, a run cut after it failed/, r.text);
});
