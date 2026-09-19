/**
 * THE WATCHER'S OWN LIVENESS, WHICH NOTHING MEASURED.
 *
 * Measured on this machine 2026-09-19, and it is the whole reason this file
 * exists: ~/.agentbridge/polls held two log files, BOTH 0 BYTES, and no
 * supervisor process was running for either. Two sessions had detached a
 * watcher; neither watcher was alive; nothing anywhere had noticed. The bridge
 * reported code-a silent 4884s and code-b silent 22976s, and the only reason
 * anyone found out was that send_message happened to attach a note about it.
 *
 * THE DEFECT IS NOT THAT THE WATCHER DIES. It is that dying and working
 * produced BYTE-IDENTICAL evidence. The supervisor's healthy path is
 * `continue` and `continue` -- both silent -- into a log file nobody reads,
 * and its pid record was written once at detach and never touched again. So
 * "holding a 600s poll exactly as designed" and "died forty minutes ago" were
 * the same observation: an empty log and an old startedAt.
 *
 * Absence of output cannot distinguish them, so the supervisor now leaves a
 * positive mark every cycle and records a reason on every exit. Rule 4: health
 * is asserted, never inferred from silence.
 *
 * watcherHealth is pure and exported for the reason classifyCycle was
 * extracted -- a blind audit found four uncaught mutations in logic that could
 * only be reached through a real detached spawn. Every branch below is watched
 * failing without one. The last two tests then drive the SHIPPED script,
 * because the wiring is a separate claim from the logic and only the logic has
 * unit tests (rule 17).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, linkSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { watcherHealth, darkWatchers } from '../scripts/bridge-session-poll.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLL = path.join(REPO, 'scripts', 'bridge-session-poll.mjs');

const NOW = Date.parse('2026-09-19T02:00:00Z');
const ago = (seconds) => new Date(NOW - seconds * 1000).toISOString();

test('a record that never existed is WRONG, not merely empty', () => {
  for (const nothing of [null, undefined, 'not an object', 42]) {
    const h = watcherHealth(nothing, { now: NOW, pidAlive: false });
    assert.equal(h.state, 'unknown');
    assert.equal(h.wrong, true, 'no record must be reported, not shrugged at');
  }
});

test('THE SILENT CASE: the process is gone and left no reason -- dead, and wrong', () => {
  const h = watcherHealth(
    { pid: 4242, sessionId: 'claude-x', startedAt: ago(7200), lastCycleAt: ago(3600) },
    { now: NOW, pidAlive: false },
  );
  assert.equal(h.state, 'dead');
  assert.equal(h.wrong, true);
  assert.match(h.detail, /4242/, 'name the pid so the reader can check it themselves');
  assert.match(h.detail, /no reason/, 'the absence of a reason is the finding, and must be said');
});

test('a watcher that died before its first cycle says so, rather than reporting a cycle age', () => {
  const h = watcherHealth(
    { pid: 4242, startedAt: ago(7200) },
    { now: NOW, pidAlive: false },
  );
  assert.equal(h.state, 'dead');
  assert.match(h.detail, /never completed a cycle/);
});

test('a recorded stop is reported and is STILL wrong: nobody is watching either way', () => {
  const h = watcherHealth(
    { pid: 4242, startedAt: ago(7200), lastCycleAt: ago(600), stoppedAt: ago(300), stopReason: 'permanent: error: unknown session' },
    { now: NOW, pidAlive: false },
  );
  assert.equal(h.state, 'stopped');
  assert.match(h.detail, /unknown session/, 'the reason is the point of recording it');
  assert.equal(h.wrong, true,
    'a tidy explanation on disk is still an agent that is invisible -- reporting it as fine is the bug');
});

test('a stop reason with no timestamp is still a stop, not a healthy watcher', () => {
  const h = watcherHealth(
    { pid: 4242, startedAt: ago(7200), lastCycleAt: ago(10), stopReason: 'process exited' },
    { now: NOW, pidAlive: true },
  );
  assert.equal(h.state, 'stopped', 'the reason alone is sufficient evidence that it stopped');
  assert.equal(h.wrong, true);
});

test('the quiet path is HEALTHY: a long poll that marked a cycle recently is not an alarm', () => {
  /*
   * The branch that matters most. `quiet` is by far the commonest outcome on a
   * healthy bridge, and a check that treated it as no-news-is-bad-news would
   * report every working watcher as stalled. A liveness report that cries wolf
   * gets switched off, which loses the whole layer (rule 16).
   */
  const h = watcherHealth(
    { pid: 4242, startedAt: ago(7200), lastCycleAt: ago(30), cycles: 11, lastVerdict: 'quiet' },
    { now: NOW, pidAlive: true, pollSeconds: 600 },
  );
  assert.equal(h.state, 'healthy');
  assert.equal(h.wrong, false);
  assert.match(h.detail, /11 cycles/, 'the count is the evidence that it is really cycling');
});

