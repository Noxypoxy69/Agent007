/**
 * THE GOVERNOR. One authority above every control, anchored to the owner.
 *
 * ═══ WHY THIS EXISTS: FOURTEEN MODULES, FOURTEEN IDEAS OF "OWNER" ═══
 *
 * `trustGenesis`, `taskGate`, `takeNext`, `seatReaper`, `ownerDecisions`,
 * `actionAuthority`, `claudeGuard`, `coordination`, `reviewDecision`,
 * `preExecutionGuard`, `permissionRequest`, `leases` and two memory modules
 * each reason about owner authority. None of them is above the others, none
 * can overrule another, and a caller satisfying the most permissive one has
 * satisfied "the owner" as far as that path is concerned.
 *
 * That is not a governor. That is thirteen opinions and a race.
 *
 * ═══ THE ONE THING THAT MAKES A GOVERNOR REAL, AND WE DO NOT HAVE IT ═══
 *
 * A governor is worth exactly as much as the thing it is anchored to. Measured
 * on this repository, 2026-09-20, by an auditor that did not write the code:
 *
 *   identity_source: CREDENTIAL  <- set from process.env.AGENTBRIDGE_PRINCIPAL_ID
 *   claimed_by_source: resolved  <- set from process.env.AGENTBRIDGE_SESSION_ID
 *
 * Nothing verifies either. An author produces a fully `enforced`,
 * gate-satisfying self-audit by exporting two environment variables and
 * choosing two different strings. The code's own comments insist that
 * authorship is "bound from the active authenticated session, which is a thing
 * the author does not get to type". It is a thing the author types.
 *
 * The same hole is in every other spelling of owner authority here:
 * `granted_by: "danny"` in an override grant is a string an agent writes;
 * `authorised_by` in a genesis record is a string an agent writes. An agent
 * that writes its own permission and fills in the grantor has forged it, and
 * CLAUDE.md says so — but nothing stops it, because there is no anchor.
 *
 * ═══ SO WHAT AN ANCHOR HAS TO BE ═══
 *
 * Something the agents on this machine CANNOT PRODUCE. That rules out, and
 * each of these was considered and rejected for a stated reason:
 *
 *   an env var            the author sets it. This is today's hole.
 *   a JSON file anywhere  agents write files, including outside the worktree.
 *                         The override-grant store is already this shape.
 *   a shared secret on    an agent that can read the path can read the value.
 *   this disk             CLAUDE.md's "pass the PATH, never the value" is a
 *                         convention, not a boundary.
 *   a name in a commit    author-written provenance. Danny's own ruling:
 *   trailer               "Claude-Session: is not authority."
 *
 * What is left is genuinely short: a signature made by a key the agents never
 * hold, or a record written through a channel the agents cannot write. Both
 * are real options and BOTH REQUIRE THE OWNER TO ACT — which is the point. A
 * root of trust an agent can establish on its own is not a root of trust.
 *
 * ═══ WHAT THIS MODULE DOES UNTIL THAT EXISTS ═══
 *
 * It refuses to pretend. `anchorState` reports UNANCHORED, and every
 * owner-only action resolves to REQUIRES_OWNER rather than to ALLOW — never
 * the other way. But ordinary work is NOT blocked, because a governor that
 * stops everything on day one is the rule 19 outage that gets the whole layer
 * switched off, and then there is no governor at all.
 *
 * That asymmetry is the entire design: UNANCHORED costs you escalation, not
 * operation.
 *
 * PURE. No filesystem, no clock, no network, no crypto side effects. The
 * verification result arrives as an argument, because the thing that checks a
 * signature is exactly the thing a test must be able to lie to.
 */

const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** Whether the governor is standing on anything. */
export const ANCHOR = Object.freeze({
  /* An owner assertion was verified against something agents cannot produce. */
  ANCHORED: 'ANCHORED',
  /* No verifiable owner anchor exists. Escalation is unavailable; work is not. */
  UNANCHORED: 'UNANCHORED',
});

export const VERDICT = Object.freeze({
  ALLOW: 'allow',
  DENY: 'deny',
  REQUIRES_OWNER: 'requires_owner',
});

/**
 * The classes of act that are the owner's and nobody else's.
 *
 * TAKEN FROM CLAUDE.md RATHER THAN INVENTED HERE, because a governor that
 * defines its own scope has widened it. "Production deploys, destructive
 * actions, spending, merges to main and anything a customer receives are
 * HIS, and no coordinator may approve them on his behalf."
 */
export const OWNER_ONLY = Object.freeze([
  'deploy.production',
  'destructive',
  'spend',
  'merge.main',
  'customer_facing',
  /* Added because the audit showed these are self-grantable today. */
  'grant.override',
  'trust.genesis',
  'authority.widen',
]);

/**
 * Is a proof of owner authority actually a proof?
 *
 * THE CALLER DOES THE CRYPTOGRAPHY AND HANDS THE RESULT IN. That is
 * deliberate: a module that verifies its own signatures cannot be tested
 * against a forged one without generating real keys, and the branch that
 * matters is the one where verification FAILED.
 *
 * `verified` must be exactly `true`. Not truthy — a string, a 1 or an object
 * is a caller that has not checked, and the whole failure class this
 * repository produces is a check that passes while proving nothing.
 */
