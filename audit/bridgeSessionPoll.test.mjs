/**
 * THE POLL RUNNER, TESTED AT THE FAR END.
 *
 * WHY THIS FILE IS SHAPED THE WAY IT IS, and it is a direct correction of my own
 * earlier mistake rather than a general principle.
 *
 * I wrote a near-identical starter earlier tonight and its end-to-end test was
 * hollow. It asserted `alive(pid)` immediately after spawnSync returned -- a
 * LIVE PID, which is a proxy for "the thing is working" (rule 4). A blind
 * auditor deleted the flag that made the child a long-lived watcher rather than
 * a one-shot registration, putting the tree back into exactly the broken state
 * the work existed to fix, and the test stayed 4 of 4 GREEN: the check raced a
 * child that registered once and exited, and won.
 *
 * So nothing here asserts a pid. The far end is the LOG: the supervisor writes
 * to it only by actually invoking the CLI and handling what came back, so a
 * marker appearing there proves the process started, reached the bridge path,
 * and continued -- none of which a pid can tell you.
 *
 * NOTHING TOUCHES THE LIVE BRIDGE. AGENTBRIDGE_REGISTER_URL points at an
 * unreachable host, so registration stays local and every poll cycle fails
 * transport. That is the correct fixture: it exercises the supervisor's retry
 * path, which is the behaviour that distinguishes a re-arming poll from a
 * one-shot, and it publishes nothing anywhere. AGENTBRIDGE_HOME is a temp dir so
 * no fixture reaches the operator's real store.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const RUNNER = path.join(REPO, 'scripts', 'bridge-session-poll.mjs');

const UUID = 'poll-test-3f2a9c11-4e77-4d0e-9a2c-2f0e5d4b6a18';
const SESSION = `claude-${UUID}`;

const mkTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentbridge-poll-'));

function baseEnv(home, tokenFile) {
  return {
    ...process.env,
    AGENTBRIDGE_HOME: home,
    AGENTBRIDGE_AGENT_ID: 'test-agent',
    AGENTBRIDGE_LANE: 'test-lane',
    AGENTBRIDGE_TOKEN_FILE: tokenFile,
    // Nothing may reach the real bridge. Unreachable, not merely wrong.
    AGENTBRIDGE_REGISTER_URL: 'https://x.invalid/mcp/register',
  };
}

function run(mode, env, payload = { session_id: UUID }) {
  return spawnSync(process.execPath, [RUNNER, mode], {
    cwd: REPO, env, input: JSON.stringify(payload),
    encoding: 'utf8', timeout: 90_000, windowsHide: true,
  });
}

const message = (r) => {
  try { return JSON.parse(String(r.stdout).trim().split('\n').pop()).systemMessage; } catch { return String(r.stdout); }
};

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Wait for the supervisor's own marker to appear in its log. */
async function waitForLog(file, marker, ms = 45_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes(marker)) return text;
    } catch { /* not created yet */ }
    await new Promise((r) => { setTimeout(r, 300); });
  }
  return null;
}

const paths = (home) => ({
  pidFile: path.join(home, 'polls', `${SESSION}.json`),
  logFile: path.join(home, 'polls', `${SESSION}.log`),
});

/* ── the refusals, each of which must start NOTHING ──────────────────────── */

test('no session_id: refuses loudly and records nothing', () => {
  const home = mkTemp();
  const tok = path.join(home, 'token.txt');
  fs.writeFileSync(tok, 'dummy-token\n');
  const r = run('--session-start', baseEnv(home, tok), {});
  assert.equal(r.status, 0, 'a hook must never fail a session');
  assert.match(message(r), /NOT POLLING/);
  assert.match(message(r), /session_id/);
  assert.equal(fs.existsSync(path.join(home, 'polls')), false, 'nothing may be recorded');
  fs.rmSync(home, { recursive: true, force: true });
});

