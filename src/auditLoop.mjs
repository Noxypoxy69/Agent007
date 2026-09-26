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

/*
 * ═══ A REASON BUILDER ON A FAIL-CLOSED PATH MUST BE TOTAL. T-305 / B-25 F1 ═══
 *
 * The corrupt-marker reason used JSON.stringify, which THROWS on a BigInt, a
 * cycle or a throwing toJSON, and returns undefined for a symbol or a
 * function. A fail-closed branch that throws hands the caller an exception
 * instead of STOP. So: every step is guarded, the text falls back to String()
 * and then to a placeholder, and the TYPE is always named -- `10n (bigint)`
 * and `"1" (string)` must not read alike.
 *
 * ═══ AND BOUNDED, BEFORE ANY CONCATENATION. T-316 / B-28 F-A ═══
 *
 * Total was not enough: an object whose toString returns a near-
 * MAX_STRING_LENGTH string made `${text} (${type})` overflow, a RangeError out
 * of the same fail-closed branch, and nothing capped the text at all. The
 * text is cut to DESCRIBED_MAX characters plus an ellipsis FIRST, so every
 * concatenation after it is over a bounded string. A cut never splits a
 * surrogate pair.
 *
 * Exported because src/auditDispatch.mjs builds its unreadable-counter reason
 * with it: one helper, so the two fail-closed reasons cannot drift apart.
 */
const DESCRIBED_MAX = 200;
/*
 * Exported for the one caller that must cap a string it has already
 * validated WITHOUT describing it -- auditDispatch's `(${author})`, whose
 * unquoted form test/daemonArgs.test.mjs pins (T-316 r3 (b)).
 *
 * TOTAL, because an exported cap is a promise to every caller (T-316 r4 /
 * T-324 F1): r3 reached it with a BigInt from an attacker's iterator and it
 * threw `t.charCodeAt is not a function`. A non-string is DESCRIBED instead
 * -- describeValue only ever hands this a string, so there is no loop.
 */
export function capText(t) {
  if (typeof t !== 'string') return describeValue(t);
  if (t.length <= DESCRIBED_MAX) return t;
  let cut = DESCRIBED_MAX;
  const c = t.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
  return `${t.slice(0, cut)}…`;
}

/*
 * ═══ DESCRIBING A VALUE MUST NOT WALK IT. T-316 r5 / T-326 F1 ═══
 *
 * Bounded LENGTH was not enough; the TIME was unbounded. The String()
 * fallback joined every hole of a sparse length-2**32-1 array (~66 s,
 * measured by T-326), and r4 had routed three sites that used to throw in
 * under 50 ms through it. JSON.stringify itself walked a sparse 1e8 array
 * for ~4 s at every site, 8a8e136 included (live/T-316/work/r5/timing-*.json).
 * My B-36 note blamed JSON.stringify for the first one; it was the fallback.
 *
 * So nothing here walks a container without a budget:
 *  - JSON.stringify runs with a replacer that counts every value it visits
 *    and stops at WALK_MAX, and refuses, BEFORE they are walked, any array
 *    or typed array longer than WALK_MAX -- at any depth, since the replacer
 *    sees each value before JSON enumerates it.
 *  - String() is never applied to an object. A container JSON could not
 *    print is described by kind and length; a function through the
 *    intrinsic Function.prototype.toString; anything else as unprintable.
 *  - A typed array's kind and length come from the intrinsic %TypedArray%
 *    getters, which the value cannot override.
 *
 * ═══ AND NOTHING HERE COSTS TIME IN PROPORTION TO THE VALUE. T-356 / B-28 ═══
 *
 * The visit budget bounds how many values the replacer is SHOWN, not what
 * JSON.stringify does before it shows them, and both gaps are reachable from
 * the JSONL audit store (JSON.parse of one line, up to MAX_STRING_LENGTH):
 *  - JSON collects ALL of an object's own keys before the replacer sees the
 *    first one. `{"k0":0,...}` with 5e6 keys (65M chars, one line) took
 *    5.2 s at the review_attempts and last-cause sites; measured ~0.77 us
 *    per key, the same as Object.keys, so NO enumeration is cheap enough and
 *    no O(1) probe of an object's size exists. So `keys: false` (the
 *    dispatcher's mode: its values ARE store rows) never lets JSON open a
 *    plain object: the value is named, its keys are not read. auditLoop's own
 *    sites keep `keys: true`, because their values are the daemon's
 *    in-process counters and CLI numbers -- no store row reaches them -- and
 *    `backoffServed is {}` is pinned (T-291 B-10).
 *  - JSON escapes a WHOLE string before capText cuts it: 1e7 lone
 *    surrogates took 1.75 s. A string longer than STRING_WALK_MAX is handed
 *    to JSON already cut. That cannot change the shown text: every input
 *    character yields at least one output character, so the first
 *    DESCRIBED_MAX output characters come from the first DESCRIBED_MAX input
 *    characters, and the cut string still overruns the cap, so the ellipsis
 *    stays. A pair split at STRING_WALK_MAX lands past the cap too.
 */
