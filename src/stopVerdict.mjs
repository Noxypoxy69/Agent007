/**
 * STOP-GATE VERDICT REUSE AND THE ONE-SUITE LOCK: the decisions, pure.
 *
 * WHY THIS EXISTS (FINDINGS F-31). Every seat's turn end ran the FULL suite on
 * the SAME unchanged shared checkout, often three or four at once; under that
 * load a run that takes ~78 s quiet took over 30 minutes and ended in
 * stop-deadline or an unnamed test-run-failed. scripts/claude-stop-gate.mjs
 * now (1) reuses a PASS recorded for byte-identical inputs, and (2) lets only
 * one suite run on the machine at a time, with the others waiting for it.
 *
 * OWNER RULING (a), T-147, 2026-09-24. A reused PASS certifies "these exact
 * inputs passed at <time> on this machine" -- NOT that the suite passes now.
 * The key cannot cover everything a suite verdict depends on, and the residual
 * is printed in every reused-pass message (REUSE_RESIDUAL below). Owner intent,
 * recorded: option (b), a hermetic suite, comes next, and would let the key be
 * honest without the residual.
 *
 * NOT A SECURITY BOUNDARY. The store and the lock live in the same user's
 * state directory; anyone who can run this gate can edit them. Stop is
 * honest-error detection (Constitutional Rule 1), and so is this.
 *
 * PURE: no filesystem, no spawn, no clock. The gate reads, hashes and times;
 * everything decided here can be imported and watched failing (CLAUDE.md
 * rule 10).
 */

import { createHash } from 'node:crypto';

export const VERDICT_STORE_LABEL = 'same-user; honest-error detection only';

/** A reused PASS must be younger than this (owner ruling (a)). */
export const MAX_REUSE_AGE_MS = 10 * 60 * 1000;

/**
 * Environment variables EXCLUDED from the key: identifiers that differ per
 * Claude Code session or terminal and would stop two seats on the same bytes
 * from ever sharing a verdict. Each was checked: NO file under src/, bin/,
 * bridge/, mcp/, scripts/ or test/ reads any of them (ripgrep, plus a byte
 * search of the two NUL-framed files grep skips). Everything else the gate
 * passes to the suite -- PATH, HOME, TEMP, NODE_*, GIT_*, AGENTBRIDGE_*, ... --
 * is in the key. Compared case-insensitively, as Windows resolves them.
 */
export const EXCLUDED_ENV = Object.freeze([
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED', 'WT_SESSION', 'WT_PROFILE_ID',
]);

/** Every part the key is computed over. A missing part means no key, so no reuse. */
export const KEY_PARTS = Object.freeze([
  'repoRoot', 'head', 'tracked', 'untracked', 'ignored', 'gateScriptSha256', 'suiteFiles',
  'nodeVersion', 'platform', 'arch', 'env', 'secrets',
]);

const EXCLUDED = new Set(EXCLUDED_ENV.map((k) => k.toUpperCase()));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The environment that goes into the key: every [name, value] except EXCLUDED_ENV, sorted. */
export function envForKey(env) {
  return Object.entries(env ?? {})
    .filter(([k]) => !EXCLUDED.has(String(k).toUpperCase()))
    .map(([k, v]) => [String(k), String(v)])
    .sort((a, b) => cmp(a[0].toUpperCase(), b[0].toUpperCase()) || cmp(a[0], b[0]));
}

/**
 * sha256 over every KEY_PART, in a fixed order, with every list sorted -- so
 * the same inputs give the same key whatever order the gate observed them in.
 * THROWS when a part is missing: a key that silently omits an input would
 * reuse a verdict across a change to it.
 */
export function verdictKey(parts) {
  const missing = KEY_PARTS.filter((p) => parts?.[p] === undefined);
  if (missing.length) throw new Error(`verdict key: missing part(s) ${missing.join(', ')}`);
  const sortRows = (rows) => [...rows].map((r) => (Array.isArray(r) ? r.map(String) : String(r)))
    .sort((a, b) => cmp(JSON.stringify(a), JSON.stringify(b)));
  const canonical = KEY_PARTS.map((p) => {
    const v = parts[p];
    return [p, Array.isArray(v) ? sortRows(v) : v];
  });
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

const OUTCOMES = new Set(['pass', 'fail', 'deadline']);
const isIso = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s) && !Number.isNaN(Date.parse(s));

