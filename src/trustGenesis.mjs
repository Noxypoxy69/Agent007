/**
 * THE BOOTSTRAP BOUNDARY. How a trust system starts trusting anything.
 *
 * ═══ THE HOLE THIS CLOSES ═══
 *
 *   a candidate may pass audit ONLY IF its author identity was authoritatively
 *   bound at creation, AND the reviewer identity is credential-resolved, AND
 *   they are independent.
 *
 * Good rule. But the machinery that establishes those identities does not
 * exist in production yet, so:
 *
 *   need trusted identity -> to accept a trusted audit -> which needs trusted
 *   code implementing identity -> which itself requires a trusted audit -> LOOP
 *
 * There is no clever way out of that from inside. Either the system deadlocks
 * forever, or somebody invents a "temporary exception" -- and a temporary
 * exception in a trust model is the hole, permanently, because nothing ever
 * removes it and everything downstream inherits it.
 *
 * So the escape is ONE EXPLICIT BOUNDARY, owner-authorised, and structurally
 * incapable of applying to anything else.
 *
 * ═══ WHY IT CANNOT LEAK, BY CONSTRUCTION RATHER THAN BY POLICY ═══
 *
 * Genesis names ONE EXACT TREE SHA. A candidate qualifies only when its tree
 * sha equals that one, byte for byte. Every descendant -- every commit made
 * after it, including the one that fixes a defect the genesis audit found --
 * has a DIFFERENT tree, so the exception cannot reach it. Not "must not":
 * cannot. The frozen tree already exists and cannot grow new children under
 * the same hash.
 *
 * That is the whole safety argument, and it is why the exception is expressed
 * as a tree identity rather than as a date, a commit range, a flag or a grace
 * period. Every one of those would extend to work that had not been written
 * when the owner authorised it, which is exactly what an owner cannot consent
 * to in advance.
 *
 * ═══ WHAT THE 24 LEGACY COMMITS ARE, HONESTLY ═══
 *
 * They were made before authoritative authorship binding existed. Nobody can
 * now truthfully produce a principal_id, an authenticated session, an attempt
 * or a lease for them, and their `Claude-Session:` trailers are author-written
 * provenance. So they can never become `enforced` by auditing them harder, and
 * pretending otherwise would be the fabricated-ledger-line failure the audit
 * ledger already carries a header about.
 *
 * They are marked PRE_GENESIS and, once a genesis tree is accepted,
 * SUPERSEDED_BY_GENESIS. That is NOT a pass. It records that the work predates
 * the machinery and that what was actually verified is the resulting aggregate
 * tree, not each historical step. Their audit records are kept as provenance.
 *
 * PURE. No filesystem, no clock, no git. The owner decision, the freeze and the
 * mechanical verification are all measured elsewhere and passed in.
 */

const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const sha40 = (v) => {
  const s = str(v);
  return s && /^[0-9a-f]{40}$/i.test(s) ? s.toLowerCase() : null;
};

/** Which trust regime a candidate falls under. */
export const REGIME = Object.freeze({
  PRE_GENESIS: 'PRE_GENESIS',
  GENESIS: 'GENESIS',
  POST_GENESIS: 'POST_GENESIS',
});

/**
 * Is this a usable genesis record?
 *
 * EVERY FIELD IS A SEPARATE REFUSAL because a partially-specified root of trust
 * is worse than none: it looks like a decision and answers nothing.
 *
 * @returns {{ok:true, genesis:object} | {ok:false, errors:string[]}}
 */
