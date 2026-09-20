/**
 * THE HOLD BAR: stop a builder BEFORE it degrades, not when it hits a wall.
 *
 * ═══ WHAT ALREADY STOPS A BUILDER, AND WHY NONE OF IT IS THIS ═══
 *
 * Lease expiry, run timeout, guard refusal, loop detection, attempt failure,
 * token budget. Every one of them fires AT a wall, and the work in flight at
 * that moment is whatever it happened to be: half an edit, an uncommitted
 * tree, a thought nobody wrote down. They are failure stops.
 *
 * Nothing says "this builder has done enough steps, consumed enough context
 * and touched enough state -- stop HERE, checkpoint, hand to a fresh one".
 * That is a different control with a different verdict, and its whole value is
 * that it fires EARLY, while the work is still in a shape somebody can pick up.
 *
 * So the thresholds here are deliberately BELOW the runtime's limits. A hold
 * bar set at the same place as the timeout is just the timeout with extra
 * ceremony; set below it, the difference is a clean handoff instead of a
 * salvage.
 *
 * ═══ THREE ANSWERS, AND THE MIDDLE ONE IS THE POINT ═══
 *
 *   continue              nothing is near a limit.
 *   checkpoint_and_rotate degraded or approaching it, AND the work can be
 *                         handed over. The successor inherits the task, the
 *                         findings and the obligations; it does not start
 *                         clean.
 *   fail                  the attempt is over. Either something unrecoverable
 *                         happened, or the work cannot be checkpointed, or the
 *                         rotation budget is spent.
 *
 * ═══ THE THREE REFUSALS THAT KEEP IT HONEST ═══
 *
 * ROTATION CANNOT LOSE WORK. If a limit is crossed and the tree is dirty with
 * nothing committed, rotating discards it. The verdict is `fail` with the
 * reason, not a rotation that quietly drops an hour of edits -- and this
 * repository has a header about never destroying evidence.
 *
 * ROTATION CANNOT BE AN ESCAPE FROM FAILING. A builder that has just produced
 * three identical errors is not degraded, it is stuck, and rotating hands a
 * fresh builder the same wall. Unrecoverable signals outrank every soft limit,
 * so `fail` is checked first.
 *
 * ROTATION IS BOUNDED. Unbounded rotation is a task that never completes and
 * never fails, which is worse than either: it consumes budget forever and
 * nothing ever reports a problem. Past the budget the verdict is `fail`.
 *
 * ═══ MEASURED BY THE RUNTIME, NOT SELF-REPORTED ═══
 *
 * Every field in `observed` is something the runtime counts: steps taken,
 * tokens consumed, distinct paths touched, elapsed time, consecutive identical
 * errors. A builder asked "are you degrading?" is the self-assessment this
 * whole layer exists to remove -- and a degrading builder is precisely the one
 * whose judgement about its own state is worth least.
 *
 * PURE. No clock, no filesystem, no process table. Rule 10, and the only
 * reason the interesting cases are testable: no test can degrade a real
 * builder, but any test can hand this a step count and a dirty tree.
 */

export const HOLD = Object.freeze({
  CONTINUE: 'continue',
  ROTATE: 'checkpoint_and_rotate',
  FAIL: 'fail',
});

/**
 * Where the bar sits, and WHY each number is where it is.
 *
 * THESE ARE JUDGEMENTS, NOT MEASUREMENTS, AND SAYING SO IS THE POINT. There is
 * no degradation data for this system yet -- nothing has ever recorded how a
 * builder's output quality tracks its step count. A constant presented as
 * derived would be a false claim; a constant presented as a starting position
 * somebody can argue with is honest and adjustable.
 *
 * What IS reasoned: each sits below the corresponding runtime wall, because a
 * hold bar level with the wall is the wall.
 */
export const LIMITS = Object.freeze({
  /* Tool calls. Long past the point where a fresh reader is cheaper than a
   * tired one, and well inside any run timeout. */
  steps: 120,
  /* Fraction of the context window. Not a token count, because the window
   * differs per model and a literal would be a fact about one of them. */
  contextFraction: 0.75,
  /* Distinct paths written. Breadth, not volume: a builder touching thirty
   * files is doing something a task contract probably did not describe. */
  filesTouched: 30,
  /* Wall clock inside one attempt. */
  elapsedMs: 90 * 60_000,
  /* How many times one task may rotate before it is simply failing. */
  rotations: 3,
  /* Consecutive identical errors that mean stuck rather than tired. */
  repeatedErrors: 3,
});

/**
 * The signals that mean "tired", as opposed to "stuck" or "spent".
 *
 * EXPORTED SO THE TESTS GENERATE THEIR FIXTURES FROM IT. Rule 7: a hostile
 * property checked against a hand-typed list of cases stops covering the list
 * the moment somebody adds an entry. Driving the cases from this array means a
 * new signal arrives already covered, without anybody remembering to.
 */
export const SOFT_SIGNALS = Object.freeze(['steps', 'contextFraction', 'filesTouched', 'elapsedMs']);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Should this builder keep going?
 *
 * @param {object} observed   measured by the runtime, never reported by the builder
 *   steps, contextFraction, filesTouched, elapsedMs, rotations, repeatedErrors
 *   checkpointable  can the work be handed over as it stands -- committed, or
 *                   committable. The runtime knows; this must not guess.
 *   unrecoverable   a reason string when something has already failed for good
 * @param {object} opts  { limits }
 * @returns {{verdict:string, why:string, crossed:string[], measured:boolean}}
 */
