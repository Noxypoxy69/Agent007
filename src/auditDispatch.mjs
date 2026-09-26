/**
 * WHICH LIVE SEAT SHOULD TAKE WHICH QUEUED AUDIT.
 *
 * P0 item 2, Danny 2026-09-20. The measured state that produced it: 33 audit
 * jobs, 25 PENDING, 8 CLAIMED by a single `audit-daemon@<host>` seat, and that
 * daemon dead. Enqueueing worked; consumption did not, because consumption
 * depended on a process somebody had to remember to start.
 *
 * (The host is elided on purpose. The first version of this comment pasted the
 * operator's real machine name in, and test/leakRegression.test.mjs caught it
 * -- this repository is published, and a hostname is an identity. Same scrub
 * as the operator's home directory, which CLAUDE.md records for the same
 * reason.)
 *
 *     "Audit jobs must be consumed by the existing task/worker dispatcher, or
 *      by the same authoritative worker-liveness mechanism. Do not add another
 *      owner-operated watcher that Danny has to restart."
 *
 * ═══ WHAT THIS MODULE IS, AND THE TWO THINGS IT DELIBERATELY IS NOT ═══
 *
 * It is the SELECTION step, and only that: given the queue and the roster, it
 * says which seat should take which audit. It is pure, so the suite can watch
 * every branch of it fail -- rule 10, the reason `canAssign` and `canAccept`
 * live in src/ rather than in the edge function.
 *
 * It is NOT a claim. `claimJob` in src/auditJob.mjs is the only thing that
 * takes a job, and it stays that way: it already enforces one-auditor-per-
 * candidate, the author exclusion, lease expiry and the independence grading,
 * and a second implementation of any of those is the "four token classes in
 * one table" mistake in another costume. A proposal here is a suggestion that
 * `claimJob` is free to refuse, and when the two disagree `claimJob` wins.
 *
 * It is NOT a liveness oracle. `isLive` is injected exactly as `proposeWork`
 * injects it, because src/liveRegistry.mjs already owns that judgement and a
 * dispatcher forming its own second opinion is how two answers to one question
 * get shipped.
 *
 * ═══ WHY "NO SEAT" IS NOT A FAILURE ═══
 *
 * A queue with nobody to serve it is a queue WAITING, not a queue that failed.
 * The distinction is the whole reason the 8 stranded jobs were invisible for a
 * day: a dead consumer and a working one produced the same evidence. So a job
 * nobody can take is returned in `unassigned` with a reason, never marked
 * failed, never silently dropped, and never left looking claimed.
 */
import { CLAIM_LEASE_MS, JOB, AUTHOR_UNAVAILABLE } from './auditJob.mjs';
/*
 * ONE REASON BUILDER FOR A VALUE THAT MAY BE ANYTHING. T-316 / B-28.
 * Every reason below that prints a caller-supplied value went through
 * JSON.stringify or a bare template, which THROW on a BigInt, a cycle, a
 * throwing toJSON, a Symbol, and overflow on a near-max string -- so a
 * fail-closed branch handed its caller an exception instead of a decision.
 * auditLoop's describeValue is total, bounded and names the type; shared, not
 * copied, so the two cannot drift. capText is the same file's cap WITHOUT the
 * description, for a string already validated whose unquoted form is pinned
 * (the only-author reason, T-316 r3 (b)).
 */
import { describeValue, capText } from './auditLoop.mjs';
/*
 * EVERY VALUE THIS FILE DESCRIBES IS A STORE ROW'S (or the clock), so it is
 * described WITHOUT opening plain objects. T-356 / B-28: a row is one JSONL
 * line, up to MAX_STRING_LENGTH, and a 5e6-key object in review_attempts or
 * last_review.not_recorded_because made proposeAudit take 5.2 s -- JSON reads
 * every key before any bound applies. See auditLoop's "NOTHING HERE COSTS
 * TIME IN PROPORTION TO THE VALUE".
 */
const STORE_VALUE = Object.freeze({ keys: false });