const WALK_MAX = 1000;
const STRING_WALK_MAX = DESCRIBED_MAX + 56;
const OBJECT_NOT_READ = 'its keys were not read';
const TOO_LARGE = Object.freeze({ tooLarge: true });
const TYPED_PROTO = Object.getPrototypeOf(Uint8Array.prototype);
const typedName = Object.getOwnPropertyDescriptor(TYPED_PROTO, Symbol.toStringTag).get;
const typedLength = Object.getOwnPropertyDescriptor(TYPED_PROTO, 'length').get;
const viewByteLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength').get;
const fnSource = Function.prototype.toString;

/* The kind and length of a container too large to walk, or null. An array's
 * length may be a proxy trap; the caller guards. A length that is not a
 * number counts as too large, since JSON would coerce it and walk. */
function tooLargeToWalk(value) {
  if (value === null || typeof value !== 'object') return null;
  if (ArrayBuffer.isView(value)) {
    const name = typedName.call(value);
    const length = name === undefined ? viewByteLength.call(value) : typedLength.call(value);
    return length > WALK_MAX ? { kind: name ?? 'DataView', length } : null;
  }
  if (Array.isArray(value)) {
    const { length } = value;
    if (typeof length === 'number' && length <= WALK_MAX) return null;
    return { kind: 'array', length: typeof length === 'number' ? length : 'unreadable' };
  }
  return null;
}

/* A plain object: something JSON would open by collecting all its keys. */
const isPlainObject = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && !ArrayBuffer.isView(value);

function boundedJSON(v, type, keys) {
  let visits = 0;
  let big = null;
  try {
    return JSON.stringify(v, function bounded(key, value) {
      visits += 1;
      if (visits > WALK_MAX) { big = { budget: true }; throw TOO_LARGE; }
      const size = tooLargeToWalk(value);
      if (size) { big = { ...size, root: visits === 1 }; throw TOO_LARGE; }
      if (!keys && isPlainObject(value)) { big = { object: true, root: visits === 1 }; throw TOO_LARGE; }
      if (typeof value === 'string' && value.length > STRING_WALK_MAX) return value.slice(0, STRING_WALK_MAX);
      return value;
    });
  } catch (e) {
    if (e !== TOO_LARGE || big === null) throw e;
    if (big.budget) return `<${type} with more than ${WALK_MAX} values>`;
    if (big.object) return big.root ? `<object: ${OBJECT_NOT_READ}>` : `<${type} holding an object: ${OBJECT_NOT_READ}>`;
    if (big.root) return `<${big.kind} of length ${big.length}>`;
    return `<${type} holding ${big.kind === 'array' ? 'an' : 'a'} ${big.kind} of length ${big.length}>`;
  }
}

/* When JSON could not print it: never String() an object. */
function describeUnprintable(v) {
  if (typeof v === 'function') return fnSource.call(v);
  if (v === null || typeof v !== 'object') return String(v);
  if (Array.isArray(v)) {
    const { length } = v;
    return `<array of length ${typeof length === 'number' ? length : 'unreadable'}>`;
  }
  return '<unprintable>';
}

/**
 * @param {{keys?: boolean}} [opts] keys: false never opens a plain object
 *   (T-356): for values that come from the audit store, where an object's key
 *   count is bounded only by the line cap. Default true (auditLoop's own sites).
 */
