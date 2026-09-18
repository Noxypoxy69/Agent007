/**
 * THE OWNER DECISION LEDGER — "tell your AI team once".
 *
 * A builder running five agents answers the same question five times. Worse,
 * each agent asks slightly differently, so the builder's answers drift, and no
 * agent can tell an answer it was given from an answer somebody else was given.
 * The authority is real but it lives in five separate conversations and dies
 * with each of them.
 *
 * This is the durable, append-only record of what the builder has already
 * decided, and the resolution rules every worker consults BEFORE putting a
 * question in front of them. A decision is stated once and every connected
 * worker inherits it, including workers that join afterwards.
 *
 * THIS MODULE IS PURE. No filesystem, no network, no clock, no randomness.
 * Every timestamp arrives as an argument. That is what lets the precedence
 * rules -- the part where a mistake quietly widens someone's authority -- be
 * tested exhaustively and offline.
 *
 * THE RULE THAT MATTERS MOST: never infer broader authority from a narrow
 * approval. A builder approving "deploy staging for task-123" has approved
 * exactly that. Not deploying staging for task-124, not deploying production,
 * not deploying. Every widening in this file is refused by construction rather
 * than by a reviewer noticing, because the failure is silent and the blast
 * radius is the builder's production system.
 */

/** Narrower beats broader. The number IS the precedence. */
export const SCOPE_PRECEDENCE = { bridge: 0, project: 1, repo: 2, lane: 3, task: 4 };
export const SCOPE_TYPES = Object.keys(SCOPE_PRECEDENCE);

export const EFFECTS = ['allow', 'deny', 'require_owner'];

/** What a worker gets back. Anything but `allowed` means do not proceed. */
export const OUTCOMES = ['allowed', 'denied', 'owner_required', 'no_decision'];

/** Which context key each scope type is keyed by. `bridge` is unkeyed. */
const SCOPE_KEY = { project: 'project', repo: 'repo', lane: 'lane', task: 'task' };

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * WHO THE OWNER ACTUALLY IS — the fact the authorship check was missing.
 *
 * `validateDecision` used to require `created_by === owner_id` and nothing
 * more. Both fields arrive on the same record from the same caller, so that
 * compares a claim against itself: a coordinator writing
 * `{owner_id: "c8", created_by: "c8"}` satisfied it exactly as well as the
 * owner did, and walked away with whatever capabilities it typed. Closing the
 * forgery of the NAME `danny` -- which is what binding created_by to the
 * authenticated token label achieved -- left minting under a DIFFERENT name
 * completely open. An identity check that never leaves the record cannot
 * anchor anything.
 *
 * MEASURED IN THE LIVE LEDGER, 2026-09-18, not hypothesised: of 33 decisions,
 * two carry `owner_id: "main"` / `created_by: "main"`, and
 * `d-review-ruling-t-wire-gate-scripts-corrected-20260917` was ACTIVE and
 * granting `review.accept` at repo scope. Nobody called `main` is the owner.
 * It validated because its two self-declared fields agreed.
 *
 * ALIASES ARE INCLUDED because `canonicalActor` resolves `owner` to `danny`,
 * so a record saying `owner` means the same person and must not be voided by
 * this check. What is refused is a name that is not the owner under ANY
 * spelling.
 *
 * WHY A LOCAL CONSTANT RATHER THAN AN IMPORT. This module's header promises it
 * is pure -- no filesystem, no network, no clock -- and `src/coordination.mjs`
 * reaches `liveRegistry.mjs`. So the roster arrives as an argument, the way
 * every timestamp in this file already does, and the default is declared here.
 * The duplication that buys is held down by a gate rather than by memory:
 * `test/ownerIdentityMatchesRoster.test.mjs` derives the owners from `ACTORS`
 * on BOTH surfaces and fails if either list drifts.
 */
export const OWNER_IDS = Object.freeze(['danny', 'owner']);

/**
 * Is this name the owner, under any spelling the roster recognises?
 *
 * Case- and whitespace-insensitive, because `Danny` and ` danny ` are the same
 * person and a validity check that turns on capitalisation is a trap, not a
 * control.
 */