/*
 * ═══ A TRIM THAT COSTS THE SAME WHATEVER THE STRING HOLDS. T-356 r2 / V1-F1 ═══
 *
 * `str` was `v.trim() !== '' ? v.trim() : null`: two native trims per call,
 * and proposeAudit calls it six to fifteen times per row (audit_id, state,
 * claimed_by, author_session, author_source, candidate_sha, and both seat
 * ids). A native trim walks the WHOLE leading and trailing whitespace run
 * every time, and caches nothing -- so one store row whose id is padded with
 * 1e8 spaces on each side (a legal JSON string, 2e8 characters, well under
 * the line cap) made proposeAudit take 2.2-6.2 s. The blind verifier found
 * it because the round-1 table swept string LENGTH in one content class
 * ('x'), where trim stops at the first character. Time is a verdict, and
 * the cost of an operation depends on the CONTENT it is given, not only on
 * the length.
 *
 * So the scan is BOUNDED: at most TRIM_SCAN code units are read from each
 * end. A string whose leading or trailing whitespace run is longer than that
 * is not trimmed at all -- it is UNREADABLE (TRIM_OVER), and proposeAudit
 * names it (UNPLACED.ROW_UNREADABLE, or a seat marked `unreadable`) rather
 * than dropping the row silently, because a corrupt row must surface
 * (Controller decision, T-356 r2). Below the bound the result is exactly
 * `.trim()`'s, for every code unit the engine trims: the predicate is the
 * ECMAScript WhiteSpace + LineTerminator set (25 code units on this engine),
 * pinned against the running engine by test/auditDispatch.test.mjs so an
 * engine that changes its set turns the test red rather than the trim wrong.
 * No whitespace code point lies outside the BMP and a lone surrogate is
 * never whitespace, so a per-code-unit scan equals the spec's TrimString.
 *
 * The bound is not a cut: nothing about a string's CONTENT is truncated
 * (an audit id is an identity; T-316 r3 (b) pins that a 1e6-character id is
 * read whole and only its DISPLAY is capped). Only the whitespace around the
 * content is bounded. 4096 is four thousand times any padding a real row
 * carries and costs at most about 20 us per call.
 */
export const TRIM_SCAN = 4096;
export const TRIM_OVER = Symbol('whitespace run longer than TRIM_SCAN: not read');
const isWs = (c) => c === 0x20 || (c >= 0x09 && c <= 0x0d) || c === 0xa0 || c === 0x1680
  || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f
  || c === 0x205f || c === 0x3000 || c === 0xfeff;
export function boundedTrim(v) {
  const n = v.length;
  let i = 0;
  while (i < n && isWs(v.charCodeAt(i))) { if (++i > TRIM_SCAN) return TRIM_OVER; }
  if (i === n) return '';
  let j = n;
  while (isWs(v.charCodeAt(j - 1))) { if (n - --j > TRIM_SCAN) return TRIM_OVER; }
  return v.slice(i, j);
}
/* The usable text of a store string, or null: not a string, blank, or padded past the bound (which
 * `unreadableFields` names separately -- str() alone cannot tell the caller which it was). */
const str = (v) => {
  if (typeof v !== 'string') return null;
  const t = boundedTrim(v);
  return t === TRIM_OVER || t === '' ? null : t;
};
const overBound = (v) => typeof v === 'string' && boundedTrim(v) === TRIM_OVER;
/* Every field of a row / a seat that str() reads. A row with any of these past the bound is REFUSED whole and
 * named: deciding on the others would decide with a field it could not read (an author_session past the bound
 * would otherwise read as "no author" and hand the candidate to whoever wrote it). */
const ROW_TEXT_FIELDS = Object.freeze(['audit_id', 'state', 'claimed_by', 'author_session', 'author_source', 'candidate_sha']);
const SEAT_TEXT_FIELDS = Object.freeze(['session_id', 'agent_id']);
function unreadableFields(o, fields) {
  const out = [];
  for (const f of fields) if (overBound(o[f])) out[out.length] = f;
  return out;
}
const unreadableWhy = (fields) => `${fields.join(', ')} ${fields.length > 1 ? 'are strings' : 'is a string'} with more `
  + `than ${TRIM_SCAN} whitespace characters at one end, so the text was not read: an unbounded trim was where a `
  + 'padded row cost seconds per call (T-356). ';
