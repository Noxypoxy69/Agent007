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

const refusal = (why) => ({ ok: false, code: ARG_ERROR, why });

/*
 * ═══ TWO SPELLINGS, ONE MATCHER. T-285 ═══
 *
 * `--by=sess-1` and `--by sess-1` are the same request, and every reader
 * here used `argv.indexOf(name)` / `argv.includes(name)`, which sees only
 * the second. Measured by T-276:
 *
 *   --by=sess-1     became audit-daemon@<host>: the identity the daemon
 *                   claims work AS, silently replaced, so the
 *                   author-cannot-audit exclusion could not fire.
 *   --max-ticks=0   became 5: an operator asking for a dry run got a spend.
 *   M-D             "a loop flag without --supervise is refused" read
 *                   `includes` too, so `--max-ticks=0` without --supervise
 *                   was discarded without a word.
 *
 * Fourth spelling of one class (M-6 trailing, M-3 `--by` left behind, M-A
 * the next flag as the value). So EVERY reader -- value, number, presence,
 * boolean -- goes through this one function, and a new spelling is handled
 * once or nowhere rather than once per reader.
 *
 * Unknown flags are NOT refused, in either spelling: the daemon has never
 * validated argv against a known set, and `--x=1` is ignored exactly as
 * `--x 1` is. That policy is unchanged here.
 */

/**
 * Every place `name` appears in argv, in either spelling.
 * `--name` is the space form; `--name=<v>` is the equals form and carries
 * its value. A longer flag that merely shares the prefix is not `name`.
 */
export function flagOccurrences(argv, name) {
  const list = Array.isArray(argv) ? argv : [];
  const eq = `${name}=`;
  const out = [];
  list.forEach((a, index) => {
    if (a === name) out.push({ index, form: 'space' });
    else if (typeof a === 'string' && a.startsWith(eq)) out.push({ index, form: 'equals', value: a.slice(eq.length) });
  });
  return out;
}

/** Was `name` given at all, in either spelling. What every presence check asks. */
export function flagPresent(argv, name) {
  return flagOccurrences(argv, name).length > 0;
}

/**
 * A flag that takes NO value: present or not.
 *
 * `--launch=no` would launch under a presence check and `--launch=yes`
 * would not launch under an exact-match one. Neither reading is the
 * operator's, so a value on a boolean flag is refused. Repeating the bare
 * flag is harmless and accepted.
 */
export function boolFlag(argv, name) {
  const withValue = flagOccurrences(argv, name).find((o) => o.form === 'equals');
  if (withValue) {
    return refusal(`${name} takes no value, and was given ${JSON.stringify(`${name}=${withValue.value}`)}. `
      + 'Refusing to guess whether that means on or off.');
  }
  return { ok: true, value: flagPresent(argv, name) };
}

/*
 * The raw value, with every refusal EXCEPT the blank one. Shared by both
 * readers so the structural checks -- repeated, trailing, a flag as the
 * value -- live in one place (M-3). The blank check is `flagValue`'s: the
 * numeric reader already refuses a blank as "not a whole number", and the
 * message it has always given is kept.
 */
