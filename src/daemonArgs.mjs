/**
 * THE AUDIT DAEMON'S ARGUMENT PARSING, WHERE THE SUITE CAN REACH IT.
 *
 * ═══ WHY THIS IS A MODULE ═══
 *
 * `scripts/audit-daemon.mjs` HAS NO TEST FILE AT ALL, and cannot have one:
 * importing it consumes a job from the live queue. A blind auditor called
 * that "the largest uncovered surface in the range" and it was right --
 * FOUR findings across two audits have lived in its argument handling:
 *
 *   M-6  a TRAILING `--max-ticks` silently became the default 5, which is
 *        an operator asking for one spend and getting another.
 *   M-3  the fix for M-6 went inside the numeric parser, so `--by` -- the
 *        identity the daemon claims work AS -- kept the old behaviour. A
 *        trailing `--by` substitutes a synthetic id that matches no commit
 *        trailer, so `claimJob`'s author-cannot-audit check cannot fire.
 *        Fail-open on rule 20's core property, from a typing order.
 *   L3   `Number(stored ?? 0) + 1` produced NaN for a malformed counter,
 *        `JSON.stringify` wrote NaN as null, and the next read turned it
 *        back into 0 -- so one corrupt value reset the bound permanently.
 *
 * Every one of those was found by reading, because nothing could run them.
 * Rule 10: put the decision in `src/` as a pure function and let the script
 * call it.
 *
 * ═══ THESE RETURN, THEY DO NOT EXIT ═══
 *
 * A parser that calls `process.exit` cannot be tested at all, which is half
 * of how this stayed uncovered. Each function returns a result the caller
 * turns into an exit code, so the DECISION is testable and only the
 * plumbing is not.
 */

/** The parse failed. Carries a reason an operator can act on. */
export const ARG_ERROR = 'arg_error';

/**
 * The value following `name` in argv.
 *
 * A flag PRESENT WITH NO VALUE is an error, not the default — for every
 * flag, not only the numeric ones. That distinction is M-3: guarding
 * inside the numeric parser left `--by` behind.
 *
 * @returns {{ok:true, value:string|null} | {ok:false, code:string, why:string}}
 */
export function flagValue(argv, name, dflt = null) {
  const list = Array.isArray(argv) ? argv : [];
  const i = list.indexOf(name);
  if (i === -1) return { ok: true, value: dflt };
  if (i + 1 >= list.length) {
    return {
      ok: false,
      code: ARG_ERROR,
      why: `${name} was given with no value. Refusing to guess it.`,
    };
  }
  return { ok: true, value: list[i + 1] };
}

/**
 * A whole-number flag, or a refusal.
 *
 * STRICT: a malformed value is an error rather than the default. An
 * operator asking for one spend and silently getting another is the single
 * mistake here that costs money rather than correctness.
 */
export function posIntArg(argv, name, dflt) {
  const got = flagValue(argv, name, null);
  if (!got.ok) return got;
  if (got.value === null) return { ok: true, value: dflt };

  const raw = String(got.value).trim();
  if (!/^\d+$/.test(raw)) {
    return {
      ok: false,
      code: ARG_ERROR,
      why: `${name} must be a whole number, got ${JSON.stringify(got.value)}`,
    };
  }
  return { ok: true, value: Number(raw) };
}

/**
 * The next review-attempt count from a stored value that may be anything.
 *
 * An unreadable stored value counts as ALREADY AT THE BOUND rather than as
 * zero. `Number(x ?? 0) + 1` produced NaN, `JSON.stringify` writes NaN as
 * null, and the next read turned that back into 0 through its own `?? 0` --
 * so one corrupt value reset the counter permanently and the bound could
 * never be reached.
 */
export function nextAttempt(stored, bound) {
  const max = Number.isInteger(bound) && bound >= 0 ? bound : 0;
  if (stored === null || stored === undefined) return 1;
  const n = typeof stored === 'number' || typeof stored === 'string' ? Number(stored) : NaN;
  if (!Number.isFinite(n) || n < 0) return max;
  return Math.floor(n) + 1;
}
