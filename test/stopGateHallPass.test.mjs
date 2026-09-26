/*
 * T-273: THE HALL PASS, DRIVEN THROUGH THE REAL (MERGED) GATE.
 *
 * Owner (typed, relayed by the Controller): "if your job runs late you can't be
 * dinged if it runs." When the Stop gate cannot FINISH verification in its budget
 * -- the suite is still running, or another session's run holds the one-suite lock
 * -- it ends the turn with [agentbridge:stop-hall-pass]: UNVERIFIED, STILL OWED,
 * never an approval. The owed key is written to guard-sessions/stop-debts/, and
 * the SAME session's next Stop must settle it: a PASS clears it, a FAIL refuses
 * naming the failing test, and a second hall pass is refused.
 *
 * THE SUITE'S OUTCOME IS DECIDED OUTSIDE THE KEY, by a mode file in a control
 * directory that lives outside the repository, the home and the secrets dir. So
 * every run in a test has the SAME key -- the a543adf9 shape (T-265) -- and only
 * the mode moves the verdict. Every gate in a test gets the same environment.
 *
 * MERGED GATE: results live in <home>/verify/<key>.json (one record per key,
 * overwritten), and every notice rides in systemMessage, so assertions read the
 * reason and the message together.
 *
 * T-344: whether a hall pass may be given is decided by ONE source, the per-key
 * outcome log <home>/verify-outcomes/<key>/<seq>.json; records and failure files
 * are views (see "RECORDS AND FAILURE FILES ARE VIEWS" below).
 *
 * NODE_TEST* is stripped: a nested runner that inherits NODE_TEST_CONTEXT
 * reports in the child protocol instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* 20 s declared: ~9 s for verification after the 10 s output reserve -- inside the 5 s minimum with margin. */
const HOOK_TIMEOUT_S = 20;