test('a full poll interval may elapse between marks without raising an alarm', () => {
  const h = watcherHealth(
    { pid: 4242, startedAt: ago(7200), lastCycleAt: ago(601), cycles: 3 },
    { now: NOW, pidAlive: true, pollSeconds: 600 },
  );
  assert.equal(h.state, 'healthy', 'one bounded cycle plus jitter is normal, not a stall');
  assert.equal(h.wrong, false);
});

test('an UP process that stopped cycling is STALLED -- alive is not the same as working', () => {
  const h = watcherHealth(
    { pid: 4242, startedAt: ago(7200), lastCycleAt: ago(5000), cycles: 3 },
    { now: NOW, pidAlive: true, pollSeconds: 600 },
  );
  assert.equal(h.state, 'stalled');
  assert.equal(h.wrong, true);
  assert.match(h.detail, /5000s ago/, 'give the age, so the reader can judge rather than trust');
});

test('a just-detached watcher is STARTING, but one that never cycles becomes stalled', () => {
  const young = watcherHealth(
    { pid: 4242, startedAt: ago(20) },
    { now: NOW, pidAlive: true, pollSeconds: 600 },
  );
  assert.equal(young.state, 'starting');
  assert.equal(young.wrong, false, 'a watcher in its first long poll must not be reported as broken');

  /*
   * The same record an hour later is the shape of a supervisor that started
   * and immediately wedged -- up, but never once completed a cycle.
   */
  const wedged = watcherHealth(
    { pid: 4242, startedAt: ago(3600) },
    { now: NOW, pidAlive: true, pollSeconds: 600 },
  );
  assert.equal(wedged.state, 'stalled');
  assert.equal(wedged.wrong, true);
  assert.match(wedged.detail, /never completed a cycle/);
});

/* ── the wiring, through the shipped script (rule 17) ────────────────────── */

function withHome(records) {
  const home = mkdtempSync(path.join(tmpdir(), 'watcher-status-'));
  mkdirSync(path.join(home, 'polls'), { recursive: true });
  for (const [name, rec] of Object.entries(records)) {
    writeFileSync(path.join(home, 'polls', `${name}.json`), JSON.stringify(rec, null, 2));
  }
  return home;
}