export function isOwnerId(value, owners = OWNER_IDS) {
  if (!isNonEmptyString(value)) return false;
  const want = value.trim().toLowerCase();
  return owners.some((o) => isNonEmptyString(o) && o.trim().toLowerCase() === want);
}

/**
 * Does a declared capability cover a requested action?
 *
 * STRICT BY DESIGN, AND THIS IS THE WIDENING GUARD. Only three forms match:
 *
 *   "*"                  everything -- must be authored deliberately
 *   "deploy.*"           any action under deploy
 *   "deploy.production"  exactly that action
 *
 * A bare "deploy" does NOT match "deploy.production". That looks pedantic until
 * you notice the alternative: prefix matching would turn an approval of
 * `deploy` (whatever the builder pictured) into authority over every action
 * whose name happens to start with those characters -- `deploy.production`
 * included, and `deployment.teardown` too. The wildcard has to be typed.
 */
export function capabilityMatches(capability, action) {
  if (!isNonEmptyString(capability) || !isNonEmptyString(action)) return false;
  const cap = capability.trim();
  const act = action.trim();
  if (cap === '*') return true;
  if (cap === act) return true;
  if (cap.endsWith('.*')) {
    const prefix = cap.slice(0, -2);
    // "deploy.*" covers "deploy.production" but NOT "deployment.teardown":
    // the dot must be a real segment boundary.
    return act.startsWith(`${prefix}.`);
  }
  return false;
}

/**
 * Is this decision addressed to the situation the worker is in?
 *
 * A scope_id that does not match is not a near miss, it is a different
 * decision. task-123's approval says nothing about task-124.
 */
export function scopeMatches(decision, context = {}) {
  const type = decision?.scope_type;
  if (type === 'bridge') return true;
  const key = SCOPE_KEY[type];
  if (!key) return false;
  const want = decision?.scope_id;
  const have = context?.[key];
  if (!isNonEmptyString(want) || !isNonEmptyString(have)) return false;
  return want === have;
}

/**
 * A decision record, validated. Returns {ok, errors}.
 *
 * AMBIGUOUS OR MALFORMED MEANS UNUSABLE, NOT LENIENT. An invalid record is
 * excluded from resolution entirely rather than being interpreted generously,
 * so a typo in a scope id can never read as a broader grant.
 */