/** One store line. The label is on every record, so a stray copy still says what it is. */
export function formatVerdictRecord({ key, outcome, at, durationMs, counts }) {
  return `${JSON.stringify({ v: 1, label: VERDICT_STORE_LABEL, key, outcome, at, durationMs, counts })}\n`;
}

/**
 * Parse the append-only store. ANY malformed line makes the whole store
 * unusable ({ok:false}), because a store that cannot be read entirely cannot
 * be trusted partially -- and an unusable store means a full run, never a pass.
 * Empty text is a valid, empty store.
 */
export function parseVerdictStore(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'store was not text' };
  const records = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === '' && i === lines.length - 1) continue;
    let r;
    try { r = JSON.parse(line); } catch { return { ok: false, reason: `line ${i + 1} is not JSON` }; }
    if (!r || r.v !== 1 || r.label !== VERDICT_STORE_LABEL || typeof r.key !== 'string' || !/^[0-9a-f]{64}$/.test(r.key)
      || !OUTCOMES.has(r.outcome) || !isIso(r.at)) {
      return { ok: false, reason: `line ${i + 1} is not a verdict record` };
    }
    records.push(r);
  }
  return { ok: true, records };
}

/**
 * Rule 1: reuse ONLY a PASS whose key equals the current key EXACTLY and that
 * is younger than maxAgeMs (and not dated in the future). A fail or a deadline
 * is never reused. The newest qualifying record wins.
 */
export function chooseReuse({ records, key, nowMs, maxAgeMs = MAX_REUSE_AGE_MS }) {
  if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) return { reuse: null, reason: 'no key' };
  if (!Array.isArray(records)) return { reuse: null, reason: 'no records' };
  let best = null;
  for (const r of records) {
    if (r?.outcome !== 'pass' || r.key !== key) continue;
    const age = nowMs - Date.parse(r.at);
    if (!(age >= 0 && age < maxAgeMs)) continue;
    if (!best || Date.parse(r.at) > Date.parse(best.at)) best = r;
  }
  return best ? { reuse: best, reason: null } : { reuse: null, reason: 'no fresh pass for this key' };
}

/** What a reused pass does and does NOT certify. Printed verbatim in every reused-pass message. */
export const REUSE_RESIDUAL = 'It does NOT cover network or production-server state, the live process table, the clock, or machine load, nor hand edits inside node_modules that npm\'s lockfile (node_modules/.package-lock.json) does not record.';

/*
 * THE ABA RESIDUAL (owner ruling, T-154 measured it in every file dimension). The
 * key is observed before the suite and before the record, so a change made and
 * REVERTED while the suite runs leaves both keys equal while the suite read the
 * other state. That is a measured limitation, stated on every reuse, not closed.
 */
const ABA_RESIDUAL = 'Identity matched at the pre-run and pre-save boundaries; changes made and reverted during the run are not excluded.';

export function reusedPassMessage(record, nowMs) {
  const ageS = Math.round((nowMs - Date.parse(record.at)) / 1000);
  return `[agentbridge:stop-verdict-reused] The suite was NOT run for this turn. A PASS recorded ${ageS}s ago is reused because every keyed input is byte-identical (key ${record.key.slice(0, 16)}). `
    + `This reused pass certifies "these exact inputs passed at ${record.at} on this machine". ${REUSE_RESIDUAL} `
    + `${ABA_RESIDUAL} `
    + `Store: ${VERDICT_STORE_LABEL}.`;
}

/*
 * ═══ T-153: THE KEY IS OBSERVED MORE THAN ONCE ═══
 *
 * T-148 S16, measured: T-147 observed the key ONCE, before the lock wait, ran
 * the suite on the tree as it stood AFTER the wait, and recorded the outcome
 * under the old key. A waiter that started on a failing tree X, while the tree
 * became a passing Y, recorded Y's PASS as X's -- and the next gate on X reused
 * a PASS that X never earned. So the key is re-observed immediately before the
 * suite and immediately before recording, and a record is written only when all
 * three agree. Every reuse is keyed on the state as it is AT THAT MOMENT.
 */

/** A record is written only when the key was the same before the wait, before the suite and before recording. */
export function shouldRecord({ keyBeforeWait, keyBeforeSuite, keyBeforeRecord }) {
  const ok = (k) => typeof k === 'string' && /^[0-9a-f]{64}$/.test(k);
  return ok(keyBeforeWait) && keyBeforeWait === keyBeforeSuite && keyBeforeSuite === keyBeforeRecord;
}

