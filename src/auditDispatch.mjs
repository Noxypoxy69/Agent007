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

const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const arr = (v) => (Array.isArray(v) ? v : []);

/** Reasons a job could not be placed. Codes, so a caller can branch. */
export const UNPLACED = Object.freeze({
  NO_LIVE_SEAT: 'no_live_seat',
  ONLY_AUTHOR_AVAILABLE: 'only_author_available',
  ALL_SEATS_BUSY: 'all_seats_busy',
  AUTHOR_UNKNOWN: 'author_unknown',
  REVIEW_EXHAUSTED: 'review_exhausted',
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
function byUrgency(a, b) {
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
   */
  const prepped = Number(Boolean(a?.prepared_at)) - Number(Boolean(b?.prepared_at));
  if (prepped !== 0) return prepped;
  const at = String(a?.first_seen_at ?? '');
  const bt = String(b?.first_seen_at ?? '');
  if (at !== bt) return at < bt ? -1 : 1;
  return String(a?.audit_id ?? '') < String(b?.audit_id ?? '') ? -1 : 1;
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

  const seats = live
    .map((s) => ({
      session_id: str(s.session_id),
      agent_id: str(s.agent_id),
      busy: busy.has(str(s.session_id)) || busy.has(str(s.agent_id)),
    }))
    .filter((s) => s.session_id || s.agent_id);

  const claimable = arr(jobs)
    .filter((j) => j && str(j.audit_id) && isClaimable(j, { now, leaseMs }))
    .sort(byUrgency);

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
          : 'every live seat already holds an unexpired claim',
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
     * either. Absent (null/undefined) IS legitimately zero: that is what
     * a row written before this field existed looks like, and refusing
     * those would stall every historical job.
     */
    const raw = job.review_attempts;
    let tries;
    if (raw === null || raw === undefined) tries = 0;
    else if (typeof raw === 'number') tries = Number.isInteger(raw) && raw >= 0 ? raw : NaN;
    else if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) tries = Number(raw.trim());
    else tries = NaN;
    const unreadable = !Number.isFinite(tries);
    if (unreadable || tries >= MAX_REVIEW_ATTEMPTS) {
      unassigned.push({
        audit_id: str(job.audit_id),
        code: UNPLACED.REVIEW_EXHAUSTED,
        why: unreadable
          ? `review_attempts is ${JSON.stringify(raw)}, which is not a count. Refusing to `
            + 'dispatch: an unreadable counter cannot bound anything, and treating it as zero '
            + 'is how one corrupt row gets reviewed for ever'
          : `reviewed ${tries} times without the result being attributable `
            + `(last: ${job.last_review?.not_recorded_because ?? 'unknown'}). Not re-dispatching: `
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
        why: `the only free seat authored this candidate (${author}). Rule 20: the party `
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

  return { proposals, unassigned, seats };
}