export function anchorState(proof = null) {
  if (!proof || typeof proof !== 'object') {
    return { state: ANCHOR.UNANCHORED, why: 'no owner anchor was presented' };
  }
  if (proof.verified !== true) {
    return {
      state: ANCHOR.UNANCHORED,
      why: `the owner anchor was presented but not verified (verified=${JSON.stringify(proof.verified)}); `
        + 'an unverified assertion of owner authority is the forgery this exists to prevent',
    };
  }
  const by = str(proof.owner);
  if (!by) {
    return { state: ANCHOR.UNANCHORED, why: 'the anchor verified but names no owner, so it authorises nobody' };
  }
  /*
   * THE METHOD IS RECORDED, because "verified" without saying HOW is the
   * proxy this repository keeps getting caught by. A reader must be able to
   * tell a signature from an environment variable somebody trusted.
   */
  const method = str(proof.method);
  if (!method) {
    return {
      state: ANCHOR.UNANCHORED,
      why: 'the anchor claims verification but does not say by what method, so nobody can judge whether it counts',
    };
  }
  if (method === 'env' || method === 'trailer' || method === 'self') {
    return {
      state: ANCHOR.UNANCHORED,
      why: `"${method}" is not an anchor: it is a value the acting party can produce. `
        + 'This is the exact hole the audit found in AGENTBRIDGE_PRINCIPAL_ID',
    };
  }
  return { state: ANCHOR.ANCHORED, owner: by, method, why: `owner authority verified by ${method}` };
}

/**
 * The single question every control should ask.
 *
 * @param {object} req
 *   action     what is being attempted, e.g. 'deploy.production'
 *   actor      who is attempting it
 *   ownerOnly  override the OWNER_ONLY list (tests, and future policy)
 * @param {object} ctx
 *   proof      the owner anchor, if any
 *   decision   a matching owner decision already on the ledger, if any
 *              (resolved by src/ownerDecisions.mjs — this does NOT re-derive
 *              it, because two resolvers is the pair nobody watches)
 */
export function govern(req = {}, ctx = {}) {
  const action = str(req.action);
  const actor = str(req.actor);
  if (!action) {
    return { verdict: VERDICT.DENY, why: 'no action was named, and a governor that permits the unnamed permits everything' };
  }

  const list = Array.isArray(req.ownerOnly) ? req.ownerOnly : OWNER_ONLY;
  const isOwnerOnly = list.includes(action);
  const anchor = anchorState(ctx.proof);

  /*
   * AN ORDINARY ACTION IS NOT THE GOVERNOR'S BUSINESS. Refusing everything
   * while unanchored is the rule 19 outage: it gets the layer switched off,
   * and a layer that is off protects nothing. UNANCHORED costs escalation,
   * not operation.
   */
  if (!isOwnerOnly) {
    /*
     * ...unless the ledger says otherwise. A standing owner DENY outranks
     * "this is ordinary", because that is what the ledger is for.
     */
    const effect = str(ctx.decision?.effect);
    if (effect === 'deny') {
      return { verdict: VERDICT.DENY, why: `a standing owner decision denies ${action}`, anchor: anchor.state };
    }
    if (effect === 'require_owner') {
      return {
        verdict: VERDICT.REQUIRES_OWNER,
        why: `a standing owner decision routes ${action} to the owner`,
        anchor: anchor.state,
      };
    }
    return { verdict: VERDICT.ALLOW, why: `${action} is not an owner-only act`, anchor: anchor.state };
  }

  /*
   * OWNER-ONLY, AND NOTHING IS ANCHORED. The honest answer is not "no" and
   * certainly not "yes": it is that this cannot be decided here, and the
   * owner has to. Saying DENY would be a lie in the other direction and would
   * teach people to route around the governor.
   */
  if (anchor.state !== ANCHOR.ANCHORED) {
    return {
      verdict: VERDICT.REQUIRES_OWNER,
      why: `${action} is the owner's and ${anchor.why}. No agent can authorise this, including by recording `
        + 'a decision that says it may',
      anchor: anchor.state,
    };
  }

  /*
   * ANCHORED. Now a standing decision can actually carry weight, because
   * there is something behind the word "owner".
   *
   * THE DECISION MUST BE THE OWNER'S OWN. An `allow` recorded by a
   * coordinator does not become owner authority by sitting next to a verified
   * anchor -- that is the laundering CLAUDE.md names, and it is the sharpest
   * way this module could go wrong.
   */
  const effect = str(ctx.decision?.effect);
  const decidedBy = str(ctx.decision?.decided_by);
  if (effect === 'allow') {
    if (decidedBy && decidedBy === anchor.owner) {
      return { verdict: VERDICT.ALLOW, why: `${anchor.owner} decided ${action}, verified by ${anchor.method}`, anchor: anchor.state };
    }
    return {
      verdict: VERDICT.REQUIRES_OWNER,
      why: `${action} is allowed by a decision recorded by ${decidedBy ?? 'nobody named'}, who is not the `
        + `anchored owner (${anchor.owner}). A decision is not owner authority because it sits beside one`,
      anchor: anchor.state,
    };
  }
  if (effect === 'deny') {
    return { verdict: VERDICT.DENY, why: `${anchor.owner} denied ${action}`, anchor: anchor.state };
  }

  return {
    verdict: VERDICT.REQUIRES_OWNER,
    why: `${action} is the owner's and no decision covers it`,
    anchor: anchor.state,
    actor,
  };
}
