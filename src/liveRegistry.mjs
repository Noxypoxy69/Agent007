/**
 * THE REGISTRY, BUILT FROM WHAT IS RUNNING — not from a file somebody typed.
 *
 * A hand-authored roster is humans typing machine truth. It is wrong the moment
 * a session restarts, and worse, it is wrong CONFIDENTLY: `--to code-b` resolves
 * against a name that was accurate last Tuesday. So the roster is derived from
 * registration and heartbeat, and `lanes.example.yml` stays an example.
 *
 * WHY THIS IS NOT A SECOND IDENTITY SYSTEM. src/laneRegistry.mjs already has
 * resolveWorker, and its rules are already the ones required here: exactly one
 * live eligible session resolves, zero refuses, several refuse as ambiguous,
 * repo and worktree filters apply. Rewriting that against runtime rows would
 * produce two implementations of identity which would disagree the first time
 * one was fixed. This module does one job instead: it builds the SAME
 * {agents, sessions} shape resolveWorker already consumes, out of live state.
 *
 * THIS MODULE IS PURE. The clock is a parameter. Liveness is the entire point
 * and a wall-clock read inside here would make every staleness test a race.
 *
 * NO AGENT MAY INVENT ANOTHER AGENT'S SESSION. A worker declares its own
 * durable agent_id and the Bridge derives the rest from the process and the
 * worktree. A row that does not carry its own session_id is DROPPED rather than
 * defaulted -- defaulting session_id to agent_id would manufacture exactly the
 * identity the registry exists to verify, and it would look like it worked.
 */

/** Past this with no heartbeat, a worker is offline whatever it last claimed. */
export const STALE_AFTER_MS = 10 * 60 * 1000;

export const CAPACITIES = ['idle', 'busy', 'blocked', 'offline'];

const str = (v) => (typeof v === 'string' && v.trim().length ? v.trim() : null);

/** Milliseconds since a heartbeat, or null when it is missing or unparseable. */
export function heartbeatAgeMs(row, now) {
  const at = row?.heartbeat_at ?? row?.lastSeenAt ?? row?.last_seen_at ?? null;
  if (!at) return null;
  const t = Date.parse(at);
  const n = Date.parse(now);
  if (Number.isNaN(t) || Number.isNaN(n)) return null;
  return n - t;
}

/**
 * Is this session live right now?
 *
 * A MISSING HEARTBEAT IS OFFLINE, NOT LIVE. An unparseable or absent timestamp
 * means the Bridge has no evidence the worker is there, and "no evidence" must
 * never resolve as "present" -- that is the difference between refusing a
 * delegation and addressing one to nobody.
 */
export function isLive(row, { now, staleAfterMs = STALE_AFTER_MS } = {}) {
  if (row?.capacity === 'offline') return false;
  const age = heartbeatAgeMs(row, now);
  if (age === null) return false;
  return age >= 0 && age <= staleAfterMs;
}

/**
 * Build the registry resolveWorker consumes, from live session rows.
 *
 * @param {Array}  rows  runtime registrations: {agent_id, session_id, repo_id,
 *                       worktree_id, lane_id, capacity, head_sha, heartbeat_at}
 * @param {object} opts  {now, staleAfterMs}
 * @returns {{agents: Array, sessions: Array, lanes: Array, assignments: Array}}
 */
