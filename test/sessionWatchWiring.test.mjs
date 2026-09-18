/**
 * THE WIRING, NOT THE LOGIC. CLAUDE.md rule 17: the wiring is a separate claim
 * from the logic, and only the logic had tests -- which is the entire reason the
 * watcher was never running. A green test/sessionWatch.test.mjs says the
 * decisions are right; it says nothing about whether the hook starts anything.
 *
 * So this runs scripts/bridge-session-watch.mjs AS A HOOK: real child process,
 * real JSON on stdin, real files on disk.
 *
 * NOTHING HERE TOUCHES THE NETWORK OR THE OPERATOR'S STORE.
 *   AGENTBRIDGE_HOME      -> a temp dir, so the operator's real ~/.agentbridge is
 *                            never written. An audit that writes fixtures into
 *                            the live store has happened here before.
 *   AGENTBRIDGE_REGISTER_URL -> an unreachable host, so no registration is ever
 *                            published anywhere. Unreachable is treated as
 *                            transient by the watcher, which is what keeps it
 *                            alive for the survival assertion below.
 *   the token              -> a dummy in the temp dir, never the real one.
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
const HOOK = path.join(REPO, 'scripts', 'bridge-session-watch.mjs');

const SESSION_UUID = 'test-wiring-0b9f2c41-77ae-4f1e-9a2c-2f0e5d4b6a18';

function mkTemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentbridge-watch-'));
}

function runHook(mode, env, payload = { session_id: SESSION_UUID }) {
  return spawnSync(process.execPath, [HOOK, mode], {
    cwd: REPO,
    env: { ...process.env, ...env },
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
}

function message(r) {
  try { return JSON.parse(String(r.stdout).trim().split('\n').pop()).systemMessage; } catch { return String(r.stdout); }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Base env with every outward path pointed somewhere harmless. */
function baseEnv(home) {
  return {
    AGENTBRIDGE_HOME: home,
    AGENTBRIDGE_AGENT_ID: 'test-agent',
    AGENTBRIDGE_LANE: 'test-lane',
    AGENTBRIDGE_WATCH_INTERVAL: '5',
    AGENTBRIDGE_REGISTER_URL: 'https://x.invalid/mcp/register',
    AGENTBRIDGE_REGISTRATION_TOKEN: '',
    AGENTBRIDGE_TOKEN_FILE: path.join(home, 'token.txt'),
  };
}

test('a missing credential is reported LOUDLY and starts nothing', () => {
  /*
   * THE FAILURE THIS WHOLE CHANGE IS ABOUT. Without a token, register-session
   * prints "hosted NOT CONFIGURED -- local only", registers anyway and EXITS 0.
   * A watcher started into that state looks like the problem is fixed while the
   * session stays invisible to every other machine, so the hook must refuse and
   * SAY SO rather than start one.
   */
  const home = mkTemp();
  const env = baseEnv(home); // note: token file deliberately not created

  const r = runHook('--session-start', env);

  assert.equal(r.status, 0, 'a hook must never fail a session');
  const msg = message(r);
  assert.match(msg, /NOT WATCHING/);
  assert.match(msg, /registration token could not be read/);
  assert.match(msg, /age out/);

  const pidFile = path.join(home, 'watchers', `claude-${SESSION_UUID}.json`);
  assert.equal(fs.existsSync(pidFile), false, 'nothing may be recorded when nothing was started');

  fs.rmSync(home, { recursive: true, force: true });
});

test('an unconfigured agent id refuses, and the message says what to set', () => {
  const home = mkTemp();
  const env = { ...baseEnv(home), AGENTBRIDGE_AGENT_ID: '' };
  fs.writeFileSync(path.join(home, 'token.txt'), 'dummy-token-value\n');

  const r = runHook('--session-start', env);
  assert.equal(r.status, 0);
  assert.match(message(r), /NOT WATCHING/);
  assert.match(message(r), /AGENTBRIDGE_AGENT_ID/);

  fs.rmSync(home, { recursive: true, force: true });
});

test('THE WIRING: the watcher starts, OUTLIVES the hook, and is stopped cleanly', async () => {
  /*
   * THE CLAIM BEING TESTED IS ABOUT THE HARNESS, NOT ABOUT NODE.
   *
   * Claude Code cancels a hook's entire process tree on timeout, so a watcher
   * spawned as an ordinary child would die with it. The script uses detached +
   * unref to escape that. This project has been wrong about exactly this kind of
   * "surely it works" claim often enough that it is asserted rather than
   * reasoned about: the hook process has FULLY EXITED by the time spawnSync
   * returns, so a child still alive here is a child that outlived its parent.
   */
  const home = mkTemp();
  const env = baseEnv(home);
  fs.writeFileSync(path.join(home, 'token.txt'), 'dummy-token-value\n');

  let pid = null;
  try {
    const r = runHook('--session-start', env);
    assert.equal(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);

    const msg = message(r);
    assert.match(msg, /refreshing every 5s/, `expected a watching message, got: ${msg}`);

    const pidFile = path.join(home, 'watchers', `claude-${SESSION_UUID}.json`);
    assert.equal(fs.existsSync(pidFile), true, 'a started watcher must be recorded');
    const record = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    pid = record.pid;
    assert.ok(Number.isInteger(pid) && pid > 0, 'the record must carry a real pid');
    assert.equal(record.agentId, 'test-agent');
    assert.equal(record.intervalSeconds, 5);

    // THE SURVIVAL ASSERTION. The parent is gone; this must still be running.
    assert.equal(alive(pid), true, 'the detached watcher did not outlive the hook');

    /*
     * IDEMPOTENCE, AGAINST THE LIVE ONE. SessionStart fires again on resume,
     * clear, compact and fork. A second watcher on the same row would leave the
     * loser killed at SessionEnd while the winner kept publishing.
     */
    const again = runHook('--session-start', env);
    assert.match(message(again), /already running/);
    assert.equal(
      JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid, pid,
      'the recorded pid must not change when a watcher is already running',
    );

    // THE STOP PATH.
    const stop = runHook('--session-end', env);
    assert.equal(stop.status, 0);
    assert.equal(fs.existsSync(pidFile), false, 'the record must be removed on stop');

    // Give the OS a moment to reap, then assert it is actually gone.
    for (let i = 0; i < 40 && alive(pid); i += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    assert.equal(alive(pid), false, 'the watcher was still running after session end');
    pid = null;
  } finally {
    // NEVER LEAVE A STRAY WATCHER BEHIND, whatever failed above.
    if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('stopping a session that was never watched says so rather than pretending', () => {
  const home = mkTemp();
  const env = baseEnv(home);
  fs.writeFileSync(path.join(home, 'token.txt'), 'dummy-token-value\n');

  const r = runHook('--session-end', env);
  assert.equal(r.status, 0);
  assert.match(message(r), /no watcher was running/);

  fs.rmSync(home, { recursive: true, force: true });
});
