#!/usr/bin/env node
/**
 * START AND STOP THE BRIDGE WATCHER AROUND A CLAUDE CODE SESSION.
 *
 * `register-session --watch` keeps a session on the roster. Nothing started it,
 * so every agent aged out after ten minutes and the roster read `offline` for
 * sessions that were running. See src/sessionWatch.mjs for the measurement.
 *
 * Wired as two hooks:
 *   SessionStart -> --session-start   spawns the watcher, detached
 *   SessionEnd   -> --session-end     stops it and deregisters cleanly
 *
 * THIS SCRIPT IS THIN ON PURPOSE. Every decision it makes lives in
 * src/sessionWatch.mjs, which the suite imports; what is left here is process
 * control and file I/O, which a hook script is the only place to do.
 *
 * IT NEVER BLOCKS A SESSION AND NEVER FAILS ONE. SessionStart cannot block, and
 * a registration problem is not a reason to interfere with the operator's work
 * anyway. Every path exits 0; the only thing a failure changes is the message.
 *
 * IT NEVER PRINTS THE TOKEN. The credential is read from a file outside every
 * worktree and handed to the child through `env`, never through argv -- argv is
 * visible in the process table. Only its presence and length are ever reported.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  resolveIdentity,
  resolveInterval,
  watchArgv,
  stopArgv,
  watcherPaths,
  shouldStartWatcher,
  describeOutcome,
  sessionIdFor,
} from '../src/sessionWatch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CLI = path.join(REPO, 'bin', 'agentbridge.mjs');

/** The operator's secrets directory, kept outside every worktree so no `git add` can reach it. */
const DEFAULT_TOKEN_FILE = path.join(
  os.homedir(), 'Documents', 'agentbridge-secrets', 'registration-token.txt',
);

function say(message) {
  process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);
}

async function readPayload() {
  let raw = '';
  try {
    for await (const chunk of process.stdin) raw += chunk;
  } catch { /* no stdin is not a reason to fail a session */ }
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

function homeDir(env) {
  return env.AGENTBRIDGE_HOME || path.join(os.homedir(), '.agentbridge');
}

/**
 * THE CREDENTIAL, AND THE FAILURE THAT MATTERS MOST.
 *
 * Without it `register-session` prints "hosted NOT CONFIGURED -- local only",
 * registers anyway and EXITS 0. That is the silent no-op this whole exercise is
 * about, so a missing token is reported as NOT WATCHING rather than started and
 * hoped for: a watcher publishing to nowhere is worse than none, because it
 * looks like the problem is solved.
 */
function loadToken(env) {
  const already = String(env.AGENTBRIDGE_REGISTRATION_TOKEN ?? '').trim();
  if (already) return { ok: true, token: already, source: 'environment' };

  const file = String(env.AGENTBRIDGE_TOKEN_FILE ?? '').trim() || DEFAULT_TOKEN_FILE;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, reason: `the registration token could not be read from ${file} (${e.code ?? e.message})` };
  }
  const token = raw.trim();
  if (!token) return { ok: false, reason: `the registration token file ${file} is empty` };
  return { ok: true, token, source: file };
}

function readRecord(pidFile) {
  try { return JSON.parse(fs.readFileSync(pidFile, 'utf8')); } catch { return null; }
}

/**
 * IS THAT PID STILL OURS?
 *
 * `process.kill(pid, 0)` answers "does a process with this id exist", which is
 * NOT the same question -- pids are recycled, and a stale pidfile pointing at a
 * recycled id would have this script terminate an unrelated program. So the
 * image name is checked too, and a kill only happens for a node process.
 *
 * That narrows the hazard, it does not eliminate it: another node process could
 * in principle inherit the id. The residual risk is accepted and written down
 * rather than hidden, because the alternative -- never stopping the watcher --
 * leaves a session publishing after it has ended.
 */
function aliveAsNode(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform !== 'win32') return true;
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
    encoding: 'utf8', windowsHide: true,
  });
  if (r.status !== 0 || typeof r.stdout !== 'string') return false;
  return /"node\.exe"/i.test(r.stdout);
}

