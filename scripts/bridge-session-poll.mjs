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

/**
 * How far ahead of our own clock a cursor may be before it is refused.
 *
 * Generous on purpose: the comparison is between the SERVER's clock and this
 * machine's, and refusing a legitimate cursor re-delivers mail forever, which
 * is the spin this file exists to stop. Five minutes is far beyond any real
 * skew and still refuses every implausible value.
 */
const CURSOR_SKEW_MS = 5 * 60 * 1000;

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

/**
 * ADVANCE PAST WHAT WAS DELIVERED, given the previous cursor and the CLI's
 * stdout. Returns the new cursor, which is `prev` when there is nothing to
 * move to.
 *
 * EXPORTED SO IT CAN BE WATCHED FAILING. The supervisor's only other route to
 * this logic is a live bridge, and the wiring test drives an unreachable host
 * on purpose -- so the success path, which is the one carrying the defect this
 * function fixes, had no coverage at all until it moved out here. CLAUDE.md
 * rule 10: decision logic goes somewhere the suite can import.
 *
 * The CLI prints `  cursor  <iso>` after any batch of events. The value is the
 * SERVER's, so there is no clock skew to reason about and no overlap window to
 * tune -- which is what makes this better than any timestamp we could take.
 *
 * FORWARD ONLY. A malformed, unparseable or older value is ignored rather than
 * rewinding, because rewinding re-delivers everything and re-delivery is the
 * spin this whole change exists to stop.
 *
 * ANCHORED TO ITS OWN LINE. The CLI also prints event lines and an advisory
 * about reading details; matching `cursor` loosely anywhere in stdout is how a
 * check ends up agreeing with prose instead of data (rule 13).
 */
/**
 * A timestamp in MICROSECONDS, matching `parse` in src/events.mjs exactly.
 *
 * THIS MUST NOT DRIFT FROM THE SERVER'S COMPARISON, and it did, for four
 * commits. b5851bc taught `eventsFor` that Postgres emits six fractional digits
 * and that `Date.parse` truncates to three — so two events inside one
 * millisecond stopped collapsing and the later one began to be delivered. The
 * CLIENT was left on `Date.parse`.
 *
 * The result was worse than the bug it fixed. The server correctly delivers the
 * second event; `advanceCursor` compares `.123999` against a cursor of
 * `.123456`, finds them EQUAL after truncation, and its forward-only rule
 * (`t <= bestMs` → skip) refuses to adopt it. The cursor sticks, the same event
 * is delivered on every cycle forever, and `classifyCycle` calls each one
 * `done` — which is the branch with no backoff. A rare silent drop became a
 * permanent re-delivery loop with an unthrottled re-spawn, on a script that
 * runs as a SessionStart hook on every session on this machine. Found by blind
 * audit; I shipped the server half and called the class closed.
 *
 * Duplicated rather than imported because this script is a hook that must run
 * with no module graph behind it. test/pollCursorAdvances.test.mjs pins the two
 * implementations against each other so the duplication cannot drift again.
 */
export function parseCursorInstant(v) {
  // MUTATION M6: back to millisecond Date.parse, dropping the microseconds.
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) return null;
  return ms;
}

export function advanceCursor(prev, stdout, now = Date.now()) {
  const lines = String(stdout ?? '').split('\n');
  const prevMs = parseCursorInstant(prev);
  let best = prev;
  let bestMs = Number.isFinite(prevMs) ? prevMs : -Infinity;

  /*
   * A CURSOR IN THE FUTURE IS NEVER LEGITIMATE, AND ACCEPTING ONE IS
   * UNRECOVERABLE.
   *
   * The server's cursor is an event's own created_at, so it is always in the
   * past. A future value can only arrive by accident or by injection — and
   * because this function is FORWARD-ONLY by design, once adopted nothing can
   * ever move past it. The session then polls for events after the year 9999,
   * finds none, exits 0 quietly, and looks perfectly healthy while receiving
   * nothing for the rest of its life. There is no recovery short of restarting
   * the session, and nothing anywhere says what happened.
   *
   * THE INJECTION IS REAL, not theoretical. The CLI interpolates event fields
   * into the lines this function reads. `from` and `type` are closed sets, but
   * a newline inside a field that is only checked for non-emptiness — task_id
   * or lane_id — manufactures a genuine `  cursor  <value>` line at column
   * zero, which is exactly what the anchoring above was built to trust. Found
   * by blind audit.
   *
   * ANCHORING WAS THE WRONG LAYER TO FIX IT AT. It stops prose being mistaken
   * for data; it cannot stop data being shaped like data. So this adds the
   * bound that does not depend on where the line came from: a cursor may not be
   * meaningfully ahead of our own clock.
   *
   * THE SKEW ALLOWANCE IS DELIBERATELY GENEROUS. The comparison is between the
   * SERVER's clock and this machine's, and refusing a legitimate cursor would
   * re-deliver mail forever — the spin this file exists to stop. Five minutes
   * is far beyond any real skew and still refuses every implausible value.
   */
  const ceiling = (now + CURSOR_SKEW_MS) * 1000;

  for (const line of lines) {
    const m = /^\s*cursor\s+(\S+)\s*$/.exec(line);
    if (!m) continue;
    const t = parseCursorInstant(m[1]);
    if (!Number.isFinite(t) || t <= bestMs) continue;
    if (t > ceiling) continue;
    best = m[1];
    bestMs = t;
  }
  return best;
}