test('no agent id: refuses, and says why an id is not invented', () => {
  /*
   * A fabricated identity on the roster is what work gets routed by, so this
   * refuses rather than guessing -- the same rule b/session-credentials states
   * from the other direction.
   */
  const home = mkTemp();
  const tok = path.join(home, 'token.txt');
  fs.writeFileSync(tok, 'dummy-token\n');
  const env = { ...baseEnv(home, tok), AGENTBRIDGE_AGENT_ID: '' };
  const r = run('--session-start', env);
  assert.equal(r.status, 0);
  assert.match(message(r), /NOT POLLING/);
  assert.match(message(r), /AGENTBRIDGE_AGENT_ID/);
  assert.equal(fs.existsSync(paths(home).pidFile), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('no token file: refuses BEFORE registering, naming the silent no-op', () => {
  /*
   * Without a credential, register-session prints "registered", says hosted NOT
   * CONFIGURED and exits 0. Starting a poll into that state would look like the
   * problem was solved while the session stayed invisible.
   */
  const home = mkTemp();
  const r = run('--session-start', baseEnv(home, path.join(home, 'absent.txt')));
  assert.equal(r.status, 0);
  assert.match(message(r), /NOT POLLING/);
  assert.match(message(r), /registration token/);
  assert.equal(fs.existsSync(paths(home).pidFile), false, 'it must not register or poll');
  fs.rmSync(home, { recursive: true, force: true });
});

/* ── the wiring, asserted at the far end ─────────────────────────────────── */

test('THE WIRING: the supervisor OUTLIVES the hook and actually polls', async () => {
  const home = mkTemp();
  const tok = path.join(home, 'token.txt');
  fs.writeFileSync(tok, 'dummy-token-value\n');
  const { pidFile, logFile } = paths(home);

  let pid = null;
  try {
    const r = run('--session-start', baseEnv(home, tok));
    assert.equal(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
    assert.match(message(r), /is polling \(pid \d+\)/, `expected a polling message, got: ${message(r)}`);

    assert.equal(fs.existsSync(pidFile), true, 'a started poll must be recorded');
    const rec = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    pid = rec.pid;
    assert.equal(rec.agentId, 'test-agent');
    assert.equal(rec.sessionId, SESSION);

    /*
     * THE ASSERTION THAT MATTERS, AND THE ONE I GOT WRONG LAST TIME.
     *
     * spawnSync has returned, so the hook process is gone. A pid being alive
     * here would prove only that something exists -- last time that raced a
     * one-shot child and won, and the test stayed green with the whole feature
     * deleted.
     *
     * The supervisor writes this marker ONLY by invoking the CLI and handling
     * its result. Its presence proves the detached process survived its parent,
     * reached the bridge path, and came back round the loop. A one-shot child,
     * or a child killed with the hook, never writes it.
     */
    const log = await waitForLog(logFile, '[poll]');
    assert.ok(log, 'the supervisor never invoked wait-for-work: no marker in its log');
    assert.match(log, /wait-for-work exited/, 'the supervisor must report what the poll returned');

    // Only NOW is liveness meaningful: it ran a cycle and is still going.
    assert.equal(alive(pid), true, 'the supervisor exited after one cycle instead of re-arming');
  } finally {
    if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('IDEMPOTENCE: a second start does not add a second poller', async () => {
  /*
   * SessionStart fires on startup, resume, clear, compact and fork. Two
   * supervisors on one session would leave the loser killed at SessionEnd while
   * the winner kept stamping a session the operator believes has stopped.
   */
  const home = mkTemp();
  const tok = path.join(home, 'token.txt');
  fs.writeFileSync(tok, 'dummy-token-value\n');
  const { pidFile, logFile } = paths(home);

  let pid = null;
  try {
    const first = run('--session-start', baseEnv(home, tok));
    assert.match(message(first), /is polling/);
    pid = JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid;
    assert.ok(await waitForLog(logFile, '[poll]'), 'the first supervisor never ran a cycle');

    const second = run('--session-start', baseEnv(home, tok));
    assert.match(message(second), /already polling/);
    assert.equal(JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid, pid,
      'the recorded pid must not change while a poll is running');
  } finally {
    if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('SESSION END: the poll is stopped and the record removed', async () => {
  const home = mkTemp();
  const tok = path.join(home, 'token.txt');
  fs.writeFileSync(tok, 'dummy-token-value\n');
  const { pidFile, logFile } = paths(home);

  let pid = null;
  try {
    run('--session-start', baseEnv(home, tok));
    pid = JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid;
    assert.ok(await waitForLog(logFile, '[poll]'), 'nothing was polling, so stopping proves nothing');

    const end = run('--session-end', baseEnv(home, tok));
    assert.equal(end.status, 0);
    assert.equal(fs.existsSync(pidFile), false, 'the record must be removed');

    for (let i = 0; i < 60 && alive(pid); i += 1) {
      await new Promise((r) => { setTimeout(r, 100); });
    }
    assert.equal(alive(pid), false, 'the supervisor survived session end and is still stamping');
    pid = null;
  } finally {
    if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('stopping a session that was never polling says so rather than pretending', () => {
  const home = mkTemp();
  const tok = path.join(home, 'token.txt');
  fs.writeFileSync(tok, 'dummy-token-value\n');
  const r = run('--session-end', baseEnv(home, tok));
  assert.equal(r.status, 0);
  assert.match(message(r), /nothing was polling/);
  fs.rmSync(home, { recursive: true, force: true });
});
