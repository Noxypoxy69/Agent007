import { canAssign, canAccept } from './coordination.mjs';

/**
 * THE SUPERVISED DISPATCHER: it PREPARES, it does not decide.
 *
 * The coordinator polls hourly at best, so every handoff waited on a human to
 * relay it. An always-running dispatcher fixes the latency and raises an
 * obvious question: may it assign work by itself?
 *
 * The owner's answer was no. It prepares an assignment; the coordinator
 * confirms on its pass. So this module produces PROPOSALS, and a proposal is a
 * suggestion with a timestamp -- never a stored permission.
 *
 * THAT DISTINCTION IS THE WHOLE DESIGN, and it is easy to lose.
 *
 * The tempting shortcut is to record the verdict at proposal time and let
 * confirmation trust it. Then the dispatcher's judgment, formed minutes or an
 * hour earlier against a world that has since moved, becomes the authority --
 * and "supervised" degrades into "autonomous, with a delay". The worker may
 * have gone offline, taken other work, or had its lane reassigned; the task may
 * have been cancelled or already returned.
 *
 * So canConfirm RE-RUNS the guard against live state and ignores the recorded
 * verdict entirely. The stored reasoning exists to be READ by whoever confirms,
 * not to be relied on by the code.
 *
 * ROUTING IS BY LANE, NOT BY A CHAIN. A fixed C -> B -> D -> A rotation was
 * proposed; it describes today's roster rather than a rule, and canAssign
 * already refuses on lane and repo mismatch, so most hops in such a chain would
 * produce refusals instead of handoffs. The registry records which lane a
 * session holds. That is the routing table.
 *
 * PURE. Rows and the clock arrive as arguments.
 */

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const arr = (v) => (Array.isArray(v) ? v : []);

/** How long a proposal is worth looking at before the world has moved. */
export const PROPOSAL_STALE_AFTER_MS = 60 * 60 * 1000;

export const PROPOSAL_KINDS = ['assign', 'review'];

/**
 * What the dispatcher would suggest, given the world as it is now.
 *
 * @returns {{proposals: object[], idle: object[], blocked: object[]}}
 */
export function proposeWork({ tasks = [], sessions = [], now, isLive }) {
  if (!nonEmpty(now)) throw new TypeError('proposeWork requires a `now` timestamp');
  if (typeof isLive !== 'function') {
    /*
     * Liveness is INJECTED, as it is everywhere else in this system. A
     * dispatcher that decided for itself whether a worker was alive would be
     * the second opinion on the question the registry exists to answer.
     */
    throw new TypeError('proposeWork requires an isLive predicate');
  }

  const live = arr(sessions).filter((s) => s && isLive(s) && s.capacity !== 'offline');
  const taken = new Set(
    arr(tasks).filter((t) => t?.state === 'assigned').map((t) => t.assigned_session),
  );

  const proposals = [];
  const idle = live
    .filter((s) => !taken.has(s.session_id))
    .map((s) => ({ agent_id: s.agent_id, session_id: s.session_id, lane_id: s.lane_id ?? null }));

  const blocked = [];

  for (const task of arr(tasks)) {
    if (!task || !nonEmpty(task.task_id)) continue;

    /*
     * RETURNED WORK IS A REVIEW, NOT A REASSIGNMENT.
     *
     * The dispatcher must never propose handing returned work to somebody
     * else: it has been done, and what it needs is a coordinator to look at
     * the commit. Proposing a reassignment here would quietly discard a
     * worker's finished contract.
     */
    if (task.state === 'returned') {
      const verdict = canAccept(task, { at: now });
      proposals.push({
        kind: 'review',
        task_id: task.task_id,
        // Who did it, and what to look at. The dispatcher forms no opinion on
        // whether the work is GOOD -- it cannot read a diff.
        returned_by: task.returned_by ?? null,
        head_sha: task.returned_head_sha ?? null,
        notes: task.returned_notes ?? null,
        would_be_accepted: verdict.ok,
        reasons: verdict.ok ? [] : verdict.errors,
        prepared_at: now,
      });
      continue;
    }

    if (task.state === 'blocked') {
      blocked.push({ task_id: task.task_id, reason: task.blocked_reason ?? null });
      continue;
    }

    if (task.state !== 'runnable') continue;

    // ── routing, by lane ────────────────────────────────────────────────────
    const lane = task.lane_id ?? null;
    const candidates = live.filter((s) => {
      if (taken.has(s.session_id)) return false;
      if (nonEmpty(lane) && nonEmpty(s.lane_id) && s.lane_id !== lane) return false;
      if (nonEmpty(task.repo_id) && nonEmpty(s.repo_id) && s.repo_id !== task.repo_id) return false;
      return true;
    });

    if (candidates.length === 0) {
      blocked.push({
        task_id: task.task_id,
        reason: nonEmpty(lane)
          ? `no idle live worker holds lane "${lane}"`
          : 'no idle live worker is available',
      });
      continue;
    }

    /*
     * AMBIGUITY IS REPORTED, NOT BROKEN BY A TIE-RULE.
     *
     * Picking "the first" would be a decision about who does the work, made by
     * the component explicitly told not to make those. Two eligible workers is
     * something a supervisor should see.
     */
    if (candidates.length > 1) {
      blocked.push({
        task_id: task.task_id,
        reason: `${candidates.length} idle workers are eligible; choose one`,
        candidates: candidates.map((s) => s.agent_id),
      });
      continue;
    }

    const worker = candidates[0];
    const verdict = canAssign(task, worker, {
      tasks,
      assignments: arr(tasks).filter((t) => t?.task_id !== task.task_id),
      isLive,
    });

    proposals.push({
      kind: 'assign',
      task_id: task.task_id,
      agent_id: worker.agent_id,
      session_id: worker.session_id,
      lane_id: lane,
      // RECORDED TO BE READ, NOT TRUSTED. canConfirm re-runs this against live
      // state; a stale ok here confirms nothing.
      would_be_accepted: verdict.ok,
      reasons: verdict.ok ? [] : verdict.errors,
      prepared_at: now,
    });
  }

  return { proposals, idle, blocked };
}

