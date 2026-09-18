/**
 * LEAD WORK — provenance for work nobody delegated.
 *
 * The delegation ledger refuses a contract whose assigning_session equals its
 * assigned_session, and that guard is correct: a contract to yourself is not a
 * handoff, and pretending otherwise would let anyone manufacture the appearance
 * of oversight by delegating to themselves.
 *
 * But the integrator does real work -- wiring, integration, the corrections
 * nobody else is allowed to touch -- and with self-delegation forbidden, all of
 * it was falling out of provenance entirely. On 2026-09-15 the runtime
 * registration enforcement shipped with no contract and no audit, which is
 * exactly the gap this project keeps catching in others.
 *
 * The owner's ruling: lead work needs a record, but not a fake handoff. So this
 * is a first-class record type that says plainly what it is -- work performed
 * directly by the current lead -- rather than a contract wearing a disguise.
 *
 * APPEND-ONLY, like the ledgers it sits beside. A record of what was done is
 * worthless if it can be edited into agreeing with what was later wished.
 *
 * PURE. The clock and the git resolver are parameters.
 */

export const REQUIRED_FIELDS = [
  'work_id', 'agent_id', 'session_id', 'repo_id',
  'base_sha', 'head_sha', 'scope', 'created_at',
];

const SHA = /^[0-9a-f]{40}$/i;
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * Build a lead-work record. Returns {ok, record} or {ok:false, errors}.
 *
 * BOTH SHAS ARE REQUIRED AND MUST DIFFER. A record whose head equals its base
 * describes an empty diff, which is not work -- and recording one would put a
 * claim of effort into the ledger with nothing behind it. The delegation
 * lifecycle refuses the same shape when a delegate returns head == base; the
 * rule is identical here because the reason is.
 */
export function createLeadWork(input = {}) {
  const errors = [];
  const rec = {
    kind: 'lead_work',
    work_id: input.work_id ?? null,
    agent_id: input.agent_id ?? null,
    session_id: input.session_id ?? null,
    repo_id: input.repo_id ?? null,
    base_sha: input.base_sha ?? null,
    head_sha: input.head_sha ?? null,
    scope: isNonEmptyString(input.scope) ? input.scope.trim() : '',
    files_changed: Array.isArray(input.files_changed) ? [...input.files_changed] : [],
    tests: input.tests ?? null,
    created_at: input.created_at ?? null,
  };

  for (const f of REQUIRED_FIELDS) {
    if (!isNonEmptyString(rec[f])) errors.push(`${f} is required`);
  }

  for (const f of ['base_sha', 'head_sha']) {
    if (isNonEmptyString(rec[f]) && !SHA.test(rec[f])) {
      errors.push(`${f} must be a full 40-character sha, resolved through git and never typed`);
    }
  }

  if (isNonEmptyString(rec.base_sha) && rec.base_sha === rec.head_sha) {
    errors.push('head_sha equals base_sha: nothing was committed, so there is no work to record');
  }

  if (!rec.files_changed.length) {
    errors.push('files_changed is required — a record naming no files cannot be audited');
  }

  /*
   * NOT A DELEGATION, AND IT MUST NOT BE READABLE AS ONE. A caller passing
   * assigning/assigned sessions is trying to express a handoff through the
   * wrong record type, which is the workaround the ruling forbids.
   */
  if (input.assigning_session || input.assigned_session) {
    errors.push('lead_work records no assigning/assigned session: it is not a handoff. '
      + 'Use `delegate` for work given to somebody else.');
  }

  return errors.length ? { ok: false, errors } : { ok: true, record: rec };
}

/**
 * Append a record, or refuse. Returns NEW rows; never mutates the input.
 *
 * Mirrors applySupersession deliberately: a rejected record must not half-land,
 * so nothing touches disk until the caller has the whole verdict.
 */
export function appendLeadWork(rows, input) {
  const list = Array.isArray(rows) ? rows : [];
  const built = createLeadWork(input);
  if (!built.ok) return { ok: false, errors: built.errors, rows: list };

  if (list.some((r) => r?.work_id === built.record.work_id)) {
    return {
      ok: false,
      errors: [`a lead_work record "${built.record.work_id}" already exists; these are append-only`],
      rows: list,
    };
  }

  return { ok: true, errors: [], record: built.record, rows: [...list, built.record] };
}

/** Every lead_work record for a session, newest first. */
export function leadWorkFor(rows, sessionId) {
  if (!Array.isArray(rows)) throw new TypeError('leadWorkFor requires an array');
  return rows
    .filter((r) => r?.kind === 'lead_work' && r?.session_id === sessionId)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}
