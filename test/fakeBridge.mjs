/*
 * AN IN-MEMORY MODEL OF THE REVIEW HALF OF THE DATABASE.
 *
 * It implements claim_review, renew_review_lease, expire_dead_reviews,
 * submit_review, the release_review_lease trigger and claim_task's review
 * refusal -- the six pieces the reviewer runtime touches -- with the same
 * refusal reasons the SQL returns, because a runner tested against a fake that
 * always says yes is a runner whose refusal paths have never run.
 *
 * WHAT IT IS NOT. It is a MODEL of the SQL and not the SQL. It can agree with a
 * migration that is wrong, and it cannot tell you the migration is applied.
 * Nothing in this file is evidence about production; the tests that use it say
 * so, and so does the report that ships with them.
 *
 * WHY IT EXISTS ANYWAY. The property the runner has to have is that it HONOURS
 * refusals it did not predict -- self-review, wrong state, a superseded token --
 * and there is no way to exercise that against a stub that cannot refuse. A
 * fixture that cannot construct the real case cannot fail for it, so this one
 * constructs the states a real claim produces: 'returned' with a live review
 * lease, 'returned' with an expired one not yet reaped, and 'returned' with the
 * columns nulled by the reaper. Those are three different rows and the runner
 * must be claimable from two of them.
 */

