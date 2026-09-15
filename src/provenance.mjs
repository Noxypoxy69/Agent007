import { matchesAny } from './laneRegistry.mjs';

/**
 * Session provenance and delegation contracts.
 *
 * TWO THINGS GIT CANNOT RECORD, both of which cost real time today.
 *
 * 1. WHO WROTE A COMMIT. Four commits landed on one branch in seventeen
 *    minutes from three different agent sessions, every one of them authored
 *    AND committed as the same shared account identity. One was an accidental
 *    amend of another session's work -- a session read `git log -1`, expected
 *    its own commit, found a stranger's, and amended it. `git log` shows four
 *    commits by one person. The provenance was recoverable only because three
 *    sessions happened to compare notes in prose, and the integrator who had
 *    to reconcile two shared choke-point files would otherwise have had no way
 *    to know to ask.
 *
 * 2. WHO AGREED TO WHAT. When one session delegates a bounded task to another
 *    -- start from this SHA, own these files, never touch those -- that
 *    contract lives in a chat message. So "did B honour the boundary?" is
 *    answered by a human reading a diff and remembering what was agreed.
 *
 * A DELEGATION IS A CHECKABLE CONTRACT, NOT A NOTE. Because the record carries
 * allowed_paths and forbidden_paths, auditing the return is COMPUTED:
 * auditChangedPaths() takes the files the delegate actually changed and reports
 * violations. That is the difference between recording an agreement and
 * enforcing one, and it is the only reason this file is worth more than a
 * comment in a handoff document.
 *
 * GLOBS COME FROM laneRegistry. matchesAny() is imported rather than
 * reimplemented: two glob engines that disagree about `**` would mean the
 * contract B was audited against is not the contract B was given.
 *
 * PURE. No filesystem, no git, no clock -- callers pass `now`. The store layer
 * is thin and separate, so every rule here is testable with a literal.
 */

export const DELEGATION_STATES = ['assigned', 'returned', 'accepted', 'rejected', 'withdrawn'];

/**
 * Legal lifecycle. Anything absent is refused.
 *
 * `accepted` and `rejected` are terminal, and reachable only from `returned`.
 * A lead cannot accept work that was never handed back -- that would let an
 * audit be recorded for a SHA nobody produced, which is exactly the shape of
 * claiming a check passed without running it.
 */
export const TRANSITIONS = {
  assigned: ['returned', 'withdrawn'],
  returned: ['accepted', 'rejected'],
  accepted: [],
  rejected: ['returned'],   // delegate fixes and hands back again
  withdrawn: [],
};

const SHA = /^[0-9a-f]{7,40}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Build a delegation record. Does not validate; call validateDelegation. */
export function createDelegation({
  id, assigning_session, assigned_session, task, lane_id = null, base_sha,
  allowed_paths = [], forbidden_paths = [], shared_paths = [], notes = null, now = null,
}) {
  return {
    id,
    assigning_session,
    assigned_session,
    task,
    lane_id,
    base_sha,
    allowed_paths: [...allowed_paths],
    forbidden_paths: [...forbidden_paths],
    shared_paths: [...shared_paths],
    notes,
    state: 'assigned',
    head_sha: null,
    audit: null,
    history: [{ state: 'assigned', at: now }],
  };
}

