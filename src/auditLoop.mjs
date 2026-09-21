/**
 * WHEN SHOULD THE AUDIT DAEMON TICK AGAIN, AND WHEN SHOULD IT STOP?
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * `scripts/audit-daemon.mjs` consumes exactly one job per invocation and
 * then exits. Nothing loops it. That is the last break in the audit loop:
 * the enqueue side is automatic (a commit hook records the demand), the
 * consume side works, and the two were never joined, so the queue reached
 * 115 jobs while a working consumer sat unused.
 *
 * The decision of WHEN to run is separated from the work of running so it
 * can be tested without spawning anything. A scheduler whose backoff has
 * never been watched is how you get a spin loop that bills an LLM every
 * second, which is a failure nobody notices until the invoice.
 *
 * ═══ THE THREE THINGS THIS BOUNDS, AND WHY EACH IS HERE ═══
 *
 * SPEND. Every launched tick is an LLM review. `maxTicks` is a hard stop,
 * not a suggestion, and it counts ATTEMPTED launches rather than
 * successful ones -- a run that fails after paying still cost money.
 * Spending is the owner's call (CLAUDE.md, Authority), so the default is
 * small and the caller must raise it deliberately.
 *
 * SPIN. A starved queue means every seat is busy; ticking again
 * immediately just re-reads the same rows. Backoff is exponential on
 * consecutive no-progress cycles, because the two real causes -- a live
 * claim holding the only seat, and a lease that has not lapsed -- both
 * resolve on a timescale of minutes, not milliseconds.
 *
 * SILENCE. `stop` always carries a reason. This repository has a whole
 * section on a supervisor whose healthy path and dead path produced
 * byte-identical evidence: an empty log and an old timestamp. A loop that
 * ends must say which of the four ways it ended.
 */

/** Why a loop stopped. Codes, so a caller can branch rather than parse. */
export const LOOP_STOP = Object.freeze({
  BUDGET: 'budget_exhausted',
  EMPTY: 'queue_empty',
  STARVED: 'starved_too_long',
  DEADLINE: 'deadline_reached',
});

export const LOOP_ACTION = Object.freeze({
  TICK: 'tick',
  WAIT: 'wait',
  STOP: 'stop',
});

/**
 * Defaults chosen to be BORING. A scheduler that surprises its operator
 * gets turned off, and then every layer under it is gone too.
 */
export const LOOP_DEFAULTS = Object.freeze({
  intervalMs: 60_000,
  maxIntervalMs: 15 * 60_000,
  maxTicks: 5,
  /*
   * STRICTLY BELOW maxTicks, OR STARVED CAN NEVER FIRE. Blind audit M-1.
   *
   * The caller increments `ticksUsed` and `consecutiveNoProgress` in
   * lockstep and neither moves on a WAIT, so it maintains
   * `noProgress <= ticksUsed` always. With both limits at 5, BUDGET was
   * reached on the same cycle that would have tripped STARVED and won,
   * every time. STARVED -- the entire reason this module exists, per its
   * own header -- was unreachable through the only caller, and a blocked
   * backlog was reported as budget exhaustion with advice to raise the
   * SPEND cap. Exactly the wrong instruction.
   */
  starvedLimit: 3,
});

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);

/**
 * Decide the next action. PURE: no clock, no fs, no spawn.
 *
 * @param state.ticksUsed          launches attempted so far this run
 * @param state.consecutiveNoProgress  cycles that placed nothing
 * @param state.queueDepth         claimable jobs the last read saw; 0 means empty
 * @param state.startedAt          ms epoch the loop began
 * @param state.now                ms epoch now
 * @param opts                     intervalMs, maxIntervalMs, maxTicks,
 *                                 starvedLimit, deadlineMs
 */