export function validateDecision(d, { owners = OWNER_IDS } = {}) {
  const errors = [];
  if (!isPlainObject(d)) return { ok: false, errors: ['decision must be an object'] };

  if (!isNonEmptyString(d.decision_id)) errors.push('decision_id is required');
  if (!isNonEmptyString(d.owner_id)) errors.push('owner_id is required');
  else if (!isOwnerId(d.owner_id, owners)) {
    /*
     * THE ANCHOR. Without this, every check below compares the record against
     * itself and the ledger's authority is whatever the writer typed.
     */
    errors.push(`owner_id "${d.owner_id}" is not the owner: a decision can only be recorded in the owner's name, and naming somebody else does not make them one`);
  }
  if (!isNonEmptyString(d.statement)) errors.push('statement is required — the builder\'s own words are the audit');
  if (!SCOPE_TYPES.includes(d.scope_type)) errors.push(`scope_type must be one of ${SCOPE_TYPES.join(', ')}`);
  if (!EFFECTS.includes(d.effect)) errors.push(`effect must be one of ${EFFECTS.join(', ')}`);

  // Every scope but `bridge` is keyed, and an unkeyed keyed-scope is the exact
  // shape that would silently apply everywhere.
  if (d.scope_type && d.scope_type !== 'bridge' && !isNonEmptyString(d.scope_id)) {
    errors.push(`scope_type "${d.scope_type}" requires a scope_id`);
  }
  if (d.scope_type === 'bridge' && isNonEmptyString(d.scope_id)) {
    errors.push('scope_type "bridge" must not carry a scope_id — it is the whole bridge');
  }

  if (!Array.isArray(d.capabilities) || d.capabilities.length === 0) {
    errors.push('capabilities must be a non-empty array — a decision about nothing applies to everything');
  } else if (!d.capabilities.every(isNonEmptyString)) {
    errors.push('every capability must be a non-empty string');
  }

  if (d.constraints != null && !isPlainObject(d.constraints)) {
    errors.push('constraints must be an object when present');
  }

  /*
   * THE WORKER MAY NOT SPEAK FOR THE OWNER.
   *
   * created_by must BE the owner. A record authored by a worker session is not
   * a weaker decision, it is a forged one, and the whole ledger is worthless if
   * an agent can write its own permission slip.
   *
   * ON ITS OWN THIS CHECK STOPS NOTHING, and the comment that used to end here
   * claimed otherwise for three days. Both fields come off the same record from
   * the same caller, so this only ever established that the writer was
   * CONSISTENT. `{owner_id: "c8", created_by: "c8"}` passed. The check became
   * real the moment `owner_id` had to name the actual owner -- see the
   * `isOwnerId` call above, which is the half that anchors it to somebody
   * outside the record. Kept, because the two together are what make
   * `created_by` mean "the owner wrote this" rather than "these two strings
   * match".
   */
  if (!isNonEmptyString(d.created_by)) errors.push('created_by is required');
  else if (isNonEmptyString(d.owner_id) && d.created_by !== d.owner_id) {
    errors.push(`created_by "${d.created_by}" is not the owner "${d.owner_id}": a worker cannot record a decision on the owner's behalf`);
  }

  if (!isNonEmptyString(d.created_at)) errors.push('created_at is required');

  return { ok: errors.length === 0, errors };
}

/**
 * Build a decision. The caller supplies the clock; this module has none.
 */
export function createDecision({
  decision_id, owner_id, decision_type = 'policy', statement,
  scope_type, scope_id = null, effect, capabilities = [], constraints = null,
  created_by, created_at, supersedes = null,
}) {
  return {
    decision_id, owner_id, decision_type, statement,
    scope_type, scope_id: scope_type === 'bridge' ? null : scope_id,
    effect,
    capabilities: [...capabilities],
    constraints: constraints ?? {},
    created_at, created_by,
    supersedes,
    revoked_at: null,
    revoked_by: null,
    history: [{ event: 'created', at: created_at, by: created_by }],
  };
}

/**
 * Which decisions are in force right now?
 *
 * Two ways a decision stops applying, and neither erases it:
 *
 *   revoked      revoked_at is set
 *   superseded   some OTHER live decision names it in `supersedes`
 *
 * A superseded decision stays in the ledger and stays readable forever. The
 * builder must always be able to see what they originally said and what
 * changed it; a ledger that can be edited into agreeing with the present is
 * not an audit trail.
 */
export function activeDecisions(rows, { owners = OWNER_IDS } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('activeDecisions requires an array');

  const valid = rows.filter((d) => validateDecision(d, { owners }).ok);
  const notRevoked = valid.filter((d) => !d.revoked_at);

  // Only a live decision can supersede. Otherwise revoking a replacement would
  // leave the thing it replaced dead too, and the builder would be governed by
  // nothing while the ledger showed two records.
  const superseded = new Set(
    notRevoked.map((d) => d.supersedes).filter(isNonEmptyString),
  );

  return notRevoked.filter((d) => !superseded.has(d.decision_id));
}

/**
 * THE CALL EVERY WORKER MAKES BEFORE ASKING THE BUILDER ANYTHING.
 *
 * @param {Array}  rows     the whole ledger, including dead records
 * @param {string} action   the classified action, e.g. "deploy.production"
 * @param {object} context  {project, repo, lane, task} — as much as is known
 * @returns {{outcome: string, decision_id: string|null, matched_scope: string|null,
 *            reason: string, constraints: object, statement: string|null,
 *            candidates: string[]}}
 */
