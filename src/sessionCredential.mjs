import { createHash, randomBytes } from 'node:crypto';
import { safeEqualHex } from './sign.mjs';
import { STALE_AFTER_MS } from './liveRegistry.mjs';

/**
 * WHO IS CALLING, DECIDED FROM A CREDENTIAL RATHER THAN FROM A TYPED NAME.
 *
 * Today an agent id is a string anybody can type, and the registration
 * credential is shared, so one session can register — and speak — under another
 * session's name. That is an authorization hole, not a cosmetic one, and it is
 * first in the repair order on its own merit.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: identity is DERIVED from the
 * credential and never read from the request. A caller may state which agent it
 * believes it is, and that statement is CHECKED against the credential; it is
 * never used to look anything up. The difference matters because a lookup keyed
 * on a claimed name is impersonation with extra steps.
 *
 * AN ALIAS IS ADDRESSING, NEVER AUTHENTICATION. `agent_aliases` exists so mail
 * sent to an old name still arrives. A name — canonical or alias — proves
 * nothing on its own, so a request with no credential is refused whatever it
 * calls itself. Aliases that are historical_only, or outside their validity
 * window, are not accepted even as a self-description: they route, they do not
 * identify.
 *
 * PURE, AND DELIBERATELY SO. `supabase/functions/mcp/index.ts` is Deno-only and
 * cannot be imported by the suite, so a guard living there is untested by
 * construction. This decides; the edge function calls it. Same shape as
 * canAssign, canAccept and canDecidePermission.
 *
 * UNKNOWN IS NEVER PERMISSION. Every refusal below is reached by a missing or
 * unreadable fact as well as by a contradicted one — a session whose binding
 * cannot be checked is refused, not waved through.
 */

/** 32 bytes of randomness: the token is the secret, the digest is what we store. */
export const SESSION_TOKEN_BYTES = 32;

export function digestToken(token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Mint a per-session credential. The caller stores `digest` and hands `token`
 * to exactly one session. We never store the token, so a leak of the table does
 * not yield a usable credential — and a credential nobody can read back is a
 * credential nobody can rotate, so the token is returned here and written to a
 * gitignored dotfile by the caller rather than generated and piped.
 */
export function mintSessionToken({ random = randomBytes } = {}) {
  const token = random(SESSION_TOKEN_BYTES).toString('hex');
  return { token, digest: digestToken(token) };
}

function isRetired(alias, now) {
  if (alias.historical_only === true) return true;
  const from = alias.valid_from ? Date.parse(alias.valid_from) : null;
  const until = alias.valid_until ? Date.parse(alias.valid_until) : null;
  if (from !== null && Number.isFinite(from) && now < from) return true;
  if (until !== null && Number.isFinite(until) && now >= until) return true;
  return false;
}

/**
 * Resolve the caller from the credential alone.
 *
 * Returns { ok: true, agentId, sessionId, kind } or { ok: false, reason }.
 * `reason` is a stable token, never prose, because a refusal string is
 * something a model argues with.
 */
export function resolveCaller({
  token,
  claimedAgentId = null,
  sessions = [],
  aliases = [],
  agents = [],
  taskId = null,
  attemptId = null,
  now = Date.now(),
  staleAfterMs = STALE_AFTER_MS,
} = {}) {
  /*
   * A NAME IS NOT A CREDENTIAL. This arm is what makes "alias authentication"
   * fail: presenting any name at all, canonical or alias, with nothing to prove
   * it, stops here.
   */
  const presented = digestToken(token);
  if (presented === null) return { ok: false, reason: 'no-credential' };

  if (!Array.isArray(sessions)) return { ok: false, reason: 'no-session-store' };

  /*
   * Constant-time comparison against every candidate, and the WHOLE list is
   * scanned rather than short-circuiting on the first hit, because two sessions
   * sharing a digest must be detectable. A credential that resolves two
   * identities resolves none.
   */
  const matches = sessions.filter(
    (s) => typeof s?.credential_digest === 'string' && safeEqualHex(s.credential_digest, presented),
  );
  if (matches.length === 0) return { ok: false, reason: 'unknown-credential' };
  if (matches.length > 1) return { ok: false, reason: 'ambiguous-credential' };

  const session = matches[0];
  if (typeof session.agent_id !== 'string' || session.agent_id.length === 0) {
    return { ok: false, reason: 'session-without-agent' };
  }

  if (session.revoked_at) return { ok: false, reason: 'credential-revoked' };
  if (session.ended_at) return { ok: false, reason: 'session-ended' };

  const agent = agents.find((a) => a?.agent_id === session.agent_id) ?? null;
  if (agent && agent.status && agent.status !== 'active') {
    return { ok: false, reason: `agent-${agent.status}` };
  }

  /*
   * STALENESS IS MEASURED, AND AN UNREADABLE HEARTBEAT IS STALE. A session with
   * no usable heartbeat cannot be shown to be live, and "I could not check" is
   * not "I checked and it was fine".
   */
  const beat = session.heartbeat_at ? Date.parse(session.heartbeat_at) : NaN;
  if (!Number.isFinite(beat)) return { ok: false, reason: 'session-heartbeat-unreadable' };
  if (now - beat > staleAfterMs) return { ok: false, reason: 'session-stale' };

  /*
   * A DISPOSABLE CREDENTIAL IS BOUND TO ONE PIECE OF WORK. A bound session that
   * cannot be matched against the work in hand is refused rather than allowed
   * on the grounds that nothing contradicted it.
   */
  if (session.bound_task_id) {
    if (!taskId) return { ok: false, reason: 'task-binding-uncheckable' };
    if (taskId !== session.bound_task_id) return { ok: false, reason: 'wrong-task-binding' };
  }
  if (session.bound_attempt_id) {
    if (!attemptId) return { ok: false, reason: 'attempt-binding-uncheckable' };
    if (attemptId !== session.bound_attempt_id) return { ok: false, reason: 'wrong-attempt-binding' };
  }

  /*
   * THE CLAIMED NAME IS CHECKED, NEVER TRUSTED. It may be the canonical id or a
   * currently-valid alias OF THE SAME AGENT. A retired alias does not identify
   * even its own agent, which is the half that keeps aliases non-authenticating
   * once they stop being current.
   */
  if (claimedAgentId !== null && claimedAgentId !== undefined && claimedAgentId !== '') {
    if (claimedAgentId !== session.agent_id) {
      const alias = aliases.find((a) => a?.alias === claimedAgentId) ?? null;
      if (alias === null) return { ok: false, reason: 'impersonation' };
      if (alias.canonical_agent_id !== session.agent_id) return { ok: false, reason: 'impersonation' };
      if (isRetired(alias, now)) return { ok: false, reason: 'alias-not-authenticating' };
    }
  }

  return {
    ok: true,
    agentId: session.agent_id,
    sessionId: session.session_id ?? null,
    kind: agent?.kind ?? 'permanent',
  };
}

/**
 * Addressing only: what canonical id does this name reach? Historical aliases
 * DO resolve here — that is the entire point of keeping them — which is why
 * this is a separate function from the one above. Nothing in this function
 * grants anything.
 */
export function resolveAddress(name, { aliases = [], now = Date.now() } = {}) {
  if (typeof name !== 'string' || name === '') return null;
  const alias = aliases.find((a) => a?.alias === name) ?? null;
  if (alias === null) return name;
  void now;
  return alias.canonical_agent_id ?? null;
}