export function nextAction(state = {}, opts = {}) {
  /*
   * `= {}` COVERS AN OMITTED ARGUMENT, NOT AN EXPLICIT null, and a caller
   * reading a queue file that came back empty passes exactly that. The
   * first version threw `Cannot read properties of null` on the last line
   * of its own garbage-input test -- so the scheduler would have died on
   * the case it was written to survive.
   */
  const s = state ?? {};
  /*
   * ═══ opts GOES THROUGH `num` TOO, OR THE SPEND BOUND FAILS OPEN ═══
   *
   * Blind audit M-2. Every `state` field was validated and no `opts` field
   * was, and object spread means an EXPLICITLY PRESENT `maxTicks: undefined`
   * overrides the default rather than falling back to it. So
   * `{ maxTicks: undefined }`, `NaN` or `'abc'` all made `ticksUsed >=
   * o.maxTicks` false for ever, and the loop returned TICK unboundedly.
   *
   * This module is registered as a control on exactly one ground -- it
   * holds the only spending bound in the system -- and that bound was the
   * one value nothing checked. `posInt` in the daemon means there is no
   * live exploit today; this is a latent fail-open, fixed rather than
   * argued away, because the next caller will not be `posInt`.
   */
  const raw = opts ?? {};
  const o = {
    ...LOOP_DEFAULTS,
    ...raw,
    maxTicks: num(raw.maxTicks, LOOP_DEFAULTS.maxTicks),
    starvedLimit: num(raw.starvedLimit, LOOP_DEFAULTS.starvedLimit),
    intervalMs: num(raw.intervalMs, LOOP_DEFAULTS.intervalMs),
    maxIntervalMs: num(raw.maxIntervalMs, LOOP_DEFAULTS.maxIntervalMs),
  };
  const ticksUsed = num(s.ticksUsed, 0);
  const noProgress = num(s.consecutiveNoProgress, 0);
  const depth = num(s.queueDepth, 0);

  /*
   * THE DEADLINE IS CHECKED FIRST, and against the clock rather than a
   * count, because the whole point of a deadline is that it holds however
   * the loop has been spending its cycles.
   */
  if (typeof o.deadlineMs === 'number' && Number.isFinite(o.deadlineMs)) {
    const started = num(s.startedAt, NaN);
    const now = num(s.now, NaN);
    if (Number.isFinite(started) && Number.isFinite(now) && now - started >= o.deadlineMs) {
      return {
        action: LOOP_ACTION.STOP,
        code: LOOP_STOP.DEADLINE,
        why: `ran for ${Math.round((now - started) / 1000)}s, past the ${Math.round(o.deadlineMs / 1000)}s deadline`,
      };
    }
  }

  /*
   * BUDGET BEFORE EMPTINESS. A caller that set maxTicks to 0 means "do not
   * launch anything", and must not be talked out of it by a queue that
   * happens to be empty -- the two answers differ in what they say, and
   * the honest one is the one the operator asked for.
   */
  /*
   * STARVED IS TESTED BEFORE BUDGET, because when both are true the
   * starved message is the one the operator needs. "You have spent your
   * budget, raise it" is actively misleading advice when nothing was
   * spent and every seat is blocked -- raising it just buys more empty
   * cycles. Blind audit M-1, second half: the ordering mattered as much
   * as the limits did.
   */
  if (noProgress >= o.starvedLimit && depth > 0) {
    return {
      action: LOOP_ACTION.STOP,
      code: LOOP_STOP.STARVED,
      why: `${noProgress} consecutive cycles placed nothing while ${depth} job(s) were `
        + 'claimable. THE QUEUE IS NOT EMPTY: every seat is holding a live claim, or '
        + 'every candidate is this daemon\'s own work. Register another seat, or wait '
        + 'for the leases to lapse',
    };
  }

  if (ticksUsed >= o.maxTicks) {
    return {
      action: LOOP_ACTION.STOP,
      code: LOOP_STOP.BUDGET,
      why: `${ticksUsed} of ${o.maxTicks} ticks used. Each one is a paid review, so this `
        + 'is a hard stop rather than a pause. Raise --max-ticks deliberately',
    };
  }

  if (depth === 0) {
    return {
      action: LOOP_ACTION.STOP,
      code: LOOP_STOP.EMPTY,
      why: 'no claimable jobs. This is the good ending: the queue is drained',
    };
  }

  /*
   * ═══ A BACKOFF THAT HAS BEEN SERVED MUST NOT BE SERVED AGAIN ═══
   *
   * MEASURED: the first version returned WAIT whenever `noProgress > 0`,
   * and `noProgress` only changes after a TICK. So the loop waited, came
   * back, saw the same count, and waited again -- for ever, at a fixed
   * interval, never retrying. It ran 300s without a second tick and
   * without stopping, printing "backing off" each time.
   *
   * That is worse than a spin: a spin is visible and expensive, while this
   * looked exactly like a healthy supervisor and did nothing. The starved
   * stop condition below was unreachable for the same reason, so the loop
   * could never report the backlog it was sitting on either.
   *
   * `backoffServed` is the caller saying "I have slept". It resets with
   * every tick, so the backoff still grows across genuine no-progress
   * cycles rather than being skipped.
   */
  if (noProgress > 0 && !s.backoffServed) {
    /*
     * EXPONENTIAL, CAPPED. Both causes of no-progress resolve in minutes,
     * so doubling reaches a useful wait quickly and the cap stops it
     * drifting into "effectively stopped, still calling itself running".
     */
    const waitMs = Math.min(o.intervalMs * (2 ** noProgress), o.maxIntervalMs);
    return {
      action: LOOP_ACTION.WAIT,
      waitMs,
      why: `nothing placed on the last ${noProgress} cycle(s); backing off to ${Math.round(waitMs / 1000)}s`,
    };
  }

  return {
    action: LOOP_ACTION.TICK,
    why: `${depth} claimable job(s), ${o.maxTicks - ticksUsed} tick(s) of budget left`,
  };
}
