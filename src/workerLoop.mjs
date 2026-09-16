/**
 * THE WORKER RUNTIME'S DECISIONS, AS PURE FUNCTIONS.
 *
 * ═══ WHY THIS FILE EXISTS AT ALL ═══
 *
 * Measured on 2026-09-16, after a day of building the coordination plane:
 *
 *     tasks 2 | max_attempt 0 | leases ever held 0 | outbox rows 0
 *     proposals prepared 538 | confirmed 0
 *
 * Nothing had ever moved through this system autonomously, and the reason was
 * not a bug. It was that the component which CLAIMS work, RUNS it and HANDS IT
 * BACK did not exist. `agentbridge`'s own help line said so:
 * "read-only multi-agent coordination daemon". Everything else was the part
 * that tells a worker what to do and refuses it when it is wrong.
 *
 * ═══ WHY THE DECISIONS ARE HERE AND NOT IN THE LOOP ═══
 *
 * Rule 10 of CLAUDE.md: a guard that cannot be imported is a guard nobody has
 * watched fail. A worker runtime is mostly a state machine wrapped around I/O,
 * and if the state machine lives inside the I/O then its dangerous branches --
 * "my lease died while I was working" -- can only be tested by actually killing
 * a lease mid-run. So the machine is here, pure, and `bin` supplies the world.
 *
 * ═══ THE FOUR PROPERTIES THIS MACHINE EXISTS TO HOLD ═══
 *
 *   1. NEVER RETURN WORK WITHOUT A LIVE LEASE. A lease that expired mid-run
 *      means the task may have been reaped and re-claimed by somebody else.
 *      Returning then overwrites live work with the output of a run nobody is
 *      waiting for -- the zombie this whole fencing design exists to stop. The
 *      result is DISCARDED, not submitted.
 *
 *   2. A FAILED RENEWAL STOPS THE WORK IMMEDIATELY. Not at the end. The moment
 *      renewal is refused, this process is no longer the holder, and every
 *      second it keeps running is a second spent producing output that must be
 *      thrown away.
 *
 *   3. A PAUSED TASK STILL RENEWS. A worker waiting on a permission decision is
 *      not a dead worker -- it holds the lease and must keep holding it, or the
 *      reaper takes the task away while a human is deciding whether to allow it.
 *      This is the one case where "do nothing" is wrong.
 *
 *   4. A FAILED RUN IS RETURNED, NOT SWALLOWED. If the agent crashes or times
 *      out, the task goes back with the failure attached. Holding it until the
 *      lease expires turns a fast, legible failure into a silent ten-minute
 *      stall, and the retry counter never learns anything.
 *
 * PURE. The clock, the lease, the run result and the outstanding permission
 * requests all arrive as arguments.
 */

import { leaseState } from './leases.mjs';