/*
 * A COUNT IS SHORT. A review counter arrives as a number from nextAttempt, or
 * as a digit string from a hand-edited row; `/^\d+$/` and `Number()` both
 * read every character (0.6 s at 5e8 digits, measured), so a count text
 * longer than this is unreadable before either runs. 20 characters holds any
 * safe integer's digits with room; MAX_REVIEW_ATTEMPTS is 3.
 */
const COUNT_TEXT_MAX = 20;
const arr = (v) => (Array.isArray(v) ? v : []);

/*
 * THE LAST REVIEW'S CAUSE, READ ONLY WHERE IT IS PRINTED, AND READ SAFELY.
 * T-316 r2 / T-320 F1.
 *
 * r1 hoisted `job.last_review?.not_recorded_because` above the
 * unreadable/exhausted split, so the READ ran on both branches, and a
 * last_review that throws when read (a revoked proxy, a get trap, a
 * throwing getter) made proposeAudit throw for review_attempts null, where
 * 3af14ea had returned REVIEW_EXHAUSTED. So this is called only from the
 * at-the-bound reason, and a read that throws is reported as unreadable
 * rather than escaping the fail-closed branch.
 */
function lastReviewCause(job) {
  let cause;
  try { cause = job.last_review?.not_recorded_because; } catch {
    return '<unreadable: reading last_review threw>';
  }
  return cause == null ? 'unknown' : describeValue(cause, STORE_VALUE);
}

/** Reasons a job could not be placed. Codes, so a caller can branch. */
export const UNPLACED = Object.freeze({
  NO_LIVE_SEAT: 'no_live_seat',
  ONLY_AUTHOR_AVAILABLE: 'only_author_available',
  ALL_SEATS_BUSY: 'all_seats_busy',
  AUTHOR_UNKNOWN: 'author_unknown',
  REVIEW_EXHAUSTED: 'review_exhausted',
  /* A row whose text fields could not be read (whitespace past TRIM_SCAN). Named, never dropped: T-356 r2. */
  ROW_UNREADABLE: 'row_unreadable',
});

/**
 * How many times one candidate may be reviewed without the result landing.
 *
 * ═══ WHY A BOUND EXISTS AT ALL ═══
 *
 * A review that completes but cannot be attributed -- a dirty worktree, a
 * moved candidate -- puts the job back at PENDING. `byUrgency` sorts on
 * `escaped`, then `first_seen_at`, then `audit_id`, none of which the
 * re-queue changes, so the job is head-of-queue again on the next tick and
 * is re-reviewed AT FULL LLM COST. Forever.
 *
 * That was raised as D-4, and my fix wrote the verdict into `last_review`
 * and changed nothing else -- `last_review` is read by nothing, and the
 * loop was byte-for-byte still there. Preserving the evidence was worth
 * doing and was not the finding. The finding was the unbounded retry.
 *
 * Three, because the failure modes are real but transient-ish: a reviewer
 * killed mid-mutation, an `npm install` touching a lockfile. One attempt
 * would discard work for a hiccup; unbounded spends the budget on a job
 * that will never land.
 */
export const MAX_REVIEW_ATTEMPTS = 3;

/**
 * Is this job available to somebody other than its current holder?
 *
 * PENDING, or CLAIMED past the lease. The second half is the recovery path
 * proven in test/auditClaimRecovery.test.mjs: an auditor that died holding a
 * job must not park it forever, and a claim with no timestamp is treated as
 * infinitely old rather than immortal -- unknown age fails TOWARD recovery,
 * because the cost of re-auditing is a duplicate review and the cost of
 * stranding is a control nobody ever clears.
 */
