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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, linkSync, cpSync, existsSync } from 'node:fs';
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

/*
 * THE TIMEOUT IS A MACHINE-SPEED ASSUMPTION, AND AT 30s IT WAS THE AUTHOR'S
 * MACHINE ON A QUIET DAY. CLAUDE.md RULE 21.
 *
 * Measured 2026-09-19, same commit, two runs an hour apart: the suite took 185s
 * and every test here passed, then took 403s under load and BOTH of these failed
 * with `status: null` at 30082ms and 30085ms -- a child killed at its timeout,
 * not an assertion that disagreed. The failure renders as `null !== 1`, which
 * reads like the script returning the wrong code, so it costs a reader a real
 * diagnosis before they reach "the box was busy". That is the phantom rule 21
 * warns an environment failure spends an auditor's budget on.
 *
 * RAISING IT CANNOT HIDE A HANG. A script that never exits still produces
 * `status: null` and still fails, just later. What the old value did was fail a
 * WORKING script, and a gate that goes red on a busy machine is one people learn
 * to rerun until it is green -- which is how a real red gets waved through.
 *
 * Every assertion below is untouched: exit 1, DEAD, the agent id, HEALTHY, and
 * the "1 of 2" count all still have to hold.
 */
const SPAWN_TIMEOUT_MS = 120_000;

function runStatus(home) {
  const r = spawnSync(process.execPath, [POLL, '--status'], {
    cwd: REPO, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS,
    env: { ...process.env, AGENTBRIDGE_HOME: home },
  });
  /*
   * A TIMEOUT IS NAMED, NOT LEFT AS A BARE null. spawnSync sets `error` to
   * ETIMEDOUT and `signal` when it kills the child, so the two causes of
   * `status === null` are distinguishable -- and "could not tell" must never
   * render the same as "answered wrongly", which is the distinction this
   * repository makes for liveness, for heartbeats and for check-first.
   */
  const timedOut = r.error?.code === 'ETIMEDOUT' || r.signal !== null;
  const detail = timedOut
    ? `\n[environment] the script was KILLED after ${SPAWN_TIMEOUT_MS}ms `
      + `(signal=${r.signal}, error=${r.error?.code ?? 'none'}); this is a machine-speed `
      + 'failure, not a wrong exit code -- see the note above runStatus'
    : '';
  return { status: r.status, timedOut, out: `${r.stdout ?? ''}${r.stderr ?? ''}${detail}` };
}