/**
 * Reuse, run, or refuse -- the gate's whole wait, with every effect INJECTED so
 * each decision point can be driven and watched failing on its own (rule 10).
 *
 *   effects.currentKey()     the key over the inputs as they are NOW, or null
 *   effects.freshPass(key)   a reusable PASS record for exactly that key, or null
 *   effects.tryLock()        'taken' | 'held' | 'unusable' (unusable: run unlocked, as before T-147)
 *   effects.readLock()       the holder's lock, or 'vanished'
 *   effects.lockIsStale(l)   true when the holder is dead or past its own budget
 *   effects.breakLock()      move a stale lock aside
 *   effects.now(), effects.sleep(ms)
 *
 * Returns one of
 *   { action: 'reuse', record, at: 'start' | 'poll' | 'lock' }
 *   { action: 'run', keyBeforeWait, keyBeforeSuite, locked }
 *   { action: 'deadline', where: 'lock-attempt' | 'lock-held', holder }
 */
export async function acquireOrReuse({ effects, deadlineAt, minSuiteMs, pollMs }) {
  const keyBeforeWait = effects.currentKey();
  const startPass = keyBeforeWait ? effects.freshPass(keyBeforeWait) : null;
  if (startPass) return { action: 'reuse', record: startPass, at: 'start' };

  let locked = false;
  let key = keyBeforeWait;
  for (let attempt = 0; ; attempt += 1) {
    // Checked on EVERY iteration, so no path through this loop can outlive the budget.
    if (attempt > 0 && effects.now() > deadlineAt - minSuiteMs) return { action: 'deadline', where: 'lock-attempt', holder: null };
    const t = effects.tryLock();
    if (t === 'taken') { locked = true; break; }
    if (t === 'unusable') break;
    const held = effects.readLock();
    if (held === 'vanished') continue;
    if (effects.lockIsStale(held)) { effects.breakLock(); continue; }
    if (effects.now() + pollMs > deadlineAt - minSuiteMs) return { action: 'deadline', where: 'lock-held', holder: held };
    await effects.sleep(pollMs);
    /*
     * THE POLL RE-CHECK (T-148 G03). The run this gate is waiting on may have
     * recorded a PASS. It is taken only if the inputs are STILL the ones that PASS
     * was recorded for: the key is re-observed before approving, and a changed
     * tree moves this gate onto its new key instead.
     */
    if (key && effects.freshPass(key)) {
      const now = effects.currentKey();
      if (now && now === key) return { action: 'reuse', record: effects.freshPass(key), at: 'poll' };
      key = now;
    }
  }
  /*
   * THE RE-CHECK AT THE LOCK (T-148 G04), on the key as it is NOW: a run may have
   * finished between the last poll and taking the lock, and the tree may have
   * moved while this gate waited.
   */
  const keyBeforeSuite = effects.currentKey();
  const lockPass = keyBeforeSuite ? effects.freshPass(keyBeforeSuite) : null;
  if (lockPass) return { action: 'reuse', record: lockPass, at: 'lock', locked };
  return { action: 'run', keyBeforeWait, keyBeforeSuite, locked };
}

/**
 * Rule 2: may this gate take the one-suite lock?
 *   'free'  -- no lock file
 *   'held'  -- a live holder within its own budget
 *   'stale' -- the holder is dead, or the lock is older than the holder's budget
 * An unreadable lock (mid-write, or garbage) is 'held' until its file is older
 * than the fallback budget, then 'stale' -- never free on sight.
 */
export function lockState({ lock, nowMs, pidAlive, fallbackBudgetMs }) {
  if (lock === null || lock === undefined) return 'free';
  if (lock.unreadable) {
    return nowMs - lock.mtimeMs > fallbackBudgetMs ? 'stale' : 'held';
  }
  const started = Date.parse(lock.startedAt);
  if (Number.isNaN(started) || !Number.isInteger(lock.pid)) {
    return nowMs - (lock.mtimeMs ?? nowMs) > fallbackBudgetMs ? 'stale' : 'held';
  }
  if (pidAlive === false) return 'stale';
  const budget = Number.isFinite(lock.budgetMs) && lock.budgetMs > 0 ? lock.budgetMs : fallbackBudgetMs;
  return nowMs - started > budget ? 'stale' : 'held';
}
