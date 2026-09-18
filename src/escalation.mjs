/**
 * THE PRE-FLIGHT EVERY ESCALATION GOES THROUGH.
 *
 * The Owner Decision Ledger already answers "has the builder decided this?" and
 * `agentbridge ask` already exposes it. What nothing enforced is the step
 * AFTER: a worker that gets `no_decision` asks the builder, and so does the
 * next worker, and the next. The ledger stops the same question being asked
 * twice across TIME; it does nothing about the same question being asked five
 * times in the same ten minutes, which is the shape that actually happens when
 * five agents start at once.
 *
 * So an escalation is itself a record. The first worker to hit `no_decision`
 * opens one; every later worker asking the same thing is told it is already
 * open, by whom, and how long ago -- and does not ask again.
 *
 * THIS MODULE IS PURE. Clock and ledgers arrive as arguments, so "was this
 * already asked" is testable without a filesystem and without waiting.
 *
 * WHY AN OPEN ESCALATION EXPIRES. A question asked eight hours ago that the
 * builder never answered is not a reason to stay silent forever -- they may
 * simply have missed it. After the window it may be raised again, and the
 * record shows it was re-raised rather than asked fresh.
 */

export const OUTCOMES = ['allowed', 'denied', 'owner_required', 'escalate', 'already_escalated'];

/** Past this, an unanswered question may be raised again. */
export const REASK_AFTER_MS = 60 * 60 * 1000;

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * Two escalations are "the same question" when the action and the scope match.
 *
 * NOT the question TEXT. Two workers will phrase the same question differently
 * -- that is what makes duplicates hard to spot by eye and easy to spot by
 * key. Matching on prose would let a reworded question through, which is
 * exactly the duplicate this exists to stop.
 */
export function escalationKey(action, context = {}) {
  const part = (v) => (nonEmpty(v) ? v.trim() : '-');
  return [
    part(action),
    part(context.project),
    part(context.repo),
    part(context.lane),
    part(context.task),
  ].join('|');
}

/** Open = raised, not yet answered, and not yet stale. */
export function openEscalations(escalations, { now, reaskAfterMs = REASK_AFTER_MS } = {}) {
  const n = Date.parse(now);
  if (Number.isNaN(n)) throw new TypeError('openEscalations requires a valid `now`');

  return arr(escalations).filter((e) => {
    if (!e || e.answered_at) return false;
    const at = Date.parse(e.asked_at);
    if (Number.isNaN(at)) return false;
    const age = n - at;
    return age >= 0 && age <= reaskAfterMs;
  });
}

/**
 * MAY THIS WORKER PUT THIS QUESTION TO THE BUILDER?
 *
 * @param {object} args
 *   decisions    the owner decision ledger
 *   escalations  the escalation ledger
 *   action       classified action, e.g. "deploy.production"
 *   context      {project, repo, lane, task}
 *   now          ISO timestamp
 *   resolve      the owner-decision resolver, injected
 *
 * Returns the resolver's own outcome when the ledger answers, and otherwise
 * either `escalate` (ask, and record it) or `already_escalated` (do not ask).
 */
export function preflight({
  decisions = [], escalations = [], action, context = {}, now,
  resolve, reaskAfterMs = REASK_AFTER_MS,
}) {
  if (typeof resolve !== 'function') {
    // The resolver is injected so this module never carries a second copy of
    // the precedence rules. Missing it is a wiring fault, not a question to
    // answer optimistically.
    throw new TypeError('preflight requires the owner-decision resolver');
  }

  const decided = resolve(decisions, action, context);

  /*
   * A DECIDED QUESTION IS NEVER ESCALATED, INCLUDING owner_required.
   *
   * owner_required is itself an answer: the builder has already said this
   * always needs them. It goes to them as an escalation of the ACTION, not as
   * a question about policy -- and it is not deduplicated, because "may I do
   * this specific thing now" is a different question each time it is asked.
   */
  if (decided.outcome !== 'no_decision') {
    return { outcome: decided.outcome, decision: decided, escalation: null };
  }

  const key = escalationKey(action, context);
  const open = openEscalations(escalations, { now, reaskAfterMs })
    .find((e) => escalationKey(e.action, e.context ?? {}) === key);

  if (open) {
    const ageMs = Date.parse(now) - Date.parse(open.asked_at);
    return {
      outcome: 'already_escalated',
      decision: decided,
      escalation: open,
      reason: `already asked by ${open.asked_by} ${Math.round(ageMs / 1000)}s ago and still unanswered`
        + ' — do not ask again; wait for the answer, which will be recorded as a decision',
    };
  }

  return {
    outcome: 'escalate',
    decision: decided,
    escalation: null,
    reason: 'nobody has asked this yet — ask ONCE, then record the answer with `agentbridge owner-decide`',
  };
}

/**
 * Build an escalation record. The caller supplies the clock.
 *
 * The QUESTION TEXT is stored even though matching ignores it: the builder has
 * to read something, and the next worker needs to see how it was put so it can
 * recognise the answer when it lands.
 */
export function createEscalation({ escalation_id, action, context = {}, question, asked_by, asked_at }) {
  const errors = [];
  if (!nonEmpty(escalation_id)) errors.push('escalation_id is required');
  if (!nonEmpty(action)) errors.push('action is required');
  if (!nonEmpty(question)) errors.push('question is required — the builder has to read something');
  if (!nonEmpty(asked_by)) errors.push('asked_by is required');
  if (!nonEmpty(asked_at)) errors.push('asked_at is required');

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    record: {
      escalation_id,
      action: action.trim(),
      context: {
        project: context.project ?? null,
        repo: context.repo ?? null,
        lane: context.lane ?? null,
        task: context.task ?? null,
      },
      question: question.trim(),
      asked_by,
      asked_at,
      answered_at: null,
      decision_id: null,
    },
  };
}

/**
 * Close an escalation because the builder answered it.
 *
 * The answer is a DECISION id, not prose. An escalation closed with "yes, go
 * ahead" in free text would leave the next worker to interpret it; closed with
 * a decision id, the next worker gets `allowed` from the ledger and never asks
 * at all. That is the whole loop.
 */
export function answerEscalation(escalation, { decision_id, at }) {
  if (!escalation) return { ok: false, errors: ['no such escalation'] };
  if (escalation.answered_at) {
    return { ok: false, errors: [`already answered at ${escalation.answered_at}`] };
  }
  if (!nonEmpty(decision_id)) {
    return {
      ok: false,
      errors: ['an escalation is closed with a decision id, not prose: '
        + 'record the answer with `owner-decide` first, then close this with its id'],
    };
  }
  if (!nonEmpty(at)) return { ok: false, errors: ['a timestamp is required'] };

  return { ok: true, record: { ...escalation, answered_at: at, decision_id } };
}
