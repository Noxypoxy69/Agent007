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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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