/**
 * WHAT CAPACITY A READER SHOULD BE TOLD, AS OPPOSED TO WHAT THE ROW SAYS.
 *
 * ═══ THE ROSTER WAS LYING ABOUT THE ONLY ROW THAT MATTERED ═══
 *
 * Found by code-d probing the live endpoint, filed at 23:28, unfixed for
 * fifteen hours, and demonstrated the moment Danny asked me to confirm every
 * agent was connected:
 *
 *     code-b   danny-win-f1   last seen 898.8 MINUTES AGO   capacity: idle
 *
 * Every other stale row in that roster read `offline` correctly — b6 and eight
 * probes. They were right for the wrong reason: they DECLARED offline on their
 * way out. code-b never did. It just stopped, so its last self-description
 * stands forever.
 *
 * So the one row that was a real agent rather than a probe was also the only
 * wrong one, and taken at face value the roster answered "is code-b connected?"
 * with "yes, idle". That is the question the data cannot answer being answered
 * anyway, in the vocabulary of one it can.
 *
 * ═══ WHY IT EXISTED: THE RULE WAS APPLIED IN ONLY ONE DIRECTION ═══
 *
 * `registryFromSessions` already overrode declared capacity with derived
 * liveness, and assignTask, confirmProposal and the dispatcher all go through
 * it — which is why the bug could never produce a bad assignment. The WRITE
 * paths were correct and the READ path was not: the edge function mapped
 * `capacity` straight off the stored column.
 *
 * The blast radius was therefore not corrupted state. It was every human and
 * every agent reading a roster that described a dead worker as available.
 *
 * ═══ ONE RULE, ONE PLACE ═══
 *
 * This function is now the single definition, and registryFromSessions calls
 * it. Writing the derivation inline at the read site would have been three
 * lines and a second source of truth for "what does a reader see", and the two
 * would disagree the first time somebody changed one.
 */
export function observedCapacity(row, { now, staleAfterMs = STALE_AFTER_MS } = {}) {
  return isLive(row, { now, staleAfterMs })
    ? (CAPACITIES.includes(row?.capacity) ? row.capacity : 'idle')
    : 'offline';
}



export function registryFromSessions(rows, { now, staleAfterMs = STALE_AFTER_MS } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('registryFromSessions requires an array');
  if (!str(now)) throw new TypeError('registryFromSessions requires a `now` timestamp');

  const sessions = [];
  const agentIds = new Set();

  for (const r of rows) {
    const agent_id = str(r?.agent_id);
    const session_id = str(r?.session_id);
    // Both are required and NEITHER is derived from the other. A row missing
    // its session id is not a worker with an unknown session, it is a row this
    // registry cannot vouch for.
    if (!agent_id || !session_id) continue;

    agentIds.add(agent_id);
    sessions.push({
      session_id,
      agent_id,
      repo_id: str(r?.repo_id),
      worktree_id: str(r?.worktree_id),
      lane_id: str(r?.lane_id),
      head_sha: str(r?.head_sha),
      heartbeat_at: r?.heartbeat_at ?? r?.lastSeenAt ?? r?.last_seen_at ?? null,
      // Staleness OVERRIDES the declared capacity. A worker that claimed `idle`
      // and then died still says `idle` in its last row forever.
      capacity: observedCapacity(r, { now, staleAfterMs }),
    });
  }

  return {
    // An agent EXISTS because a session registered under it. There is no
    // separate roster to fall out of step with the sessions.
    agents: [...agentIds].sort().map((agent_id) => ({ agent_id, display_name: agent_id })),
    sessions,
    lanes: [],
    assignments: [],
  };
}

/**
 * How a delegation's target was established. Stored on the contract.
 *
 * LEGACY ROWS ARE NOT SILENTLY PROMOTED. Every delegation recorded before
 * runtime registration existed took the "no registry configured, warn and
 * accept" path, and there is no way to go back and check who those contracts
 * were really addressed to. Treating an absent marker as `verified` would
 * rewrite the provenance of every one of them at once, which is the same class
 * of error as editing a ledger to agree with the present.
 *
 * So absent means legacy-unverified, permanently, and that is a fact about the
 * record rather than a defect to be cleaned up.
 */
export const VERIFICATION = {
  VERIFIED: 'verified',
  LEGACY: 'legacy-unverified',
};

export function verificationOf(delegation) {
  const v = str(delegation?.target_verification);
  return v === VERIFICATION.VERIFIED ? VERIFICATION.VERIFIED : VERIFICATION.LEGACY;
}