const RIG_SUITE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
const mode = readFileSync(path.join(process.env.RIG_CTL, 'mode'), 'utf8').trim();
test('first rig test', () => { if (mode === 'fail' || mode === 'fail-then-slow') assert.fail('rig says red: ' + mode); });
test('second rig test', async () => {
  if (mode === 'slow' || mode === 'fail-then-slow') await new Promise((r) => { setTimeout(r, 60_000); });
});
test('leaking rig test', () => {
  if (mode !== 'leak') return;
  const sec = readFileSync(path.join(process.env.AGENTBRIDGE_SECRETS_DIR, 'leak.txt'), 'utf8');
  const env = process.env.RIG_LEAK_ENV;
  assert.fail(\`leak env=\${env} envjson=\${JSON.stringify(env)} raw=\${sec} json=\${JSON.stringify(sec)} b64=\${Buffer.from(sec).toString('base64')} up=\${sec.toUpperCase()}\`);
});
`;

function removeScratch(dir) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; } catch (e) {
      if (e?.code !== 'EPERM' && e?.code !== 'EBUSY') throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  process.stderr.write(`[stopGateHallPass] could not remove ${dir}: a killed child still holds it\n`);
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

test('HALL PASS: a suite still running at the budget ends the turn unblocked, tagged, owed -- and writes NO pass', (t) => {
  const s = scratch(t, 'slow');
  primed(s, 'A');
  const r = gate(s, 'A');
  assert.equal(r.killed, false, `the killer won: the gate rendered nothing (${r.elapsedMs}ms)`);
  assert.equal(r.blocked, false, `a late job must not be refused: ${r.text}`);
  assert.match(r.message, HALL_PASS, r.text);
  assert.match(r.message, /the suite was still running when this gate's budget ran out/, r.text);
  assert.match(r.message, /\[agentbridge:stop-run-stopped\] [1-9]\d* suite process\(es\) were killed rather than orphaned/, r.text);
  const owed = debts(s);
  assert.equal(owed.length, 1, 'the owed key is recorded');
  assert.equal(owed[0].session, 'A');
  assert.equal(owed[0].cause, 'suite-running');
  assert.ok(r.message.includes(owed[0].key.slice(0, 16)), 'the message names the owed key');
  assert.equal(records(s).some((x) => x.state === 'VERIFY_PASSED'), false, 'a hall pass wrote a PASSED record');
  assert.equal(events(s).at(-1).verdict, 'hall-pass', 'the event log says hall-pass, not approve');
  assert.equal(events(s).at(-1).tag, 'stop-hall-pass');
});

test('THE DEBT: the same session cannot defer it, a FAIL refuses naming the test, a PASS settles it', (t) => {
  const s = scratch(t, 'slow');
  primed(s, 'A');
  assert.match(gate(s, 'A').message, HALL_PASS, 'precondition: a hall pass was issued');
  const owedKey = debts(s)[0].key;
  // 1. Still slow: a SECOND hall pass is refused, so this Stop refuses with stop-deadline and says why.
  const again = gate(s, 'A');
  assert.equal(again.blocked, true, `a debt was deferred by a second hall pass: ${again.text}`);
  assert.match(again.reason, /^\[agentbridge:stop-deadline\]/, again.text);
  assert.match(again.text, /\[agentbridge:stop-hall-pass-refused\] No hall pass: this session already owes verification/, again.text);
  assert.match(again.text, /\[agentbridge:stop-hall-pass-owed\]/, again.text);
  assert.equal(debts(s).length, 1, 'the debt is still owed');
  // 2. Red: the FAIL refuses and NAMES the failing test; the debt stays.
  setMode(s, 'fail');
  const red = gate(s, 'A');
  assert.equal(red.blocked, true, `a FAIL settled a debt: ${red.text}`);
  assert.match(red.reason, /^\[agentbridge:verify-failed\]/, red.text);
  assert.match(red.reason, /\[agentbridge:stop-failing-test\] First failing test: "first rig test"/, red.text);
  assert.equal(debts(s).length, 1, 'a FAIL does not settle the debt');
  // 3. Green: a PASS from a fresh run settles it, and says so.
  setMode(s, 'pass');
  const green = gate(s, 'A');
  assert.equal(green.blocked, false, `the passing tree must be approved: ${green.text}`);
  assert.match(green.message, /\[agentbridge:stop-hall-pass-settled\] The earlier hall pass \(key [0-9a-f]{16}, since [^)]+\) is settled by a PASS from this run\./, green.text);
  assert.ok(green.message.includes(owedKey.slice(0, 16)), 'the settled key is the owed one');
  assert.doesNotMatch(green.message, /stop-hall-pass-owed/, 'the owed notice is withdrawn once settled');
  assert.equal(debts(s).length, 0, 'the debt file is gone');
  assert.equal(records(s).length, 1, 'precondition: one key (one store record) throughout -- the mode lives outside it');
  // THE EVENT LOG (T-264 patch 3, ported): one line per exit, tags only.
  assert.deepEqual(events(s).map((e) => `${e.verdict}:${e.tag}`), [
    'block:baseline-created', 'hall-pass:stop-hall-pass', 'block:stop-deadline', 'block:verify-failed', 'approve:null',
  ]);
});

test('T-273 port: a failing verification keeps its test\'s name, and env and secrets-dir values reach no output', (t) => {
  const s = scratch(t, 'leak');
  const MARK = `t273-LeAk-${process.pid}-q7'"\\z`;
  const ENV_MARK = `t273-envmark-${process.pid}-w3`;
  writeFileSync(path.join(s.secrets, 'leak.txt'), MARK);
  const env = { RIG_LEAK_ENV: ENV_MARK };
  assert.match(gate(s, 'A', env).reason, /baseline-created/);
  const r = gate(s, 'A', env);
  assert.equal(r.blocked, true, `precondition: the leaking test failed: ${r.text}`);
  assert.match(r.reason, /\[agentbridge:stop-failing-test\] First failing test: "leaking rig test" \(1 failing test\(s\) named; kept in /, r.text);
  const dir = path.join(stateDir(s), 'stop-failures');
  const files = readdirSync(dir);
  assert.equal(files.length, 1, 'one failure file');
  const text = readFileSync(path.join(dir, files[0]), 'utf8');
  // POSITIVE CONTROL: the message WAS captured, and its values were replaced rather than simply missing.
  assert.ok(text.includes('not ok - leaking rig test'), text);
  assert.ok(text.includes('leak env=[redacted:env:RIG_LEAK_ENV]'), text);
  assert.ok(/raw=\[redacted:secret\]/.test(text) && /b64=\[redacted:secret\]/.test(text) && /up=\[redacted:secret\]/.test(text), text);
  for (const x of [text, r.text, readFileSync(path.join(stateDir(s), 'stop-events.jsonl'), 'utf8')]) {
    const low = x.toLowerCase();
    assert.equal(low.includes('t273-leak'), false, `a fragment of the secrets-dir value leaked:\n${x}`);
    assert.equal(low.includes('t273-envmark'), false, `a fragment of the env value leaked:\n${x}`);
  }
});

test('HALL PASS on the lock wait: another session\'s run holds the one-suite lock through the budget', (t) => {
  const s = scratch(t, 'pass');
  primed(s, 'A');
  const lock = path.join(stateDir(s), 'stop-suite.lock');
  // A LIVE holder (this test process), within its own budget: never stale, so the waiter waits it out.
  writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), budgetMs: 600_000 }));
  const r = gate(s, 'A');
  rmSync(lock, { force: true });
  assert.equal(r.blocked, false, `waiting on another run is a late job, not a failure: ${r.text}`);
  assert.match(r.message, HALL_PASS, r.text);
  assert.match(r.message, /another Stop gate's run held the one-suite lock/, r.text);
  assert.equal(debts(s)[0]?.cause, 'lock-held');
  assert.deepEqual(records(s), [], 'a waiter that never ran records nothing');
});

test('A HALL PASS IS NEVER A PASS: another session on the same inputs runs the suite, and its PASS settles the owed one', (t) => {
  const s = scratch(t, 'pass');
  primed(s, 'A');
  primed(s, 'B');
  const lock = path.join(stateDir(s), 'stop-suite.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), budgetMs: 600_000 }));
  assert.match(gate(s, 'A').message, HALL_PASS, 'precondition: A holds a hall pass');
  rmSync(lock, { force: true });
  const b = gate(s, 'B');
  assert.doesNotMatch(b.text, /stop-verdict-reused/, `a hall pass was REUSED as a pass: ${b.text}`);
  assert.equal(b.blocked, false, `B ran the passing suite: ${b.text}`);
  assert.doesNotMatch(b.text, /stop-hall-pass/, 'A\'s debt is A\'s: B is not charged for it');
  assert.deepEqual(records(s).map((x) => x.state), ['VERIFY_PASSED'], 'B\'s run is the only record');
  // A's next Stop: B's PASS was recorded after A's hall pass, for these inputs -- it settles the debt, by reuse.
  const a = gate(s, 'A');
  assert.equal(a.blocked, false, a.text);
  assert.match(a.message, /stop-verdict-reused/, a.text);
  assert.match(a.message, /\[agentbridge:stop-hall-pass-settled\]/, a.text);
  assert.equal(debts(s).length, 0);
});

test('THE DEBT REFUSES A REUSE THAT DOES NOT SETTLE IT: a PASS for another state, recorded BEFORE the hall pass, is not taken', (t) => {
  const s = scratch(t, 'pass');
  primed(s, 'A');
  const x = gate(s, 'A');                                        // state X passes and is recorded
  assert.equal(x.blocked, false, `precondition: X passes: ${x.text}`);
  const notes = path.join(s.dir, 'notes.txt');
  writeFileSync(notes, 'y\n');                                   // state Y: an untracked file is in the key
  const lock = path.join(stateDir(s), 'stop-suite.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), budgetMs: 600_000 }));
  const y = gate(s, 'A');
  rmSync(lock, { force: true });
  assert.match(y.message, HALL_PASS, `precondition: a hall pass on Y: ${y.text}`);
  assert.notEqual(debts(s)[0].key, records(s)[0].identity.tree_digest, 'precondition: the owed key (Y) is not X\'s');
  rmSync(notes);                                                 // back to X, whose PASS predates the hall pass
  const back = gate(s, 'A');
  assert.doesNotMatch(back.text, /stop-verdict-reused/, `a PASS that does not settle the debt was reused: ${back.text}`);
  assert.equal(back.blocked, false, `X ran again and passed: ${back.text}`);
  assert.match(back.message, /\[agentbridge:stop-hall-pass-settled\][^\n]* is settled by a PASS from this run\./, back.text);
  assert.equal(debts(s).length, 0);
});

test('THE ONE-HOUR WINDOW, THROUGH THE REAL GATE: 20 minutes is reused (NOT FRESH), 61 minutes runs', (t) => {
  const s = scratch(t, 'pass');
  primed(s, 'A');
  assert.equal(gate(s, 'A').blocked, false, 'precondition: a PASS is recorded');
  const dir = path.join(s.home, 'verify');
  const age = (min) => {
    for (const n of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const r = JSON.parse(readFileSync(path.join(dir, n), 'utf8'));
      writeFileSync(path.join(dir, n), JSON.stringify({ ...r, finished_at: Date.now() - min * 60_000 }, null, 2));
    }
  };
  age(20);
  const twenty = gate(s, 'A');
  assert.match(twenty.message, /stop-verdict-reused\] The suite was NOT run for this turn\. NOT FRESH: this PASS is 20 minutes old/,
    `a 20-minute-old PASS for these exact inputs must be reused, labelled NOT FRESH (a call site that re-narrows the window fails here): ${twenty.text}`);
  age(61);
  const sixtyOne = gate(s, 'A');
  assert.doesNotMatch(sixtyOne.text, /stop-verdict-reused/, `a PASS past the hour was reused: ${sixtyOne.text}`);
  assert.equal(sixtyOne.blocked, false, `the suite ran and passed: ${sixtyOne.text}`);
});

test('NO hall pass when the suite had already FAILED before the budget ran out', (t) => {
  const s = scratch(t, 'fail-then-slow');
  primed(s, 'A');
  const r = gate(s, 'A');
  assert.equal(r.blocked, true, `a suite that FAILED got a hall pass: ${r.text}`);
  assert.match(r.reason, /^\[agentbridge:stop-deadline\] Verification was still running/, `precondition: the run was cut at the budget: ${r.text}`);
  assert.match(r.text, /\[agentbridge:stop-hall-pass-refused\] No hall pass: the suite had already FAILED/, r.text);
  assert.match(r.text, /\[agentbridge:stop-failing-test\] First failing test: "first rig test"/, r.text);
  assert.equal(debts(s).length, 0, 'nothing is owed: it is refused');
});

/*
 * T-273 r2 F1 (T-292 blind verify, HIGH): a KNOWN FAIL for these inputs, followed by a SLOW run on the same inputs,
 * got a hall pass. The store keeps ONE record per key, and the runner writes RUNNING at its start (and PARTIAL on
 * abort) over the FAILED record -- so by the time the hall-pass decision read the store, the FAIL was gone.
 */
test('F1: a KNOWN FAIL for these inputs, then a SLOW run on the same inputs, is BLOCKED naming the failing test -- never a hall pass', (t) => {
  const s = scratch(t, 'fail');
  primed(s, 'A');
  primed(s, 'B');
  const red = gate(s, 'A');
  assert.equal(red.blocked, true, `precondition: the suite fails: ${red.text}`);
  assert.deepEqual(records(s).map((x) => x.state), ['VERIFY_FAILED'], 'precondition: VERIFY_FAILED is recorded for the key');
  const failedKey = records(s)[0].identity.tree_digest;
  setMode(s, 'slow');                                            // SAME key: the mode lives outside it
  for (const session of ['A', 'B']) {                           // the session that saw the FAIL, and one that did not
    const r = gate(s, session);
    assert.equal(r.killed, false, `precondition: the gate answered (${r.elapsedMs}ms)`);
    assert.doesNotMatch(r.message, /\[agentbridge:stop-hall-pass\] UNVERIFIED/, `${session}: a hall pass after a KNOWN FAIL: ${r.text}`);
    assert.equal(r.blocked, true, `${session}: a slow run after a known FAIL must refuse: ${r.text}`);
    assert.match(r.reason, /^\[agentbridge:stop-deadline\] Verification was still running/, `${session}: precondition: the run was cut at the budget: ${r.text}`);
    assert.match(r.text, /\[agentbridge:stop-hall-pass-refused\] No hall pass: the newest completed result for these inputs is a FAIL/,
      `${session}: the refusal does not say a known FAIL is why there is no hall pass: ${r.text}`);
    assert.match(r.text, /\[agentbridge:stop-failing-test\] First failing test: "first rig test" -- from the recorded FAIL for these inputs/,
      `${session}: the refusal does not name the failing test of the known FAIL: ${r.text}`);
    // THE PREMISE OF THE BUG, asserted so this test cannot pass by never reaching it (rule 9): the one-per-key
    // record no longer SAYS failed -- the aborted run overwrote it.
    assert.notEqual(records(s)[0].state, 'VERIFY_FAILED', 'premise: the runner overwrote the FAILED record');
    assert.equal(records(s)[0].identity.tree_digest, failedKey, 'premise: the same key throughout');
  }
  assert.equal(debts(s).length, 0, 'nothing is owed: both were refused');
  // And the rule recovers: a PASS on these inputs, then a slow run, IS a late job again.
  setMode(s, 'pass');
  assert.equal(gate(s, 'A').blocked, false, 'the passing tree is approved');
  // The fresh PASS would be reused; move it out of the window so the next Stop runs (slowly).
  const dir = path.join(s.home, 'verify');
  for (const n of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const rec = JSON.parse(readFileSync(path.join(dir, n), 'utf8'));
    writeFileSync(path.join(dir, n), JSON.stringify({ ...rec, finished_at: Date.now() - 2 * 3_600_000 }, null, 2));
  }
  setMode(s, 'slow');
  assert.match(gate(s, 'A').message, HALL_PASS, 'after a newer PASS, a slow run is a late job again');
});

test('T-273 one-byte: a one-byte change to a TRACKED file is a new key -- the real gate runs, it does not reuse', (t) => {
  const s = scratch(t, 'pass');
  primed(s, 'A');
  const first = gate(s, 'A');
  assert.equal(first.blocked, false, `precondition: the first run passes: ${first.text}`);
  assert.doesNotMatch(first.text, /stop-verdict-reused/, 'precondition: the first run actually ran');
  assert.match(gate(s, 'A').message, /stop-verdict-reused/, 'POSITIVE CONTROL: the unchanged tree reuses');
  const f = path.join(s.dir, 'rig', 'data.txt');                 // tracked (committed by scratch()), not protected
  const before = readFileSync(f);
  writeFileSync(f, 'y\n');
  const after = readFileSync(f);
  assert.equal(after.length, before.length, 'precondition: same length');
  assert.equal([...after].filter((b, i) => b !== before[i]).length, 1, 'precondition: exactly one byte differs');
  const changed = gate(s, 'A');
  assert.doesNotMatch(changed.text, /stop-verdict-reused/, `a PASS was reused across a one-byte change to a tracked file: ${changed.text}`);
  assert.equal(changed.blocked, false, `the changed tree ran and passed: ${changed.text}`);
  assert.equal(records(s).filter((x) => x.state === 'VERIFY_PASSED').length, 2, 'the changed tree has its own PASSED record');
});

/*
 * T-273 r2 F5 (T-292, LOW): a hall pass must never hide the audit escalation. The rig gets a REAL upstream, so the
 * escalation BLOCKS (a pushed, unaudited control commit). Positive control: without the upstream, the SAME slow
 * suite gets a hall pass -- so the refusal here is the escalation's doing and nothing else's.
 */
test('F5: a hall pass never hides the audit escalation (a real upstream makes it block)', (t) => {
  const control = scratch(t, 'slow');
  primed(control, 'A');
  assert.match(gate(control, 'A').message, HALL_PASS, 'POSITIVE CONTROL: no upstream, no escalation: a hall pass');
  const s = scratch(t, 'pass', { upstream: true });
  primed(s, 'A');
  // PRECONDITION, measured on its own: in this rig the escalation BLOCKS even a green, fast suite.
  const green = gate(s, 'A');
  assert.equal(green.blocked, true, `precondition: the escalation blocks a passing tree in this rig: ${green.text}`);
  assert.match(green.reason, /^\[agentbridge:audit-escaped\]/, `precondition: and it is the escalation that blocks: ${green.text}`);
  // Age that PASS out of the reuse window, so the next Stop RUNS -- slowly.
  const vdir = path.join(s.home, 'verify');
  for (const n of readdirSync(vdir).filter((f) => f.endsWith('.json'))) {
    const rec = JSON.parse(readFileSync(path.join(vdir, n), 'utf8'));
    writeFileSync(path.join(vdir, n), JSON.stringify({ ...rec, finished_at: Date.now() - 2 * 3_600_000 }, null, 2));
  }
  setMode(s, 'slow');
  const r = gate(s, 'A');
  assert.equal(r.killed, false, `precondition: the gate answered (${r.elapsedMs}ms)`);
  assert.doesNotMatch(r.message, /\[agentbridge:stop-hall-pass\] UNVERIFIED/, `a hall pass hid the audit escalation: ${r.text}`);
  assert.equal(r.blocked, true, `the turn must be refused: ${r.text}`);
  assert.match(r.text, /\[agentbridge:audit-escaped\]/, `the refusal must still carry the escalation: ${r.text}`);
  assert.match(r.text, /\[agentbridge:stop-hall-pass-refused\] No hall pass: the audit escalation is refusing this turn/,
    `the refusal does not say the escalation is why there is no hall pass: ${r.text}`);
  assert.equal(debts(s).length, 0, 'nothing is owed: it was refused');
});

/* ── T-273 r3 (T-323 blind verify): a hall pass needs POSITIVE evidence ── */

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
const CORRUPTIONS = {
  'NUL-filled at the same size (as a crash leaves it)': (buf) => Buffer.alloc(buf.length),
  empty: () => Buffer.alloc(0),
  truncated: (buf) => buf.subarray(0, Math.floor(buf.length / 2)),
  deleted: () => null,                                          // only the kept failure file can refuse this one
};

for (const [how, corrupt] of Object.entries(CORRUPTIONS)) {
  test(`F7: FAIL, then the verify record is ${how}, then a SLOW run -- refused, never a hall pass`, (t) => {
    const s = scratch(t, 'pass');
    primed(s, 'A');
    failFirst(s, 'A');
    const f = recFile(s);
    const after = corrupt(readFileSync(f));
    if (after === null) rmSync(f); else writeFileSync(f, after);
    assert.throws(() => JSON.parse(readFileSync(f, 'utf8')), 'precondition: the record is unreadable or gone');
    assert.equal(failureFiles(s).length, 1, 'precondition: the failing Stop kept its failure file');
    setMode(s, 'slow');
    const r = gate(s, 'A');
    assert.equal(r.killed, false, `precondition: the gate answered (${r.elapsedMs}ms)`);
    assert.doesNotMatch(r.message, /\[agentbridge:stop-hall-pass\] UNVERIFIED/, `F7(${how}): a hall pass after a FAIL whose record became unreadable: ${r.text}`);
    assert.equal(r.blocked, true, `F7(${how}): the slow run must be refused: ${r.text}`);
    assert.match(r.text, /\[agentbridge:stop-hall-pass-refused\] No hall pass: /, `F7(${how}): the refusal must say why there is no hall pass: ${r.text}`);
    assert.match(r.text, /\[agentbridge:stop-failing-test\] First failing test: "first rig test" -- from the recorded FAIL for these inputs/,
      `F7(${how}): the known FAIL must be named (T-344: from the outcome log, whatever became of the record): ${r.text}`);
    assert.equal(debts(s).length, 0, 'nothing is owed');
  });
}

test('F7b: FAIL, record NUL-filled, failure file GONE too -- still refused (T-344: the outcome log still holds the FAIL)', (t) => {
  const s = scratch(t, 'pass');
  primed(s, 'A');
  failFirst(s, 'A');
  const f = recFile(s);
  writeFileSync(f, Buffer.alloc(readFileSync(f).length));
  rmSync(path.join(stateDir(s), 'stop-failures'), { recursive: true, force: true });
  assert.equal(failureFiles(s).length, 0, 'precondition: no failure file remains');
  setMode(s, 'slow');
  const r = gate(s, 'A');
  assert.doesNotMatch(r.message, /\[agentbridge:stop-hall-pass\] UNVERIFIED/, `F7b: a hall pass after an unreadable record with no failure file: ${r.text}`);
  assert.equal(r.blocked, true, `F7b: refused: ${r.text}`);
  // ... and it stays refused on the NEXT slow run too, although the run in between rewrote the record readable.
  const again = gate(s, 'A');
  assert.doesNotMatch(again.message, /\[agentbridge:stop-hall-pass\] UNVERIFIED/, `F7b: the doubt was lost on the next run: ${again.text}`);
  // A PASS clears the doubt: then a slow run is a late job again.
  setMode(s, 'pass');
  assert.equal(gate(s, 'A').blocked, false, 'the passing tree is approved');
  const f2 = recFile(s);
  writeFileSync(f2, JSON.stringify({ ...JSON.parse(readFileSync(f2, 'utf8')), finished_at: Date.now() - 2 * 3_600_000 }, null, 2));
  setMode(s, 'slow');
  assert.match(gate(s, 'A').message, HALL_PASS, 'POSITIVE CONTROL: after a real PASS, a slow run gets its hall pass');
});

test('F8: the clock steps BACK between a PASS and a FAIL -- the record\'s own FAIL outranks its carried PASS (lock-held path)', (t) => {
  const s = scratch(t, 'pass');
  primed(s, 'A');
  assert.equal(gate(s, 'A').blocked, false, 'precondition: a PASS is recorded');
  const f = recFile(s);
  // The clock steps back 2 h: the PASS's finished_at is now 2 h AHEAD of Date.now().
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), finished_at: Date.now() + 2 * 3_600_000 }, null, 2));
  setMode(s, 'fail');
  assert.equal(gate(s, 'A').blocked, true, 'precondition: the FAIL run refuses');
  const rec = JSON.parse(readFileSync(recFile(s), 'utf8'));
  assert.equal(rec.state, 'VERIFY_FAILED', 'precondition: FAILED recorded');
  assert.equal(rec.last_completed?.state, 'VERIFY_PASSED', 'precondition: it carries the earlier PASS');
  assert.ok(rec.last_completed.finished_at > rec.finished_at, 'precondition: the carried PASS is timestamped LATER than the FAIL');
  holdLock(s);
  const r = gate(s, 'A');
  dropLock(s);
  assert.doesNotMatch(r.message, /\[agentbridge:stop-hall-pass\] UNVERIFIED/, `F8: a hall pass after a FAIL, because a skewed carried PASS looked newer: ${r.text}`);
  assert.equal(r.blocked, true, `F8: refused: ${r.text}`);
  assert.match(r.text, /No hall pass: the newest completed result for these inputs is a FAIL/, `F8: the refusal must name the known FAIL: ${r.text}`);
});