export function validateGenesis(record = {}) {
  const errors = [];
  const g = {
    tree_sha: sha40(record.tree_sha),
    candidate_sha: sha40(record.candidate_sha),
    base_sha: sha40(record.base_sha),
    policy_version: str(record.policy_version),

    /* WHO AUTHORISED IT. Not an agent, ever. */
    authorised_by: str(record.authorised_by),
    owner_decision_id: str(record.owner_decision_id),

    /* WHAT WAS DONE TO IT BEFORE THE OWNER ACCEPTED IT. */
    reviewer: str(record.reviewer),
    review_verdict: str(record.review_verdict)?.toUpperCase() ?? null,
    verification_key: str(record.verification_key),
    verification_state: str(record.verification_state),

    accepted_at: str(record.accepted_at),
  };

  if (!g.tree_sha) errors.push('tree_sha is required and must be a full 40-hex sha: genesis is a TREE, not a moment');
  if (!g.candidate_sha) errors.push('candidate_sha is required: the tree must be reachable from a named commit');
  if (!g.policy_version) errors.push('policy_version is required: a root of trust must say which rules it was accepted under');

  /*
   * THE OWNER, AND ONLY THE OWNER. CLAUDE.md: production decisions are Danny's
   * and no coordinator may approve them on his behalf. A genesis authorised by
   * an agent is an agent declaring itself trustworthy, which is the entire
   * failure this boundary exists to avoid.
   */
  if (!g.authorised_by) errors.push('authorised_by is required: genesis is an owner act');
  if (!g.owner_decision_id) {
    errors.push('owner_decision_id is required: the authorisation must exist as a recorded owner decision, '
      + 'not as a field somebody typed into this record');
  }

  /*
   * AN INDEPENDENT REVIEW STILL HAPPENS. The bootstrap relaxes WHOSE identity
   * can be proved cryptographically; it does not relax that somebody who did
   * not write the tree looked at it. Skipping that would make genesis a
   * self-certification with ceremony.
   */
  if (!g.reviewer) errors.push('reviewer is required: genesis relaxes identity proof, never the review itself');
  if (g.review_verdict !== 'PASS') {
    errors.push(`review_verdict must be PASS, got ${JSON.stringify(record.review_verdict ?? null)}: `
      + 'a root of trust cannot be a tree a reviewer rejected');
  }

  /*
   * AND A MACHINE CHECKED IT TOO. A reviewer's PASS is a judgement; the suite
   * result is a measurement, and genesis needs both -- bound to the same tree.
   */
  if (!g.verification_key) errors.push('verification_key is required: the mechanical result must be bound to this exact tree');
  if (g.verification_state !== 'VERIFY_PASSED') {
    errors.push(`verification_state must be VERIFY_PASSED, got ${JSON.stringify(record.verification_state ?? null)}`);
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, genesis: g };
}

/**
 * Which regime does this candidate fall under?
 *
 * THE ORDER MATTERS. A candidate is GENESIS only if it IS the frozen tree.
 * Everything reachable after it is POST_GENESIS and gets the full rules;
 * everything before is PRE_GENESIS and can never be promoted.
 *
 * @param {object} args
 *   candidateTree   the tree sha being judged
 *   genesis         a validated genesis record, or null if none exists yet
 *   isDescendant    did this candidate come AFTER the genesis commit --
 *                   measured by the caller with git, never guessed here
 */
export function regimeOf({ candidateTree = null, genesis = null, isDescendant = null } = {}) {
  const tree = sha40(candidateTree);
  if (!genesis) {
    /*
     * NO GENESIS YET. Everything is pre-genesis, including the candidate that
     * will become genesis -- it is not genesis until the owner says so, and it
     * gets no exception in the meantime.
     */
    return { regime: REGIME.PRE_GENESIS, why: 'no trust genesis has been established, so nothing can be enforced yet' };
  }
  if (tree && tree === sha40(genesis.tree_sha)) {
    return { regime: REGIME.GENESIS, why: 'this is the exact tree the owner accepted as the root of trust' };
  }
  if (isDescendant === true) {
    return { regime: REGIME.POST_GENESIS, why: 'this candidate was created after the genesis tree, so the full rules apply with no exception' };
  }
  if (isDescendant === false) {
    return {
      regime: REGIME.PRE_GENESIS,
      why: 'this candidate predates the genesis tree. It cannot be promoted: nobody can now truthfully produce '
        + 'the principal, session, attempt or lease that did not exist when it was written',
    };
  }
  /*
   * UNKNOWN ANCESTRY IS TREATED AS POST-GENESIS, which is the strict direction.
   * Guessing PRE here would hand the bootstrap exception to a candidate nobody
   * could place -- exactly the leak this module exists to prevent.
   */
  return {
    regime: REGIME.POST_GENESIS,
    why: 'ancestry relative to the genesis tree could not be determined, so the full rules apply. '
      + 'An unplaceable candidate does not get the bootstrap exception',
  };
}

/**
 * May the bootstrap exception be applied to this candidate?
 *
 * THE ANSWER IS ALMOST ALWAYS NO, AND THAT IS THE DESIGN. It is true for
 * exactly one tree, once, and the comparison is an equality on a frozen hash.
 * There is no range, no window, no flag and no grace period, because each of
 * those would extend to work that had not been written when the owner
 * authorised it -- which is not something an owner can consent to in advance.
 */
export function genesisApplies(candidateTree, genesis) {
  if (!genesis) return false;
  const v = validateGenesis(genesis);
  if (!v.ok) return false;
  const tree = sha40(candidateTree);
  return Boolean(tree) && tree === v.genesis.tree_sha;
}

/**
 * How a legacy audit record should be marked once genesis exists.
 *
 * NOT A PASS. The 24 control commits that predate the machinery were really
 * audited and those records are worth keeping, but what the owner actually
 * accepted is the resulting aggregate tree -- not each historical step. Saying
 * SUPERSEDED_BY_GENESIS records both facts without inventing authority for
 * either.
 */
export function legacyMarking(genesis) {
  return genesis
    ? { status: 'SUPERSEDED_BY_GENESIS', genesis_tree: sha40(genesis.tree_sha) }
    : { status: 'PRE_GENESIS', genesis_tree: null };
}