export function isClaimable(job, { now, leaseMs = CLAIM_LEASE_MS } = {}) {
  const state = str(job?.state);
  if (!state) return false;
  if (state === JOB.PENDING) return true;
  if (state !== JOB.CLAIMED) return false;   // terminal states are not re-openable

  const since = typeof job.claimed_at === 'number' && Number.isFinite(job.claimed_at)
    ? job.claimed_at
    : null;
  if (since === null) return true;

  /*
   * ═══ THE CLOCK MUST BE A NUMBER, AND THIS THROWS RATHER THAN GUESSING ═══
   *
   * Blind audit H-1, and it was mine. `scripts/audit-daemon.mjs:1073` passed
   * `new Date().toISOString()`. A string minus a number is NaN, every
   * `NaN > leaseMs` is false, so EVERY claim with a well-formed
   * `claimed_at` read as un-expired however long its lease had lapsed --
   * and the supervised loop computed `queueDepth` from exactly that. With
   * only expired claims left it saw depth 0, reported
   * "no claimable jobs. This is the good ending: the queue is drained",
   * and exited 0 over a backlog it exists to recover.
   *
   * `proposeAudit` has thrown a TypeError on this since it was written,
   * and test/auditDispatch.test.mjs carries a PASSING test called
   * "A STRING `now` IS REFUSED, because it would make every lease
   * immortal". The mechanism was known, written down and covered -- and
   * `isClaimable` is exported separately with no such guard, so the one
   * call site that bypassed `proposeAudit` walked straight into it.
   *
   * Fixing only the call site would leave the next one free to repeat it
   * (rule 8: fix the matcher, not the spelling). Refusing here is also
   * the fail-safe direction: a loud throw beats a silent "nothing is
   * claimable", which is indistinguishable from real success.
   */
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new TypeError('isClaimable needs `now` as epoch milliseconds, got '
      + `${describeValue(now, STORE_VALUE)}. A non-number makes (now - claimed_at) NaN, `
      + 'so every lease reads as un-expired and a recoverable backlog reports as empty');
  }
  return (now - since) > leaseMs;
}

/**
 * ESCAPED FIRST, THEN OLDEST, THEN BY ID.
 *
 * A pushed candidate outranks one still on this machine: other clones can
 * already build on it, so the moment to review it has passed and every hour
 * costs more. Oldest-next keeps the queue from starving anything, and the id
 * is the final tiebreak so the order is TOTAL -- two runs over the same queue
 * must propose the same pairing, or a "the dispatcher assigned it" claim is
 * unreproducible and nobody can debug it.
 */
/**
 * @param demotePrepared  true when the CALLER is preparing workspaces, so a
 *   job it already prepared should wait behind one it has not.
 */
function byUrgency(a, b, demotePrepared = true) {
  /*
   * ESCAPED STILL COMES FIRST. Blind audit L5, and I had this inverted.
   *
   * My first version compared `last_review` BEFORE `escaped`, so a single
   * unattributable review pushed an ALREADY-PUSHED candidate below every
   * local job in the queue. That is backwards: an escaped commit is one
   * other clones can already build on, which is the whole reason it
   * outranks a local one, and a failed review does not make it less
   * urgent -- if anything it makes it more.
   *
   * The starvation it was written to stop is bounded now by
   * MAX_REVIEW_ATTEMPTS, so the worst an escaped candidate can do is take
   * the seat three times and then be reported as REVIEW_EXHAUSTED. Three
   * passes to protect the priority order is the right trade; indefinite
   * demotion of the urgent class to protect against three is not.
   */
  const esc = Number(Boolean(b?.escaped)) - Number(Boolean(a?.escaped));
  if (esc !== 0) return esc;

  /*
   * WITHIN ONE URGENCY CLASS, A JOB ALREADY REVIEWED WAITS BEHIND ONE THAT
   * HAS NOT.
   *
   * Nothing the re-queue touches is otherwise in the sort key, so without
   * this the re-queued job is head-of-queue again on the very next tick
   * and burns a full LLM review every time. Sorting it behind its PEERS is
   * what turns a spin into a retry, and doing it here rather than above
   * means it can no longer reorder the classes themselves.
   */
  const tried = Number(Boolean(a?.last_review)) - Number(Boolean(b?.last_review));
  if (tried !== 0) return tried;

  /*
   * AND A JOB ALREADY PREPARED WAITS BEHIND ONE THAT IS NOT.
   *
   * Blind audit H-1. The daemon's prepare-only path gives the claim back
   * without recording a review -- correctly, since none happened -- so
   * none of the keys above changed and the row returned to head-of-queue.
   * A supervised prepare run therefore re-prepared ONE job every tick,
   * leaking a worktree and a brief each time, while reporting progress.
   *
   * Demoting on `prepared_at` makes that loop WALK the queue: each job is
   * prepared once, then sorts behind the ones that are not. It is
   * deliberately below `last_review`, because a failed review is stronger
   * evidence of trouble than a pending preparation.
   *
   * ═══ AND ONLY WHEN THE CALLER IS PREPARING ═══
   *
   * Blind audit M-5, second half, and it was backwards. `byUrgency` serves
   * BOTH modes, so a `--launch` run was demoting exactly the jobs whose
   * worktree and brief already exist on disk -- the daemon avoiding the
   * work it had already paid to set up, and leaving those worktrees to
   * accumulate while it prepared more.
   *
   * The demotion answers "do not prepare this twice". It says nothing
   * about reviewing, so a reviewing caller passes false and the key is
   * skipped. The flag is the caller's knowledge, not this function's
   * guess.
   */
  const prepped = demotePrepared
    ? Number(Boolean(a?.prepared_at)) - Number(Boolean(b?.prepared_at))
    : 0;
  if (prepped !== 0) return prepped;
  const at = sortKey(a?.first_seen_at);
  const bt = sortKey(b?.first_seen_at);
  if (at !== bt) return at < bt ? -1 : 1;
  return sortKey(a?.audit_id) < sortKey(b?.audit_id) ? -1 : 1;
}