test('--status exits non-zero and names the dead watcher, through the real script', () => {
  const home = withHome({
    'claude-dead': { pid: 999999, agentId: 'code-a', sessionId: 'claude-dead', startedAt: ago(7200) },
    'claude-live': { pid: process.pid, agentId: 'fixer', sessionId: 'claude-live', startedAt: ago(600), lastCycleAt: new Date().toISOString(), cycles: 4 },
  });
  try {
    const r = runStatus(home);

    assert.equal(r.timedOut, false, r.out);
    assert.equal(r.status, 1, `a dead watcher must set a non-zero exit so a cron can act on it${r.out}`);
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
    assert.equal(r.timedOut, false, r.out);
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

test('THE REPORT MAKES ONE PROCESS-TABLE QUERY, NOT ONE PER WATCHER', (t) => {
  /*
   * THE DEFECT: alive() spawned tasklist once per pid, and both --status and
   * the SessionStart dark-watcher report call it in a loop. The report got
   * slower exactly as the fleet grew -- and the many-agent case is the one it
   * exists for.
   *
   * THIS TEST USED TO MEASURE TIME, AND A BLIND AUDIT CAUGHT IT PASSING
   * AGAINST THE DEFECT. It timed one tasklist spawn and asserted that eleven
   * more watchers added less than two of those. On a COLD machine the
   * IMAGENAME query it used as the yardstick ranged 138ms-2008ms, while the
   * per-pid query the defect actually makes is a stable ~150ms -- so the
   * budget ballooned past the thing it was bounding and the gate reported
   * pass after spending 39.8 seconds watching the bug happen.
   *
   * Two different prices, and the volatile one was the yardstick. Worse, the
   * one run that matters most -- "watch it fail", performed once, per rule 1
   * -- is the run most likely to be cold.
   *
   * SO IT COUNTS INSTEAD OF TIMING. The claim was never about milliseconds;
   * it is that the number of process-table queries does not scale with the
   * number of watchers. That is an integer, and an integer cannot be flaky.
   *
   * HOW THE COUNT IS TAKEN, without mocking the subject: a copy of node.exe
   * named tasklist.exe goes first on the child's PATH, and NODE_OPTIONS gives
   * it a --require hook that appends one byte per invocation. The shipped
   * script runs its real spawnSync; the thing it finds really runs and really
   * records that it ran. The hook counts only when its own execPath is
   * tasklist.exe, so the poll script and its other children are not counted.
   *
   * The stand-in exits non-zero, so the watchers read UNKNOWN. That is
   * irrelevant here: this test asserts how many times the probe was called,
   * not what it answered.
   */
  const dir = mkdtempSync(path.join(tmpdir(), 'tlcount-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const counter = path.join(dir, 'counter.cjs');
  writeFileSync(counter, [
    "const p = require('path');",
    "const f = require('fs');",
    "if (p.basename(process.execPath).toLowerCase() === 'tasklist.exe') {",
    "  try { f.appendFileSync(process.env.TASKLIST_COUNTER, 'x'); } catch { /* ignore */ }",
    '}',
    '',
  ].join('\n'));

  const shim = path.join(dir, 'tasklist.exe');
  try { linkSync(process.execPath, shim); } catch { cpSync(process.execPath, shim); }

  const countFile = path.join(dir, 'count.txt');
  writeFileSync(countFile, '');

  const recs = {};
  for (let i = 0; i < 12; i += 1) {
    recs[`claude-${i}`] = {
      pid: process.pid, agentId: `a-${i}`, sessionId: `claude-${i}`,
      startedAt: ago(600), lastCycleAt: new Date().toISOString(), cycles: 4,
    };
  }
  const home = withHome(recs);
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const env = withPath({ ...process.env, AGENTBRIDGE_HOME: home }, dir);
  env.NODE_OPTIONS = `--require ${JSON.stringify(counter)}`;
  env.TASKLIST_COUNTER = countFile;

  const r = spawnSync(process.execPath, [POLL, '--status'],
    { cwd: REPO, encoding: 'utf8', timeout: 120_000, env });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;

  const calls = readFileSync(countFile, 'utf8').length;

  /*
   * Precondition asserted, not guarded (rule 6): if the shim never ran, the
   * count is zero for an uninteresting reason and proves nothing.
   */
  assert.ok(calls >= 1,
    `the tasklist stand-in was never invoked, so this test measured nothing. ${out}`);

  assert.equal(calls, 1,
    `twelve watchers cost ${calls} process-table queries. The report scales with the fleet `
    + 'it is meant to survey, which is what made it time out on the machines that need it.');
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
  /*
   * REAP BEFORE REMOVING THE STORE, OR A FAILING RUN LEAVES AN IMMORTAL
   * POLLER.
   *
   * Found by blind audit, with the evidence still running on the operator's
   * machine: a detached supervisor from THIS fixture, started four minutes
   * before the commit was authored, out of the shared worktree. When this
   * test fails -- against the parent, or under the mutation it exists to
   * catch -- sessionStart runs to completion and spawns a real detached
   * poller. t.after then deleted the temp home and nothing killed the child.
   *
   * The pid record is the only thing that knows about it, so it must be read
   * BEFORE the directory goes. A test whose failure mode is the exact hazard
   * its own docstring is about has no business shipping.
   */
  t.after(() => {
    let spawned = null;
    try { spawned = JSON.parse(readFileSync(path.join(home, 'polls', 'claude-rival.json'), 'utf8')); } catch { /* none */ }
    if (spawned && Number.isInteger(spawned.pid) && spawned.pid !== process.pid) {
      try { process.kill(spawned.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    rmSync(home, { recursive: true, force: true });
  });
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

test('AN UNIDENTIFIABLE PID IS NOT TERMINATED AT SESSION END', async (t) => {
  /*
   * THIS TEST ASSERTED THE OPPOSITE FOR ONE COMMIT, AND THE OPPOSITE WAS
   * DESTRUCTIVE.
   *
   * I had `alive(rec.pid) !== false` here, reasoning that a signal to a dead
   * pid throws and is caught, so trying costs nothing. A blind audit showed
   * what that actually does: it TERMINATED A LIVE, UNRELATED, NON-NODE
   * PROCESS whose pid happened to sit in a stale poll record.
   *
   *     PARENT   victim pid=21820 PING.EXE -> STILL-RUNNING
   *     COMMIT   victim pid=32272 PING.EXE -> EXITED code=1
   *
   * The reasoning was wrong at its root: this branch is reached only when we
   * CANNOT tell, and process.kill(pid, 0) has already proved something is
   * running under that pid. On Windows SIGTERM is TerminateProcess -- no
   * handler, no veto. And pid reuse reaches this with no probe failure at
   * all, which is the open defect on this file; `!== false` promoted it from
   * a reporting error to a destructive one.
   *
   * The victim here is deliberately NOT a node process, because that is the
   * case that proves the point: nothing about it belongs to this project.
   */
  const home = mkdtempSync(path.join(tmpdir(), 'nokill-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(path.join(home, 'polls'), { recursive: true });

  /* ping loops for ~30s without being node, and needs no cleanup if it survives. */
  const victim = spawn('ping', ['-n', '30', '127.0.0.1'], { stdio: 'ignore' });
  let exited = false;
  victim.on('exit', () => { exited = true; });
  t.after(() => { try { victim.kill('SIGKILL'); } catch { /* already gone */ } });
  await new Promise((r) => { setTimeout(r, 300); });

  assert.doesNotThrow(() => process.kill(victim.pid, 0), 'precondition: the victim is running');

  const pidFile = path.join(home, 'polls', 'claude-victim.json');
  writeFileSync(pidFile, JSON.stringify({
    pid: victim.pid, agentId: 'code-a', sessionId: 'claude-victim', startedAt: ago(600),
  }));

  const r = spawnSync(process.execPath, [POLL, '--session-end'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 60_000,
    input: JSON.stringify({ session_id: 'victim' }),
    env: withPath({ ...process.env, AGENTBRIDGE_HOME: home,
      AGENTBRIDGE_TOKEN_FILE: path.join(home, 'no-such-token.txt') }, brokenProbePath(t)),
  });

  await new Promise((res) => { setTimeout(res, 500); });
  assert.equal(exited, false,
    'session end TERMINATED a live non-node process because it could not identify the pid');

  /*
   * AND THE RECORD SURVIVES. Declining to signal is only safe if the thing we
   * declined to stop stays visible -- deleting the record is what would turn
   * it into an orphan nothing can find, which is the hazard that pushed me
   * into killing it in the first place.
   */
  assert.ok(existsSync(pidFile),
    'the record was deleted for a supervisor we chose not to stop, so --status can no longer see it');
  assert.match(`${r.stdout ?? ''}${r.stderr ?? ''}`, /could NOT confirm/,
    'and it must say so, rather than reporting a clean stop it did not perform');
});

test('a CONFIRMED live supervisor is still stopped at session end', async (t) => {
  /*
   * THE POSITIVE CONTROL (rule 5). Refusing to kill what we cannot identify
   * is only correct if we still kill what we CAN -- otherwise session end
   * stops stopping anything and every session leaks its poller.
   *
   * No broken probe here: tasklist answers, the pid is a real node process,
   * so alive() returns true rather than null.
   */
  const home = mkdtempSync(path.join(tmpdir(), 'dokill-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(path.join(home, 'polls'), { recursive: true });

  const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exited = new Promise((resolve) => { victim.on('exit', () => resolve(true)); });
  t.after(() => { try { victim.kill('SIGKILL'); } catch { /* already gone */ } });

  const pidFile = path.join(home, 'polls', 'claude-live.json');
  writeFileSync(pidFile, JSON.stringify({
    pid: victim.pid, agentId: 'code-a', sessionId: 'claude-live', startedAt: ago(600),
  }));
  assert.doesNotThrow(() => process.kill(victim.pid, 0), 'precondition: the supervisor is running');

  spawnSync(process.execPath, [POLL, '--session-end'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 60_000,
    input: JSON.stringify({ session_id: 'live' }),
    env: { ...process.env, AGENTBRIDGE_HOME: home,
      AGENTBRIDGE_TOKEN_FILE: path.join(home, 'no-such-token.txt') },
  });

  const done = await Promise.race([exited,
    new Promise((resolve) => { setTimeout(() => resolve(false), 10_000); })]);
  assert.equal(done, true, 'a confirmed live node supervisor must still be stopped');
  assert.equal(existsSync(pidFile), false, 'and its record removed, because it really was stopped');
});

test('A LIVE PID THAT IS NOT NODE READS DEAD -- the node-ness check is load-bearing', async (t) => {
  /*
   * A MUTATION AN AUDITOR FOUND UNCAUGHT: `return live.has(pid)` -> `return
   * true` left all 24 tests green. That membership test is the whole point of
   * liveNodePids, and it is what limits the blast radius of a recycled pid --
   * so the one line protecting session end from signalling a stranger had
   * nothing falsifying it.
   *
   * It survived because every fixture used either process.pid (a real node)
   * or 999999, and 999999 is rejected by process.kill(pid, 0) BEFORE tasklist
   * is ever consulted. So no test ever reached the membership question.
   *
   * This one does: a real, live, NON-node pid, with the probe working.
   */
  const home = mkdtempSync(path.join(tmpdir(), 'notnode-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(path.join(home, 'polls'), { recursive: true });

  const stranger = spawn('ping', ['-n', '30', '127.0.0.1'], { stdio: 'ignore' });
  t.after(() => { try { stranger.kill('SIGKILL'); } catch { /* already gone */ } });
  await new Promise((r) => { setTimeout(r, 300); });
  assert.doesNotThrow(() => process.kill(stranger.pid, 0), 'precondition: the stranger is running');

  writeFileSync(path.join(home, 'polls', 'claude-stranger.json'), JSON.stringify({
    pid: stranger.pid, agentId: 'code-a', sessionId: 'claude-stranger',
    startedAt: ago(600), lastCycleAt: new Date().toISOString(), cycles: 4,
  }));

  const r = runStatus(home);
  assert.match(r.out, /DEAD/,
    `a pid held by ping.exe is not our watcher, so the watcher is gone. ${r.out}`);
  assert.doesNotMatch(r.out, /HEALTHY/,
    `a live pid that is not node was reported as a healthy watcher. ${r.out}`);
  assert.equal(r.status, 1, r.out);
});

test('A RECORD WITH NO PID READS DEAD, NOT UNKNOWN', async () => {
  /*
   * The other uncaught mutation: `return false` -> `return null` for a
   * missing or malformed pid, which left every test green.
   *
   * This case is load-bearing and the script says so in its own comment: a
   * crashed poller rewrites its record WITHOUT a pid, and it must read dead.
   * Under the mutation it reads unknown -- and sessionStart's `!== false`
   * then refuses to start a supervisor for that session at all, so the
   * session is never polled and the record never changes. A permanent,
   * self-sustaining silence.
   *
   * The unit tests could not reach it: they pass pidAlive in directly, so
   * alive() never runs. This drives the shipped script.
   */
  const home = withHome({
    'claude-nopid': {
      agentId: 'code-a', sessionId: 'claude-nopid',
      startedAt: ago(7200), lastCycleAt: new Date().toISOString(), cycles: 4,
    },
  });
  try {
    const r = runStatus(home);
    assert.match(r.out, /DEAD/,
      `a record naming no pid is a crashed poller, not an unanswerable question. ${r.out}`);
    assert.doesNotMatch(r.out, /UNKNOWN/, r.out);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
