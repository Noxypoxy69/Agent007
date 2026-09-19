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

/**
 * SHOULD A LIVENESS STAMP BE WRITTEN FOR THIS ROW? Measured 2026-09-19.
 *
 * ═══ THE ZOMBIE ROW ═══
 *
 * `touchLiveness` in the edge function (index.ts:258) patches ONE column:
 *
 *     patch(`session_registrations?session_id=eq.${id}`,
 *           { heartbeat_at: new Date().toISOString() })
 *
 * It never writes `capacity`. It fires from four routes -- /task (1707),
 * /return (1874), /wait (2311) and /review (2561).
 *
 * `isLive` short-circuits on a DECLARED `capacity === 'offline'` BEFORE it
 * consults the clock, and that is CORRECT and deliberate: dispatch.mjs:252
 * says a declared shutdown is a worker saying so, and it must not be handed
 * work. Nothing below changes that.
 *
 * The defect is the COMPOSITION. Nothing ever clears the declaration, and
 * touchLiveness keeps refreshing the row, so a deregistered session whose
 * poll supervisor outlived its SessionEnd sits in the registry:
 *
 *     permanently FRESH   -- /wait re-stamps heartbeat_at every cycle
 *     permanently DEAD    -- capacity is still 'offline'
 *     and it NEVER AGES OUT, because ageing is what heartbeat_at drives.
 *
 * Measured directly: a row with capacity 'offline' and a ONE-SECOND-OLD
 * heartbeat and the same row with a ONE-HOUR-OLD heartbeat both answer
 * isLive === false. The two are indistinguishable, so the staleness sweep can
 * never reclaim the first one.
 *
 * REACHABLE, not theoretical. sessionEnd kills the supervisor only when it can
 * find and verify the pid -- `if (rec && alive(rec.pid))`. Poll records are
 * observably absent while their logs remain (that is how the dead-watcher
 * finding was made), and a supervisor that survives keeps polling /wait for
 * the life of the machine.
 *
 * ═══ WHY THE FIX IS HERE AND NOT IN isLive ═══
 *
 * Making isLive ignore a declared shutdown would hand work to a worker that
 * said it was leaving -- a real regression, in the name of a reporting bug.
 * The stamp is the wrong half: a row nobody will ever consider live should not
 * be kept artificially young. Refuse the stamp and the row ages out on its
 * own, through the mechanism that already exists.
 *
 * ═══ WHAT THIS FUNCTION IS AND IS NOT ═══
 *
 * It is the DECISION, pure and importable, because index.ts is Deno-only and
 * cannot be imported by the suite -- anything left in it is untested by
 * construction (rule 10). Wiring it into touchLiveness is a one-line change in
 * the edge function AND A DEPLOY, which is Danny's, so it is NOT done here.
 * Until that deploy, this function is correct and unconsulted: a control that
 * is never called is not a control (rule 17), and saying so is the difference
 * between shipping a fix and shipping the appearance of one.
 *
 * @returns {{stamp: boolean, reason: string}}
 */
export function shouldStampLiveness(row) {
  if (!row || typeof row !== 'object') {
    return { stamp: false, reason: 'no row to stamp' };
  }
  if (row.capacity === 'offline') {
    return {
      stamp: false,
      reason: 'the session declared itself offline; refreshing it would keep a row '
        + 'permanently fresh that nothing will ever read as live, so it could never age out',
    };
  }
  return { stamp: true, reason: 'live-eligible row' };
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