const ms = (v) => {
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

/** What the loop should do next. */
export const ACTION = Object.freeze({
  POLL: 'poll',           // hold nothing; wait for an assignment
  START: 'start',         // lease is live and the run has not begun
  RENEW: 'renew',         // the lease needs extending before it lapses
  WAIT: 'wait',           // running, lease healthy, nothing to do but let it work
  RETURN: 'return',       // the run finished and the lease is still ours
  ABANDON: 'abandon',     // we are no longer the holder; DISCARD the result
  PAUSE: 'pause',         // a permission decision is outstanding for this task
  STOP: 'stop',           // shutting down
});

/**
 * RENEW AT A THIRD REMAINING, AND NEVER LATER THAN 60 SECONDS OUT.
 *
 * A margin, not a deadline. Renewing exactly at expiry means one slow round
 * trip loses the lease while the work is still running and correct -- the most
 * expensive possible way to lose it, because everything done so far is thrown
 * away. A third of the lease gives three chances to renew before it lapses, and
 * the absolute floor stops a very long lease from renewing for the first time
 * ten minutes after anything has gone wrong.
 */
export const RENEW_AT_FRACTION = 1 / 3;
export const RENEW_FLOOR_MS = 60_000;

export function renewalDue(lease, { now, leaseMs } = {}) {
  const at = ms(now);
  if (at === null) throw new TypeError('renewalDue requires a `now` timestamp');
  const expires = ms(lease?.lease_expires_at);
  if (expires === null) return true; // no expiry we can read: treat as due, never as healthy
  const remaining = expires - at;
  if (remaining <= 0) return true;
  const window = Math.max(RENEW_FLOOR_MS, (leaseMs ?? (expires - (ms(lease?.leased_at) ?? at))) * RENEW_AT_FRACTION);
  return remaining <= window;
}

/**
 * THE MACHINE. One call, one decision, no hidden state.
 *
 * @param w  {
 *   session_id, task, lease, run, stopping, pausedTaskIds, renewalFailed
 * }
 *   task           the row we hold, or null
 *   lease          { lease_token, lease_expires_at, leased_at }
 *   run            null | { done, ok, timedOut, headSha, notes, error }
 *   stopping       a shutdown was requested
 *   pausedTaskIds  task ids with an outstanding permission request
 *   renewalFailed  the last renewal attempt was refused
 */
export function nextAction(w = {}, { now, leaseMs } = {}) {
  const at = ms(now);
  if (at === null) throw new TypeError('nextAction requires a `now` timestamp');

  const task = w.task ?? null;
  const lease = w.lease ?? null;
  const run = w.run ?? null;

  /*
   * SHUTDOWN DOES NOT ABANDON WORK THAT IS FINISHED AND STILL OURS. A worker
   * told to stop between "the run completed" and "the result was submitted"
   * should submit it -- the result exists, the lease is live, and throwing it
   * away would make an orderly shutdown more destructive than a crash.
   */
  if (w.stopping && !(task && run?.done)) {
    return { action: ACTION.STOP, reason: 'shutdown requested' };
  }

  if (!task) return { action: ACTION.POLL, reason: 'holding no work' };

  if (!nonEmpty(lease?.lease_token)) {
    /*
     * HOLDING A TASK WITH NO LEASE TOKEN IS NOT A STATE TO WORK IN. It is the
     * shape the whole system had before the token was delivered to the worker:
     * assignment without a credential to return under. Refusing to start is the
     * only safe reading -- starting would produce work that cannot be handed
     * back.
     */
    return {
      action: ACTION.ABANDON,
      reason: `holding ${task.task_id} with no lease token; nothing could be returned under it`,
      discard: true,
    };
  }

  const state = leaseState({ ...task, ...lease }, { now });

  // 1. NEVER RETURN WITHOUT A LIVE LEASE — checked before anything else, and
  //    before `run.done`, so a completed run cannot sneak past it.
  if (state === 'expired') {
    return {
      action: ACTION.ABANDON,
      reason: `the lease on ${task.task_id} expired; the task may have been reaped and re-claimed`,
      discard: true,
    };
  }

  // 2. A FAILED RENEWAL MEANS WE ARE NO LONGER THE HOLDER. Stop now, not later.
  if (w.renewalFailed) {
    return {
      action: ACTION.ABANDON,
      reason: `renewal of ${task.task_id} was refused; this process is no longer the holder`,
      discard: true,
    };
  }

  const due = renewalDue(lease, { now, leaseMs });

  // 3. A PAUSED TASK STILL RENEWS. Renewal outranks the pause, because losing
  //    the lease while a human decides is the failure the pause exists to avoid.
  const paused = Array.isArray(w.pausedTaskIds) && w.pausedTaskIds.includes(task.task_id);
  if (paused) {
    if (due) return { action: ACTION.RENEW, reason: 'paused on a permission decision, and the lease needs holding' };
    return { action: ACTION.PAUSE, reason: `awaiting a permission decision on ${task.task_id}` };
  }

  if (due) return { action: ACTION.RENEW, reason: 'the lease is inside its renewal window' };

  if (!run) return { action: ACTION.START, reason: `lease live; starting work on ${task.task_id}` };

  // 4. A FAILED RUN IS RETURNED, NOT SWALLOWED. `done` covers success, failure
  //    and timeout alike; the outcome rides along in the payload.
  if (run.done) {
    return {
      action: ACTION.RETURN,
      reason: run.ok ? 'the run succeeded' : `the run failed: ${run.error ?? 'no reason given'}`,
      outcome: run.ok ? 'completed' : 'failed',
    };
  }

  return { action: ACTION.WAIT, reason: 'running, lease healthy' };
}

/**
 * WHAT GETS SENT BACK, AND WHAT MUST NEVER BE INVENTED.
 *
 * The commit is DERIVED, never supplied. `bin/agentbridge.mjs` already refuses
 * a typed `--head-sha` for this reason: a return carrying a commit somebody
 * typed is a claim about work, not evidence of it. This function will not
 * assemble a payload without one.
 *
 * The lease token is included because /return requires it and has no fallback
 * -- a path that accepts a return without a token is the one every zombie takes
 * by omitting a field.
 */
export function returnPayload(w = {}, { now } = {}) {
  if (ms(now) === null) throw new TypeError('returnPayload requires a `now` timestamp');
  const errors = [];

  if (!w.task?.task_id) errors.push('no task is held');
  if (!nonEmpty(w.lease?.lease_token)) errors.push('no lease token: /return would refuse this and should');
  if (!nonEmpty(w.session_id)) errors.push('no session id');
  if (!w.run?.done) errors.push('the run has not finished');
  if (w.run?.done && !nonEmpty(w.run?.headSha)) {
    errors.push('no commit was produced; a return must carry the commit that holds the work');
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    body: {
      task_id: w.task.task_id,
      session_id: w.session_id,
      lease_token: w.lease.lease_token,
      head_sha: w.run.headSha,
      outcome: w.run.ok ? 'completed' : 'failed',
      notes: summarise(w.run),
    },
  };
}

/**
 * A NOTE A PERSON CAN ACT ON, BOUNDED SO IT CANNOT BECOME A LOG DUMP.
 *
 * A failure that returns ten thousand lines of stderr is a failure nobody
 * reads. The tail is kept rather than the head: the useful part of a crash is
 * where it stopped, not where it started.
 */
export const NOTES_LIMIT = 2000;

export function summarise(run = {}) {
  if (run.ok) return nonEmpty(run.notes) ? run.notes.slice(0, NOTES_LIMIT) : 'completed';
  const parts = [];
  if (run.timedOut) parts.push('TIMED OUT');
  if (nonEmpty(run.error)) parts.push(run.error);
  if (nonEmpty(run.notes)) parts.push(run.notes);
  const joined = parts.join('\n') || 'failed with no output';
  return joined.length <= NOTES_LIMIT ? joined : `…${joined.slice(-NOTES_LIMIT)}`;
}

/**
 * IS THIS EVENT WORTH WAKING FOR?
 *
 * The outbox is at-least-once BY CONSTRUCTION -- the event is written in the
 * same transaction as the claim, which closes "lost publish after commit" and
 * makes duplicates certain. So no consumer may trust an event body, and every
 * consumer must be able to see the same event twice without acting twice.
 *
 * The event is a DOORBELL, not a payload: it says which task changed, and the
 * worker then reads the authority. The one thing taken from the body is the
 * lease token, because that is the only place the holder can learn it.
 */
export function actionableEvent(event = {}, w = {}) {
  if (!nonEmpty(event.task_id)) return { act: false, reason: 'event names no task' };
  if (event.kind !== 'assigned') return { act: false, reason: `nothing to do for "${event.kind}"` };
  if (w.task) {
    return w.task.task_id === event.task_id
      ? { act: false, reason: 'already holding this task' }
      : { act: false, reason: `busy with ${w.task.task_id}` };
  }
  return { act: true, task_id: event.task_id, lease_token: event.lease_token ?? null };
}
