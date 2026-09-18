/**
 * SESSION WATCH -- the decisions behind keeping a registration alive.
 *
 * WHY THIS EXISTS. `register-session --watch` was written carefully and works:
 * HEAD is re-resolved on every beat, the interval defaults to 120s well inside
 * the 600s stale window, the timer is ref'd so the loop stays open, and a clean
 * stop deregisters instead of ageing out. NOTHING STARTED IT.
 *
 * Measured 2026-09-18 07:29Z: all ten agents on the roster read `offline` while
 * the operator reported two of them live. The decisive check was the LOCAL
 * registry, which needs no network -- `agentbridge workers` reported
 * `fixer (no live session)` on the very machine fixer was running on. A live
 * `--watch` would have held a local row. Every one of the nine had registered
 * one-shot and aged out ten minutes later.
 *
 * That is CLAUDE.md rule 17: a control that is never consulted is not a control,
 * and the wiring is a separate claim from the logic. Only the logic had tests.
 *
 * WHY THE DECISIONS LIVE HERE AND NOT IN THE SCRIPT. Rule 10: a guard that
 * cannot be imported is a guard nobody has watched fail. A hook script is run by
 * Claude Code with a JSON payload on stdin and is awkward to exercise; these
 * functions are pure, so the refusals can be watched going red directly.
 *
 * HOME IS A PARAMETER, NEVER READ FROM THE ENVIRONMENT HERE. src/config.mjs
 * resolves HOME at import time from process.env, and a module that does that
 * reaches into the operator's real `~/.agentbridge` from inside the suite --
 * which is how a live override grant once turned a guard proof red and blamed
 * the guard. Callers pass the directory in; tests pass a temp one.
 */
import path from 'node:path';

/** Well inside the 600s stale window: a refresh landing at 9m59s has already aged out. */
export const DEFAULT_INTERVAL_SECONDS = 120;

/** src/liveRegistry.mjs STALE_AFTER_MS, in seconds. Mirrored for the bound check below. */
export const STALE_WINDOW_SECONDS = 600;

/** bin/agentbridge.mjs refuses anything under this. Refuse it here too, with a reason. */
export const MIN_INTERVAL_SECONDS = 5;

export const SESSION_PREFIX = 'claude-';

/*
 * AN ID THAT BECOMES A FILE NAME IS UNTRUSTED INPUT.
 *
 * session_id arrives from the hook payload and is used to build a pidfile path.
 * A value of `../../x` would escape the watcher directory, so the shape is
 * checked before it is ever joined to anything. This is not defensive padding:
 * the only reason it has never mattered is that the producer happens to emit
 * uuids today, and "the caller is well behaved" is not a property this file can
 * verify.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The bridge session id for a Claude Code session.
 *
 * NOT TRUNCATED. The obvious readability win is to slice the uuid to eight
 * characters, and it is wrong: two sessions that collide would share one row and
 * each would deregister the other. Identifiers in this project have been
 * truncated before and it has cost a day each time.
 *
 * @returns {string|null} null when the payload carries no usable id
 */
export function sessionIdFor(payload) {
  const raw = typeof payload?.session_id === 'string' ? payload.session_id.trim() : '';
  if (!raw || !SAFE_ID.test(raw)) return null;
  return `${SESSION_PREFIX}${raw}`;
}

/**
 * WHO THIS SESSION REGISTERS AS.
 *
 * THE AGENT ID IS NOT GUESSED, AND THAT IS DELIBERATE. Deriving one from the
 * directory name or minting one per session would put fabricated identities on a
 * roster that work gets routed by. b/session-credentials makes the point in the
 * other direction -- "an agent id is a string anybody can type, and one shared
 * token types it" -- so inventing one here would be the same hole with nobody
 * even asking. Absent configuration this refuses AND SAYS HOW TO FIX IT.
 */
export function resolveIdentity(env = {}, payload = {}) {
  const sessionId = sessionIdFor(payload);
  if (!sessionId) {
    return { ok: false, code: 'no-session-id', reason: 'the hook payload carried no usable session_id' };
  }

  const agentId = String(env.AGENTBRIDGE_AGENT_ID ?? '').trim();
  if (!agentId) {
    return {
      ok: false,
      code: 'no-agent-id',
      sessionId,
      reason: 'AGENTBRIDGE_AGENT_ID is not set, and an agent id is never invented here',
    };
  }
  if (!SAFE_ID.test(agentId)) {
    return { ok: false, code: 'bad-agent-id', sessionId, reason: `AGENTBRIDGE_AGENT_ID ${JSON.stringify(agentId)} is not a usable id` };
  }

  const laneRaw = String(env.AGENTBRIDGE_LANE ?? '').trim();
  if (laneRaw && !SAFE_ID.test(laneRaw)) {
    return { ok: false, code: 'bad-lane', sessionId, reason: `AGENTBRIDGE_LANE ${JSON.stringify(laneRaw)} is not a usable lane id` };
  }

  const capacityRaw = String(env.AGENTBRIDGE_CAPACITY ?? '').trim();
  /*
   * idle, not busy. The supervisory report defines idle_workers as "live and
   * holding nothing", which is exactly a session that has just started.
   * Declaring busy at startup would hide the session from the dispatcher for the
   * whole of its life.
   */
  const capacity = capacityRaw || 'idle';
  if (!['idle', 'busy', 'blocked', 'offline'].includes(capacity)) {
    return { ok: false, code: 'bad-capacity', sessionId, reason: `AGENTBRIDGE_CAPACITY ${JSON.stringify(capacity)} is not a capacity` };
  }

  return { ok: true, agentId, sessionId, lane: laneRaw || null, capacity };
}