export function describeValue(v, { keys = true } = {}) {
  let type = v === null ? 'null' : typeof v;
  try { if (Array.isArray(v)) type = 'array'; } catch { /* a revoked proxy throws here */ }
  let text;
  try {
    if (typeof v === 'number') text = String(v);
    else if (typeof v === 'bigint') text = `${String(v)}n`;
    else text = boundedJSON(v, type, keys);
  } catch { text = undefined; }
  if (typeof text !== 'string') {
    try { text = describeUnprintable(v); } catch { text = '<unprintable>'; }
  }
  const shown = capText(text);
  return `${shown} (${type})`;
}

/*
 * THE DISPATCHER'S REASONS, READ SAFELY AND PRINTED BOUNDED. T-316 r3 (a).
 *
 * `Array.isArray` throws on a revoked proxy, `.filter` runs a hostile get
 * trap, and `join` overflowed on one near-max element -- inside the STARVED
 * STOP, the message an operator most needs. So: the whole read is guarded
 * (a throw is reported as unreadable, never as "none reported"), only
 * non-blank strings count, each is capped with capText BEFORE the join, and
 * at most MAX_REASONS are printed with a count of the rest.
 *
 * ═══ AND NOTHING THE INPUT CAN OVERRIDE IS EVER CALLED. T-316 r4 / T-324 F1 ═══
 *
 * r3 used Array.prototype.filter, which builds its result through the
 * input's `constructor[Symbol.species]`, then spread `new Set(result)`, which
 * runs that result's own iterator. So a REAL Array (isArray true) put 5n,
 * null and an object into capText, outside the guard -- a new throw where
 * 8a8e136 had returned STARVED. Now: an index loop reads `length` and each
 * element of the input under the guard and copies strings into arrays THIS
 * function created; no filter, slice, map, species or iterator of the input
 * is touched, and the join is inside the guard too.
 *
 * THE SCAN IS BOUNDED. `a.length = 2 ** 32 - 1` made the old filter walk four
 * billion holes (over 20 s, measured at 8a8e136 and at r3), and an index loop
 * inherits that unless it stops. At most MAX_SCAN entries are read, and a
 * cut-short scan says so.
 */