/**
 * Anchored to the start of a line and to the fixed prefix the CLI itself
 * writes, BEFORE any interpolated detail.
 *
 * `res.detail` from the far end is interpolated into the CLI's stderr, so an
 * unanchored match reads a proxy or WAF body as if it were our own CLI's
 * verdict — data mistaken for a conclusion (rule 4). A 5xx page containing the
 * words "no registration token" would have stopped the poller permanently on a
 * transient fault.
 */
const PERMANENT_PATTERNS = Object.freeze([
  /^error: no registration token\b/im,
  /^error: the Bridge REFUSED this credential\b/im,
  /^error: the Bridge refused the wait\b/im,
]);

/**
 * The CLI's verdict is its FIRST line. Everything after it is detail.
 *
 * THE `m` FLAG WAS THE HOLE, AND MY OWN COMMENT CLAIMED THE OPPOSITE. I
 * anchored these patterns to stop far-end text being read as our own
 * conclusion, and then used `/m`, which anchors to ANY line start. The far end
 * controls that: `src/hostedRegistry.mjs` builds a 5xx detail from the response
 * BODY, slices it to 200 characters without stripping newlines, and
 * `bin/agentbridge.mjs` interpolates it into `error: the Bridge is unreachable
 * (...)`. So a newline inside a proxy or WAF body puts `error: no registration
 * token` at column zero and permanently stops the poller on a TRANSIENT fault —
 * exactly the outcome this script exists to prevent.
 *
 * My gate for it used three poisoned strings and none contained a newline: a
 * hostile property checked with inputs that could not express the attack
 * (rules 7 and 8). The probe bounded nothing.
 *
 * So the verdict is taken from the first line only. The CLI writes its
 * conclusion first and its advice after, and nothing the far end says can
 * become the first line of our own process's stderr.
 */
const firstLine = (text) => String(text ?? ''); // MUTATION M5: whole stderr, not the first line

/**
 * WHAT ONE POLL CYCLE MEANT. Pure, exported, and that is the point.
 *
 * This decision used to live inline in `supervise`, which cannot be imported
 * and can only be driven through a real spawn. A blind audit measured the cost:
 * removing the cursor carry, removing the credential abort, flipping the import
 * guard and changing the null-status handling were ALL uncaught — four separate
 * mutations, not one named assertion between them. The logic had tests; the
 * wiring was a separate claim with none (rule 17), and the branch that carried
 * the defects was the one an unreachable-host fixture can never reach.
 *
 * @param {{status: number|null, error?: Error, stderr?: string}} r a spawnSync result
 * @returns {'permanent'|'quiet'|'done'|'retry'}
 *   permanent  stop; asking again cannot change the answer
 *   quiet      the child ran and waited out our timeout — re-arm immediately
 *   done       a normal cycle: woken (0) or nothing came (3)
 *   retry      anything else — report and back off
 */
export function classifyCycle(r) {
  const err = firstLine(r?.stderr);
  if (PERMANENT_PATTERNS.some((re) => re.test(err))) return 'permanent';

  /*
   * A null status is the quiet case ONLY IF THE CHILD ACTUALLY RAN. spawnSync
   * also returns null when the spawn itself failed, and that returns instantly:
   * treating it as quiet is a hot spin at roughly 1500 iterations per second,
   * silent, because this path writes nothing and the supervisor is detached.
   * `r.error` is set on a spawn failure and absent on a timeout kill.
   */
  if (r?.status === null || r?.status === undefined) return r?.error ? 'retry' : 'quiet';

  return (r.status === 0 || r.status === 3) ? 'done' : 'retry';
}

/* ── the supervisor: re-arm the poll until told to stop ──────────────────── */