/**
 * The interval, bounded at BOTH ends.
 *
 * The upper bound is the one that matters and it is not in the CLI: the CLI
 * refuses under 5s and accepts anything above it, so `--interval 900` is
 * accepted and produces a worker that is offline more often than it is live --
 * a watcher that reports the failure it exists to prevent.
 */
export function resolveInterval(env = {}) {
  const raw = String(env.AGENTBRIDGE_WATCH_INTERVAL ?? '').trim();
  if (!raw) return { ok: true, seconds: DEFAULT_INTERVAL_SECONDS };
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, reason: `AGENTBRIDGE_WATCH_INTERVAL ${JSON.stringify(raw)} is not an integer` };
  }
  if (n < MIN_INTERVAL_SECONDS) {
    return { ok: false, reason: `interval ${n}s is below the ${MIN_INTERVAL_SECONDS}s floor the CLI enforces` };
  }
  if (n >= STALE_WINDOW_SECONDS) {
    return {
      ok: false,
      reason: `interval ${n}s is at or past the ${STALE_WINDOW_SECONDS}s stale window, so the session would age out between beats`,
    };
  }
  return { ok: true, seconds: n };
}

/** argv for the watcher child. `--watch` is the whole point and is not optional. */
export function watchArgv({ agentId, sessionId, lane, capacity, intervalSeconds }) {
  const argv = [
    'register-session',
    '--agent', agentId,
    '--session', sessionId,
    '--capacity', capacity,
    '--interval', String(intervalSeconds),
    '--watch',
  ];
  if (lane) argv.splice(5, 0, '--lane', lane);
  return argv;
}

/**
 * argv for the clean stop.
 *
 * unregister-session, NOT a kill on its own. Windows cannot deliver a SIGTERM
 * handler to another process: `process.kill(pid, 'SIGTERM')` terminates the
 * watcher without running the stop() that deregisters it. So the kill stops the
 * beating and THIS publishes the offline row -- bin/agentbridge.mjs:1172 reads
 * the row before removing it and publishes capacity offline to hosted, which is
 * the whole difference between an orderly shutdown and ten minutes of a dead
 * worker looking idle.
 */
export function stopArgv(sessionId) {
  return ['unregister-session', '--session', sessionId];
}

/** Where the pid and the watcher's own output live. `home` is passed in, never read. */
export function watcherPaths(home, sessionId) {
  if (!sessionId || !SAFE_ID.test(sessionId)) throw new Error('watcherPaths: unusable session id');
  const dir = path.join(home, 'watchers');
  return {
    dir,
    pidFile: path.join(dir, `${sessionId}.json`),
    logFile: path.join(dir, `${sessionId}.log`),
  };
}

/**
 * IDEMPOTENCE, BECAUSE SessionStart FIRES MORE THAN ONCE.
 *
 * The matcher values are startup, resume, clear, compact and fork, so a single
 * session reaching this repeatedly is normal rather than exceptional. Starting a
 * second watcher for one session id would put two processes on the same row,
 * and the loser would be killed at SessionEnd while the winner kept publishing
 * a session the operator believes has stopped.
 *
 * A STALE PIDFILE IS NOT A RUNNING WATCHER. The liveness of the pid is asked of
 * the caller rather than assumed from the file existing -- a file left behind by
 * a killed process is exactly the state this has to start through, and treating
 * the file as proof would mean the first crash disabled watching permanently.
 */
export function shouldStartWatcher({ record, isAlive }) {
  if (!record) return { start: true, reason: 'no watcher recorded for this session' };
  if (!Number.isInteger(record.pid) || record.pid <= 0) {
    return { start: true, reason: 'the recorded watcher has no usable pid' };
  }
  if (isAlive) {
    return { start: false, reason: `a watcher is already running for this session (pid ${record.pid})` };
  }
  return { start: true, reason: `the recorded watcher (pid ${record.pid}) is gone` };
}

/**
 * THE MESSAGE IS THE POINT.
 *
 * The bug being fixed is that a session with no watcher looked exactly like a
 * session with one. So the not-watching outcomes are phrased to be unmissable
 * and to name the reason; a hook that fails quietly here would reproduce the
 * original failure with more machinery in front of it.
 */
export function describeOutcome(o) {
  switch (o.kind) {
    case 'watching':
      return `agentbridge watch: ${o.agentId} / ${o.sessionId} refreshing every ${o.intervalSeconds}s (pid ${o.pid})`;
    case 'already':
      return `agentbridge watch: already running for ${o.sessionId} (pid ${o.pid})`;
    case 'stopped':
      return `agentbridge watch: stopped and deregistered ${o.sessionId}`;
    case 'nothing-to-stop':
      return `agentbridge watch: no watcher was running for ${o.sessionId}`;
    default:
      return `agentbridge watch: NOT WATCHING -- ${o.reason}. `
        + 'This session will age out of the roster in 10 minutes and other machines will read it as offline.';
  }
}