function runStatus(home) {
  const r = spawnSync(process.execPath, [POLL, '--status'], {
    cwd: REPO, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, AGENTBRIDGE_HOME: home },
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('--status exits non-zero and names the dead watcher, through the real script', () => {
  const home = withHome({
    'claude-dead': { pid: 999999, agentId: 'code-a', sessionId: 'claude-dead', startedAt: ago(7200) },
    'claude-live': { pid: process.pid, agentId: 'fixer', sessionId: 'claude-live', startedAt: ago(600), lastCycleAt: new Date().toISOString(), cycles: 4 },
  });
  try {
    const r = runStatus(home);

    assert.equal(r.status, 1, 'a dead watcher must set a non-zero exit so a cron can act on it');
    assert.match(r.out, /DEAD/, 'the dead watcher must be named as dead');
    assert.match(r.out, /code-a/, 'and attributed to its agent, because that is who is invisible');
    assert.match(r.out, /HEALTHY/, 'the live one must still read healthy -- this is not an all-red report');
    assert.match(r.out, /1 of 2/, 'the summary must count, so a reader cannot miss one line in a long list');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('--status exits 0 only when every watcher is healthy', () => {
  const home = withHome({
    'claude-live': { pid: process.pid, agentId: 'fixer', sessionId: 'claude-live', startedAt: ago(600), lastCycleAt: new Date().toISOString(), cycles: 4 },
  });
  try {
    const r = runStatus(home);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /all 1 watcher\(s\) healthy/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('AN EMPTY POLL DIRECTORY IS THE ALARM, NOT THE ALL-CLEAR', () => {
  /*
   * The literal state of this machine when the defect was found. "No records"
   * must never read as "nothing wrong": it means no session is being watched
   * at all, which is the worst case rather than the quiet one.
   */
  const home = withHome({});
  try {
    const r = runStatus(home);
    assert.equal(r.status, 1, 'no watchers at all must be a non-zero exit');
    assert.match(r.out, /NOTHING IS WATCHING/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('THE SUPERVISOR ACTUALLY WRITES THE MARK watcherHealth READS', async () => {
  /*
   * THIS TEST EXISTS BECAUSE ITS ABSENCE WAS CAUGHT BY MUTATION, AND IT IS THE
   * ONE THAT MATTERS MOST.
   *
   * Every other test here plants a record BY HAND and asks what it means. So
   * deleting the supervisor's `cycles += 1; mark(...)` entirely left the suite
   * 13/13 green: the reader was fully tested against a column NOTHING EVER
   * WROTE. That is hollow gate 3 word for word, and rule 17 -- the wiring is a
   * separate claim from the logic, and only the logic had tests.
   *
   * So this drives the REAL detached supervisor. It is pointed at a token file
   * that does not exist, so the cycle fails immediately rather than holding a
   * 600-second poll; the mark is written BEFORE the verdict is branched on, so
   * a failing cycle must still leave one. What is asserted is the thing the
   * reader depends on: lastCycleAt and cycles appearing in the record.
   */
  const home = mkdtempSync(path.join(tmpdir(), 'supervise-mark-'));
  mkdirSync(path.join(home, 'polls'), { recursive: true });
  const sessionId = 'claude-marktest';
  const recFile = path.join(home, 'polls', `${sessionId}.json`);

  const child = spawn(process.execPath, [
    POLL, '--supervise', '--session', sessionId,
    '--token-file', path.join(home, 'no-such-token.txt'),
  ], { cwd: REPO, env: { ...process.env, AGENTBRIDGE_HOME: home }, stdio: 'ignore' });

  try {
    let rec = null;
    /*
     * SHORTER THAN THE RUNNER'S TIMEOUT, DELIBERATELY. If this wait outlasts
     * --test-timeout the test is CANCELLED rather than failed, and a
     * cancellation is not counted in `fail` -- so a harness scoring failures
     * reads "the supervisor stopped marking cycles" as UNCAUGHT. Measured:
     * that is exactly what happened with a 60s wait under a 60s timeout.
     * A check must fail by ASSERTING, not by running out of time (rule 3).
     */
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      try { rec = JSON.parse(readFileSync(recFile, 'utf8')); } catch { rec = null; }
      if (rec && (rec.lastCycleAt || rec.stopReason)) break;
      await new Promise((r) => { setTimeout(r, 250); });
    }

    assert.ok(rec, 'the supervisor wrote no record at all within 60s');
    assert.ok(rec.lastCycleAt,
      'the supervisor completed a cycle and did not mark it -- watcherHealth is reading a field nothing writes');
    assert.ok(Number.isInteger(rec.cycles) && rec.cycles >= 1,
      `expected at least one counted cycle, got ${JSON.stringify(rec.cycles)}`);

    /* And the mark must be one watcherHealth can actually parse. */
    assert.ok(Number.isFinite(Date.parse(rec.lastCycleAt)),
      `lastCycleAt is not a parseable timestamp: ${rec.lastCycleAt}`);
  } finally {
    try { child.kill('SIGTERM'); } catch { /* going away regardless */ }
    await new Promise((r) => { setTimeout(r, 500); });
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    rmSync(home, { recursive: true, force: true });
  }
});

/* ── the automatic half: a starting session reports who has gone dark ───── */

test('darkWatchers names the dead and stalled, and stays silent when all are well', () => {
  /*
   * `claude-self` is deliberately given a DEAD pid and an old startedAt, so
   * that on its own merits it WOULD be reported. Exclusion by session id is
   * then the only thing that can keep it out of the line, and the assertion
   * below is load-bearing. An earlier fixture gave self a live pid and a fresh
   * timestamp, so it read healthy anyway -- the test passed while proving
   * nothing about exclusion, which mutation caught.
   */
  const home = withHome({
    'claude-self': { pid: 999999, agentId: 'fixer', sessionId: 'claude-self', startedAt: ago(7200) },
    'claude-gone': { pid: 999999, agentId: 'code-a', sessionId: 'claude-gone', startedAt: ago(7200) },
    'claude-wedged': { pid: process.pid, agentId: 'code-b', sessionId: 'claude-wedged', startedAt: ago(7200) },
  });
  try {
    const dir = path.join(home, 'polls');
    const said = darkWatchers(dir, 'claude-self', NOW);

    assert.ok(said, 'two watchers are not watching and it said nothing');
    assert.match(said, /code-a/, 'the dead one must be named by AGENT, because that is who is invisible');
    assert.match(said, /code-b/, 'an up-but-never-cycling watcher is stalled and must be named too');
    assert.match(said, /2 OTHER/, 'it must count');

    /*
     * The other direction, and the one that decides whether anyone keeps
     * reading these lines: a starting session must not be told about ITSELF,
     * which was created moments ago and always reads `starting`.
     */
    assert.doesNotMatch(said, /fixer/, 'it reported the starting session as a problem');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('darkWatchers says nothing at all when every other watcher is healthy', () => {
  const home = withHome({
    'claude-self': { pid: process.pid, agentId: 'fixer', sessionId: 'claude-self', startedAt: ago(30) },
    'claude-ok': { pid: process.pid, agentId: 'code-a', sessionId: 'claude-ok', startedAt: ago(1200), lastCycleAt: new Date().toISOString(), cycles: 3 },
  });
  try {
    assert.equal(darkWatchers(path.join(home, 'polls'), 'claude-self'), null,
      'a healthy machine must produce NO line -- an alarm that fires every session gets ignored (rule 16)');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('darkWatchers survives a missing polls directory rather than failing a session start', () => {
  assert.equal(darkWatchers(path.join(tmpdir(), 'no-such-polls-dir-xyz'), 'claude-self'), null,
    'a liveness report must never be the thing that stops a session starting');
});

test('THE SUPERVISOR OWN RECORD MUST NOT READ AS DEAD -- writer and reader joined', async () => {
  /*
   * Found by blind audit. Every other test here plants a record by hand, and
   * the wiring test asserted only that lastCycleAt and cycles appeared. So
   * writer and reader were joined on ONE FIELD, and the supervisor could --
   * and did -- produce a record the reader called DEAD while it was alive and
   * cycling:
   *
   *     !! DEAD   pid ? is gone and recorded no reason; last cycle 0s ago
   *
   * updateRecord merges onto readRecord(pidFile) ?? {}, and only sessionStart
   * ever wrote pid. Driving `--supervise` directly -- a shipped entry point,
   * and what the wiring test itself does -- left a record with no pid.
   *
   * This test closes the join: take what the REAL supervisor wrote and put it
   * through the REAL reader.
   */
  const home = mkdtempSync(path.join(tmpdir(), 'supervise-self-'));
  mkdirSync(path.join(home, 'polls'), { recursive: true });
  const sessionId = 'claude-selfread';
  const recFile = path.join(home, 'polls', `${sessionId}.json`);

  const child = spawn(process.execPath, [
    POLL, '--supervise', '--session', sessionId,
    '--token-file', path.join(home, 'no-such-token.txt'),
  ], { cwd: REPO, env: { ...process.env, AGENTBRIDGE_HOME: home }, stdio: 'ignore' });

  try {
    let rec = null;
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      try { rec = JSON.parse(readFileSync(recFile, 'utf8')); } catch { rec = null; }
      if (rec && rec.lastCycleAt) break;
      await new Promise((r) => { setTimeout(r, 250); });
    }
    assert.ok(rec, 'the supervisor wrote no record within 25s');

    assert.equal(rec.pid, child.pid,
      'the record must name the supervisor that wrote it, or the reader cannot check it is alive');

    const h = watcherHealth(rec, { now: Date.now(), pidAlive: true });
    assert.notEqual(h.state, 'dead',
      `a live, cycling supervisor read as ${h.state}: ${h.detail}`);
    assert.equal(h.wrong, false,
      `a live, cycling supervisor was reported wrong: ${h.state} -- ${h.detail}`);
  } finally {
    try { child.kill('SIGTERM'); } catch { /* going away regardless */ }
    await new Promise((r) => { setTimeout(r, 400); });
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    rmSync(home, { recursive: true, force: true });
  }
});

test('importing the poll script does not start, stop or register anything', () => {
  /*
   * This file imports the script for watcherHealth. The dispatch is guarded by
   * RUN_DIRECTLY precisely so that an import cannot detach a poller or
   * register against the operator's live bridge as a side effect. If that
   * guard ever regresses, this suite is one of the things that would silently
   * do it, so it is pinned here rather than assumed.
   */
  assert.equal(typeof watcherHealth, 'function', 'the import succeeded');
  /*
   * pathToFileURL, not a hand-spelled path. On Windows "C:\..." is not a legal
   * ESM specifier -- the loader reads the drive letter as a URL scheme and
   * throws ERR_UNSUPPORTED_ESM_URL_SCHEME. Rule 21, in the test rather than in
   * the subject: derive what the platform owns instead of typing it.
   */
  const spec = pathToFileURL(POLL).href;
  const home = mkdtempSync(path.join(tmpdir(), 'import-'));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(spec)}); console.log("IMPORTED-QUIETLY");`],
  { cwd: REPO, encoding: 'utf8', timeout: 30_000, env: { ...process.env, AGENTBRIDGE_HOME: home } });
  rmSync(home, { recursive: true, force: true });

  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  assert.match(out, /IMPORTED-QUIETLY/, out);
  assert.doesNotMatch(out, /is polling|NOT POLLING|deregister/,
    'an import ran a dispatch branch -- RUN_DIRECTLY has regressed');
});

/* ══ "could not tell" is a third answer, and the report must cost O(1) ═════
 *
 * Both of these come from one blind audit of the dark-watcher report. They
 * are opposite failures of the same line -- `pidAlive: alive(rec?.pid)` in a
 * loop -- and neither had a test.
 */

test('A PID THAT COULD NOT BE CHECKED IS UNKNOWN, NOT DEAD', () => {
  /*
   * alive() now returns null when the process-table probe itself fails. The
   * old code returned false, so ONE failed spawn made every watcher on the
   * machine read DEAD at once and --status named every agent as dark.
   *
   * A whole-fleet false alarm is worse than no report: it is precisely the
   * alarm people learn to skip, and then the layer is gone (rule 16). Unknown
   * is still WRONG -- nobody can say anybody is being watched -- but it sends
   * the reader to the probe instead of to five innocent agents.
   */
  const rec = { pid: 4242, agentId: 'code-a', sessionId: 's', startedAt: ago(600),
    lastCycleAt: new Date().toISOString(), cycles: 4 };

  const unknown = watcherHealth(rec, { now: Date.now(), pidAlive: null });
  assert.equal(unknown.state, 'unknown', 'a failed probe must not be reported as a dead process');
  assert.equal(unknown.wrong, true, 'but it is still not a watcher anybody can vouch for');
  assert.match(unknown.detail, /could not determine/i,
    'and the detail must send the reader at the probe, not at the agent');

  /*
   * THE POSITIVE CONTROLS, both of them. This change makes a previously
   * two-valued branch three-valued, so the test has to show the other two
   * still land where they did -- a rule that answers "unknown" to everything
   * would pass the assertion above and report nothing forever.
   */
  assert.equal(watcherHealth(rec, { now: Date.now(), pidAlive: true }).state, 'healthy',
    'a live cycling watcher is still healthy');
  assert.equal(watcherHealth(rec, { now: Date.now(), pidAlive: false }).state, 'dead',
    'and a pid genuinely confirmed gone is still DEAD, not softened to unknown');
});

test('undefined pidAlive is unknown too -- an omitted probe is not a dead process', () => {
  /* The caller that forgets the option must fail the same safe way. */
  const rec = { pid: 4242, agentId: 'code-a', startedAt: ago(600) };
  assert.equal(watcherHealth(rec, { now: Date.now() }).state, 'unknown');
});

test('--status REPORTS UNKNOWN RATHER THAN A FLEET OF DEAD WATCHERS, through the real script', () => {
  /*
   * The wiring claim, driven end to end (rule 17): watcherHealth having an
   * unknown branch proves nothing about what alive() actually hands it.
   *
   * NOTHING IS MOCKED. The shipped script runs its real spawnSync, and the
   * `tasklist` it finds is a real program that really exits non-zero -- the
   * field failure the audit predicted, where the probe is present but cannot
   * answer. The stand-in is derived from process.execPath rather than built
   * or named (rule 21): node.exe under another name rejects tasklist's
   * switches and exits 1, which is all this needs.
   *
   * IT MUST GO ON PATH, NOT IN THE CWD. Measured here while writing this:
   * a copy in the child's working directory is NOT picked up -- libuv does
   * its own PATH search -- and stripping PATH entirely does not work either,
   * because CreateProcess still finds the real tasklist in System32. The
   * first version of this test did exactly that and passed against the
   * defect for the wrong reason.
   *
   * The pids are REAL AND LIVE (this test runner), so process.kill(pid, 0)
   * succeeds and the only unanswerable question is the node-ness one
   * tasklist owns. That is precisely the state the old code called dead.
   */
  const shimDir = mkdtempSync(path.join(tmpdir(), 'no-tasklist-'));
  const shim = path.join(shimDir, 'tasklist.exe');
  try { linkSync(process.execPath, shim); } catch { cpSync(process.execPath, shim); }

  const live = { pid: process.pid, startedAt: ago(600), lastCycleAt: new Date().toISOString(), cycles: 4 };
  const home = withHome({
    'claude-a': { ...live, agentId: 'code-a', sessionId: 'claude-a' },
    'claude-b': { ...live, agentId: 'code-b', sessionId: 'claude-b' },
  });
  try {
    const env = { ...process.env, AGENTBRIDGE_HOME: home };
    /* Windows environment keys are case-insensitive; a plain object copy is not. */
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    env[pathKey] = `${shimDir}${path.delimiter}${env[pathKey] ?? ''}`;

    const r = spawnSync(process.execPath, [POLL, '--status'],
      { cwd: REPO, encoding: 'utf8', timeout: 30_000, env });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;

    /*
     * The precondition is an ASSERTION, not a guard (rule 6): if the shim did
     * not win the lookup, the real tasklist answered, both watchers read
     * healthy, and every assertion below would be measuring nothing.
     */
    assert.doesNotMatch(out, /HEALTHY/,
      `the tasklist stand-in did not win PATH resolution -- this test proved nothing. ${out}`);
    assert.equal(r.status, 1, `unknown is still wrong, so the exit must stay non-zero. ${out}`);
    assert.match(out, /UNKNOWN/, out);
    assert.doesNotMatch(out, /DEAD/,
      `no watcher may be called DEAD on the strength of a probe that never answered. ${out}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(shimDir, { recursive: true, force: true });
  }
});

test('THE REPORT COSTS ONE PROCESS-TABLE QUERY, NOT ONE PER WATCHER', () => {
  /*
   * THE DEFECT THAT MADE THE FEATURE DEFEAT ITSELF. alive() spawned tasklist
   * per pid; --status and the SessionStart report both call it in a loop.
   * Measured by blind audit: 20 live records took 16,620ms -- inside a
   * SessionStart hook budgeted at 30s that has already spent up to 60s on
   * register-session. The more agents on the machine, the likelier the report
   * dies before printing, and the many-agent case is the one it exists for.
   *
   * THE COST OF A SPAWN IS A PROPERTY OF THIS MACHINE, NOT OF THE CODE, so it
   * is measured here rather than typed (rule 21). A literal millisecond
   * budget would be a fact about whoever's laptop wrote it, and would go red
   * on a loaded CI box while the defect was absent.
   *
   * The shape of the claim is what matters: adding ELEVEN live watchers must
   * not add eleven process-table queries. Pre-fix the delta is ~11x one
   * query; post-fix it is ~0. Two is a wide margin that still fails loudly.
   */
  const probe = () => {
    const t0 = Date.now();
    spawnSync('tasklist', ['/FI', 'IMAGENAME eq node.exe', '/NH', '/FO', 'CSV'],
      { encoding: 'utf8', windowsHide: true });
    return Date.now() - t0;
  };
  probe();                                        // warm the loader; first spawn is not typical
  const queryMs = Math.min(probe(), probe(), probe());
  assert.ok(queryMs > 0, 'the cost unit must be measured, not assumed');

  const live = (n) => {
    const recs = {};
    for (let i = 0; i < n; i += 1) {
      recs[`claude-${i}`] = { pid: process.pid, agentId: `a-${i}`, sessionId: `claude-${i}`,
        startedAt: ago(600), lastCycleAt: new Date().toISOString(), cycles: 4 };
    }
    return withHome(recs);
  };
  const timed = (home) => {
    const t0 = Date.now();
    try { runStatus(home); } finally { rmSync(home, { recursive: true, force: true }); }
    return Date.now() - t0;
  };

  const one = timed(live(1));
  const twelve = timed(live(12));
  const added = twelve - one;

  assert.ok(added < queryMs * 2,
    `eleven more watchers added ${added}ms, and one process-table query costs ${queryMs}ms here. `
    + 'That is a per-record query: the report scales with the fleet it is meant to survey.');
});

/* ── the two call sites, which the tri-state changed in OPPOSITE directions ──
 *
 * `alive()` gained a third answer, so every caller had to decide what "could
 * not tell" means for IT. Getting that wrong is silent in both places, and a
 * boolean-shaped mutation (`!== false` back to a plain truthiness test) is
 * invisible to every test above.
 */

/** node.exe under tasklist's name: found first on PATH, and exits non-zero. */
function brokenProbePath(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'no-tasklist-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shim = path.join(dir, 'tasklist.exe');
  try { linkSync(process.execPath, shim); } catch { cpSync(process.execPath, shim); }
  return dir;
}
const withPath = (env, dir) => {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  return { ...env, [key]: `${dir}${path.delimiter}${env[key] ?? ''}` };
};

test('AN UNCHECKABLE PID DOES NOT GET A SECOND SUPERVISOR DETACHED AGAINST IT', (t) => {
  /*
   * sessionStart skips detaching when a supervisor is already running. Read
   * null as "not running" and it starts a RIVAL: two pollers on one session,
   * two heartbeats, and a pid record that remembers only the newer one -- so
   * the older is unstoppable, which is the orphan hazard this file already
   * warns about, manufactured by the very check meant to prevent it.
   *
   * When in doubt, do not start a rival. The cost of being wrong that way is
   * one session that is not polled and says so; the other way it is a poller
   * nothing can ever reach.
   */
  const home = mkdtempSync(path.join(tmpdir(), 'rival-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(path.join(home, 'polls'), { recursive: true });
  const token = path.join(home, 'token.txt');
  writeFileSync(token, 'not-a-real-token\n');
  writeFileSync(path.join(home, 'polls', 'claude-rival.json'),
    JSON.stringify({ pid: process.pid, agentId: 'code-a', sessionId: 'claude-rival', startedAt: ago(600) }));

  const r = spawnSync(process.execPath, [POLL, '--session-start'], {
    cwd: REPO, encoding: 'utf8', timeout: 60_000,
    input: JSON.stringify({ session_id: 'rival' }),
    env: withPath({ ...process.env, AGENTBRIDGE_HOME: home, AGENTBRIDGE_AGENT_ID: 'code-a',
      AGENTBRIDGE_TOKEN_FILE: token,
      /*
       * A DEAD LOOPBACK, SO NO FAILURE OF THIS TEST CAN REACH THE OPERATOR'S
       * LIVE BRIDGE. Under the shipped code the run returns before
       * register-session. Under the mutation this test exists to catch, it
       * does NOT -- and a test whose failure mode is registering a fixture
       * session against production is a worse bug than the one it detects.
       * Loopback also avoids the Windows/node libuv abort, which needs a
       * remote fetch to reproduce.
       */
      AGENTBRIDGE_REGISTER_URL: 'http://127.0.0.1:1/register' }, brokenProbePath(t)),
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;

  assert.match(out, /already polling/,
    `an unverifiable supervisor must be left alone, not raced. ${out}`);
  assert.doesNotMatch(out, /NOT POLLING/,
    `the run must reach the liveness check, not bail earlier -- otherwise this proves nothing. ${out}`);
});

test('AN UNCHECKABLE PID IS STILL SIGNALLED AT SESSION END', async (t) => {
  /*
   * The opposite default, for the opposite cost. Here "could not tell" must
   * NOT mean "leave it": sessionEnd deletes the pid record moments later, so
   * a supervisor skipped here survives with nothing on disk pointing at it.
   * A signal to a pid that turns out to be dead throws and is caught, which
   * is free; the skipped signal is permanent.
   *
   * The victim is a REAL detached node process, not a planted number, and the
   * assertion is that it is gone -- rule 4: the far end, not a proxy for it.
   */
  const home = mkdtempSync(path.join(tmpdir(), 'sigterm-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(path.join(home, 'polls'), { recursive: true });

  const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
    { stdio: 'ignore' });
  const exited = new Promise((resolve) => { victim.on('exit', () => resolve(true)); });
  t.after(() => { try { victim.kill('SIGKILL'); } catch { /* already gone */ } });

  writeFileSync(path.join(home, 'polls', 'claude-victim.json'),
    JSON.stringify({ pid: victim.pid, agentId: 'code-a', sessionId: 'claude-victim', startedAt: ago(600) }));

  /* Precondition asserted, not assumed (rule 6): it must be alive to prove killed. */
  assert.doesNotThrow(() => process.kill(victim.pid, 0), 'the victim never started');

  spawnSync(process.execPath, [POLL, '--session-end'], {
    cwd: REPO, encoding: 'utf8', timeout: 60_000,
    input: JSON.stringify({ session_id: 'victim' }),
    env: withPath({ ...process.env, AGENTBRIDGE_HOME: home,
      AGENTBRIDGE_TOKEN_FILE: path.join(home, 'no-such-token.txt') }, brokenProbePath(t)),
  });

  const done = await Promise.race([exited,
    new Promise((resolve) => { setTimeout(() => resolve(false), 10_000); })]);
  assert.equal(done, true,
    'the supervisor outlived the session end that deleted its record -- nothing can stop it now');
});
