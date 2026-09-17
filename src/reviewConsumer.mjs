/*
 * WHICH RETURNED TASK SHOULD THIS SESSION REVIEW, AS A PURE FUNCTION.
 *
 * THE GAP THIS FILLS, measured rather than assumed. The database already holds
 * claim_review, renew_review_lease, submit_review, the self-review refusal, the
 * review fence and fix-task creation. `bin/agentbridge-review.mjs` already
 * drives a review end to end. What was missing is the step in front of both:
 * nothing DISCOVERS reviewable work. The reviewer CLI takes `--task <file.json>`
 * and `--envelope <file.json>`, so somebody has to already know what to review.
 * Nobody did, so between 01:13 and 03:20 on 2026-09-17 the dispatcher prepared
 * 740 review proposals for one task and every single one superseded unread.
 *
 * IT SELECTS FROM TASKS, NOT FROM PROPOSALS, AND THAT IS DELIBERATE.
 * A proposal is a derived artifact that the dispatcher rewrites every minute --
 * 740 rows for one piece of work, which is history, not a queue. The task row is
 * the authority for whether work is reviewable: `claim_review` reads `tasks` and
 * nothing else, so a consumer that selected from proposals could hand the lease
 * call a task it will refuse. Proposals are carried here only for ATTRIBUTION,
 * because "the churn stopped" has to be answerable with WHICH proposal was
 * consumed rather than with a rate that fell.
 *
 * WHY ATTRIBUTION IS PART OF THE CONTRACT AND NOT A NICETY. The done-means for
 * this work says the supersede rate must go to zero because a proposal was
 * CONSUMED and not because something SUPPRESSED it, and that those two are
 * indistinguishable in a row count. On 2026-09-17 a third cause appeared that
 * neither reading predicted: the rate went to zero because the task was accepted
 * outright at 03:20:37 with `reviewer` null, so the dispatcher stopped proposing.
 * A falling rate meant "nothing left to review", which looks exactly like
 * success. So this returns the proposal id it acted on, and the caller records
 * it; a number that fell is not evidence and a specific row that closed is.
 *
 * THE REFUSALS ARE SEPARATE VALUES BECAUSE THEY MEAN DIFFERENT THINGS.
 * "There was no returned work" and "there was returned work and all of it was
 * mine" are the same empty result and completely different situations -- the
 * second means this session is the only one running and the loop cannot make
 * progress no matter how long it waits. Collapsing them into one falsy answer is
 * how a stuck consumer reads as an idle one.
 */

/** Why nothing was selected. Every value is actionable and none is "false". */
export const NO_WORK = Object.freeze({
  /** No task is in `returned` at all. The honest idle case. */
  NONE_RETURNED: 'none-returned',
  /** Returned work exists and every piece was returned BY this session. */
  ALL_SELF: 'all-self',
  /** Returned work exists and every piece is under a live lease held elsewhere. */
  ALL_UNDER_REVIEW: 'all-under-review',
  /** Returned work exists but none of it names a commit a reviewer could read. */
  ALL_UNREADABLE: 'all-unreadable',
});

/**
 * Pick one returned task this session may review.
 *
 * `tasks`    rows as `claim_review` sees them: task_id, state, returned_by,
 *            returned_head_sha, reviewer, review_lease_expires_at, returned_at.
 * `proposals` optional open review proposals, used ONLY to attribute the work to
 *            a proposal id. A missing proposal never blocks a review -- the task
 *            is the authority, and refusing to review real returned work because
 *            a derived row is absent would be the queue driving the ledger.
 * `reviewerSession` this session's id, compared to returned_by exactly as
 *            `claim_review` compares it, so the answer here and the answer the
 *            database gives cannot disagree.
 *
 * Returns `{ ok: true, taskId, proposalId, task, reason }` or
 * `{ ok: false, reason, counts }`.
 */
