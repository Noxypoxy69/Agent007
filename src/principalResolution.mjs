/**
 * P0-5: WHO IS ACTING, AND ON WHAT EVIDENCE.
 *
 * ═══ THE HOLE THIS CLOSES, MEASURED ═══
 *
 *   bin/agentbridge.mjs:3341   const principal = str_(process.env.AGENTBRIDGE_PRINCIPAL_ID);
 *   bin/agentbridge.mjs:3372   identity_source: principal ? IDENTITY.CREDENTIAL : IDENTITY.OBSERVED
 *
 * Nothing verified anything. A non-empty environment variable WAS the
 * credential. An author produced a fully `enforced`, gate-satisfying
 * self-audit by exporting two variables and choosing two different strings --
 * found by a blind auditor, 2026-09-20. The module's own comments insisted
 * authorship was "bound from the active authenticated session, which is a
 * thing the author does not get to type". It was exactly a thing the author
 * types.
 *
 * ═══ WHAT COUNTS AS EVIDENCE, AND WHY THE LEASE TOKEN ═══
 *
 * An anchor has to be something the acting party CANNOT PRODUCE. On this
 * machine an agent can write any file, set any variable, and edit any source,
 * so the candidates are short. Enumerated and rejected:
 *
 *   an env var        the author sets it. This is the hole above.
 *   a CLI flag        likewise, and more obviously.
 *   a file on disk    an agent writes files, including outside the worktree.
 *   a commit trailer  author-written provenance. Danny's ruling: not authority.
 *   a config value    a file by another name.
 *
 * What survives is the LEASE TOKEN. The server mints it inside the claim
 * transaction, it is never chosen by the client, and the server verifies it on
 * `/renew` and `/return` -- `return_with_lease` refuses a token that is not
 * the current holder's. So possession of a live lease is a fact about the
 * server's state, not about what an agent typed, and an agent cannot mint one.
 *
 * THE VERIFICATION IS PERFORMED BY THE CALLER AND PASSED IN. This module is
 * pure. That is deliberate: the branch that matters is the one where
 * verification FAILED, and a module that verifies its own credentials cannot
 * be tested against a forged one without a live server.
 *
 * ═══ WHAT THIS DOES NOT CLOSE ═══
 *
 * A party holding the REGISTRATION token can still register a session under a
 * chosen agent id, so `agent_id` remains an assertion. This binds the SESSION
 * that holds a lease, which is the identity the audit rules actually turn on
 * (author vs reviewer). Stated rather than glossed, because a control
 * documented as stronger than it is, is worse than one documented as absent --
 * which is precisely how the env-var hole survived: three comments said it was
 * bound and no code bound it.
 */

const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** How an identity was obtained. Ordered weakest to strongest. */
export const SOURCE = Object.freeze({
  /* Nothing usable. Not an error -- the honest answer when no evidence exists. */
  UNVERIFIABLE: 'unverifiable',
  /* Read from the environment or a flag. Usable as a LABEL, never as authority. */
  OBSERVED: 'observed',
  /* The server confirmed possession of a credential it minted. */
  CREDENTIAL: 'credential',
});

/**
 * Sources that can NEVER yield `credential`, by name.
 *
 * AN EXPLICIT LIST, because the failure mode is a future caller passing
 * `method: 'env'` and a `verified: true` it decided for itself. Naming them
 * makes the refusal greppable and makes a reviewer ask why a new one is
 * absent, rather than discovering it as a hole later.
 */
export const NEVER_CREDENTIAL = Object.freeze(['env', 'flag', 'file', 'config', 'trailer', 'self', 'assumed']);

/**
 * Resolve the acting principal.
 *
 * @param {object} evidence
 *   lease   { verified, session, task_id, attempt, method } — the RESULT of
 *           asking the bridge, not a claim. `verified` must be exactly true.
 *   env     { session, principal, agent } — what the environment says. Used
 *           only to label an OBSERVED identity, never to reach CREDENTIAL.
 * @returns {{source, session, why, agent}}
 */
export function resolvePrincipal({ lease = null, env = {} } = {}) {
  const e = env && typeof env === 'object' ? env : {};
  const fallback = {
    session: str(e.session),
    agent: str(e.agent),
  };

  if (!lease || typeof lease !== 'object') {
    return {
      source: fallback.session ? SOURCE.OBSERVED : SOURCE.UNVERIFIABLE,
      session: fallback.session,
      agent: fallback.agent,
      why: 'no lease verification was performed, so the identity is whatever the environment says it is',
    };
  }

  /*
   * EXACTLY TRUE. A truthy value -- a non-empty string, a 1, an object -- is a
   * caller that did not check, and the whole failure class this repository
   * produces is a check that passes while proving nothing.
   */
  if (lease.verified !== true) {
    return {
      source: fallback.session ? SOURCE.OBSERVED : SOURCE.UNVERIFIABLE,
      session: fallback.session,
      agent: fallback.agent,
      why: `the lease was presented but not verified (verified=${JSON.stringify(lease.verified)}); `
        + 'an unverified credential is the forgery this exists to prevent',
    };
  }

  const method = str(lease.method);
  if (method && NEVER_CREDENTIAL.includes(method.toLowerCase())) {
    return {
      source: SOURCE.OBSERVED,
      session: str(lease.session) ?? fallback.session,
      agent: fallback.agent,
      why: `"${method}" is not a credential: it is a value the acting party can produce. `
        + 'This is the exact shape of the AGENTBRIDGE_PRINCIPAL_ID hole',
    };
  }

  const session = str(lease.session);
  if (!session) {
    return {
      source: SOURCE.UNVERIFIABLE,
      session: null,
      agent: fallback.agent,
      why: 'the lease verified but names no session, so it authenticates nobody',
    };
  }

  /*
   * THE SERVER'S ANSWER OUTRANKS THE ENVIRONMENT, AND A DISAGREEMENT IS NOT
   * A CREDENTIAL.
   *
   * If the environment claims one session and the verified lease belongs to
   * another, the safe reading is not "trust the server and carry on" -- it is
   * that this process does not know what it is. Returning CREDENTIAL for the
   * server's session would let a process borrow an identity it can prove
   * possession of but was not launched as.
   */
  if (fallback.session && fallback.session !== session) {
    return {
      source: SOURCE.OBSERVED,
      session,
      agent: fallback.agent,
      why: `the verified lease belongs to ${session} but this process was launched as `
        + `${fallback.session}; a disagreement about identity is not an authenticated identity`,
    };
  }

  return {
    source: SOURCE.CREDENTIAL,
    session,
    agent: fallback.agent,
    why: `the bridge confirmed this session holds the lease on ${str(lease.task_id) ?? 'a task'}`
      + `${Number.isInteger(lease.attempt) ? ` at attempt ${lease.attempt}` : ''}`,
  };
}

/**
 * May this resolution be written as an authenticated identity?
 *
 * SEPARATE FROM `resolvePrincipal` ON PURPOSE, the same way `admitVerification`
 * is separate from `decideVerify`: the function that describes a state must not
 * be the function that approves on it, or every new caller re-decides the rule
 * and one of them gets it wrong.
 */
export function mayWriteCredential(resolution) {
  return Boolean(resolution)
    && resolution.source === SOURCE.CREDENTIAL
    && typeof resolution.session === 'string'
    && resolution.session.trim() !== '';
}