function rawValue(argv, name) {
  const list = Array.isArray(argv) ? argv : [];
  const seen = flagOccurrences(list, name);
  if (seen.length === 0) return { ok: true, value: null, absent: true };

  /*
   * REPEATED IS REFUSED, in any mix of spellings. The old reader took the
   * first `--by` and ignored the rest; with two spellings "first" also
   * depends on which one the reader happens to see. Either occurrence is a
   * guess about which the operator meant.
   */
  if (seen.length > 1) {
    return refusal(`${name} was given ${seen.length} times. Refusing to guess which one was meant.`);
  }

  const [at] = seen;
  let value;
  if (at.form === 'equals') {
    value = at.value;
  } else {
    if (at.index + 1 >= list.length) {
      return refusal(`${name} was given with no value. Refusing to guess it.`);
    }
    value = list[at.index + 1];
  }

  /*
   * ═══ AND THE NEXT FLAG IS NOT A VALUE EITHER ═══
   *
   * Blind audit M-A, and it is the trailing-flag defect surviving one
   * spelling over. This guarded only `i + 1 >= length`, so a flag
   * FOLLOWED BY ANOTHER FLAG returned that flag as the value.
   *
   * `posIntArg` happened to catch it, because `/^\d+$/` rejects
   * `--launch` -- so the numeric flags looked covered and `--by` was not.
   * And `--by` is the identity the daemon claims work AS:
   *
   *     node scripts/audit-daemon.mjs --supervise --launch --by --once
   *
   * gives `BY = '--once'`, which matches no commit trailer, so
   * `proposeAudit`'s author-cannot-audit exclusion cannot fire -- while
   * `has('--once')` and `has('--launch')` still read argv independently,
   * so the run proceeds in launch mode. Fail-open on rule 20's core
   * property, from a plausible typing order.
   *
   * Guarding in the shared helper rather than in the numeric parser is
   * the same correction M-3 already made once, one spelling short.
   *
   * It applies to the equals form as well: `--by=--once` is the same
   * defect spelled with an `=`.
   */
  if (typeof value === 'string' && /^--?[A-Za-z]/.test(value)) {
    return refusal(`${name} was followed by ${JSON.stringify(value)}, which is another flag rather `
      + 'than a value. Refusing to guess it.');
  }
  return { ok: true, value, absent: false };
}

/**
 * The value of `name` in argv, given as `--name value` or `--name=value`.
 *
 * A flag PRESENT WITH NO VALUE is an error, not the default — for every
 * flag, not only the numeric ones. That distinction is M-3: guarding
 * inside the numeric parser left `--by` behind. A BLANK value (empty or
 * whitespace, in either spelling) is the same thing and is refused too:
 * T-276 F2, `--by ""` was accepted as an identity.
 *
 * @returns {{ok:true, value:string|null} | {ok:false, code:string, why:string}}
 */
export function flagValue(argv, name, dflt = null) {
  const got = rawValue(argv, name);
  if (!got.ok) return got;
  if (got.absent) return { ok: true, value: dflt };
  if (typeof got.value === 'string' && got.value.trim() === '') {
    return refusal(`${name} was given a blank value ${JSON.stringify(got.value)}. Refusing to guess it.`);
  }
  return { ok: true, value: got.value };
}

/**
 * A whole-number flag, or a refusal.
 *
 * STRICT: a malformed value is an error rather than the default. An
 * operator asking for one spend and silently getting another is the single
 * mistake here that costs money rather than correctness.
 */
export function posIntArg(argv, name, dflt) {
  const got = rawValue(argv, name);
  if (!got.ok) return got;
  if (got.absent) return { ok: true, value: dflt };

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
  /*
   * ═══ ABSENT IS FRESH. NULL IS CORRUPT. T-291 / B-12 ═══
   *
   * These were one case, and they are not. A row that never had a counter
   * has NO KEY, which reads back as `undefined`: that is a fresh count.
   * A JSON `null` is exactly what the old NaN corruption left behind --
   * `JSON.stringify(NaN)` is "null" -- so treating null as fresh restarted
   * the count on precisely the rows L3 was about. Measured by T-276
   * (f5196a3 F2). Null therefore falls through to the unreadable path
   * below with the blank and non-digit strings: AT THE BOUND, fail closed.
   */
  if (stored === undefined) return 1;

  /*
   * A BLANK STRING IS NOT ZERO, and this is the half I had already fixed
   * at the other end and not here. `Number('')` and `Number('  ')` are
   * both 0, so a truncated or empty value -- exactly what a partial write
   * leaves behind -- counted as a fresh counter and returned 1, for ever.
   *
   * `proposeAudit` was made strict about this when L3 was closed; the
   * WRITER was not, so the two ends disagreed about what a corrupt
   * counter means. Found the moment this function became testable, which
   * is the argument for extracting it.
   */
  let n = NaN;
  if (typeof stored === 'number') n = stored;
  else if (typeof stored === 'string' && /^\d+$/.test(stored.trim())) n = Number(stored.trim());

  if (!Number.isFinite(n) || n < 0) return max;
  return Math.floor(n) + 1;
}