let counter = 0;
const uuid = () => {
  counter += 1;
  const n = counter.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${n}`;
};

export function createFakeBridge({ tasks = [], now = () => Date.now() } = {}) {
  const rows = new Map();
  for (const t of tasks) rows.set(t.task_id, { depends_on: [], attempt: 0, ...t });
  const outbox = [];

  /* The BEFORE UPDATE trigger. Leaving 'returned' ends the review, whatever
   * moved the row and whoever moved it. */
  const applyState = (row, next) => {
    const leaving = row.state === 'returned' && next !== 'returned';
    row.state = next;
    if (leaving) {
      row.reviewer = null;
      row.review_lease_token = null;
      row.review_lease_expires_at = null;
    }
  };

  const liveReview = (row, at) =>
    row.review_lease_token != null
    && row.review_lease_expires_at != null
    && row.review_lease_expires_at > at;

  return {
    rows,
    outbox,

    /** public.claim_review */
    async claimReview({ task_id, reviewer_session, lease_seconds = 1800 }) {
      const at = now();
      if (typeof reviewer_session !== 'string' || reviewer_session.trim() === '') {
        return { ok: false, reason: 'no-reviewer' };
      }
      if (lease_seconds < 30 || lease_seconds > 86400) {
        return { ok: false, reason: 'lease_seconds must be between 30 and 86400' };
      }
      const row = rows.get(task_id);
      if (!row) return { ok: false, reason: 'not-claimable', detail: 'no such task' };
      if (row.state !== 'returned') {
        return {
          ok: false,
          reason: 'state',
          detail: `task is "${row.state}"; only returned work is reviewable`,
        };
      }
      if (row.returned_by != null && row.returned_by === reviewer_session) {
        return {
          ok: false,
          reason: 'self-review',
          detail: 'the session that returned this work cannot review it',
        };
      }
      if (liveReview(row, at) && row.reviewer !== reviewer_session) {
        return {
          ok: false,
          reason: 'under-review',
          detail: `held by ${row.reviewer} until ${row.review_lease_expires_at}`,
        };
      }
      const tok = uuid();
      const expires = at + lease_seconds * 1000;
      row.reviewer = reviewer_session;
      row.review_lease_token = tok;
      row.review_lease_expires_at = expires;
      outbox.push({ kind: 'review_claimed', task_id, session_id: reviewer_session, lease_token: tok });
      return { ok: true, task_id, review_lease_token: tok, review_expires_at: expires };
    },

    /** public.renew_review_lease -- compare-and-set on the review token */
    async renewReview({ task_id, review_lease_token, lease_seconds = 1800 }) {
      const at = now();
      const row = rows.get(task_id);
      if (!row || row.review_lease_token !== review_lease_token || !liveReview(row, at)) {
        return { ok: false, reason: 'review-lease-not-current' };
      }
      row.review_lease_expires_at = at + lease_seconds * 1000;
      return { ok: true, review_expires_at: row.review_lease_expires_at };
    },

    /** public.expire_dead_reviews -- the reaper, which is the whole recovery path */
    async expireDeadReviews() {
      const at = now();
      let n = 0;
      for (const row of rows.values()) {
        if (
          row.state === 'returned'
          && row.review_lease_token != null
          && row.review_lease_expires_at != null
          && row.review_lease_expires_at <= at
        ) {
          outbox.push({ kind: 'review_lease_expired', task_id: row.task_id, session_id: row.reviewer });
          row.reviewer = null;
          row.review_lease_token = null;
          row.review_lease_expires_at = null;
          n += 1;
        }
      }
      return n;
    },

    /** public.submit_review -- the fenced write */
    async submitReview({
      task_id, review_lease_token, decision, reasons = [],
      reviewer_session = null, head_sha = null, fix_task = null,
    }) {
      const at = now();
      if (!['accept', 'fix_required', 'reject'].includes(decision)) {
        return { ok: false, reason: 'decision', detail: `"${decision}" is not a decision` };
      }
      const row = rows.get(task_id);
      if (!row) return { ok: false, reason: 'not-found' };
      if (
        row.review_lease_token == null
        || row.review_lease_token !== review_lease_token
        || !liveReview(row, at)
      ) {
        return { ok: false, reason: 'review-lease-not-current' };
      }
      if (row.state !== 'returned') {
        return { ok: false, reason: 'state', detail: `task is "${row.state}"` };
      }
      if (reviewer_session != null && row.reviewer !== reviewer_session) {
        return { ok: false, reason: 'reviewer-mismatch' };
      }
      if (head_sha != null && row.returned_head_sha !== head_sha) {
        return {
          ok: false,
          reason: 'head-moved',
          detail: `the review is of ${head_sha}; the task returned ${row.returned_head_sha}`,
        };
      }

      let fixId = null;
      if (decision === 'fix_required') {
        if (!fix_task?.task_id) return { ok: false, reason: 'fix-task-missing' };
        if (fix_task.task_id === task_id) return { ok: false, reason: 'fix-task-collides' };
        fixId = fix_task.task_id;
        if (!rows.has(fixId)) {
          rows.set(fixId, {
            task_id: fixId,
            title: fix_task.title ?? `Fix findings raised on ${task_id}`,
            state: 'runnable',
            lane_id: fix_task.lane_id ?? row.lane_id ?? null,
            repo_id: fix_task.repo_id ?? row.repo_id ?? null,
            base_sha: fix_task.base_sha ?? row.returned_head_sha,
            // modelled from the migration: an omitted allow-list defaults to
            // '[]', which means NOTHING is allowed, so the insert copies the
            // reviewed task's contract rather than leaving the default
            allowed_paths: fix_task.allowed_paths ?? row.allowed_paths ?? [],
            forbidden_paths: fix_task.forbidden_paths ?? row.forbidden_paths ?? [],
            shared_paths: fix_task.shared_paths ?? row.shared_paths ?? [],
            depends_on: [],
            attempt: 0,
            fix_of: task_id,
          });
        }
      }

      const reviewedBy = row.reviewer;
      const next = decision === 'accept' ? 'accepted' : decision === 'reject' ? 'runnable' : 'blocked';
      row.review_decision = decision;
      row.review_reasons = [...reasons];
      row.reviewed_by = reviewedBy;
      row.reviewed_at = at;
      row.fix_task_id = fixId;
      if (decision === 'fix_required') row.depends_on = [...(row.depends_on ?? []), fixId];
      if (decision === 'accept') {
        row.accepted_by = reviewedBy;
        row.accepted_at = at;
        row.accepted_head_sha = row.returned_head_sha;
      }
      applyState(row, next);
      outbox.push({ kind: 'review_recorded', task_id, session_id: reviewedBy, decision, state: next });
      return { ok: true, task_id, decision, state: next, fix_task_id: fixId, reviewed_by: reviewedBy };
    },

    /** public.claim_task, only as far as the review refusal this change adds */
    async claimTask({ task_id, agent_id, session_id, lease_seconds = 900 }) {
      const at = now();
      const row = rows.get(task_id);
      if (!row) return { ok: false, reason: 'not-claimable' };
      const isRenewal = row.lease_token != null
        && row.lease_expires_at != null
        && row.lease_expires_at > at
        && row.assigned_session === session_id;
      if (!isRenewal && liveReview(row, at)) {
        return {
          ok: false,
          reason: 'under-review',
          detail: `held for review by ${row.reviewer} until ${row.review_lease_expires_at}`,
        };
      }
      if (!isRenewal && !['runnable', 'returned'].includes(row.state)) {
        return { ok: false, reason: 'state', detail: `task is "${row.state}"` };
      }
      const tok = uuid();
      row.assigned_agent = agent_id;
      row.assigned_session = session_id;
      row.lease_token = tok;
      row.lease_expires_at = at + lease_seconds * 1000;
      row.attempt = isRenewal ? row.attempt : (row.attempt ?? 0) + 1;
      applyState(row, 'assigned');
      return { ok: true, task_id, lease_token: tok, attempt: row.attempt };
    },
  };
}
