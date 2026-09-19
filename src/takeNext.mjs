/**
 * TAKE NEXT JOB — one active task per worker, and a block that actually
 * releases the slot.
 *
 * ═══ WHY A WIP LIMIT IS A CORRECTNESS RULE HERE, NOT A PRODUCTIVITY ONE ═══
 *
 * Measured on this machine 2026-09-18/19. Agents held several things at once
 * and the consequences were not "slower": a working tree reset around a591d28
 * silently destroyed another session's uncommitted work, two sessions raced
 * the shared git index, and one agent's half-finished rename left the shell
 * rail importing a function that no longer existed -- the guard was DEAD until
 * somebody noticed by hand.
 *
 * Every one of those is the same shape: a worker with more than one thing in
 * flight cannot finish either before touching shared state again. So the limit
 * is a constraint on concurrent MUTATION, which is why it counts only the
 * states in which a worker is actually changing something.
 *
 * ═══ AND WHY BLOCKED MUST NOT COUNT ═══
 *
 * If being blocked consumed the slot, a worker waiting on an owner decision
 * would be idle until that decision arrived -- which tonight has meant hours.
 * That is the failure mode where a rule designed to keep people honest just
 * stops the work, and it is how a control gets switched off. BLOCKED is
 * durable, visible and unlimited; the slot comes back immediately.
 *
 * What stops a worker simply declaring everything blocked is that a block
 * requires a CLASS and a REASON, both recorded, and blocked tasks stay on the
 * board under that worker's name.
 *
 * This module is pure: no IO, no state, no schema. It decides; the caller
 * stores.
 */

/**
 * States in which a worker is actively changing something.
 *
 * These are the states that make a second concurrent task dangerous, because
 * each of them implies an uncommitted or unverified mutation somewhere.
 */
export const ACTIVE_WIP_STATES = Object.freeze([
  'WORKING',
  'CANDIDATE_COMMITTED',
  'MUTATION_PROVEN',
]);

/**
 * States that are explicitly UNLIMITED.
 *
 * Named as a closed list rather than "anything not active" so that a NEW state
 * added upstream does not silently become unlimited. An unrecognised state is
 * treated as active -- see `wipHeldBy` -- because the safe default for "I do
 * not know what this means" is to assume the worker is busy, not to hand them
 * more work.
 */
export const PARKED_STATES = Object.freeze([
  'BLOCKED',
  'WAITING_REVIEW',
  'BLIND_REVIEWED',
  'INTEGRATION_READY',
  'INTEGRATED',
  'LIVE_PROVEN',
  'SHIPPED',
  'READY',
  'DISCOVERED',
  'CANCELLED',
]);

/** Block classes a worker may declare. A block with no class is not a block. */
export const BLOCK_CLASSES = Object.freeze([
  'DEPENDENCY',
  'OWNER_DECISION',
  'INFRASTRUCTURE',
  'COLLISION',
  'MISSING_EVIDENCE',
  'EXTERNAL_SERVICE',
  'UNKNOWN',
]);

const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/**
 * Does this state consume the worker's one slot?
 *
 * UNKNOWN STATES COUNT AS ACTIVE. Rule 19 cuts both ways: defaulting an
 * unrecognised name to "not busy" would let a typo or a newly-added state
 * hand a worker a second concurrent job, which is the exact hazard. Defaulting
 * to "busy" is recoverable -- the worker says so and it gets fixed -- while
 * the other direction corrupts a working tree silently.
 */
export function consumesSlot(state) {
  const s = str(state);
  if (!s) return true;
  if (PARKED_STATES.includes(s)) return false;
  return true;
}

/**
 * The task currently holding this worker's slot, or null.
 *
 * Matched on SESSION, falling back to durable agent id only when the task
 * records no session. A durable id can be held by two concurrent sessions of
 * the same agent, and those are exactly the two that collide on the shared
 * index -- so session is the sharper key and is preferred.
 */
export function wipHeldBy(worker, tasks) {
  const session = str(worker?.session_id);
  const agent = str(worker?.agent_id);
  if (!session && !agent) return null;

  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!consumesSlot(t?.state)) continue;
    const ts = str(t?.assigned_session);
    const ta = str(t?.assigned_agent ?? t?.agent_id);
    if (ts) { if (session && ts === session) return t; continue; }
    if (ta && agent && ta === agent) return t;
  }
  return null;
}

/**
 * May this worker take another job?
 *
 * Returns a REASON on refusal, naming the task in the way. A scheduler that
 * says only "no" produces a worker that asks again in a loop, and this
 * project has already paid for a poll that spun at roughly 1500 iterations a
 * second because a refusal carried no information.
 */
export function canTakeNext({ worker, tasks = [] } = {}) {
  if (!str(worker?.session_id) && !str(worker?.agent_id)) {
    return { ok: false, why: 'the caller named no worker; a job cannot be issued to nobody' };
  }

  const held = wipHeldBy(worker, tasks);
  if (held) {
    return {
      ok: false,
      why: `already holding ${held.task_id ?? '(unnamed task)'} in ${held.state ?? '(unknown state)'}. `
        + 'Finish it, or MARK_BLOCKED it with a class and a reason, which releases the slot.',
      held,
    };
  }
  return { ok: true, why: 'no active work in flight' };
}

/**
 * Is this a real block, or an abandonment wearing a label?
 *
 * A WORKER MAY NOT SIMPLY WALK AWAY. The slot is released on the strength of
 * what is recorded here, so if a bare "blocked" were enough, the WIP limit
 * would cost nothing to evade and the board would fill with tasks nobody owns
 * and nobody can act on.
 *
 * A DEPENDENCY or COLLISION block must additionally name WHAT it is blocked
 * on -- those are the two classes that assert something about other work, and
 * an unnamed dependency cannot be watched for clearing, so the task would
 * never come back.
 */
export function validateBlock(block) {
  const errors = [];
  const cls = str(block?.block_class);

  if (!cls) errors.push('block_class is required');
  else if (!BLOCK_CLASSES.includes(cls)) {
    errors.push(`block_class must be one of ${BLOCK_CLASSES.join(', ')} — got "${cls}"`);
  }

  if (!str(block?.reason)) {
    errors.push('reason is required: the slot is released on the strength of this, and a block '
      + 'nobody can read is an abandoned task');
  }

  if ((cls === 'DEPENDENCY' || cls === 'COLLISION') && !str(block?.blocked_on)) {
    errors.push(`a ${cls} block must name what it is blocked on, or nothing can notice it clearing`);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * The state transition for a valid block, and the slot it frees.
 *
 * Returns the new state rather than applying it: this module decides, the
 * caller stores. An invalid block does NOT transition -- the task stays
 * WORKING and the worker stays at its limit, because releasing a slot on an
 * unrecorded reason is the evasion the validation exists to stop.
 */
export function applyBlock({ task, block } = {}) {
  const check = validateBlock(block);
  if (!check.ok) {
    return { ok: false, state: task?.state ?? null, slotReleased: false, errors: check.errors };
  }
  if (!consumesSlot(task?.state)) {
    return {
      ok: false,
      state: task?.state ?? null,
      slotReleased: false,
      errors: [`only active work can be blocked; this task is ${task?.state ?? '(no state)'}`],
    };
  }
  return { ok: true, state: 'BLOCKED', slotReleased: true, errors: [] };
}