/*
 * A SORT KEY THAT CANNOT THROW OR WALK. T-356 / B-28.
 *
 * This was `String(x ?? '')`, and a store row can make that throw or stall
 * out of proposeAudit, on the ordering step before any reason is built:
 * JSON.parse gives `first_seen_at` as an array nested 1e4 deep (String()
 * joins recursively: RangeError, call stack), as `{"toString":"x"}` (a
 * non-callable toString: TypeError, cannot convert object to primitive), or
 * as 1e8 short arrays (String() joins them all: 3.6 s). A string, number or
 * boolean keeps its old key exactly; null/absent keeps ''; anything else keys
 * as U+FFFF, AFTER every real timestamp -- where '[object Object]' already
 * sorted -- so a corrupt row never jumps the queue, and audit_id breaks ties.
 */
const UNREADABLE_KEY = String.fromCharCode(0xffff);
function sortKey(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return v == null ? '' : UNREADABLE_KEY;
}

/**
 * What the dispatcher would propose, given the queue and the roster as they
 * are now.
 *
 * @param {object[]} jobs      audit queue rows (mergeQueue output)
 * @param {object[]} sessions  roster rows, the same shape proposeWork takes
 * @param {number}   now       epoch ms. NUMERIC, because lease arithmetic is
 *                             done here and in claimJob; proposeWork takes an
 *                             ISO string and the mismatch is deliberate rather
 *                             than an oversight -- see the throw below.
 * @param {function} isLive    injected from liveRegistry
 * @returns {{proposals: object[], unassigned: object[], seats: object[]}}
 */
