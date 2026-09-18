/**
 * LEASES AND FENCING TOKENS: the guards, pure, where a test can reach them.
 *
 * The problem this closes. An assignment used to be read-decide-write from an
 * edge function. Two confirmations arriving together could both read "runnable"
 * and both write "assigned", and the second would silently win. That has not
 * bitten yet only because there has been one coordinator and almost no traffic.
 * That is luck, not a guard, and luck is what this file replaces.
 *
 * A CLAIM IS HELD UNTIL A DEADLINE, NOT FOREVER. Three watchers were killed by
 * the host today. Without an expiry, a worker killed mid-task holds its work
 * until a person notices; with one, the work returns to the pool by itself and
 * the attempt counter records that it was tried.
 *
 * WHY THE TOKEN IS RANDOM PER CLAIM AND NOT THE SESSION ID. It is a FENCING
 * token. A worker that was assigned, died, and came back under the same session
 * id must not be able to use stale knowledge to write a result for work that
 * has since been re-assigned. A session id is stable and therefore useless for
 * that; a fresh random token per claim is exactly what makes the late writer
 * identifiable as late. This is the whole reason fencing tokens exist and it is
 * the one property here that is easy to "simplify" away.
 *
 * DELIVERY IS AT-LEAST-ONCE, BY CONSTRUCTION. The event is written in the same
 * transaction as the claim, so it exists if and only if the assignment does --
 * which closes "lost publish after commit" but guarantees duplicates instead.
 * Therefore NO CONSUMER MAY TRUST AN EVENT BODY. Every one re-reads the task
 * and compares the token. shouldActOnEvent is that rule, written once.
 *
 * PURE. Rows and the clock arrive as arguments; nothing here generates a token
 * or reads a database. The token is minted by Postgres inside the claiming
 * transaction, because that is the only place it can be minted atomically with
 * the write it fences.
 */

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const arr = (v) => (Array.isArray(v) ? v : []);