export function selectReviewable({
  tasks = [],
  proposals = [],
  reviewerSession,
  now = Date.now(),
} = {}) {
  if (typeof reviewerSession !== 'string' || reviewerSession.trim() === '') {
    throw new Error('selectReviewable: a reviewer session id is required; '
      + 'claim_review refuses an empty one and deciding that here rather than '
      + 'discovering it at the far end is the whole point of this module');
  }
  const me = reviewerSession.trim();
  const nowMs = typeof now === 'number' ? now : Date.parse(now);

  const returned = tasks.filter((t) => t?.state === 'returned');
  if (returned.length === 0) {
    return refuse(NO_WORK.NONE_RETURNED, { returned: 0, self: 0, underReview: 0, unreadable: 0 });
  }

  const counts = { returned: returned.length, self: 0, underReview: 0, unreadable: 0 };
  const eligible = [];

  for (const t of returned) {
    /*
     * SELF-REVIEW, decided with the same comparison the SQL makes. claim_review
     * compares returned_by to the reviewer session, so this compares the same
     * two fields. A consumer that used agent_id here would pass its own check
     * and be refused by the database, which is a loop that spins.
     */
    if (t.returned_by != null && t.returned_by === me) { counts.self += 1; continue; }

    /*
     * A LIVE lease held by somebody else blocks; an EXPIRED one does not. Again
     * the SQL's rule, not a stricter one -- treating any non-null reviewer as a
     * blocker would strand work whose reviewer died, which is exactly what the
     * lease expiry exists to recover.
     */
    const heldByOther = t.reviewer != null && t.reviewer !== me;
    const expiresMs = t.review_lease_expires_at ? Date.parse(t.review_lease_expires_at) : null;
    const leaseLive = expiresMs !== null && Number.isFinite(expiresMs) && expiresMs > nowMs;
    if (heldByOther && leaseLive) { counts.underReview += 1; continue; }

    /*
     * A RETURN THAT NAMES NO COMMIT CANNOT BE REVIEWED, and that is a selection
     * question rather than something to discover after spending a lease. This
     * checks only that a full sha is NAMED; whether it is REACHABLE is
     * headReachability's job and needs git, which a pure function does not have.
     */
    if (typeof t.returned_head_sha !== 'string' || !/^[0-9a-f]{40}$/.test(t.returned_head_sha)) {
      counts.unreadable += 1; continue;
    }

    eligible.push(t);
  }

  if (eligible.length === 0) {
    /*
     * WHICH empty this is decides what the caller does next. Ordered by what the
     * operator can act on: all-self means nobody else is running and waiting
     * will not help; all-under-review resolves itself when a lease expires.
     */
    if (counts.self === counts.returned) return refuse(NO_WORK.ALL_SELF, counts);
    if (counts.underReview === counts.returned) return refuse(NO_WORK.ALL_UNDER_REVIEW, counts);
    if (counts.unreadable === counts.returned) return refuse(NO_WORK.ALL_UNREADABLE, counts);
    /* A mixture. Name the largest cause rather than inventing a fifth value. */
    const worst = [['self', NO_WORK.ALL_SELF], ['underReview', NO_WORK.ALL_UNDER_REVIEW],
      ['unreadable', NO_WORK.ALL_UNREADABLE]]
      .sort((a, b) => counts[b[0]] - counts[a[0]])[0];
    return refuse(worst[1], counts);
  }

  /*
   * OLDEST RETURN FIRST. The work that has waited longest goes first, which is
   * the only ordering that cannot starve a task: picking the newest, or the one
   * with the most proposals behind it, lets a steadily-returning worker keep one
   * piece of work permanently at the back of the queue.
   */
  eligible.sort((a, b) => Date.parse(a.returned_at ?? 0) - Date.parse(b.returned_at ?? 0));
  const chosen = eligible[0];

  /*
   * ATTRIBUTION. The newest OPEN proposal for this task, or null. Null is a
   * legitimate answer and never a refusal -- see the header.
   */
  const open = proposals
    .filter((p) => p?.task_id === chosen.task_id && p?.state === 'open')
    .sort((a, b) => Date.parse(b.prepared_at ?? 0) - Date.parse(a.prepared_at ?? 0));

  return Object.freeze({
    ok: true,
    taskId: chosen.task_id,
    proposalId: open[0]?.proposal_id ?? null,
    task: chosen,
    counts: Object.freeze(counts),
    reason: open[0]
      ? `reviewing ${chosen.task_id}, attributed to open proposal ${open[0].proposal_id}`
      : `reviewing ${chosen.task_id}; no open proposal to attribute it to, which does not `
        + 'block the review -- the task row is the authority and the proposal is derived',
  });
}

function refuse(reason, counts) {
  return Object.freeze({ ok: false, reason, counts: Object.freeze(counts) });
}