const MAX_REASONS = 10;
const MAX_SCAN = 1000;
function readReasons(state) {
  try {
    const v = state.unplacedReasons;
    if (!Array.isArray(v)) return { text: '', unreadable: false };
    /* A length that is not a non-negative safe integer is UNREADABLE, never
     * empty (T-316 r5 / T-326 F3): only a proxy can hand one over, and "none
     * reported" would be a claim about reasons this never saw. */
    const length = v.length;
    if (!Number.isSafeInteger(length) || length < 0) return { text: '', unreadable: true };
    const total = length;
    const scan = Math.min(total, MAX_SCAN);
    const distinct = [];
    for (let i = 0; i < scan; i += 1) {
      const r = v[i];
      if (typeof r !== 'string' || r.trim() === '' || distinct.includes(r)) continue;
      distinct[distinct.length] = r;
    }
    const shown = [];
    for (let i = 0; i < distinct.length && i < MAX_REASONS; i += 1) shown[i] = capText(distinct[i]);
    let text = shown.join(', ');
    const more = distinct.length - MAX_REASONS;
    if (more > 0) text += `, and ${more} more`;
    if (total > scan) {
      text += `${text === '' ? 'nothing readable' : ''} (only the first ${scan} of ${total} entries were read)`;
    }
    return { text, unreadable: false };
  } catch {
    return { text: '', unreadable: true };
  }
}

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
  const maxTicks = num(raw.maxTicks, LOOP_DEFAULTS.maxTicks);
  const o = {
    ...LOOP_DEFAULTS,
    ...raw,
    maxTicks,
    /*
     * ═══ RECONCILED WITH THE EFFECTIVE maxTicks, NOT JUST DEFAULTED ═══
     *
     * Blind audit M-1 (second round). `starvedLimit: 3` beats `maxTicks: 5`
     * only for the DEFAULTS. The caller takes `--max-ticks` from argv and
     * has no flag for `starvedLimit`, so `--max-ticks 2` or `1` puts the
     * budget below the starve limit and BUDGET wins again -- handing a
     * cost-conscious operator, the one person most likely to lower that
     * flag, the exact misleading message the reorder was meant to remove.
     *
     * My premise assertion checked `LOOP_DEFAULTS.starvedLimit <
     * LOOP_DEFAULTS.maxTicks`, which is the defaults object and not the
     * effective value, so it could not see this.
     */
    starvedLimit: Math.max(1, Math.min(
      num(raw.starvedLimit, LOOP_DEFAULTS.starvedLimit),
      maxTicks > 1 ? maxTicks - 1 : 1,
    )),
    intervalMs: num(raw.intervalMs, LOOP_DEFAULTS.intervalMs),
    maxIntervalMs: num(raw.maxIntervalMs, LOOP_DEFAULTS.maxIntervalMs),
    /*
     * deadlineMs WAS THE ONE opts FIELD STILL UNVALIDATED. Blind audit
     * M-2 (second round): it arrived through the bare spread, and the
     * check below silently ignores a non-number -- so `deadlineMs: '600000'`,
     * which is exactly the shape a caller computing `posInt(...) * 1000`
     * could produce, disabled the deadline with no word. Same failure as
     * maxTicks, in the fix that claimed to close it.
     */
    deadlineMs: raw.deadlineMs,
  };
  const ticksUsed = num(s.ticksUsed, 0);
  const noProgress = num(s.consecutiveNoProgress, 0);
  const depth = num(s.queueDepth, 0);

  /*
   * A DEADLINE THAT WAS ASKED FOR AND CANNOT BE READ STOPS THE LOOP.
   *
   * Blind audit M-2, and my first attempt at it was not a fix. Routing the
   * value through `num` normalised a bad one to NaN, which this check then
   * ignored exactly as before -- silently running with no deadline, which
   * is the failure. There is no safe default to fall back to the way
   * `maxTicks` falls back to 5: the absence of a deadline IS a valid
   * configuration, so "unreadable" and "not asked for" would look
   * identical.
   *
   * So an unreadable deadline is treated as ALREADY EXPIRED. The operator
   * asked for a bound, the bound cannot be evaluated, and running
   * unbounded is the one outcome they did not ask for. `undefined` and
   * `null` still mean "no deadline", which is the documented default.
   */
  if (o.deadlineMs !== undefined && o.deadlineMs !== null
    && !(typeof o.deadlineMs === 'number' && Number.isFinite(o.deadlineMs) && o.deadlineMs >= 0)) {
    return {
      action: LOOP_ACTION.STOP,
      code: LOOP_STOP.DEADLINE,
      /* describeValue, not JSON.stringify: that threw on 17 of 33 hostile
       * values out of this fail-closed branch, uncapped (T-316 r2 / T-320 F2). */
      why: `deadlineMs is ${describeValue(o.deadlineMs)}, which is not a duration in `
        + 'milliseconds. A deadline that was asked for and cannot be read stops the loop: '
        + 'running unbounded is the one outcome the caller did not ask for',
    };
  }

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
    /*
     * THE REMEDY MUST NOT BE GUESSED. Blind audit M-E.
     *
     * This named two causes -- a live claim on every seat, or the
     * candidate being the daemon's own work -- and told the operator to
     * register a seat or wait for leases. `queueDepth` is computed with
     * `isClaimable`, which admits any PENDING row, while `proposeAudit`
     * additionally refuses rows for REVIEW_EXHAUSTED and AUTHOR_UNKNOWN.
     * A queue of only those is depth > 0 for ever and neither remedy
     * touches it: no new seat and no lapsing lease clears an exhausted
     * counter or an unresolvable author. The loop would then exit 1 on
     * every invocation, permanently, while advising a fix that cannot
     * work.
     *
     * The caller already has the real reasons -- `proposeAudit` returns
     * them per job -- so they are passed in and printed instead of
     * guessed. When they are absent the message says the causes are
     * CANDIDATES rather than asserting them.
     */
    const reasons = readReasons(s);
    return {
      action: LOOP_ACTION.STOP,
      code: LOOP_STOP.STARVED,
      why: `${noProgress} consecutive cycles placed nothing while ${depth} job(s) were `
        + `claimable. THE QUEUE IS NOT EMPTY. ${reasons.text !== ''
          ? `The dispatcher refused them for: ${reasons.text}. `
            + 'Note that a seat or a lapsing lease only helps the seat-related ones'
          : `${reasons.unreadable ? 'The reasons passed in could not be read'
            : 'No reason was reported'}, so the cause is UNKNOWN rather than assumed. `
            + 'Common ones are a live claim on every seat, a candidate that is this '
            + "daemon's own work, an exhausted review counter, or an author that "
            + 'could not be established -- and the last two are not fixed by waiting'}`,
    };
  }

  if (ticksUsed >= o.maxTicks) {
    return {
      action: LOOP_ACTION.STOP,
      code: LOOP_STOP.BUDGET,
      /*
       * THE MESSAGE MUST NOT CLAIM A SPEND THAT DID NOT HAPPEN.
       *
       * Blind audit M-4. This said "Each one is a paid review" on every
       * path -- including the DEFAULT mode, which prepares a workspace and
       * launches no reviewer, so nothing is paid at all. Telling an
       * operator they exhausted a spend budget over zero spend is the same
       * class of wrong as reporting a starved queue as drained, and it is
       * in a message whose whole job is to justify a hard stop.
       *
       * `spends` is what the caller knows and this module does not.
       */
      why: `${ticksUsed} of ${o.maxTicks} tick(s) used. ${o.spends === false
        ? 'This mode launches no reviewer, so nothing was spent -- the bound is on work '
          + 'prepared, not money.'
        : 'Each one is a paid review, so this is a hard stop rather than a pause.'} `
        + 'Raise --max-ticks deliberately',
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
   *
   * ═══ SERVED MEANS THE BOOLEAN true, AND NOTHING ELSE. T-291 / B-10 ═══
   *
   * This was read by truthiness while every other state field goes through
   * `num`. So the strings "false" and "no", the number 1 and `{}` all read
   * as "I have slept" and skipped the backoff -- a caller that serialised
   * the flag, or a hand-written state file, turned the anti-spin wait off
   * with a value that says the opposite. Measured by T-277 (09c51a3 F1).
   * Skipping a wait is the unsafe direction, so anything that is not
   * exactly `true` is "not served": the worst it costs is one extra wait.
   *
   * ═══ A MARKER THAT IS NOT A BOOLEAN IS CORRUPT, AND STOPS. T-298 / B-22 ═══
   *
   * "One extra wait" was wrong. The caller writes the marker after every
   * WAIT, so a caller that writes "true", 1 or {} writes it EVERY time: the
   * loop read not-served, waited, came back to the same counters and waited
   * again. Measured by T-293 F2: 200 waits, 0 ticks, STARVED unreachable --
   * the permanent wait this module's own header calls worse than a spin.
   *
   * Neither reading of a corrupt marker is safe: "served" skips the anti-spin
   * wait (B-10), "not served" waits for ever (B-22). So it is neither. It
   * fails CLOSED to a terminal STOP, reusing STARVED because the loop is
   * making no progress and the reason names the marker.
   *
   * ABSENT (`undefined`) is "not served", unchanged: that is the first call
   * of a run. NULL IS CORRUPT, not absent: no caller writes null, and a
   * JSON round-trip only produces it from NaN or an explicit null -- the
   * same reason a null review counter is corrupt (T-291 B-12).
   */
  /*
   * ═══ THE CALLER CONTRACT, AND ITS ONE UNBOUNDED CASE. T-305 / B-25 F4 ═══
   *
   * A caller MUST write the boolean `true` after it has slept a WAIT, and
   * `false` (or leave it absent) after a TICK. The boolean `false` is a legal
   * marker meaning "not served", so a caller that writes `false` after every
   * WAIT presents the same counters for ever and gets WAIT for ever: this
   * function cannot tell it from a first call. That is a LIMIT, not a STOP
   * this function can detect -- the only bound on such a caller is its own
   * `deadlineMs`. Pinned by the "F4 LIMIT" test; the one real caller
   * (scripts/audit-daemon.mjs) writes `true` and is pinned to it there.
   */
  if (s.backoffServed !== undefined && typeof s.backoffServed !== 'boolean') {
    const shown = describeValue(s.backoffServed);
    return {
      action: LOOP_ACTION.STOP,
      code: LOOP_STOP.STARVED,
      why: `backoffServed is ${shown}, which is not a boolean. The caller's "I have slept" `
        + 'marker is corrupt, so neither "served" (skips the anti-spin wait) nor "not served" '
        + '(waits for ever) can be read from it. Stopping rather than waiting unboundedly',
    };
  }
  const backoffServed = s.backoffServed === true;
  if (noProgress > 0 && !backoffServed) {
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