const ms = (v) => {
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

/** Fifteen minutes: long enough for real work, short enough that a death costs one lease. */
export const DEFAULT_LEASE_MS = 15 * 60 * 1000;

/** Bounds. A lease shorter than this thrashes; longer than this is a hostage. */
export const MIN_LEASE_MS = 30 * 1000;
export const MAX_LEASE_MS = 24 * 60 * 60 * 1000;

export const CLAIMABLE_FROM = ['runnable', 'returned'];

/**
 * THREE STATES, AND "EXPIRED" IS NOT "NONE".
 *
 * A task with an expired lease is claimable, but it is claimable for the second
 * time -- it carries the history of a worker that took it and did not finish.
 * Collapsing that into "no lease" would lose the attempt count and make a
 * crash-loop indistinguishable from fresh work.
 */
export function leaseState(task, { now } = {}) {
  const at = ms(now);
  if (at === null) throw new TypeError('leaseState requires a `now` timestamp');
  if (!task || !nonEmpty(task.lease_token)) return 'none';
  const exp = ms(task.lease_expires_at);
  if (exp === null) return 'none';
  return exp > at ? 'live' : 'expired';
}

export const isLeaseLive = (task, opts) => leaseState(task, opts) === 'live';

/**
 * MAY THIS WORKER CLAIM THIS TASK RIGHT NOW?
 *
 * The database enforces the race with FOR UPDATE SKIP LOCKED; this enforces
 * everything a race cannot see -- state, dependencies, and whose lease is live.
 * Both exist on purpose: the SQL stops two writers, this explains why a single
 * writer is being refused.
 */
export function canClaim(task, worker, { now, tasks = [], leaseMs = DEFAULT_LEASE_MS } = {}) {
  const errors = [];
  const at = ms(now);
  if (at === null) return { ok: false, errors: ['a timestamp is required'] };

  if (!task || !nonEmpty(task.task_id)) return { ok: false, errors: ['no such task'] };
  if (!worker || !nonEmpty(worker.session_id) || !nonEmpty(worker.agent_id)) {
    return { ok: false, errors: ['no resolved worker: a claim must name a registered session'] };
  }

  if (!Number.isFinite(leaseMs) || leaseMs < MIN_LEASE_MS || leaseMs > MAX_LEASE_MS) {
    errors.push(`lease must be between ${MIN_LEASE_MS / 1000}s and ${MAX_LEASE_MS / 1000}s`);
  }

  if (!CLAIMABLE_FROM.includes(task.state)) {
    errors.push(`task is "${task.state}"; only ${CLAIMABLE_FROM.join(' or ')} work can be claimed`);
  }

  /*
   * A LIVE LEASE HELD BY SOMEBODY ELSE BLOCKS. An EXPIRED one does not -- that
   * is the entire point of an expiry, and refusing on it would mean a worker
   * that died took its task to the grave.
   */
  const state = leaseState(task, { now });
  if (state === 'live' && task.assigned_session !== worker.session_id) {
    errors.push(`held by ${task.assigned_session} until ${task.lease_expires_at}`);
  }

  const byId = new Map(arr(tasks).map((t) => [t?.task_id, t]));
  for (const dep of arr(task.depends_on)) {
    const d = byId.get(dep);
    if (!d) errors.push(`depends on "${dep}", which does not exist`);
    else if (d.state !== 'accepted') {
      errors.push(`depends on "${dep}", which is "${d.state}" and not accepted`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * MAY THIS LEASE BE RENEWED?
 *
 * Compare-and-set on the token. An expired lease is NOT renewable: by then the
 * work may belong to somebody else, and extending it would resurrect a claim
 * that is over. The worker must re-claim and find out.
 */
export function canRenew(task, { token, now } = {}) {
  const at = ms(now);
  if (at === null) return { ok: false, errors: ['a timestamp is required'] };
  if (!task || !nonEmpty(task.task_id)) return { ok: false, errors: ['no such task'] };
  if (!nonEmpty(token)) return { ok: false, errors: ['a lease token is required'] };

  if (task.lease_token !== token) {
    return { ok: false, errors: ['this claim has been superseded; the work was re-assigned'] };
  }
  if (leaseState(task, { now }) !== 'live') {
    return { ok: false, errors: [`the lease expired at ${task.lease_expires_at}; re-claim it`] };
  }
  return { ok: true, errors: [] };
}

/**
 * THE ZOMBIE GUARD.
 *
 * A worker that went away long enough for its lease to expire, and came back
 * holding a finished result, must not be able to write it: the task may have
 * been re-claimed, and the late write would overwrite live work with the output
 * of a run nobody is waiting for.
 *
 * Refused on the TOKEN, not on time alone -- because the dangerous case is
 * precisely the one where the token was superseded while the clock still looks
 * plausible.
 */
export function canReturnWithLease(task, { token, headSha, now } = {}) {
  const errors = [];
  const at = ms(now);
  if (at === null) return { ok: false, errors: ['a timestamp is required'] };
  if (!task || !nonEmpty(task.task_id)) return { ok: false, errors: ['no such task'] };

  if (!nonEmpty(headSha)) {
    errors.push('a return requires the head sha of the work, resolved through git and never typed');
  } else if (!/^[0-9a-f]{40}$/i.test(headSha)) {
    errors.push('head sha must be a full 40-character sha');
  }

  if (!nonEmpty(token)) errors.push('a lease token is required');
  else if (task.lease_token !== token) {
    errors.push('this claim has been superseded; the work was re-assigned');
  } else if (leaseState(task, { now }) !== 'live') {
    errors.push(`the lease expired at ${task.lease_expires_at}; re-claim before returning`);
  }

  if (task.state !== 'assigned') {
    errors.push(`task is "${task.state}"; only assigned work can be returned`);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * THE AT-LEAST-ONCE RULE, WRITTEN ONCE SO NOBODY RE-DERIVES IT.
 *
 * The outbox commits with the claim, so an event is never lost -- and is
 * therefore sometimes delivered twice, or late, or out of order. A consumer
 * that acts on the event BODY will act twice.
 *
 * So: re-read the task, and act only if the event still describes the world.
 * The token is the comparison, because it is the only field that changes on
 * every claim. An event whose token is not the row's current token is about a
 * claim that is over, whatever its timestamp says.
 */
export function shouldActOnEvent(event, task, { now } = {}) {
  const at = ms(now);
  if (at === null) throw new TypeError('shouldActOnEvent requires a `now` timestamp');

  if (!event || !nonEmpty(event.kind)) return { act: false, reason: 'not-an-event' };
  if (!task || !nonEmpty(task.task_id)) return { act: false, reason: 'task-is-gone' };
  if (event.task_id !== task.task_id) return { act: false, reason: 'event-is-about-another-task' };

  if (nonEmpty(event.delivered_at)) {
    /*
     * Already acted on. This is ADVISORY, not the guard: at-least-once means
     * the flag itself can be written twice, so the token check below is what
     * actually holds. Checking it first only saves work.
     */
    return { act: false, reason: 'already-delivered' };
  }

  if (event.kind === 'assigned') {
    if (task.lease_token !== event.lease_token) {
      return { act: false, reason: 'superseded-claim' };
    }
    if (leaseState(task, { now }) !== 'live') {
      return { act: false, reason: 'lease-expired' };
    }
    if (task.state !== 'assigned') return { act: false, reason: 'no-longer-assigned' };
    return { act: true, reason: 'current' };
  }

  if (event.kind === 'lease_expired') {
    // Act only if the row really did go back to the pool. If it has since been
    // re-claimed, somebody already handled this and the event is history.
    if (task.state !== 'runnable') return { act: false, reason: 'already-reclaimed' };
    return { act: true, reason: 'current' };
  }

  if (event.kind === 'returned') {
    if (task.state !== 'returned') return { act: false, reason: 'no-longer-returned' };
    return { act: true, reason: 'current' };
  }

  return { act: false, reason: `unknown-kind:${event.kind}` };
}

/** Leases that have run out. Reconciliation reads this; it does not hand work out. */
export function expiredLeases(tasks, { now } = {}) {
  const at = ms(now);
  if (at === null) throw new TypeError('expiredLeases requires a `now` timestamp');
  return arr(tasks)
    .filter((t) => t && t.state === 'assigned' && leaseState(t, { now }) === 'expired')
    .map((t) => ({
      task_id: t.task_id,
      agent_id: t.assigned_agent ?? null,
      session_id: t.assigned_session ?? null,
      lease_token: t.lease_token,
      attempt: Number.isFinite(t.attempt) ? t.attempt : 0,
      expired_at: t.lease_expires_at,
    }));
}

/**
 * ESCALATIONS COLLAPSE, BECAUSE THE OWNER IS A PERSON.
 *
 * A task that fails repeatedly produces one escalation per attempt, and a
 * reconciliation loop running every minute produces one per minute. Sending the
 * owner the same sentence sixty times is how a channel gets muted, and a muted
 * channel is worse than no channel -- it looks like it is working.
 *
 * Keyed on what the owner would actually decide about, NOT on the attempt
 * number: "t-42 keeps failing" is one decision however many times it recurs.
 * The count travels with it so the repetition is still visible.
 */
export function dedupeEscalations(escalations, { now, windowMs = 60 * 60 * 1000 } = {}) {
  const at = ms(now);
  if (at === null) throw new TypeError('dedupeEscalations requires a `now` timestamp');

  const byKey = new Map();
  for (const e of arr(escalations)) {
    if (!e || !nonEmpty(e.task_id) || !nonEmpty(e.reason)) continue;
    const t = ms(e.at);
    if (t === null || at - t > windowMs) continue;

    const key = `${e.task_id}::${e.reason}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { task_id: e.task_id, reason: e.reason, occurrences: 1, first_at: e.at, last_at: e.at });
      continue;
    }
    prev.occurrences += 1;
    if (String(e.at) < String(prev.first_at)) prev.first_at = e.at;
    if (String(e.at) > String(prev.last_at)) prev.last_at = e.at;
  }

  // Most recent first: the owner reads the top of the list.
  return [...byKey.values()].sort((a, b) => String(b.last_at).localeCompare(String(a.last_at)));
}