const LC_VARIANTS = {
  'finished_at as a string': (lc) => ({ ...lc, finished_at: String(lc.finished_at) }),
  'state lower-cased': (lc) => ({ ...lc, state: 'verify_failed' }),
  'a string': () => 'VERIFY_FAILED',
  'an array': (lc) => [lc],
  'finished_at 1e20': (lc) => ({ ...lc, finished_at: 1e20 }),
  'a PASS newer than this run began': (lc) => ({ state: 'VERIFY_PASSED', finished_at: lc.finished_at + 3_600_000 }),
  'a number': () => 7,
};
test('F9: a wrong-typed or inconsistent carried result never opens a hall pass (T-344: the log decides) -- lock-held path', (t) => {
  for (const [name, fn] of Object.entries(LC_VARIANTS)) {
    const s = scratch(t, 'pass');
    primed(s, 'A');
    failFirst(s, 'A');
    setMode(s, 'slow');
    assert.equal(gate(s, 'A').blocked, true, `${name}: precondition: the slow run after the FAIL is refused`);
    const f = recFile(s);
    const rec = JSON.parse(readFileSync(f, 'utf8'));
    assert.equal(rec.last_completed?.state, 'VERIFY_FAILED', `${name}: precondition: the cut run carries the FAIL`);
    writeFileSync(f, JSON.stringify({ ...rec, last_completed: fn(rec.last_completed) }, null, 2));
    // T-344: the carried value is a VIEW now, and the refusal comes from the outcome log, which holds the FAIL.
    // Kept as a regression test: a malformed carried result must never make the gate ALLOW. (The failure file is
    // removed too, so neither view is left to name anything.)
    rmSync(path.join(stateDir(s), 'stop-failures'), { recursive: true, force: true });
    holdLock(s);
    const r = gate(s, 'A');
    dropLock(s);
    assert.equal(r.killed, false, `${name}: precondition: the gate answered`);
    assert.doesNotMatch(r.message, /\[agentbridge:stop-hall-pass\] UNVERIFIED/, `F9(${name}): a malformed carried result failed OPEN: ${r.text}`);
    assert.equal(r.blocked, true, `F9(${name}): refused: ${r.text}`);
  }
});
