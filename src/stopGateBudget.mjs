/**
 * HOW LONG THE STOP GATE MAY TAKE, SO IT IS NEVER KILLED MID-VERDICT.
 *
 * THE DEFECT THIS EXISTS TO CLOSE. The Stop hook has a timeout in
 * .claude/settings.json (190s) and the gate gives its own suite run a separate
 * hard-coded timeout (180s). The gate handles ITS timeout correctly -- spawnSync
 * sets run.error, and the gate blocks. The dangerous case is the other order: if
 * the HOOK timeout fires first, the gate process is killed before it writes
 * anything, stdout is empty, and an empty result from a hook is treated as
 * NON-BLOCKING. The gate does not merely fail; it fails OPEN.
 *
 * AND IT FAILS OPEN EXACTLY WHEN IT MATTERS. The 10s margin has to cover node
 * startup, reading stdin, hashing every protected file, hashing every baseline
 * test, walking test/ for discovery, and afterwards parsing up to 32MB of TAP
 * and writing the decision. On a healthy machine that is nothing. Under memory
 * pressure this repository's suite was measured at ~300s against ~60s healthy,
 * and all the pre-run hashing slows down with it -- so the window in which the
 * gate goes silent is the window in which the machine is already degraded.
 *
 * SO THE BUDGET IS COMPUTED, NOT CONSTANT. The gate measures what it has already
 * spent and gives the suite only what is left after reserving time to finish.
 * The invariant every caller depends on, and the one the tests assert directly:
 *
 *     elapsed + timeoutMs + reserve <= hookBudget
 *
 * A WATCHDOG TIMER WOULD NOT WORK HERE, which is why this is arithmetic instead.
 * The gate runs its suite with spawnSync, which blocks the event loop for the
 * whole run, so a setTimeout scheduled beforehand cannot fire until after the
 * thing it was meant to interrupt has already finished. The only way to
 * guarantee spawnSync returns in time is to hand it a timeout that already fits.
 *
 * EVERY REFUSAL IS A BLOCK, NEVER A PASS. "There was not enough time to verify"
 * is not "nothing changed" -- the same reasoning the gate already applies to an
 * absent snapshot. Nothing in this file can return a verdict that lets a session
 * end unverified.
 *
 * PURE. No clock, no filesystem, no spawn -- the caller reads the clock and
 * passes the number in, so every branch here is reachable from a test.
 */

/**
 * Conservative fallback, used only when the real hook timeout cannot be read.
 *
 * LOWER THAN THE 190s CONFIGURED TODAY, on purpose. If this constant is ever
 * wrong it must be wrong in the direction that blocks early rather than the
 * direction that gets the process killed, because only one of those two failure
 * modes is silent.
 */
export const FALLBACK_HOOK_BUDGET_MS = 150_000;

/** Time reserved AFTER the suite for TAP parsing and writing the decision. */
export const DEFAULT_RESERVE_MS = 20_000;

/** Below this, a suite run is not worth starting -- say so instead of pretending. */
export const DEFAULT_FLOOR_MS = 30_000;

const isPositiveFinite = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * The Stop hook's configured timeout, in milliseconds, read from parsed settings.
 *
 * TAKES ALREADY-PARSED JSON so this stays pure and so a malformed settings file
 * is the caller's error to report rather than an exception from in here.
 *
 * Returns null when it cannot be determined, and null means "use the fallback",
 * never "there is no limit". Claude Code expresses hook timeouts in SECONDS;
 * getting that unit wrong by a factor of 1000 would hand spawnSync a 190ms
 * budget and fail every run, or a 190000s budget and restore the original bug,
 * so the conversion happens exactly once, here.
 */
export function stopHookBudgetMs(settings) {
  const entries = settings?.hooks?.Stop;
  if (!Array.isArray(entries)) return null;

  const timeouts = [];
  for (const entry of entries) {
    for (const hook of entry?.hooks ?? []) {
      if (isPositiveFinite(hook?.timeout)) timeouts.push(hook.timeout * 1000);
    }
  }
  if (timeouts.length === 0) return null;

  /*
   * THE SMALLEST WINS. Several Stop hooks may be configured and the gate is
   * killed by whichever limit expires first, so the budget is the minimum rather
   * than this hook's own number -- taking the maximum would be the optimistic
   * reading, and an optimistic budget is how the process gets killed mid-verdict.
   */
  return Math.min(...timeouts);
}

/**
 * How long the suite may run, or the reason it may not run at all.
 *
 * Returns { ok: true, timeoutMs } or { ok: false, reason }. There is deliberately
 * no third answer: a caller cannot receive something it might read as permission.
 */
export function suiteBudget({
  hookBudgetMs = FALLBACK_HOOK_BUDGET_MS,
  elapsedMs = 0,
  reserveMs = DEFAULT_RESERVE_MS,
  floorMs = DEFAULT_FLOOR_MS,
} = {}) {
  /*
   * HOSTILE INPUT IS REFUSED RATHER THAN ARITHMETIC-ED.
   *
   * NaN is the one that matters and it is not hypothetical: Number(undefined) is
   * NaN, every comparison against NaN is false, and spawnSync treats a NaN
   * timeout as NO TIMEOUT AT ALL. A single unvalidated env read would therefore
   * restore the exact unbounded run this module exists to prevent -- and it
   * would do it silently, on the machine where the value happened to be unset.
   */
  for (const [name, value] of [
    ['hookBudgetMs', hookBudgetMs],
    ['reserveMs', reserveMs],
    ['floorMs', floorMs],
  ]) {
    if (!isPositiveFinite(value)) {
      return { ok: false, reason: `${name} is not a positive finite number (got ${JSON.stringify(value)})` };
    }
  }
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return { ok: false, reason: `elapsedMs is not a non-negative finite number (got ${JSON.stringify(elapsedMs)})` };
  }

  const remainingMs = hookBudgetMs - elapsedMs - reserveMs;
  if (remainingMs < floorMs) {
    return {
      ok: false,
      reason:
        `only ${Math.max(0, Math.trunc(remainingMs))}ms of the ${Math.trunc(hookBudgetMs)}ms hook budget remain after ` +
        `${Math.trunc(elapsedMs)}ms of setup and ${Math.trunc(reserveMs)}ms reserved to report, ` +
        `which is under the ${Math.trunc(floorMs)}ms floor`,
    };
  }

  /*
   * TRUNCATED, NOT ROUNDED. Rounding up could exceed the budget by a millisecond,
   * and the whole point of this function is that the returned value plus what has
   * been spent plus the reserve never exceeds what the hook allows.
   */
  return { ok: true, timeoutMs: Math.trunc(remainingMs) };
}