export function holdVerdict(observed = {}, { limits = LIMITS } = {}) {
  const o = observed && typeof observed === 'object' ? observed : {};
  const L = { ...LIMITS, ...(limits && typeof limits === 'object' ? limits : {}) };

  /*
   * "NOTHING WAS MEASURED" MUST NOT READ AS "MEASURED AND HEALTHY".
   *
   * Every signal here is optional, so a caller that wires this up and forwards
   * no observations gets `continue` forever and the bar never fires once --
   * rule 17, a control that is never consulted, wearing a green verdict. The
   * verdict stays `continue` because a hold bar is a quality control and
   * refusing all work because telemetry is missing would be the rule 19 outage
   * that gets the whole thing switched off. But `measured` makes the two states
   * distinguishable, so a test can prove the difference and an operator can see
   * a builder nobody is watching.
   */
  const measured = SOFT_SIGNALS.some((k) => num(o[k]) !== null);

  /*
   * UNRECOVERABLE FIRST. A stuck builder is not a tired one, and rotating
   * hands its successor the same wall with a fresh budget to hit it with.
   */
  const unrecoverable = typeof o.unrecoverable === 'string' && o.unrecoverable.trim() !== ''
    ? o.unrecoverable.trim()
    : null;
  if (unrecoverable) {
    return { verdict: HOLD.FAIL, why: `unrecoverable: ${unrecoverable}`, crossed: ['unrecoverable'], measured };
  }

  const repeated = num(o.repeatedErrors) ?? 0;
  if (repeated >= L.repeatedErrors) {
    return {
      verdict: HOLD.FAIL,
      why: `${repeated} consecutive identical errors: this builder is stuck, not degraded, and a fresh `
        + 'one would meet the same wall',
      crossed: ['repeatedErrors'],
      measured,
    };
  }

  /*
   * WHICH SOFT LIMITS ARE CROSSED. Collected rather than short-circuited: a
   * reader deciding whether the bar is set right needs to know it was three
   * signals and not one.
   */
  const crossed = [];
  const check = (key, value, limit) => {
    const v = num(value);
    if (v !== null && limit != null && v >= limit) crossed.push(key);
  };
  for (const key of SOFT_SIGNALS) check(key, o[key], L[key]);

  if (crossed.length === 0) {
    return {
      verdict: HOLD.CONTINUE,
      why: measured ? 'nothing is at a limit' : 'no degradation signals were measured, so the bar cannot fire',
      crossed: [],
      measured,
    };
  }

  /*
   * THE ROTATION BUDGET IS SPENT. Unbounded rotation is a task that never
   * completes and never fails: budget disappears and nothing reports a
   * problem. At the boundary this stops being degradation and starts being a
   * task nobody can finish, which is a fact the owner needs.
   */
  const rotations = num(o.rotations) ?? 0;
  if (rotations >= L.rotations) {
    return {
      verdict: HOLD.FAIL,
      why: `already rotated ${rotations} time(s), the budget, and ${crossed.join(', ')} `
        + 'crossed again. A task that keeps rotating is not degrading, it is unfinishable as scoped',
      crossed,
      measured,
    };
  }

  /*
   * ROTATION MUST NOT LOSE WORK. If the limit is crossed and nothing can be
   * handed over, rotating discards whatever is in the tree. Fail loudly with
   * the reason instead -- never destroy evidence.
   */
  if (o.checkpointable !== true) {
    return {
      verdict: HOLD.FAIL,
      why: `${crossed.join(', ')} crossed and the work cannot be checkpointed, so rotating would `
        + 'discard it. Commit or return the work first; a rotation that loses an hour of edits is '
        + 'worse than a failure that says so',
      crossed,
      measured,
    };
  }

  return {
    verdict: HOLD.ROTATE,
    why: `${crossed.join(', ')} at or past the bar. Checkpoint and hand to a fresh builder while the `
      + 'work is still in a shape somebody can pick up',
    crossed,
    measured,
  };
}

/**
 * What a successor must be given.
 *
 * A ROTATION IS A HANDOVER, NOT A RESTART. The successor inherits the task,
 * the attempt lineage and every obligation already discovered; a fresh builder
 * that starts clean would re-derive findings somebody already paid for, and
 * worse, would not know which regressions it now owes.
 *
 * THE ATTEMPT NUMBER ADVANCES, because the terminal-write fences bind to
 * task + attempt + lease. A successor writing under its predecessor's attempt
 * is the stale-write this repository has already shipped once -- a coordinator
 * that judged attempt 7 and accepted attempt 8.
 */
export function rotationHandover({ task_id = null, attempt = null, findings = [], required_regressions = [], checkpoint_sha = null } = {}) {
  const errors = [];
  const next = Number.isInteger(attempt) ? attempt + 1 : null;
  if (!task_id) errors.push('task_id is required: a rotation that forgets its task hands work to nobody');
  if (next === null) errors.push('attempt is required and must be an integer: the successor writes under attempt+1, and a terminal write bound to the wrong attempt is the stale-write fence firing');
  if (!checkpoint_sha) errors.push('checkpoint_sha is required: a handover with nothing committed is a restart wearing the name of a rotation');
  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    handover: {
      task_id,
      attempt: next,
      predecessor_attempt: attempt,
      checkpoint_sha,
      /* Carried, never cleared. The successor owes what the predecessor owed. */
      findings: Array.isArray(findings) ? [...findings] : [],
      required_regressions: Array.isArray(required_regressions) ? [...required_regressions] : [],
    },
  };
}
