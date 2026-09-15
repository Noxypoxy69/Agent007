import { resolveOwnerDecision } from './ownerDecisions.mjs';

/**
 * A PERMISSION REQUEST THAT DOES NOT NEED A HUMAN AT A KEYBOARD.
 *
 * chatgpt-work, 21:58:17Z: "interactive Claude permission prompts are a blocking
 * defect, not an owner workflow." That is the right diagnosis. A local keypress
 * is not a control, it is a person being the control -- and the person is
 * asleep, or on another machine, or doing something else, and the agent is
 * stopped until they are not.
 *
 * THE SHAPE, AND WHY IT IS THIS SHAPE.
 *
 *   1. RESOLVE EXISTING POLICY FIRST. Most requests have already been decided.
 *      Asking again is not caution, it is failing to remember -- and it teaches
 *      the owner that approvals are noise to be clicked through, which is how a
 *      real one gets clicked through too.
 *   2. ROUTE WHAT IS LEFT BY RISK, not by convenience. Routine and reversible
 *      goes to the coordinator. Irreversible, destructive, or spending goes to
 *      the owner and NOWHERE ELSE.
 *   3. DEDUPLICATE. A loop that asks sixty times produces one decision and
 *      fifty-nine interruptions.
 *   4. PAUSE ONLY THAT TASK. A worker blocked on one approval must not stop
 *      being a worker.
 *
 * WHAT THIS MODULE DOES NOT DO, AND MUST NOT.
 *
 * It does not GRANT anything. It classifies a request and says who decides.
 * The moment this file can approve its own requests, every guard downstream is
 * decoration -- the component asking for permission would be the component
 * giving it. resolveOwnerDecision reads a ledger the owner wrote; nothing here
 * writes to that ledger.
 *
 * PURE. Rows, the request, and the clock arrive as arguments.
 */

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const arr = (v) => (Array.isArray(v) ? v : []);
const ms = (v) => {
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

/**
 * RISK IS ABOUT REVERSIBILITY AND BLAST RADIUS, NOT ABOUT DIFFICULTY.
 *
 * A one-character change to production is high risk. A thousand-line refactor
 * on a branch is low. Sorting by how hard something is to do is how dangerous
 * easy things get waved through.
 */
export const RISK = Object.freeze({
  ROUTINE: 'routine',            // reversible, local, no third party sees it
  ELEVATED: 'elevated',          // reversible but visible, or touches shared state
  IRREVERSIBLE: 'irreversible',  // cannot be undone by the actor who did it
});

export const DECIDER = Object.freeze({
  POLICY: 'policy',          // already decided; proceed without asking anyone
  COORDINATOR: 'coordinator',// routine, delegated
  OWNER: 'owner',            // Danny, and nobody standing in for him
});

/**
 * THE ACTIONS THE OWNER ALONE DECIDES, BY PREFIX.
 *
 * Deliberately a DENY-BY-DEFAULT list of prefixes rather than an allow-list of
 * exact strings: a new action nobody classified must land somewhere safe, and
 * the safe place is the owner's desk. An allow-list would send the unclassified
 * action to the coordinator, which is the wrong direction to fail in.
 */
export const OWNER_ONLY_PREFIXES = Object.freeze([
  'deploy.production',
  'delete.',
  'drop.',
  'truncate.',
  'spend.',
  'rotate.',
  'revoke.',
  'customer.message',   // anything a customer receives
  'merge.main',
]);

/** Actions that are never routine even when reversible, because somebody sees them. */
export const ELEVATED_PREFIXES = Object.freeze([
  'deploy.',            // deploy.staging and friends; deploy.production is owner-only above
  'migrate.',
  'schema.',
  'sql.write',
]);

const hasPrefix = (action, list) =>
  list.some((p) => (p.endsWith('.') ? action.startsWith(p) : action === p || action.startsWith(`${p}.`)));

/**
 * Classify by risk. UNKNOWN ACTIONS ARE NOT ROUTINE.
 *
 * An action this function does not recognise is classified ELEVATED, never
 * routine. The cost of that is one extra coordinator approval; the cost of the
 * other default is a capability nobody reviewed slipping through because it was
 * new.
 */
export function riskOf(action, { reversible } = {}) {
  if (!nonEmpty(action)) return RISK.IRREVERSIBLE;
  const a = action.trim();

  if (hasPrefix(a, OWNER_ONLY_PREFIXES)) return RISK.IRREVERSIBLE;
  // An explicit reversible:false overrides any prefix match downward-to-safer.
  if (reversible === false) return RISK.IRREVERSIBLE;
  if (hasPrefix(a, ELEVATED_PREFIXES)) return RISK.ELEVATED;
  if (reversible === true) return RISK.ROUTINE;

  // Not recognised and not declared reversible: somebody looks at it.
  return RISK.ELEVATED;
}

/**
 * A stable identity for "the same request", so repeats collapse.
 *
 * KEYED ON WHAT IS BEING DECIDED, NOT ON WHEN OR BY WHOM. A worker retrying
 * after a crash asks the identical question; if the attempt number or a
 * timestamp were in the key, the owner would be asked again for a decision they
 * have already made. The task is in the key because the same action on a
 * different task IS a different decision.
 */
export function requestKey({ action, task_id = null, scope_id = null } = {}) {
  if (!nonEmpty(action)) throw new TypeError('requestKey requires an action');
  return [action.trim(), task_id ?? '-', scope_id ?? '-'].join('::');
}

/**
 * CLASSIFY ONE REQUEST: decided already, or who decides it.
 *
 * @param request  { action, task_id, scope_id, project, repo, lane, task,
 *                   reversible, arguments_summary, environment }
 * @param decisions the owner decision ledger, as rows
 */
export function classifyRequest(request, decisions, { now } = {}) {
  if (ms(now) === null) throw new TypeError('classifyRequest requires a `now` timestamp');
  if (!request || !nonEmpty(request.action)) {
    /*
     * An unclassifiable request is the OWNER's, not a failure to be retried.
     * Sending it to the coordinator would be guessing about something nobody
     * described.
     */
    return {
      decider: DECIDER.OWNER,
      risk: RISK.IRREVERSIBLE,
      reason: 'the request names no action, so nothing about it can be classified',
      key: null,
      decision_id: null,
    };
  }

  const action = request.action.trim();
  const risk = riskOf(action, { reversible: request.reversible });
  const key = requestKey(request);

  // 1. POLICY FIRST. Asking again for something already decided is failing to
  //    remember, and it trains the owner to click through.
  const resolved = resolveOwnerDecision(arr(decisions), action, {
    project: request.project,
    repo: request.repo,
    lane: request.lane,
    task: request.task ?? request.task_id,
  });

  if (resolved.outcome === 'allowed') {
    return {
      decider: DECIDER.POLICY, risk, key,
      decision_id: resolved.decision_id,
      allowed: true,
      reason: resolved.reason,
      constraints: resolved.constraints ?? {},
    };
  }
  if (resolved.outcome === 'denied') {
    return {
      decider: DECIDER.POLICY, risk, key,
      decision_id: resolved.decision_id,
      allowed: false,
      reason: resolved.reason,
      constraints: resolved.constraints ?? {},
    };
  }

  /*
   * 2. ROUTE WHAT IS LEFT. owner_required from the ledger is the owner's even
   *    if the risk class looks routine -- an explicit standing instruction
   *    outranks this function's opinion about severity.
   */
  if (resolved.outcome === 'owner_required') {
    return {
      decider: DECIDER.OWNER, risk, key,
      decision_id: resolved.decision_id,
      reason: `the owner's standing decision requires them personally: ${resolved.reason}`,
    };
  }

  if (risk === RISK.IRREVERSIBLE) {
    return {
      decider: DECIDER.OWNER, risk, key, decision_id: null,
      reason: `"${action}" is irreversible, destructive or spends money; `
        + 'the coordinator may not approve it on the owner\'s behalf',
    };
  }

  return {
    decider: DECIDER.COORDINATOR, risk, key, decision_id: null,
    reason: `"${action}" is ${risk} and no standing decision covers it; `
      + 'routine approval is delegated to the coordinator',
  };
}

/**
 * COLLAPSE REPEATS INTO ONE OUTSTANDING ASK.
 *
 * A worker in a retry loop asks the same question every attempt. The decision
 * is unchanged; only the count is news. Sending sixty identical prompts is how
 * an approval channel becomes something people mute, and a muted channel is
 * worse than no channel because it looks like it is working.
 *
 * AN ANSWERED REQUEST IS NOT OUTSTANDING. A key that already carries a decision
 * is filtered out entirely rather than shown with a count -- otherwise the list
 * of "things waiting on you" fills with things that are not.
 */
export function pendingRequests(requests, { now, windowMs = 24 * 60 * 60 * 1000 } = {}) {
  const at = ms(now);
  if (at === null) throw new TypeError('pendingRequests requires a `now` timestamp');

  const byKey = new Map();

  for (const r of arr(requests)) {
    if (!r || !nonEmpty(r.key)) continue;
    const t = ms(r.requested_at);
    if (t === null || at - t > windowMs) continue;

    const prev = byKey.get(r.key);
    if (!prev) {
      byKey.set(r.key, {
        key: r.key,
        action: r.action ?? null,
        task_id: r.task_id ?? null,
        decider: r.decider ?? null,
        risk: r.risk ?? null,
        occurrences: 1,
        first_at: r.requested_at,
        last_at: r.requested_at,
        decided: nonEmpty(r.decided_at),
        outcome: r.outcome ?? null,
      });
      continue;
    }
    prev.occurrences += 1;
    if (String(r.requested_at) < String(prev.first_at)) prev.first_at = r.requested_at;
    if (String(r.requested_at) > String(prev.last_at)) prev.last_at = r.requested_at;
    // ANY answered instance settles the key. A later repeat of a question that
    // has been answered is a caller that has not re-read, not a new ask.
    if (nonEmpty(r.decided_at)) {
      prev.decided = true;
      prev.outcome = r.outcome ?? prev.outcome;
    }
  }

  return [...byKey.values()]
    .filter((x) => !x.decided)
    // Owner first, then most recent: the owner's list is the one with a person
    // waiting at the end of it.
    .sort((a, b) => {
      if (a.decider !== b.decider) return a.decider === DECIDER.OWNER ? -1 : 1;
      return String(b.last_at).localeCompare(String(a.last_at));
    });
}

/**
 * WHICH TASK IS PAUSED, AND ONLY THAT TASK.
 *
 * "Pauses only that task while awaiting a decision" was explicit in the
 * instruction, and it is the difference between a permission system and a stop
 * button. A worker with one request outstanding on task A is still a live
 * worker for task B, and its lease on B must keep being renewed.
 *
 * A REQUEST WITH NO TASK PAUSES NOTHING. That is deliberate: a request about
 * the environment rather than a piece of work has no task to hold, and
 * inventing one would stop work that was never involved.
 */
export function pausedTasks(requests, { now } = {}) {
  const at = ms(now);
  if (at === null) throw new TypeError('pausedTasks requires a `now` timestamp');

  const paused = new Set();
  for (const r of arr(requests)) {
    if (!r || nonEmpty(r.decided_at)) continue;
    if (!nonEmpty(r.task_id)) continue;
    paused.add(r.task_id);
  }
  return [...paused].sort();
}

/**
 * MAY THIS CALLER ANSWER THIS REQUEST?
 *
 * PURE, AND IN src/ FOR A SPECIFIC REASON. The first version of this guard
 * lived inside the edge function, where the test suite cannot import it -- the
 * same position as confirm_proposal, which was listed, documented, scope-gated
 * and threw on every call it ever received because nothing could invoke it.
 * A guard that cannot be tested is a guard nobody has watched fail.
 *
 * THE REFUSAL IS THE FEATURE. If a coordinator could answer an owner-routed
 * request, the routing would be advisory and "irreversible actions are the
 * owner's" would be a sentence in a comment rather than a property of the
 * system.
 *
 * THE ROUTING COMES FROM THE ROW, NOT FROM THE ACTION. Recomputing it here
 * would let a later edit to OWNER_ONLY_PREFIXES silently hand the coordinator a
 * question that was escalated to the owner when it was asked, with nothing
 * recording that the routing had moved.
 *
 * @param row  the stored request
 * @param by   { decider } the authority the caller is acting with
 */
export function canDecidePermission(row, { as = DECIDER.COORDINATOR, outcome, decided_by } = {}) {
  const errors = [];

  if (!row) return { ok: false, errors: ['no such permission request'] };

  if (outcome !== 'allowed' && outcome !== 'denied') {
    errors.push('outcome must be exactly "allowed" or "denied"');
  }
  if (!nonEmpty(decided_by)) {
    // An answer nobody signed is not reviewable afterwards, and the whole point
    // of moving off a keypress was that the record survives the moment.
    errors.push('decided_by is required: an unsigned decision cannot be reviewed');
  }
  if (nonEmpty(row.decided_at)) {
    errors.push(`already decided "${row.outcome}" by ${row.decided_by} at ${row.decided_at}`);
  }
  if (row.decider !== as) {
    errors.push(
      `"${row.action}" was routed to the ${row.decider} when it was asked, and a ${as} `
      + 'may not answer it on their behalf',
    );
    if (row.decider === DECIDER.OWNER) {
      errors.push(
        'the owner answers by recording a standing decision, which settles this request AND '
        + 'stops the same question being asked again',
      );
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}
