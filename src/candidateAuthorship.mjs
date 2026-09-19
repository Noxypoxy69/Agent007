/**
 * P0-1: WHO MADE THIS CANDIDATE, ACCORDING TO AGENT007 RATHER THAN THE AUTHOR.
 *
 * ═══ WHY THIS EXISTS: THE TRAILER CANNOT DO THE JOB ═══
 *
 * The audit queue refuses a claimant that matches the candidate's
 * `Claude-Session:` trailer. That catches the honest mistake and nothing else,
 * because THE AUTHOR WRITES THAT TRAILER. It can carry any session string,
 * including another agent's, and the comparison then passes. Author-controlled
 * evidence cannot establish that a reviewer is not the author -- it is the
 * proxy rule 4 is about, and relying on it would rebuild the trust problem
 * Layer 0 exists to remove.
 *
 * So authorship is bound HERE, at candidate creation, from the active
 * authenticated session -- a thing the author does not get to type. The trailer
 * stays, and is demoted to what it always was: human-readable provenance that
 * may MIRROR the record and can never substitute for it.
 *
 * ═══ THE ONE PROPERTY THAT MAKES IT AUTHORITATIVE ═══
 *
 * FIRST BINDING WINS, AND A CONFLICTING REBIND IS REFUSED. Without that, an
 * author who later wanted to audit its own candidate could simply re-bind it to
 * somebody else's principal and become eligible. The store is append-only and
 * `bindAuthorship` compares against what is already recorded: identical is an
 * idempotent no-op, different is a refusal that names both sides. That refusal
 * is the whole security argument; everything else here is bookkeeping.
 *
 * ═══ AND IT REFUSES TO OVERSTATE ITSELF ═══
 *
 * `identity_source` records HOW the author identity was obtained, and only a
 * caller that genuinely resolved a credential may pass 'credential'. Today
 * nothing on this machine can: no session starts through the launcher, so
 * AGENTBRIDGE_AGENT_ID is unset and there is no authenticated principal. Every
 * record written now is therefore 'observed', which is honest and is NOT
 * sufficient to make an audit gate-satisfying. A field that said 'credential'
 * because the caller asked nicely would be worse than no field.
 *
 * PURE. No filesystem, no clock, no git -- the caller measures and passes
 * readings in. Rule 10, and the only reason the interesting case is testable:
 * no test can make a real author re-bind a real candidate, but any test can
 * hand this two records that disagree.
 */

const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const sha40 = (v) => {
  const s = str(v);
  return s && /^[0-9a-f]{40}$/i.test(s) ? s.toLowerCase() : null;
};

/**
 * How the author identity reached this record.
 *
 *   credential  resolved from an authenticated principal and a live session
 *               registration. The only value that can make a later audit
 *               gate-satisfying.
 *   observed    taken from the environment or the process without an
 *               authenticated principal behind it. Useful, attributable,
 *               and not proof.
 */
export const IDENTITY = Object.freeze({ CREDENTIAL: 'credential', OBSERVED: 'observed' });

/**
 * Bind a candidate to the party that produced it.
 *
 * @param {object} input
 * @param {object|null} existing   what the store already holds for this candidate
 * @returns {{ok:true, record:object, unchanged?:boolean} | {ok:false, errors:string[]}}
 */
