#!/usr/bin/env node
/**
 * HOLD A LONG POLL FOR THIS SESSION, SO THE BRIDGE CAN SEE IT.
 *
 * THE PROBLEM, measured 2026-09-18. Danny watched the bridge report code-b as
 * "not live, silent 3517s" forty-five seconds after it sent a message through
 * that same bridge. So the failure is not "agents go quiet and look dead" -- it
 * is that an agent can be DEMONSTRABLY talking and still look dead.
 *
 * WHY. touchLiveness fires at exactly four call sites in the edge function --
 * the /task, /return, /wait and /review HTTP routes. None is on the MCP tool
 * path, so no tool call stamps anything, send_message included. Registration
 * stamps once and ages out after ten minutes.
 *
 * WHY NOT STAMP ON THE TOOL PATH INSTEAD. Tried on paper and rejected: the MCP
 * path authenticates against coordinator_tokens or reader_tokens, while
 * /register authenticates against registration_tokens and records THAT label.
 * Different token classes, different label space -- a coordinator token does not
 * identify a session, and stamping from anything caller-supplied would let one
 * token forge liveness for a worker that died hours ago. That is the hole
 * code-b/liveness-from-activity explicitly refused to open.
 *
 * SO THE ONLY HONEST STAMP IS THE ONE THAT ALREADY EXISTS. /wait presents a
 * registration token AND names its own session, which is exactly the evidence
 * that design requires. Holding that poll does two jobs at once: the session
 * stays visible, and its mail arrives without anybody being told to look.
 * Measured: a 13-minute poll held a session past the 600s window with no
 * re-registration, and woke on a real message with no human involved.
 *
 * THIS SCRIPT IS THE STARTER AND NOTHING ELSE. It is meant to be called from a
 * SessionStart hook, which is the only thing that runs for every session without
 * somebody remembering. Registering that hook needs .claude/settings.json, which
 * is a protected path and is separately refused by the harness classifier, so
 * that half belongs to whoever owns the guard. This half does not, and is here
 * so that half is one line.
 *
 * IT NEVER TOUCHES THE CREDENTIAL. The CLI's --token-file flag takes a PATH, so
 * the token is read in-process by the CLI and never enters this script, an argv,
 * or a log line.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CLI = path.join(REPO, 'bin', 'agentbridge.mjs');
const SELF = fileURLToPath(import.meta.url);

const DEFAULT_TOKEN_FILE = path.join(
  os.homedir(), 'Documents', 'agentbridge-secrets', 'registration-token.txt',
);

/**
 * One poll is bounded; the supervisor re-arms it.
 *
 * WHY BOTH. wait-for-work returns when its own --timeout elapses, so a single
 * call leaves a gap afterwards however long the timeout. And --once is worse
 * than it looks: it returns at the SERVER's window, roughly two minutes, not at
 * the timeout you asked for. I measured that and briefly mistook a 2-minute
 * return for proof that an 11-minute poll had held.
 */
const POLL_SECONDS = 600;
const STALE_WINDOW_SECONDS = 600;

const say = (message) => process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);

async function readPayload() {
  let raw = '';
  try { for await (const chunk of process.stdin) raw += chunk; } catch { /* no stdin is survivable */ }
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

const homeDir = (env) => env.AGENTBRIDGE_HOME || path.join(os.homedir(), '.agentbridge');

/** session_id becomes a file name, so its shape is checked before it is joined to a path. */
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function paths(env, sessionId) {
  const dir = path.join(homeDir(env), 'polls');
  return { dir, pidFile: path.join(dir, `${sessionId}.json`), logFile: path.join(dir, `${sessionId}.log`) };
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform !== 'win32') return true;
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'],
    { encoding: 'utf8', windowsHide: true });
  return r.status === 0 && /"node\.exe"/i.test(String(r.stdout));
}

const readRecord = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/* ── the supervisor: re-arm the poll until told to stop ──────────────────── */

async function supervise({ sessionId, tokenFile }) {
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (!stopping) {
    const since = new Date(Date.now() - STALE_WINDOW_SECONDS * 1000).toISOString();
    const r = spawnSync(process.execPath, [
      CLI, 'wait-for-work',
      '--session', sessionId,
      '--timeout', String(POLL_SECONDS),
      '--since', since,
      '--token-file', tokenFile,
    ], { cwd: REPO, encoding: 'utf8', windowsHide: true, timeout: (POLL_SECONDS + 120) * 1000 });

    /*
     * EXIT 3 IS "NOTHING HAPPENED" AND IS THE COMMON CASE, not a failure. Exit 0
     * means an event arrived -- the CLI has already printed it, and this loop
     * does NOT read or act on it: a poll that interpreted its own wake-up would
     * be a dispatcher, and this is a heartbeat with a doorbell attached.
     *
     * Anything else is reported and the loop continues. A poll that gave up on
     * the first transient failure would leave the session silently invisible,
     * which is the exact condition it exists to prevent.
     */
    if (r.status !== 0 && r.status !== 3) {
      process.stderr.write(`[poll] wait-for-work exited ${r.status}: ${String(r.stderr).slice(0, 200)}\n`);
      if (stopping) break;
      // Back off briefly so a hard failure cannot spin.
      await new Promise((resolve) => { setTimeout(resolve, 15_000); });
    }
  }
}

/* ── session start: register, then detach a supervisor ───────────────────── */

