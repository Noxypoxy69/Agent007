import { leaseState } from './leases.mjs';

/**
 * AUTONOMOUS RUNTIME v1 — the Postgres-authority half.
 *
 * THE CONSTRAINT THAT SHAPES ALL OF THIS: "execution must not depend on
 * persistent chat sessions." Every rule below therefore has to be derivable
 * from rows alone. Nothing may depend on an agent remembering what it was
 * doing, because the agent will be killed -- that is not a hypothetical here,
 * it happened three times on 2026-09-15 -- and the work has to survive the
 * process that was doing it.
 *
 * So these are pure functions over rows and a clock. Where a decision cannot be
 * made from rows, it is REFUSED rather than guessed, and the refusal names what
 * was missing. A runtime that guesses when it lacks state is a runtime that
 * invents work.
 *
 * WHAT LIVES HERE AND WHAT DOES NOT. src/leases.mjs owns the claim itself --
 * whether this worker may hold this task right now. This module owns everything
 * that happens AROUND a claim and cannot be decided by looking at one row:
 * collisions between tasks, bases that have moved, dependencies that were
 * un-accepted after the fact, who reviews returned work, when a retry becomes
 * an escalation, and how the outbox gets drained exactly once in effect.
 */

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const arr = (v) => (Array.isArray(v) ? v : []);
const ms = (v) => {
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

/** After this many attempts, stop retrying and ask a person. */
export const RETRY_LIMIT = 3;

/** How long a reviewer holds returned work before it goes back to the queue. */
export const REVIEW_LEASE_MS = 30 * 60 * 1000;

/** States from which a task can still be invalidated. Terminal work cannot. */
export const INVALIDATABLE = ['runnable', 'assigned', 'returned', 'blocked'];

/**
 * PATH COLLISIONS BETWEEN TASKS THAT ARE BOTH LIVE.
 *
 * Two tasks whose allowed_paths overlap must not be held at once: two workers
 * editing the same file in separate worktrees produce a merge nobody planned
 * and a diff neither can explain. This is the same rule canAssign enforces for
 * a coordinator's assignment, applied where the autonomous path needs it.
 *
 * SHARED PATHS ARE THE EXCEPTION AND BOTH SIDES MUST AGREE. A path is only
 * shareable if BOTH tasks declare it shared. One task unilaterally declaring a
 * file shared would let it walk into somebody else's exclusive contract, which
 * is precisely the collision this prevents.
 *
 * ONLY LIVE HOLDERS COUNT. A task whose lease expired is not editing anything;
 * blocking on it would leave the pool permanently poisoned by dead work.
 */
export function pathCollisions(task, tasks, { now } = {}) {
  if (ms(now) === null) throw new TypeError('pathCollisions requires a `now` timestamp');
  if (!task || !nonEmpty(task.task_id)) return [];

  const mineShared = new Set(arr(task.shared_paths));
  const mine = arr(task.allowed_paths);
  const out = [];

  for (const other of arr(tasks)) {
    if (!other || other.task_id === task.task_id) continue;
    if (other.state !== 'assigned') continue;
    if (leaseState(other, { now }) !== 'live') continue;

    const theirShared = new Set(arr(other.shared_paths));
    for (const p of mine) {
      if (!arr(other.allowed_paths).includes(p)) continue;
      // Shared by BOTH, or it is a collision.
      if (mineShared.has(p) && theirShared.has(p)) continue;
      out.push({ path: p, held_by_task: other.task_id, held_by_session: other.assigned_session ?? null });
    }
  }
  return out;
}

/**
 * IS THE TASK'S BASE STILL THE TIP IT WAS CUT FROM?
 *
 * Work handed out from a commit the tree has moved past produces a diff against
 * history. The worker is not wrong and neither is the reviewer; they are simply
 * looking at different trees.
 *
 * UNKNOWN IS NOT STALE. If either sha is missing, this answers 'unknown' and
 * the caller must decide -- it does NOT quietly return false. A surface with no
 * worktree cannot observe the tip, and reporting "fresh" from ignorance is the
 * exact shape of confident answer from nothing that this project keeps
 * rediscovering.
 */
export function baseFreshness(task, { tip } = {}) {
  if (!task || !nonEmpty(task.base_sha)) return { state: 'unknown', reason: 'the task carries no base sha' };
  if (!nonEmpty(tip)) return { state: 'unknown', reason: 'the integration tip was not observed' };
  if (task.base_sha === tip) return { state: 'fresh', reason: null };
  return {
    state: 'stale',
    reason: `base ${task.base_sha.slice(0, 12)} is behind the tip ${tip.slice(0, 12)}; re-base before claiming`,
  };
}

/**
 * UPSTREAM INVALIDATION.
 *
 * A task was claimed because its dependency was ACCEPTED. If that dependency
 * later leaves the accepted state -- cancelled, or re-opened because the review
 * was wrong -- then the premise the downstream work rests on is gone. The
 * downstream worker is now building on something that has been withdrawn and
 * does not know it.
 *
 * THIS IS THE CASE A HUMAN CATCHES AND A RUNTIME MISSES. Nothing else in the
 * system looks backwards: every other guard asks "may this proceed now", and
 * this one asks "did something I already allowed stop being true".
 *
 * ACCEPTED WORK IS NEVER INVALIDATED. It is finished, it was signed off, and
 * withdrawing it would rewrite a completed contract rather than stop an
 * outstanding one. If accepted work truly rests on a withdrawn premise, that is
 * a new task, not a retraction.
 */
export function invalidatedBy(changed, tasks, { now } = {}) {
  if (ms(now) === null) throw new TypeError('invalidatedBy requires a `now` timestamp');
  if (!changed || !nonEmpty(changed.task_id)) return [];
  // Only a dependency LEAVING accepted invalidates anything.
  if (changed.state === 'accepted') return [];

  const out = [];
  for (const t of arr(tasks)) {
    if (!t || t.task_id === changed.task_id) continue;
    if (!arr(t.depends_on).includes(changed.task_id)) continue;
    if (!INVALIDATABLE.includes(t.state)) continue;

    out.push({
      task_id: t.task_id,
      reason: `depends on "${changed.task_id}", which is now "${changed.state}" and no longer accepted`,
      was_state: t.state,
      // Naming the holder matters: somebody may be working on this RIGHT NOW
      // and has to be told, not merely have the row changed underneath them.
      holder_session: t.state === 'assigned' && leaseState(t, { now }) === 'live'
        ? (t.assigned_session ?? null)
        : null,
    });
  }
  return out;
}

/**
 * THE REVIEWER QUEUE.
 *
 * Returned work is not finished; it is waiting for somebody who did not write
 * it. A review is therefore ALSO a lease -- if it were not, a reviewer that
 * died would take the work out of circulation silently, which is the same
 * failure as a worker dying and is the reason reviewer death is on the list of
 * things this runtime must survive.
 *
 * SEPARATE LEASE FIELDS ON PURPOSE. review_lease_token is not the worker's
 * lease_token: the worker's lease is consumed by the return, and reusing the
 * field would make "who holds this" ambiguous at exactly the handover point.
 *
 * THE AUTHOR IS NOT AN ELIGIBLE REVIEWER, and that is enforced here rather than
 * trusted: accept_task already refuses unreturned work, but nothing stopped the
 * returning session from reviewing its own return.
 */
export function reviewerQueue(tasks, { now } = {}) {
  if (ms(now) === null) throw new TypeError('reviewerQueue requires a `now` timestamp');

  return arr(tasks)
    .filter((t) => t && t.state === 'returned')
    .map((t) => {
      const held = nonEmpty(t.review_lease_token)
        && ms(t.review_lease_expires_at) !== null
        && ms(t.review_lease_expires_at) > ms(now);
      return {
        task_id: t.task_id,
        returned_by: t.returned_by ?? null,
        head_sha: t.returned_head_sha ?? null,
        notes: t.returned_notes ?? null,
        reviewer: held ? (t.reviewer ?? null) : null,
        // waiting = nobody is looking at it. A reviewer whose lease expired
        // counts as waiting, which is what makes reviewer death recoverable.
        waiting: !held,
        review_expires_at: held ? t.review_lease_expires_at : null,
      };
    })
    .sort((a, b) => Number(b.waiting) - Number(a.waiting));
}

/** May this session review this task? */
export function canReview(task, reviewer, { now } = {}) {
  const errors = [];
  if (ms(now) === null) return { ok: false, errors: ['a timestamp is required'] };
  if (!task || !nonEmpty(task.task_id)) return { ok: false, errors: ['no such task'] };
  if (!reviewer || !nonEmpty(reviewer.session_id)) {
    return { ok: false, errors: ['no resolved reviewer: a review must come from a registered session'] };
  }

  if (task.state !== 'returned') {
    errors.push(`task is "${task.state}"; only returned work is reviewable`);
  }

  /*
   * NOBODY REVIEWS THEIR OWN RETURN. The whole value of a returned state is
   * that somebody else put it there and somebody else signs it off; one party
   * on both sides of that is not a review, it is a formality.
   */
  if (nonEmpty(task.returned_by) && task.returned_by === reviewer.session_id) {
    errors.push('the session that returned this work cannot review it');
  }

  const held = nonEmpty(task.review_lease_token)
    && ms(task.review_lease_expires_at) !== null
    && ms(task.review_lease_expires_at) > ms(now);
  if (held && task.reviewer !== reviewer.session_id) {
    errors.push(`already under review by ${task.reviewer} until ${task.review_lease_expires_at}`);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * RETRY, OR STOP AND ASK.
 *
 * A lease that expires puts work back in the pool, which is right once and
 * wrong forever: a task that kills every worker that touches it would cycle
 * indefinitely, burning workers and looking busy. After RETRY_LIMIT the runtime
 * stops retrying and escalates.
 *
 * ESCALATION IS AN OUTCOME, NOT A FAILURE TO DECIDE. The row stops moving and
 * somebody is told why -- which is strictly better than a queue that is always
 * making progress on the same task.
 */
export function retryDecision(task, { limit = RETRY_LIMIT } = {}) {
  if (!task || !nonEmpty(task.task_id)) return { action: 'none', reason: 'no such task' };
  const attempt = Number.isFinite(task.attempt) ? task.attempt : 0;

  if (attempt >= limit) {
    return {
      action: 'escalate',
      reason: `attempted ${attempt} times without a return; a fourth worker is unlikely to fare better`,
      attempt,
    };
  }
  return { action: 'requeue', reason: `attempt ${attempt} of ${limit}`, attempt };
}

/**
 * DRAIN THE OUTBOX.
 *
 * The outbox commits with the write it describes, so nothing is lost and
 * duplicates are guaranteed. This turns that stream into decisions, by
 * re-reading each event's task and asking whether the event still describes the
 * world -- which is shouldActOnEvent, imported by the caller rather than
 * re-derived here.
 *
 * EVERY EVENT IS MARKED DELIVERED, INCLUDING THE ONES NOT ACTED ON. A superseded
 * event that stays unmarked is re-read forever, and an outbox that only grows
 * is a queue that eventually stops draining. Not-acted-on is a CONCLUSION, so
 * it is recorded as one.
 *
 * IN EVENT_ID ORDER. Events about one task must be applied in the order they
 * were written, or a 'returned' can be processed before the 'assigned' that
 * preceded it and the runtime will draw the wrong conclusion from a correct
 * log.
 */
export function drainOutbox(events, tasksById, { now, decide } = {}) {
  if (ms(now) === null) throw new TypeError('drainOutbox requires a `now` timestamp');
  if (typeof decide !== 'function') {
    // The at-least-once rule is injected, never re-implemented: two copies of
    // it would eventually disagree, and the disagreement would be silent.
    throw new TypeError('drainOutbox requires a `decide` predicate (shouldActOnEvent)');
  }

  const byId = tasksById instanceof Map
    ? tasksById
    : new Map(arr(tasksById).map((t) => [t?.task_id, t]));

  const act = [];
  const skip = [];

  const ordered = arr(events)
    .filter((e) => e && Number.isFinite(Number(e.event_id)))
    .sort((a, b) => Number(a.event_id) - Number(b.event_id));

  for (const e of ordered) {
    const task = byId.get(e.task_id) ?? null;
    const verdict = decide(e, task, { now });
    (verdict.act ? act : skip).push({ event_id: e.event_id, kind: e.kind, task_id: e.task_id, reason: verdict.reason });
  }

  return {
    act,
    skip,
    // Both lists are marked. Anything else lets the outbox grow without bound.
    mark_delivered: [...act, ...skip].map((x) => x.event_id).sort((a, b) => Number(a) - Number(b)),
  };
}
