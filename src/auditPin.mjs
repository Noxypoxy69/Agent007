/**
 * A PROCESS FINISHING DOES NOT MAKE ITS AUDIT VALID.
 *
 * An audit judges a CANDIDATE. If the tree moves while it runs, the verdict it
 * returns is about something that no longer exists -- and nothing anywhere
 * notices, because the verdict looks identical either way. That is the whole of
 * Package 2's audit-pinning requirement and the reason it is a prerequisite for
 * the finding registry: a finding must be bound to the exact candidate where it
 * was observed, and it cannot be if the candidate was never captured.
 *
 * REPRODUCED WHILE WRITING THIS, WITHOUT TRYING. I launched four audits in one
 * session against a branch three sessions were pushing to. Between assigning
 * the last piece of work and starting it, HEAD moved seven commits -- 8e9908e
 * to 4a5cedb -- and one of those audits reported the shared worktree changed
 * under it mid-pass. Every verdict tonight was returned without any check that
 * the thing judged was still the thing that existed.
 *
 * WHAT IS PINNED, and why each one is separate:
 *
 *   candidate_sha       the commit. Moves on any new commit.
 *   candidate_tree_sha  the COMMITTED content. Two different commits can carry
 *                       an identical tree (a rebase, a cherry-pick, an amend
 *                       that changed only a message), and an audit of the
 *                       content is still valid across those. Pinning the commit
 *                       alone would throw away a good verdict; pinning the tree
 *                       alone would accept a verdict about a different history.
 *   worktree_digest     THE FILES AN AUDITOR ACTUALLY READS, which is not the
 *                       same thing and was the hole in the first version of
 *                       this module. See below.
 *   base_sha            what the candidate is a change AGAINST. A verdict about
 *                       a diff is meaningless if the base moved under it.
 *
 * ═══ THE FIRST VERSION CERTIFIED A COMMIT WHILE AN AUDITOR READ A WORKING
 *     TREE, AND A BLIND AUDIT CAUGHT IT USING THIS VERY TOOL ═══
 *
 * `candidate_tree_sha` was `git rev-parse HEAD^{tree}` -- the tree of the
 * COMMIT. Nothing looked at `git status`. So uncommitted changes could land in
 * the exact files under audit and this reported OK.
 *
 * Demonstrated, not theorised: an auditor pinned a clean tree, and while it
 * read, another session put 193 changed lines into scripts/claude-stop-gate.mjs
 * and more into src/auditLedger.mjs -- both under audit. It ran
 * `audit-pin --verify` three times and got `state OK / the candidate is
 * unchanged since the audit started` every time. Its own 4/4 result on one
 * suite was, in its words, not attributable to the candidate.
 *
 * That is the precise shape this module exists to stop, in this module. An
 * auditor reads FILES, not commits, and in a shared worktree the files are the
 * thing that moves. So the working tree is measured too, and any change to it
 * is STALE.
 *
 * ═══ DECLARED FIELDS ARE RECORDED AND NOT RECHECKED, AND SAYING SO IS THE
 *     POINT ═══
 *
 * `task_id` and `attempt` cannot be measured from a repository -- there is no
 * command that reads them back. The first version compared them anyway against
 * values the VERIFIER passed in, so a pin carrying them could never be OK
 * unless the caller restated the pin's own claim, and could never be STALE for
 * a reason the caller did not choose. That is rule 4: the recheck asserted on a
 * value supplied by the party being checked.
 *
 * They are kept, because a finding must be bound to a task and an attempt. They
 * are kept as DECLARED context, excluded from the comparison, and reported as
 * unverifiable rather than silently treated as confirmed.
 *
 * PURE. No git, no clock, no filesystem -- the caller measures and passes the
 * readings in. That is rule 10, and it is also what makes the STALE case
 * testable at all: a test cannot move a real HEAD out from under a real audit,
 * but it can hand this two readings that differ.
 */

const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** A 40-hex object name, or null. Short shas are refused rather than padded. */
const sha = (v) => {
  const s = str(v);
  return s && /^[0-9a-f]{40}$/i.test(s) ? s.toLowerCase() : null;
};

const num = (v) => {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
};

/** The verdict an audit may carry once its identity has been rechecked. */
export const PIN = Object.freeze({
  OK: 'OK',
  STALE: 'STALE',
  UNKNOWN: 'UNKNOWN',
});

/**
 * Capture what an audit is about, at the moment it starts.
 *
 * REFUSES AN INCOMPLETE CAPTURE rather than recording a partial one. A pin
 * missing its candidate sha cannot detect anything, and a pin that silently
 * degrades to "whatever I could read" is worse than none: it produces an OK at
 * the far end that means only that two unknowns matched.
 *
 * @returns {{ok:true, pin:object} | {ok:false, errors:string[]}}
 */