async function supervise({ sessionId, tokenFile }) {
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  /*
   * THE CURSOR IS CARRIED, AND NOT CARRYING IT WAS A SELF-INFLICTED REQUEST LOOP.
   *
   * This used to recompute `since` as `now - 600s` on EVERY iteration. The
   * server returns the moment any event sits inside that window, so a single
   * message made every cycle return instantly, and the supervisor re-spawned
   * immediately because it only backs off on a FAILING status. A fresh node
   * process and a /wait round trip every few hundred milliseconds -- each one
   * pulling all tasks and 200 messages -- for the full ten minutes the event
   * stayed inside the trailing window. Per session, per event. The mail this
   * poll exists to deliver was the trigger, so the busiest moment was the one
   * that hammered the edge function hardest. Found by blind audit, 2026-09-18.
   *
   * The far end already solves this and was being ignored: `wait-for-work`
   * tracks the server's own cursor and PRINTS it on a line of its own. So the
   * supervisor reads that line back and hands it to the next call.
   *
   * READING THE CURSOR IS NOT INTERPRETING THE EVENT. The comment below still
   * holds -- this loop does not look at what arrived, and must not, or it
   * becomes a dispatcher. A cursor is bookkeeping about WHERE it has read to,
   * which is the one thing a poll is actually obliged to remember.
   *
   * The trailing window survives as the SEED only. It is what "catch up on
   * anything from the last ten minutes" means at startup, and it is used
   * exactly once.
   */
  let cursor = new Date(Date.now() - STALE_WINDOW_SECONDS * 1000).toISOString();

  while (!stopping) {
    const r = spawnSync(process.execPath, [
      CLI, 'wait-for-work',
      '--session', sessionId,
      '--timeout', String(POLL_SECONDS),
      '--since', cursor,
      '--token-file', tokenFile,
    ], { cwd: REPO, encoding: 'utf8', windowsHide: true, timeout: (POLL_SECONDS + 120) * 1000 });

    cursor = advanceCursor(cursor, r.stdout);

    const err = String(r.stderr ?? '');

    /*
     * PERMANENT MEANS STOP. RETRYING IT IS A BUSY LOOP AGAINST A CLOSED DOOR.
     * 66065c7 established that at registration; this loop was left retrying
     * every 15 seconds for the life of the session.
     *
     * Matched on the message rather than the status because `wait-for-work`
     * answers 2 for all four of NOT CONFIGURED, REFUSED, REJECTED and
     * unreachable, and unreachable is the one case that genuinely IS transient,
     * so the exit code cannot be the discriminator.
     *
     * TWO THINGS THE FIRST VERSION GOT WRONG, both found by blind audit.
     *
     * IT MISSED `REFUSED`, which its own comment listed. The pattern wanted
     * "REFUSED this credential" and the CLI prints "refused the wait" for that
     * case. index.ts answers 409 unknown-session for a session that is not in
     * session_registrations, hostedRegistry maps 409 to REFUSED, and the
     * supervisor then retried a permanently unknown session every 15 seconds
     * forever. Reachable on any session whose registration hit a network blip,
     * which is precisely the case sessionStart deliberately proceeds through.
     *
     * AND IT MATCHED FAR-END TEXT. `res.detail` is interpolated into the CLI's
     * stderr, so a proxy or WAF body containing "no registration token" turned a
     * transient fault into a permanent stop — the exact outcome this script
     * exists to prevent. Data read as a verdict, rule 4.
     *
     * So the match is ANCHORED to the start of a line and to the fixed prefix
     * the CLI itself writes, before any interpolated detail. What the far end
     * says can no longer be mistaken for what our own CLI concluded.
     */
    const verdict = classifyCycle(r);

    if (verdict === 'permanent') {
      const line = err.split('\n').find((l) => /^error:/i.test(l)) ?? err.split('\n')[0];
      process.stderr.write(`[poll] stopping, this will not fix itself: ${line.slice(0, 200)}\n`);
      /*
       * HONEST LIMIT: an unknown session is recoverable in principle — a fresh
       * register-session would fix it — and this loop does not attempt that.
       * supervise() only ever calls wait-for-work; registration happens once, in
       * sessionStart. Stopping loudly is better than hammering a 409 forever,
       * and it is NOT the same as solving it. Re-registration from the
       * supervisor is a real change with its own failure modes and is not being
       * smuggled in here.
       */
      break;
    }

    /*
     * A null STATUS IS THE QUIET CASE **ONLY IF THE CHILD ACTUALLY RAN**, and
     * the first version of this did not check.
     *
     * Without --once the CLI waits internally until something arrives, so on a
     * silent bridge it is still waiting when our own spawn timeout stops it.
     * That is the poll working, and reporting it was a false alarm every twelve
     * minutes on a healthy session.
     *
     * BUT spawnSync ALSO RETURNS status null WHEN THE SPAWN ITSELF FAILED, and
     * that returns INSTANTLY. `continue` on it is a tighter hot spin than the
     * one this file was written to fix: measured at roughly 1500 iterations per
     * second, and silent, because the supervisor is detached with stdio to a log
     * file and this path wrote nothing. Reachable through EMFILE or EAGAIN under
     * load, a moved process.execPath, or an AV/EDR product blocking the spawn.
     * Before the cursor commit this fell into the backoff branch below; I moved
     * it out and did not notice. Found by blind audit.
     *
     * `r.error` is set on a spawn failure and absent on a timeout kill, and it
     * was sitting unread on the result object. So the quiet case is a null
     * status WITHOUT an error; a null status WITH one falls through to the
     * backoff, where it belongs and where it is at least audible.
     *
     * (Exit 3 is not reachable as this supervisor invokes the CLI -- it is set
     * only under --once, which is not passed. Handled below anyway, because it
     * is the documented contract and a future caller may pass it.)
     */
    if (verdict === 'quiet') continue;

    /*
     * EXIT 0 means an event arrived -- the CLI has already printed it, and this
     * loop does NOT read or act on it beyond the cursor: a poll that interpreted
     * its own wake-up would be a dispatcher, and this is a heartbeat with a
     * doorbell attached. EXIT 3 means nothing came.
     *
     * Anything else is reported and the loop continues. A poll that gave up on
     * the first transient failure would leave the session silently invisible,
     * which is the exact condition it exists to prevent.
     */
    if (verdict === 'retry') {
      const why = r.error
        ? `could not start: ${r.error.code ?? ''} ${r.error.message ?? r.error}`.trim()
        : `exited ${r.status}: ${err.slice(0, 200)}`;
      process.stderr.write(`[poll] wait-for-work ${why}\n`);
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

  /*
   * THE THREE HOSTED OUTCOMES ARE NOT THE SAME, AND TREATING THEM ALIKE WAS A
   * BUG MY OWN TEST CAUGHT.
   *
   * The first version aborted on any non-zero exit. register-session exits 1
   * when the hosted endpoint is UNREACHABLE -- by design, because a one-shot
   * that could not publish should not report success. But unreachable is
   * TRANSIENT, and refusing to poll because of one network blip leaves the
   * session invisible for the rest of its life, which is the exact failure this
   * script exists to end. src/hostedRegistry.mjs makes the same distinction for
   * --watch, and for the same reason: "surviving a network blip is the entire
   * point of a watcher."
   *
   *   NOT CONFIGURED  no credential. Nothing to keep alive, and no amount of
   *                   retrying invents one. Abort, loudly.
   *   REJECTED        the credential is refused. Permanent until it changes, so
   *                   retrying is a busy loop against a closed door. Abort.
   *   UNREACHABLE     the network. PROCEED -- the supervisor retries, and the
   *                   session becomes visible the moment it comes back.
   *
   * The local registration has already been written in every one of these
   * cases, so proceeding costs nothing but a poll that fails until it does not.
   */
  const out = `${reg.stdout ?? ''}${reg.stderr ?? ''}`;
  if (/NOT CONFIGURED/.test(out)) {
    say('agentbridge poll: NOT POLLING -- registration reported hosted NOT CONFIGURED, so this '
      + 'session is invisible to other machines and a poll would have nothing to keep alive.');
    return;
  }
  if (/REJECTED/i.test(out)) {
    say('agentbridge poll: NOT POLLING -- the registration token was REFUSED. That is permanent '
      + 'until the credential changes, so retrying would be a busy loop against a closed door.');
    return;
  }
  if (reg.status !== 0 && !/UNREACHABLE/i.test(out)) {
    say(`agentbridge poll: NOT POLLING -- register-session exited ${reg.status}: ${out.trim().slice(0, 160)}`);
    return;
  }

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

/*
 * ONLY WHEN RUN, NEVER WHEN IMPORTED.
 *
 * This dispatch used to be unconditional at the top level, so `import` executed
 * it. test/pollCursorAdvances.test.mjs imports one pure function from this file
 * and the import printed the usage line -- visible, harmless, and the wrong
 * half of the problem.
 *
 * The real hazard is that the branch taken is decided by `process.argv` of
 * WHOEVER IMPORTED IT. Under the test runner that is argv with no flags, which
 * is why this was benign today. A runner, wrapper or future test invoked with
 * `--session-start` anywhere in its argv would have registered a session
 * against the operator's live bridge as a side effect of an import, and
 * `--supervise` would have detached a poller that nothing recorded and nothing
 * would ever stop. An import must not be able to do that.
 */
const RUN_DIRECTLY = !!process.argv[1] && path.resolve(process.argv[1]) === SELF;

if (RUN_DIRECTLY) try {
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