/**
 * MAY THIS PROPOSAL BE CONFIRMED, RIGHT NOW?
 *
 * Re-runs the guard against live rows. The proposal's own `would_be_accepted`
 * is deliberately ignored: it was formed against a world that has since moved,
 * and trusting it would turn a supervised dispatcher into an autonomous one
 * with an hour of lag.
 */
export function canConfirm(proposal, { task, worker, tasks = [], now, isLive, staleAfterMs = PROPOSAL_STALE_AFTER_MS } = {}) {
  const errors = [];

  if (!proposal || !PROPOSAL_KINDS.includes(proposal.kind)) {
    return { ok: false, errors: ['no such proposal'] };
  }
  if (!nonEmpty(now)) return { ok: false, errors: ['a timestamp is required'] };

  /*
   * A PROPOSAL GOES STALE.
   *
   * An hour-old suggestion confirmed without a fresh look is the dispatcher
   * deciding late rather than the supervisor deciding now. Past the window it
   * must be re-prepared, which costs nothing and forces the guard to run
   * against the present.
   */
  const prepared = Date.parse(proposal.prepared_at);
  const t = Date.parse(now);
  if (Number.isNaN(prepared) || Number.isNaN(t)) {
    errors.push('the proposal cannot be dated, so its age cannot be checked');
  } else if (t - prepared > staleAfterMs) {
    errors.push(`prepared ${Math.round((t - prepared) / 60000)} minutes ago and is stale; re-prepare it`);
  } else if (t < prepared) {
    errors.push('the proposal is dated in the future');
  }

  if (!task) {
    errors.push(`no such task: ${proposal.task_id}`);
    return { ok: false, errors };
  }

  if (proposal.kind === 'review') {
    const verdict = canAccept(task, { at: now });
    if (!verdict.ok) errors.push(...verdict.errors);
    return { ok: errors.length === 0, errors };
  }

  // kind === 'assign'
  if (!worker) {
    errors.push(`${proposal.agent_id} has no live session now; it may have gone offline since`);
    return { ok: false, errors };
  }
  if (worker.session_id !== proposal.session_id) {
    /*
     * The session is part of the proposal. A worker that restarted has a new
     * runtime, and confirming onto it would be assigning to something nobody
     * proposed -- the same session/agent confusion the registry exists to
     * prevent.
     */
    errors.push(`proposed for session "${proposal.session_id}" but ${proposal.agent_id} is now "${worker.session_id}"`);
  }

  const verdict = canAssign(task, worker, {
    tasks,
    assignments: arr(tasks).filter((t) => t?.task_id !== task.task_id),
    isLive,
  });
  if (!verdict.ok) errors.push(...verdict.errors);

  return { ok: errors.length === 0, errors };
}

/**
 * The hourly supervisory report: what a person or a coordinator needs to see.
 *
 * Counts first so a quiet hour reads as quiet, then the things that need a
 * decision. A report that buries two blocked tasks in a list of forty healthy
 * ones is a report nobody finishes reading.
 */
export function supervisoryReport({ proposals = [], idle = [], blocked = [], tasks = [], now }) {
  if (!nonEmpty(now)) throw new TypeError('supervisoryReport requires a `now` timestamp');

  const byState = {};
  for (const t of arr(tasks)) {
    if (!t?.state) continue;
    byState[t.state] = (byState[t.state] ?? 0) + 1;
  }

  return {
    at: now,
    counts: {
      proposals: arr(proposals).length,
      awaiting_review: arr(proposals).filter((p) => p.kind === 'review').length,
      idle_workers: arr(idle).length,
      blocked: arr(blocked).length,
      tasks: byState,
    },
    // Everything below needs somebody to act. Nothing here is a status update.
    awaiting_review: arr(proposals).filter((p) => p.kind === 'review'),
    ready_to_assign: arr(proposals).filter((p) => p.kind === 'assign' && p.would_be_accepted),
    would_refuse: arr(proposals).filter((p) => p.kind === 'assign' && !p.would_be_accepted),
    blocked: arr(blocked),
    idle_workers: arr(idle),
  };
}