export function capturePin({
  audit_id, task_id, attempt, base_sha, candidate_sha, candidate_tree_sha, worktree_digest,
} = {}) {
  const errors = [];
  const pin = {
    audit_id: str(audit_id),
    // DECLARED, not measured -- see the header. Recorded for binding, never compared.
    declared: { task_id: str(task_id), attempt: num(attempt) },
    base_sha: sha(base_sha),
    candidate_sha: sha(candidate_sha),
    candidate_tree_sha: sha(candidate_tree_sha),
    worktree_digest: str(worktree_digest),
  };

  if (!pin.audit_id) errors.push('audit_id is required: a pin nobody can name cannot be looked up');
  if (!pin.candidate_sha) errors.push('candidate_sha is required and must be a full 40-hex sha');
  if (!pin.candidate_tree_sha) errors.push('candidate_tree_sha is required and must be a full 40-hex sha');
  /*
   * REQUIRED, because its absence is exactly the hole this module shipped with.
   * A pin that records only the commit certifies something no auditor reads.
   */
  if (!pin.worktree_digest) {
    errors.push('worktree_digest is required: an auditor reads FILES, and a pin that records '
      + 'only the commit reports OK while the files under audit change');
  }

  /*
   * base_sha, task_id and attempt are OPTIONAL, and that is deliberate rather
   * than lax. An audit of a branch range or of the working tree legitimately
   * has no single task or attempt, and demanding them would make the honest
   * cases unpinnable -- which is how a control ends up bypassed by the work it
   * was meant to cover. What is NOT optional is the candidate, because without
   * it there is nothing to recheck.
   *
   * A field that IS supplied is compared. Absent means not claimed; it never
   * means "matches anything" -- see verifyPin.
   */
  if (attempt !== undefined && attempt !== null && pin.declared.attempt === null) {
    errors.push('attempt was supplied but is not an integer');
  }
  if (base_sha !== undefined && base_sha !== null && pin.base_sha === null) {
    errors.push('base_sha was supplied but is not a full 40-hex sha');
  }

  return errors.length ? { ok: false, errors } : { ok: true, pin };
}

/**
 * Is the audit still about the thing it was started on?
 *
 * Called with the pin taken at START and a fresh reading taken BEFORE the
 * verdict is admitted. Every field present in the pin must still match.
 *
 * UNKNOWN IS NOT OK, and it is not STALE either. If the recheck could not be
 * taken -- git unreachable, the workspace gone -- the honest answer is that
 * nobody knows, and the caller decides. Collapsing it into OK would admit a
 * verdict on an unverified identity, which is the failure this exists to stop;
 * collapsing it into STALE would throw away good audits whenever a command hiccups.
 * This repository makes that same three-way distinction for liveness, for a
 * null heartbeat and for a failed check-first lookup.
 *
 * @param {object} pin      from capturePin
 * @param {object} now      the same shape, measured again
 * @returns {{state:string, moved:string[], why:string}}
 */
export function verifyPin(pin, now) {
  if (!pin || typeof pin !== 'object') {
    return { state: PIN.UNKNOWN, moved: [], why: 'no pin was captured, so nothing can be rechecked' };
  }
  if (!now || typeof now !== 'object') {
    return {
      state: PIN.UNKNOWN,
      moved: [],
      why: 'the recheck could not be taken; unknown is not a match',
    };
  }

  /*
   * ONLY MEASURED FIELDS ARE COMPARED. task_id and attempt live under
   * `declared` and are deliberately absent here: nothing can read them back
   * from a repository, so comparing them meant comparing the verifier's own
   * restatement of the pin. See the header.
   */
  const MEASURED = ['base_sha', 'candidate_sha', 'candidate_tree_sha', 'worktree_digest'];
  const moved = [];
  const unreadable = [];

  for (const f of MEASURED) {
    const want = pin[f];
    if (want === null || want === undefined) continue;   // not claimed at capture

    const got = f === 'worktree_digest' ? str(now[f]) : sha(now[f]);
    if (got === null) { unreadable.push(f); continue; }
    if (got !== want) moved.push(f);
  }

  /*
   * MOVED BEATS UNREADABLE. If anything is known to have changed, the audit is
   * STALE regardless of what else could not be read -- a partial reading that
   * already disagrees is enough to refuse.
   */
  if (moved.length) {
    return {
      state: PIN.STALE,
      moved,
      why: `the audit was started on a different candidate: ${moved.join(', ')} changed while it ran. `
        + 'A process finishing does not make its verdict valid',
    };
  }
  if (unreadable.length) {
    return {
      state: PIN.UNKNOWN,
      moved: [],
      why: `could not recheck ${unreadable.join(', ')}, so the identity is unconfirmed rather than matched`,
    };
  }
  return { state: PIN.OK, moved: [], why: 'the candidate is unchanged since the audit started' };
}

/**
 * May this audit's verdict be recorded?
 *
 * The one call a caller needs. Fails closed on anything but OK, and says which
 * of the two reasons it is -- they call for opposite responses. STALE means
 * re-run against the new candidate; UNKNOWN means find out why the recheck
 * failed before spending another audit.
 */
export function admitVerdict(pin, now) {
  const v = verifyPin(pin, now);
  return {
    ok: v.state === PIN.OK,
    state: v.state,
    why: v.why,
    moved: v.moved,
  };
}