export function resolveOwnerDecision(rows, action, context = {}, { owners = OWNER_IDS } = {}) {
  if (!isNonEmptyString(action)) {
    // An unclassifiable action must not resolve to `allowed` by accident.
    return {
      outcome: 'owner_required', decision_id: null, matched_scope: null,
      reason: 'the requested action was not classified, so no decision can be matched',
      constraints: {}, statement: null, candidates: [],
    };
  }

  const live = activeDecisions(rows, { owners });
  const matches = live.filter((d) =>
    scopeMatches(d, context) && d.capabilities.some((c) => capabilityMatches(c, action)));

  if (matches.length === 0) {
    return {
      outcome: 'no_decision', decision_id: null, matched_scope: null,
      reason: `no owner decision covers "${action}" in this context — ask once, then record the answer`,
      constraints: {}, statement: null, candidates: [],
    };
  }

  /*
   * NARROWEST WINS, AND ONLY THE NARROWEST IS CONSULTED.
   *
   * A decision authored at task scope overrides one at repo scope for that
   * task, because somebody deliberately wrote it there. Broader decisions are
   * not blended in -- "explicit deny beats broader allow" falls straight out of
   * this, and so does its mirror, which is the one that would hurt: a narrow
   * allow never escapes into the broader scope it was written under.
   */
  const best = Math.max(...matches.map((d) => SCOPE_PRECEDENCE[d.scope_type]));
  const winners = matches.filter((d) => SCOPE_PRECEDENCE[d.scope_type] === best);
  const matched_scope = SCOPE_TYPES.find((s) => SCOPE_PRECEDENCE[s] === best);

  const effects = [...new Set(winners.map((d) => d.effect))];

  if (effects.length > 1) {
    /*
     * Two decisions at the SAME scope disagreeing is an authoring conflict, not
     * something to resolve by picking the strictest. Picking silently would
     * hide the contradiction forever; escalating is both safe and visible, and
     * the builder is the only one who can say which they meant.
     */
    return {
      outcome: 'owner_required',
      decision_id: null,
      matched_scope,
      reason: `conflicting decisions at ${matched_scope} scope (${effects.join(' vs ')}) — the owner must resolve this`,
      constraints: {},
      statement: null,
      candidates: winners.map((d) => d.decision_id),
    };
  }

  // Deterministic pick among identical effects: newest wins, ties by id, so
  // two workers resolving the same question cite the same decision_id.
  const chosen = [...winners].sort((a, b) =>
    String(b.created_at).localeCompare(String(a.created_at))
    || String(a.decision_id).localeCompare(String(b.decision_id)))[0];

  const outcome = { allow: 'allowed', deny: 'denied', require_owner: 'owner_required' }[chosen.effect];

  return {
    outcome,
    decision_id: chosen.decision_id,
    matched_scope,
    reason: `${matched_scope}-scoped decision ${chosen.decision_id}: ${chosen.statement}`,
    constraints: chosen.constraints ?? {},
    statement: chosen.statement,
    candidates: winners.map((d) => d.decision_id),
  };
}

/**
 * Revoke, without erasing.
 *
 * revoked_at is the one field that changes after creation, and the original
 * statement, author and timestamp are never touched. The history array records
 * the revocation beside the creation.
 */
export function revokeDecision(d, { at, by, reason = null }) {
  if (!isPlainObject(d)) return { ok: false, errors: ['no such decision'] };
  if (d.revoked_at) return { ok: false, errors: [`decision ${d.decision_id} was already revoked at ${d.revoked_at}`] };
  if (!isNonEmptyString(at) || !isNonEmptyString(by)) {
    return { ok: false, errors: ['revocation requires a timestamp and an author'] };
  }
  if (isNonEmptyString(d.owner_id) && by !== d.owner_id) {
    return { ok: false, errors: [`"${by}" is not the owner "${d.owner_id}": a worker cannot revoke the owner's decision`] };
  }
  return {
    ok: true,
    record: {
      ...d,
      revoked_at: at,
      revoked_by: by,
      history: [...(d.history ?? []), { event: 'revoked', at, by, reason }],
    },
  };
}