export function validateDelegation(d) {
  const errors = [];
  const req = (k, re, what) => {
    const v = d?.[k];
    if (typeof v !== 'string' || !v.length) errors.push(`${k} is required`);
    else if (re && !re.test(v)) errors.push(`${k} "${v}" is not a valid ${what}`);
  };

  req('id', ID, 'id');
  req('assigning_session', ID, 'session id');
  req('assigned_session', ID, 'session id');
  req('base_sha', SHA, 'git sha');
  if (typeof d?.task !== 'string' || !d.task.trim()) errors.push('task is required');

  // A session delegating to itself is not a contract, it is a note to self, and
  // recording it as a handoff would make the provenance trail lie about how
  // many workers touched the branch.
  if (d?.assigning_session && d.assigning_session === d.assigned_session) {
    errors.push('assigning_session and assigned_session are the same session');
  }

  if (!DELEGATION_STATES.includes(d?.state)) errors.push(`unknown state "${d?.state}"`);
  if (d?.head_sha != null && !SHA.test(String(d.head_sha))) {
    errors.push(`head_sha "${d.head_sha}" is not a valid git sha`);
  }

  for (const k of ['allowed_paths', 'forbidden_paths', 'shared_paths']) {
    if (!Array.isArray(d?.[k])) errors.push(`${k} must be an array`);
  }

  // A path both allowed and forbidden cannot be audited either way. Forbidden
  // wins at audit time, so an overlap silently narrows what the delegate was
  // actually permitted -- say so in the file rather than at review.
  for (const p of d?.allowed_paths ?? []) {
    if ((d.forbidden_paths ?? []).includes(p)) {
      errors.push(`"${p}" is listed as both allowed and forbidden`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Apply a lifecycle event. Returns a NEW record; never mutates the input.
 *
 * Returning a new object matters because a caller holding the old record after
 * a rejected transition must still see the old state -- an in-place mutation
 * that half-applied would leave a contract in a state no transition produced.
 */
export function transition(d, next, { head_sha = null, audit = null, now = null } = {}) {
  const allowed = TRANSITIONS[d?.state];
  if (!allowed) return { ok: false, errors: [`record is in unknown state "${d?.state}"`] };
  if (!allowed.includes(next)) {
    return { ok: false, errors: [`cannot go from "${d.state}" to "${next}" (allowed: ${allowed.join(', ') || 'none'})`] };
  }
  if (next === 'returned') {
    if (!head_sha || !SHA.test(String(head_sha))) {
      return { ok: false, errors: ['returning requires a valid head_sha'] };
    }
    if (String(head_sha) === String(d.base_sha)) {
      // Handing back the base SHA means nothing was committed. Accepting it
      // would record an audited delivery of an empty diff.
      return { ok: false, errors: ['head_sha equals base_sha: nothing was committed'] };
    }
  }
  if ((next === 'accepted' || next === 'rejected') && !d.head_sha && !head_sha) {
    return { ok: false, errors: [`cannot ${next} a delegation that was never returned`] };
  }

  return {
    ok: true,
    record: {
      ...d,
      state: next,
      head_sha: head_sha ?? d.head_sha,
      audit: audit ?? d.audit,
      history: [...d.history, { state: next, at: now }],
    },
  };
}

/**
 * THE AUDIT. Did the delegate stay inside the contract?
 *
 * Precedence is forbidden > allowed, deliberately. A file that appears in both
 * lists is treated as forbidden, so an ambiguous contract fails closed rather
 * than granting the wider permission. validateDelegation reports the overlap
 * separately so it gets fixed rather than relied on.
 *
 * An empty allowed_paths means "no allow-list", not "nothing is allowed". A
 * contract that forbids a few files and says nothing else is a normal and
 * useful shape; reading it as a total prohibition would make every such
 * delegation fail its own audit.
 */
export function auditChangedPaths(d, changedPaths) {
  const violations = [];
  for (const p of changedPaths) {
    if (matchesAny(p, d.forbidden_paths)) {
      violations.push({ path: p, reason: 'forbidden', detail: 'explicitly outside this delegation' });
      continue;
    }
    if (d.allowed_paths.length && !matchesAny(p, d.allowed_paths)) {
      violations.push({ path: p, reason: 'outside-allowed', detail: 'not in the delegation allow-list' });
    }
  }
  const shared = changedPaths.filter((p) => matchesAny(p, d.shared_paths));
  return {
    ok: violations.length === 0,
    violations,
    shared,                       // reported, never auto-failed: policy is the lead's
    checked: changedPaths.length,
  };
}

// ── commit attribution ──────────────────────────────────────────────────────

/**
 * Attribute a commit to a session, because git cannot.
 *
 * Deliberately NOT derived from git author/committer: on this machine every
 * agent commits as the same account, so those fields carry no information at
 * all. This is an assertion by a session about its own work, and it is stored
 * beside the machine's own state rather than in the repository -- it is
 * coordination data, not project history.
 */
export function attributeCommit({ sha, session_id, agent_id = null, lane_id = null, delegation_id = null, now = null }) {
  return { sha, session_id, agent_id, lane_id, delegation_id, at: now };
}

export function validateAttribution(a) {
  const errors = [];
  if (!SHA.test(String(a?.sha ?? ''))) errors.push(`sha "${a?.sha}" is not a valid git sha`);
  if (!ID.test(String(a?.session_id ?? ''))) errors.push('session_id is required');
  return { ok: errors.length === 0, errors };
}

/**
 * Commits claimed by more than one session.
 *
 * Not hypothetical: c3a6313 was committed by one session and amended by
 * another, and both could reasonably claim it. A conflicting claim is a
 * question for a person, so it is surfaced rather than resolved by last-write.
 */
export function conflictingAttributions(list) {
  const bySha = new Map();
  for (const a of list) {
    const k = String(a.sha);
    if (!bySha.has(k)) bySha.set(k, new Set());
    bySha.get(k).add(a.session_id);
  }
  return [...bySha.entries()]
    .filter(([, s]) => s.size > 1)
    .map(([sha, s]) => ({ sha, sessions: [...s] }));
}

/** Provenance for a branch: who touched it, and under which delegations. */
export function summariseProvenance(attributions, shas) {
  const wanted = new Set(shas.map(String));
  const rows = attributions.filter((a) => wanted.has(String(a.sha)));
  return {
    commits: shas.length,
    attributed: rows.length,
    unattributed: shas.filter((s) => !rows.some((r) => String(r.sha) === String(s))),
    sessions: [...new Set(rows.map((r) => r.session_id))].sort(),
    delegations: [...new Set(rows.map((r) => r.delegation_id).filter(Boolean))].sort(),
  };
}