export function bindAuthorship(input = {}, { existing = null, now = null } = {}) {
  const {
    candidate_sha, candidate_tree_sha, base_sha,
    session_id, principal_id, worker_id,
    task_id, attempt, lease_token, identity_source,
  } = input;

  const errors = [];
  const record = {
    candidate_sha: sha40(candidate_sha),
    candidate_tree_sha: sha40(candidate_tree_sha),
    base_sha: sha40(base_sha),

    /* WHO. The author identity, and how it was obtained. */
    session_id: str(session_id),
    principal_id: str(principal_id),
    worker_id: str(worker_id),
    identity_source: identity_source === IDENTITY.CREDENTIAL ? IDENTITY.CREDENTIAL : IDENTITY.OBSERVED,

    /* UNDER WHAT AUTHORITY. Absent for work nobody leased, which is most of it. */
    task_id: str(task_id),
    attempt: Number.isInteger(attempt) ? attempt : null,
    lease_token: str(lease_token),

    created_at: str(now),
  };

  if (!record.candidate_sha) errors.push('candidate_sha is required and must be a full 40-hex sha');
  if (!record.candidate_tree_sha) {
    errors.push('candidate_tree_sha is required: a commit and its content are different claims, '
      + 'and a rebase or an amend produces one without the other');
  }
  /*
   * AN AUTHOR WITH NO IDENTITY IS NOT A RECORD. The entire purpose is to be
   * able to say later that a reviewer is not this party; a row that names
   * nobody cannot support that and would read as though it did.
   */
  if (!record.session_id && !record.principal_id) {
    errors.push('session_id or principal_id is required: a candidate whose author cannot be named '
      + 'cannot later be shown independent of its reviewer');
  }
  if (attempt !== undefined && attempt !== null && record.attempt === null) {
    errors.push('attempt was supplied but is not an integer');
  }
  if (base_sha !== undefined && base_sha !== null && record.base_sha === null) {
    errors.push('base_sha was supplied but is not a full 40-hex sha');
  }
  /*
   * A LEASE WITHOUT ITS TASK AND ATTEMPT IS NOT AN AUTHORITY REFERENCE. It is
   * a token with nothing to check it against -- the same reason the terminal
   * write fence names all three.
   */
  if (record.lease_token && (!record.task_id || record.attempt === null)) {
    errors.push('a lease_token needs its task_id and attempt, or it references no authority');
  }
  if (errors.length) return { ok: false, errors };

  if (!existing) return { ok: true, record };

  /*
   * ═══ FIRST BINDING WINS ═══
   *
   * An identical re-bind is a no-op: a runtime that retries must not be forced
   * to care whether it already recorded this. A DIFFERENT one is refused, and
   * this is the refusal the whole module exists for -- rebinding a candidate to
   * another principal is how an author would make itself eligible to audit its
   * own work.
   */
  const BOUND = ['session_id', 'principal_id', 'worker_id', 'task_id', 'attempt', 'lease_token', 'candidate_tree_sha'];
  const differs = BOUND.filter((k) => String(existing[k] ?? '') !== String(record[k] ?? ''));
  if (differs.length === 0) return { ok: true, record: existing, unchanged: true };

  return {
    ok: false,
    errors: [`${record.candidate_sha.slice(0, 8)} is already bound to a different author and cannot be re-bound: `
      + `${differs.map((k) => `${k} was ${JSON.stringify(existing[k] ?? null)}, now ${JSON.stringify(record[k] ?? null)}`).join('; ')}. `
      + 'Re-binding a candidate to another principal is how an author becomes eligible to audit its own work'],
  };
}

/**
 * The author identity an independence check should compare against.
 *
 * Returns { id, source } or null. `source` is what decides whether a later
 * audit can be gate-satisfying, so it is carried rather than flattened -- a
 * caller that only got the id would have to guess, and guessing in the
 * permissive direction is the failure this is built to prevent.
 */
export function authorOf(record) {
  if (!record || typeof record !== 'object') return null;
  const id = str(record.principal_id) ?? str(record.session_id);
  if (!id) return null;
  return {
    id,
    source: record.identity_source === IDENTITY.CREDENTIAL ? 'authoritative' : 'observed',
  };
}

/**
 * Does this record's authorship rest on an authenticated principal?
 *
 * SEPARATE FROM authorOf, because "who was it" and "how much does that answer
 * weigh" are different questions and collapsing them is how `observed` would
 * quietly start satisfying gates.
 */
export function isAuthoritative(record) {
  return Boolean(record) && record.identity_source === IDENTITY.CREDENTIAL
    && Boolean(str(record.principal_id));
}