export function proposeAudit({
  jobs = [], sessions = [], now, isLive, leaseMs = CLAIM_LEASE_MS,
  /*
   * Does this caller PREPARE workspaces rather than review them? Only it
   * knows, and the answer changes the ordering -- see byUrgency's
   * `prepared_at` block. Defaults true because the daemon's default mode
   * is prepare-only, so the safe default is the one that stops it
   * preparing the same job twice.
   */
  demotePrepared = true,
} = {}) {
  /*
   * A STRING `now` WOULD SILENTLY POISON EVERY LEASE COMPARISON. `'2026-..' -
   * 1000` is NaN, every `> leaseMs` is false, and nothing would ever look
   * expired -- the permanent-tombstone failure again, arriving as a type
   * confusion instead of a logic bug. Refuse it where it can still be seen.
   */
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new TypeError('proposeAudit requires `now` as epoch milliseconds: lease '
      + 'arithmetic on a string silently yields NaN and nothing ever expires');
  }
  if (typeof isLive !== 'function') {
    throw new TypeError('proposeAudit requires an isLive predicate: liveness belongs to '
      + 'liveRegistry, and a dispatcher deciding it for itself is a second answer to a '
      + 'question that already has one');
  }

  const live = arr(sessions).filter((s) => s && isLive(s) && s.capacity !== 'offline');

  /*
   * A SEAT ALREADY HOLDING A LIVE CLAIM IS BUSY. Derived from the queue rather
   * than from anything the seat reports about itself: a reviewer that says it
   * is idle while holding a claim would otherwise be handed a second audit and
   * abandon the first.
   */
  const busy = new Set(
    arr(jobs)
      .filter((j) => str(j?.state) === JOB.CLAIMED && !isClaimable(j, { now, leaseMs }))
      .map((j) => str(j?.claimed_by))
      .filter(Boolean),
  );

  /*
   * A ROW WITH A TEXT FIELD PAST THE BOUND IS REFUSED WHOLE AND NAMED. It is
   * not claimable and not dispatched, and it does not vanish: the operator
   * sees a corrupt row where they would otherwise see nothing. Its audit_id
   * is shown when that field itself could be read, else null.
   *
   * ═══ AND A LIVE CLAIM WHOSE HOLDER CANNOT BE READ BLOCKS EVERY SEAT. T-356 r3 / V2-F1 ═══
   *
   * Round 2 let such a row mark NO seat busy ("the holder is unknown") and
   * the blind verifier showed what that means: a CLAIMED row still inside
   * its lease, its claimed_by padded past the bound, and the second job was
   * PROPOSED to the very seat that holds the first. Base and round 1 read the
   * padding whole and kept that seat busy; round 2 had laundered the busy
   * exclusion the way it refused to launder the author exclusion. The
   * Controller's decision covers both: unknown fails CLOSED. So a row whose
   * clock says the claim is live (claimed_at within the lease) and whose
   * state or claimed_by cannot be read marks EVERY seat busy -- the holder
   * is one of them and nothing here can say which -- until the row is
   * repaired, and both the row's own entry and ALL_SEATS_BUSY say so. A row
   * whose clock says the claim is expired, or that carries no claimed_at,
   * is not a live claim under any reading of its padding and blocks nothing.
   */
  const liveByClock = (j) => typeof j.claimed_at === 'number' && Number.isFinite(j.claimed_at) && (now - j.claimed_at) <= leaseMs;
  const unreadable = [];
  const unknownHolders = [];
  const claimable = arr(jobs)
    .filter((j) => {
      if (!j) return false;
      const fields = unreadableFields(j, ROW_TEXT_FIELDS);
      if (fields.length === 0) return str(j.audit_id) && isClaimable(j, { now, leaseMs });
      const holderUnknown = (fields.includes('claimed_by') || fields.includes('state')) && liveByClock(j);
      const id = fields.includes('audit_id') ? null : str(j.audit_id);
      if (holderUnknown) unknownHolders.push(id);
      unreadable.push({
        audit_id: id,
        code: UNPLACED.ROW_UNREADABLE,
        why: `${unreadableWhy(fields)}The row is refused whole, not dispatched, and stays in the queue until it is `
          + 'repaired; a field this refuses could otherwise decide the author exclusion or a lease'
          + (holderUnknown ? '. Its clock says the claim is LIVE and its holder cannot be read, so every seat is treated as '
            + 'busy until it is repaired: the holder is one of them' : ''),
      });
      return false;
    })
    .sort((a, b) => byUrgency(a, b, demotePrepared));

  /*
   * A SEAT WHOSE ID CANNOT BE READ IS NOT FREE, AND SAYS SO. T-356 r2. Its
   * ids are null (str refused them), so the author exclusion below could not
   * tell it from a stranger -- and the padded id might BE the author's. It
   * is kept in `seats`, marked busy and `unreadable`, never offered work --
   * kept even when BOTH ids are unreadable, so a roster of one such seat
   * reads as a seat that cannot be used, not as no seat at all (V2-F2).
   */
  const seats = live
    .map((s) => {
      const unreadable = unreadableFields(s, SEAT_TEXT_FIELDS);
      const seat = {
        session_id: str(s.session_id),
        agent_id: str(s.agent_id),
        busy: unreadable.length > 0 || unknownHolders.length > 0 || busy.has(str(s.session_id)) || busy.has(str(s.agent_id)),
      };
      return unreadable.length > 0 ? { ...seat, unreadable } : seat;
    })
    .filter((s) => s.session_id || s.agent_id || s.unreadable);
  const unreadableSeats = seats.filter((s) => s.unreadable).length;

  const proposals = [];
  const unassigned = [];
  const assigned = new Set();

  for (const job of claimable) {
    const author = str(job.author_session);
    const free = seats.filter((s) => !s.busy && !assigned.has(s.session_id ?? s.agent_id));

    if (free.length === 0) {
      unassigned.push({
        audit_id: str(job.audit_id),
        code: seats.length === 0 ? UNPLACED.NO_LIVE_SEAT : UNPLACED.ALL_SEATS_BUSY,
        why: seats.length === 0
          ? 'no reviewer seat is live. The job stays PENDING -- this is a queue waiting, not a failure'
          : `every live seat already holds an unexpired claim${unreadableSeats > 0
            ? ` or has an id that could not be read (${unreadableSeats} seat(s) with more than ${TRIM_SCAN} whitespace `
              + 'characters around an id are not offered work, T-356)'
            : ''}${unknownHolders.length > 0
            ? `, or a live claim's holder could not be read (${unknownHolders.length} row(s): every seat is treated as busy `
              + 'until the row is repaired, because the holder is one of them, T-356 r3)'
            : ''}`,
      });
      continue;
    }

    /*
     * THE AUTHOR EXCLUSION IS APPLIED HERE TOO, AND THAT IS NOT REDUNDANT
     * DESPITE claimJob ENFORCING IT.
     *
     * Rule 11: a protection that is currently redundant stops being tested and
     * then stops being a protection. If selection ignored authorship, the
     * dispatcher would propose an illegal pairing, `claimJob` would refuse it,
     * and the job would look UNDISPATCHABLE rather than "needs a different
     * seat" -- a live seat sitting idle beside a job it could legally take.
     * The refusal is the same; the OUTCOME is completely different.
     */
    /*
     * ═══ "NOBODY COULD LOOK" IS NOT "THERE IS NO AUTHOR" ═══
     *
     * Fifth-lap blind audit D5. `if (!author) return true` made EVERY seat
     * eligible -- the author's own included -- whenever the author was
     * unknown. Two commits claimed to have closed that fail-open and neither
     * touched this line: `claimJob` compares the SESSION, which is still
     * null, and this function never reads `author_source` at all. So a
     * transient git failure still handed a candidate to whoever wrote it.
     *
     * The distinction the rest of the module spent three commits building
     * arrives here: `author_source === 'unavailable'` means nobody
     * established who the author is. Rule 20 cannot be enforced against an
     * author you cannot name, so placing the job anyway and recording the
     * result as an independent review is exactly the laundering rule 20
     * exists to prevent.
     *
     * FAIL CLOSED, and accept the cost. The job stays PENDING with a reason,
     * and it is picked up on the next tick once the lookup succeeds. If the
     * lookup NEVER succeeds nothing dispatches -- which is the honest
     * outcome, loud in `unassigned`, rather than a queue of reviews nobody
     * can trust. A measured absence (`null`: git answered, this commit has
     * no trailer) is different and still dispatches: there is no author to
     * collide with.
     */
    /*
     * EXHAUSTED IS NOT DISPATCHABLE. The bound is what makes the retry a
     * retry rather than a spin -- see MAX_REVIEW_ATTEMPTS. The job stays in
     * the queue and says why, so an operator can see a candidate that keeps
     * producing unattributable reviews instead of watching the daemon
     * silently burn passes on it.
     */
    /*
     * A COUNTER THAT CANNOT BE READ IS EXHAUSTED, NOT ZERO.
     *
     * This was `Number.isFinite(tries) && tries >= MAX`, so a NaN -- from a
     * null, a string, an object, or the daemon's own `Number(x) + 1` over a
     * corrupt value -- failed the finite test and fell through to DISPATCH.
     * The one shape that means "this counter is broken" was the one shape
     * that bypassed the bound, which is the fail-open direction and exactly
     * the presence-guard habit this repository keeps catching.
     *
     * Unreadable now fails CLOSED: the job is refused and the message says
     * the counter is the reason, so an operator sees a corrupt row instead
     * of a candidate quietly being reviewed for ever. Refusing one job is
     * recoverable; an unbounded spin is the defect the bound exists for.
     */
    /*
     * STRICT, because the loose spellings are the dangerous ones.
     * `Number('')` is 0 and `Number(' ')` is 0, so an empty or blank value
     * -- exactly what a truncated write leaves behind -- would read as a
     * fresh counter and dispatch for ever. A negative is not a count
     * either. Absent (undefined) IS legitimately zero: that is what a row
     * written before this field existed looks like -- JSON has no key for
     * it -- and refusing those would stall every historical job.
     *
     * NULL IS NOT ABSENT. T-298 / B-20. `JSON.stringify(NaN)` is "null", so
     * a null is exactly what the old NaN corruption left behind, and the
     * WRITER (`nextAttempt` in daemonArgs) already reads null as unreadable
     * and returns the bound. This reader read it as 0 and dispatched: the
     * two ends disagreed on the one value that means "this counter broke"
     * (T-293 F1). Null now takes the unreadable path below -- exhausted,
     * matching nextAttempt(null) === max.
     */
    const raw = job.review_attempts;
    let tries;
    if (raw === undefined) tries = 0;
    else if (typeof raw === 'number') tries = Number.isInteger(raw) && raw >= 0 ? raw : NaN;
    else if (typeof raw === 'string') {
      /* The same bounded scan as str(): a count padded past TRIM_SCAN, or longer than COUNT_TEXT_MAX, is
       * unreadable before the regex or Number() read a character of it (T-356 r2, operation O2). */
      const t = boundedTrim(raw);
      tries = t !== TRIM_OVER && t.length <= COUNT_TEXT_MAX && /^\d+$/.test(t) ? Number(t) : NaN;
    } else tries = NaN;
    const unreadable = !Number.isFinite(tries);
    if (unreadable || tries >= MAX_REVIEW_ATTEMPTS) {
      /*
       * 2n IS UNREADABLE HERE AND AT THE BOUND IN nextAttempt, and both ends
       * now say so without throwing (T-316 / B-28): a BigInt is not
       * `typeof 'number'`, so it takes the unreadable branch -- exhausted --
       * exactly as nextAttempt(2n) returns the bound.
       */
      unassigned.push({
        audit_id: str(job.audit_id),
        code: UNPLACED.REVIEW_EXHAUSTED,
        why: unreadable
          ? `review_attempts is ${describeValue(raw, STORE_VALUE)}, which is not a count. Refusing to `
            + 'dispatch: an unreadable counter cannot bound anything, and treating it as zero '
            + 'is how one corrupt row gets reviewed for ever'
          : `reviewed ${tries} times without the result being attributable `
            + `(last: ${lastReviewCause(job)}). Not re-dispatching: `
            + 'a candidate that cannot be pinned will not become pinnable by being reviewed again',
      });
      continue;
    }

    if (str(job.author_source) === AUTHOR_UNAVAILABLE) {
      unassigned.push({
        audit_id: str(job.audit_id),
        code: UNPLACED.AUTHOR_UNKNOWN,
        why: 'the author of this candidate could not be established, so rule 20 cannot be '
          + 'enforced against it. Dispatching anyway would risk handing the candidate to '
          + 'whoever wrote it and calling the result independent',
      });
      continue;
    }

    const eligible = free.filter((s) => {
      if (!author) return true;
      return s.session_id !== author && s.agent_id !== author;
    });

    if (eligible.length === 0) {
      unassigned.push({
        audit_id: str(job.audit_id),
        code: UNPLACED.ONLY_AUTHOR_AVAILABLE,
        why: `the only free seat authored this candidate (${capText(author)}). Rule 20: the party `
          + 'that wrote a fix cannot clear it, so this waits for a different reviewer',
      });
      continue;
    }

    const seat = eligible[0];
    const key = seat.session_id ?? seat.agent_id;
    assigned.add(key);
    proposals.push({
      audit_id: str(job.audit_id),
      candidate_sha: str(job.candidate_sha),
      session_id: seat.session_id,
      agent_id: seat.agent_id,
      /*
       * WHY IT WAS OFFERED, carried on the proposal. A recovered job and a
       * fresh one are handled identically from here on, and a reader
       * reconstructing "why did this get picked up an hour later" should not
       * have to diff two timestamps to find out.
       */
      recovered: str(job.state) === JOB.CLAIMED,
      previous_holder: str(job.state) === JOB.CLAIMED ? str(job.claimed_by) : null,
      escaped: Boolean(job.escaped),
    });
  }

  /* The refused rows come LAST: a well-formed queue's first reason is still the first claimable job's. */
  for (const u of unreadable) unassigned.push(u);

  return { proposals, unassigned, seats };
}