async function sessionStart() {
  const env = process.env;
  const payload = await readPayload();

  const raw = typeof payload?.session_id === 'string' ? payload.session_id.trim() : '';
  if (!raw || !SAFE.test(raw)) { say('agentbridge poll: NOT POLLING -- no usable session_id in the hook payload'); return; }
  const sessionId = `claude-${raw}`;

  const agentId = String(env.AGENTBRIDGE_AGENT_ID ?? '').trim();
  if (!agentId || !SAFE.test(agentId)) {
    say('agentbridge poll: NOT POLLING -- AGENTBRIDGE_AGENT_ID is not set. An agent id is '
      + 'never invented here, because a fabricated identity on the roster is what work gets '
      + 'routed by. This session will be invisible to every other machine.');
    return;
  }

  const tokenFile = String(env.AGENTBRIDGE_TOKEN_FILE ?? '').trim() || DEFAULT_TOKEN_FILE;
  if (!fs.existsSync(tokenFile)) {
    say(`agentbridge poll: NOT POLLING -- no registration token at ${tokenFile}. Without it a `
      + 'session registers LOCAL ONLY and still exits 0, which is the silent no-op this exists to end.');
    return;
  }

  const { dir, pidFile, logFile } = paths(env, sessionId);
  const existing = readRecord(pidFile);
  if (existing && alive(existing.pid)) {
    say(`agentbridge poll: already polling for ${sessionId} (pid ${existing.pid})`);
    return;
  }

  /*
   * REGISTER FIRST, SYNCHRONOUSLY. The poll keeps a session alive; it does not
   * create one. /wait resolves the session from the registry, so polling for a
   * session that was never registered fails every cycle -- quietly, in a
   * detached process nobody is reading.
   */
  const reg = spawnSync(process.execPath, [
    CLI, 'register-session',
    '--agent', agentId, '--session', sessionId,
    '--capacity', 'idle', '--token-file', tokenFile,
    ...(env.AGENTBRIDGE_LANE ? ['--lane', String(env.AGENTBRIDGE_LANE)] : []),
  ], { cwd: REPO, encoding: 'utf8', windowsHide: true, timeout: 60_000 });

  const out = `${reg.stdout ?? ''}${reg.stderr ?? ''}`;
  if (/NOT CONFIGURED/.test(out)) {
    say('agentbridge poll: NOT POLLING -- registration reported hosted NOT CONFIGURED, so this '
      + 'session is invisible to other machines and a poll would have nothing to keep alive.');
    return;
  }
  if (reg.status !== 0) { say(`agentbridge poll: NOT POLLING -- register-session exited ${reg.status}`); return; }

  fs.mkdirSync(dir, { recursive: true });
  const log = fs.openSync(logFile, 'a');

  /*
   * DETACHED, because Claude Code cancels a hook's entire process tree when the
   * hook times out, and because a hook that waits for this would block session
   * start for as long as the poll runs.
   */
  const child = spawn(process.execPath, [SELF, '--supervise', '--session', sessionId, '--token-file', tokenFile], {
    cwd: REPO, env, detached: true, windowsHide: true, stdio: ['ignore', log, log],
  });
  child.unref();

  fs.writeFileSync(pidFile, `${JSON.stringify({
    pid: child.pid, sessionId, agentId, startedAt: new Date().toISOString(), logFile,
  }, null, 2)}\n`);

  say(`agentbridge poll: ${agentId} / ${sessionId} is polling (pid ${child.pid}); liveness is `
    + 'stamped every cycle and messages arrive without being asked for');
}

/* ── session end: stop beating, then deregister ──────────────────────────── */

async function sessionEnd() {
  const env = process.env;
  const payload = await readPayload();
  const raw = typeof payload?.session_id === 'string' ? payload.session_id.trim() : '';
  if (!raw || !SAFE.test(raw)) { say('agentbridge poll: no usable session_id at session end'); return; }
  const sessionId = `claude-${raw}`;

  const { pidFile } = paths(env, sessionId);
  const rec = readRecord(pidFile);

  /*
   * STOP THE POLL FIRST. A cycle landing between the deregistration and the exit
   * re-stamps the session that was just removed, which then ages out ten minutes
   * later looking as though it died rather than stopped -- the precise confusion
   * deregistering exists to prevent.
   */
  if (rec && alive(rec.pid)) { try { process.kill(rec.pid, 'SIGTERM'); } catch { /* going away regardless */ } }

  const tokenFile = String(env.AGENTBRIDGE_TOKEN_FILE ?? '').trim() || DEFAULT_TOKEN_FILE;
  const r = spawnSync(process.execPath, [
    CLI, 'unregister-session', '--session', sessionId,
    ...(fs.existsSync(tokenFile) ? ['--token-file', tokenFile] : []),
  ], { cwd: REPO, encoding: 'utf8', windowsHide: true, timeout: 30_000 });

  try { fs.rmSync(pidFile, { force: true }); } catch { /* best effort */ }

  if (!rec) { say(`agentbridge poll: nothing was polling for ${sessionId}`); return; }
  say(r.status === 0
    ? `agentbridge poll: stopped and deregistered ${sessionId}`
    : `agentbridge poll: poll stopped, but deregistering ${sessionId} exited ${r.status}`);
}

/* ── dispatch ────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};

try {
  if (argv.includes('--supervise')) {
    const sessionId = flag('--session');
    const tokenFile = flag('--token-file');
    if (!sessionId || !tokenFile) { process.stderr.write('[poll] --supervise needs --session and --token-file\n'); process.exit(2); }
    await supervise({ sessionId, tokenFile });
  } else if (argv.includes('--session-end')) {
    await sessionEnd();
  } else if (argv.includes('--session-start')) {
    await sessionStart();
  } else {
    say('agentbridge poll: pass --session-start or --session-end');
  }
} catch (e) {
  // A hook never fails a session. Say what broke and leave.
  say(`agentbridge poll: NOT POLLING -- the hook itself failed (${String(e?.message ?? e).slice(0, 160)})`);
}