async function sessionStart() {
  const env = process.env;
  const payload = await readPayload();

  const id = resolveIdentity(env, payload);
  if (!id.ok) { say(describeOutcome({ kind: 'refused', reason: id.reason })); return; }

  const interval = resolveInterval(env);
  if (!interval.ok) { say(describeOutcome({ kind: 'refused', reason: interval.reason })); return; }

  const { dir, pidFile, logFile } = watcherPaths(homeDir(env), id.sessionId);

  const record = readRecord(pidFile);
  const decision = shouldStartWatcher({ record, isAlive: record ? aliveAsNode(record.pid) : false });
  if (!decision.start) { say(describeOutcome({ kind: 'already', sessionId: id.sessionId, pid: record.pid })); return; }

  const tok = loadToken(env);
  if (!tok.ok) { say(describeOutcome({ kind: 'refused', reason: tok.reason })); return; }

  fs.mkdirSync(dir, { recursive: true });
  const out = fs.openSync(logFile, 'a');

  /*
   * DETACHED, AND THAT IS THE RISKY PART OF THIS FILE.
   *
   * Claude Code cancels a hook's ENTIRE PROCESS TREE when the hook times out, so
   * a watcher spawned as an ordinary child would be killed with it. detached
   * puts the child in its own group and unref() lets this process exit at once,
   * which also keeps the hook far away from its own timeout.
   *
   * This is a claim about the harness, not about node, and it is exactly the
   * kind of claim this project has been wrong about before. It is asserted in
   * test/sessionWatchWiring.test.mjs by spawning a real child this way and
   * confirming it outlives its parent.
   */
  const child = spawn(process.execPath, [CLI, ...watchArgv({ ...id, intervalSeconds: interval.seconds })], {
    cwd: REPO,
    env: { ...env, AGENTBRIDGE_REGISTRATION_TOKEN: tok.token },
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
  });
  child.unref();

  fs.writeFileSync(pidFile, `${JSON.stringify({
    pid: child.pid,
    sessionId: id.sessionId,
    agentId: id.agentId,
    lane: id.lane,
    intervalSeconds: interval.seconds,
    startedAt: new Date().toISOString(),
    logFile,
  }, null, 2)}\n`);

  say(describeOutcome({
    kind: 'watching',
    agentId: id.agentId,
    sessionId: id.sessionId,
    intervalSeconds: interval.seconds,
    pid: child.pid,
  }));
}

async function sessionEnd() {
  const env = process.env;
  const payload = await readPayload();

  const sessionId = sessionIdFor(payload);
  if (!sessionId) { say(describeOutcome({ kind: 'refused', reason: 'the hook payload carried no usable session_id' })); return; }

  const { pidFile } = watcherPaths(homeDir(env), sessionId);
  const record = readRecord(pidFile);

  /*
   * STOP BEATING FIRST, THEN DEREGISTER. bin/agentbridge.mjs makes the same
   * point about its own stop(): a heartbeat landing between the removal and the
   * exit re-registers the session that was just removed, and it then ages out
   * ten minutes later looking as though it died rather than stopped.
   */
  if (record && aliveAsNode(record.pid)) {
    try { process.kill(record.pid, 'SIGTERM'); } catch { /* it is going away either way */ }
  }

  /*
   * THE DEREGISTRATION IS DONE HERE, NOT LEFT TO THE WATCHER'S SIGTERM HANDLER.
   * Windows has no real signals: process.kill terminates the child without ever
   * running the handler that publishes the offline row. On POSIX the handler
   * would run and this is then a harmless second removal, which
   * unregister-session already reports as "no registration for ...".
   */
  const tok = loadToken(env);
  const r = spawnSync(process.execPath, [CLI, ...stopArgv(sessionId)], {
    cwd: REPO,
    env: tok.ok ? { ...env, AGENTBRIDGE_REGISTRATION_TOKEN: tok.token } : env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });

  try { fs.rmSync(pidFile, { force: true }); } catch { /* best effort */ }

  if (!record) { say(describeOutcome({ kind: 'nothing-to-stop', sessionId })); return; }
  if (r.status === 0) { say(describeOutcome({ kind: 'stopped', sessionId })); return; }
  say(describeOutcome({
    kind: 'refused',
    reason: `the watcher was stopped but deregistering ${sessionId} exited ${r.status}`,
  }));
}

const mode = process.argv.includes('--session-end') ? 'end'
  : process.argv.includes('--session-start') ? 'start'
    : null;

try {
  if (mode === 'start') await sessionStart();
  else if (mode === 'end') await sessionEnd();
  else say('agentbridge watch: pass --session-start or --session-end');
} catch (e) {
  // A session is never failed by this. Say what broke and leave.
  say(describeOutcome({ kind: 'refused', reason: `the watch hook itself failed (${String(e?.message ?? e).slice(0, 160)})` }));
}
