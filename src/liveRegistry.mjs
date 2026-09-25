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

/** Past this with no heartbeat, a worker is not live whatever it last claimed. */
export const STALE_AFTER_MS = 10 * 60 * 1000;

export const CAPACITIES = ['idle', 'busy', 'blocked', 'offline'];

/**
 * FOUR FACTS, NOT ONE. They were collapsed, and the collapse cost fifteen hours.
 *
 *   presence      SELF-DECLARED departure -- see the limit below
 *   liveness      heartbeat age           -- have we heard from it?
 *   availability  may receive work        -- presence AND liveness
 *   lease         authority over one task (elsewhere; untouched here)
 *
 * ═══ WHAT `presence` HERE IS NOT: OWNER INTENT ═══
 *
 * The contract this was written against says presence = owner intent. THIS
 * IMPLEMENTATION DOES NOT DELIVER THAT, and saying so here is the point --
 * a field named `presence` will otherwise be read as the owner's word by the
 * next person who sees it.
 *
 * What is implemented is the WORKER'S OWN declaration: a row reads DEPARTED
 * because that session set its capacity to 'offline'. A session asserting its
 * own presence is not the owner intending it to be there, and any session can
 * assert it by simply not declaring otherwise.
 *
 * There is currently NO owner-intent anchor to key this on. Migration
 * 20260915122811 settles why: "There is exactly ONE registration token, shared
 * by every worker", and the `registered_by` column ships the comment
 * "PROVENANCE ONLY -- never an authorization check". So the registration token
 * cannot distinguish one worker from another, let alone carry Danny's intent.
 * Keying presence on it would be decoration.
 *
 * Closing that needs either a fourth token class for owner-presence (this repo
 * already runs four classes in four tables, deliberately) or presence set by an
 * out-of-band owner action rather than by the session itself. Both are the
 * owner's decision, and neither is taken here.
 *
 * So this is HALF the contract, and it is labelled as half rather than reported
 * as a closed loop. The useful half is real: a fault is now distinguishable
 * from an orderly shutdown, which is what the fifteen-hour outage needed.
 *
 * ═══ WHY SEPARATING THEM IS THE FIX ═══
 *
 * Two different things used to render as the same word:
 *
 *     code-b   stopped reporting           ->  'offline'
 *     b6       DECLARED offline, leaving   ->  'offline'
 *
 * They call for OPPOSITE responses. A worker that declared offline is gone by
 * intent: leave it, it did what it meant to. A worker that went silent while
 * the owner still intends it to be there is a FAULT: chase it, restart it, tell
 * somebody. Collapsed into one token a fault is indistinguishable from an
 * orderly shutdown, which is why code-b sat dead for fifteen hours with nothing
 * anywhere raising its hand -- the roster was not missing the information, it
 * was rendering it in a vocabulary that could not carry it.
 *
 * A MISSED HEARTBEAT IS EVIDENCE ABOUT LIVENESS. IT IS NOT THE OWNER CHANGING
 * THEIR MIND. So presence below never reads the clock, and that is asserted as
 * a property in test/presenceIsNotLiveness.test.mjs rather than promised here.
 */
export const PRESENCE = { PRESENT: 'present', DEPARTED: 'departed' };
export const LIVENESS = { LIVE: 'live', STALE: 'stale', UNKNOWN: 'unknown' };

/**
 * THE WORKER'S OWN DECLARATION, AND NOTHING ELSE -- not the owner's. See the
 * limit recorded above PRESENCE: there is no owner-intent anchor to read yet.
 *
 * The clock is deliberately not a parameter here: taking a `now` would invite
 * the next edit to consult it, which is the conflation this split removes.
 *
 * A worker declaring `capacity: 'offline'` is the one statement the stored
 * column carries, and it is trusted in that direction ONLY -- it can take
 * itself out, it cannot put itself in. Silence is not a statement.
 */
export function presenceOf(row) {
  return row?.capacity === 'offline' ? PRESENCE.DEPARTED : PRESENCE.PRESENT;
}

/**
 * HEARTBEAT AGE, AND NOTHING ELSE.
 *
 * A declared-offline worker with a fresh heartbeat is LIVE -- the process is
 * running and saying so. Folding its declaration in here would rebuild exactly
 * the conflation this split exists to remove, from the other side.
 *
 * UNKNOWN is its own answer. "We have never heard from it" is not "we heard
 * from it too long ago", and neither is "it is running"; a reader that cannot
 * see the difference will eventually act on the wrong one.
 */
export function livenessOf(row, { now, staleAfterMs = STALE_AFTER_MS } = {}) {
  const age = heartbeatAgeMs(row, now);
  if (age === null) return LIVENESS.UNKNOWN;
  return age >= 0 && age <= staleAfterMs ? LIVENESS.LIVE : LIVENESS.STALE;
}

/**
 * MAY THIS SESSION RECEIVE WORK? Present by intent AND live by heartbeat.
 *
 * This is the predicate the dispatch paths mean, stated in its own words. Its
 * truth table is IDENTICAL to the isLive it replaces -- asserted case by case
 * in test/presenceIsNotLiveness.test.mjs, because the one real risk in naming
 * these apart is that "may receive work" quietly widens while nobody is looking.
 */
export function isAvailable(row, { now, staleAfterMs = STALE_AFTER_MS } = {}) {
  return presenceOf(row) === PRESENCE.PRESENT
    && livenessOf(row, { now, staleAfterMs }) === LIVENESS.LIVE;
}

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
/*
 * THE NAME THE CALL SITES ALREADY USE. isLive is availability -- it always was,
 * and every caller (assignTask, confirmProposal, the dispatcher, the CLI) means
 * "may this receive work". It is kept as the spelling rather than renamed
 * through twenty call sites in a change about semantics, and it now delegates
 * so there is ONE definition of the predicate instead of two that agree today.
 *
 * Its truth table is unchanged. That is a claim under test, not a comment:
 * test/presenceIsNotLiveness.test.mjs compares the two functions case by case
 * over every shape that decides an assignment.
 */
export function isLive(row, { now, staleAfterMs = STALE_AFTER_MS } = {}) {
  return isAvailable(row, { now, staleAfterMs });
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
 *
 * ═══ WHAT THIS FUNCTION IS, NOW THAT THE FACTS ARE NAMED APART ═══
 *
 * It answers AVAILABILITY, in the four-token vocabulary the dispatch path
 * already branches on. It no longer derives presence from the clock: presence
 * is presenceOf() and liveness is livenessOf(), and this composes them.
 *
 * THE 'offline' IT RETURNS FOR A SILENT WORKER IS AN AVAILABILITY VERDICT, NOT
 * A CLAIM THAT THE OWNER WITHDREW THE AGENT. That distinction is carried by the
 * `presence` and `liveness` fields on every registry row, which is where a
 * reader must look to tell a fault from an orderly shutdown.
 *
 * ═══ WHY THE TOKEN ITSELF DID NOT CHANGE, STATED SO NOBODY READS THIS AS DONE ═══
 *
 * A distinct token here -- 'stale' -- would be the fuller fix, and it is NOT
 * safe from inside this module. src/laneRegistry.mjs admits any session whose
 * `capacity !== 'offline'`, so a stale row carrying a new token would start
 * RESOLVING, and work would be assigned to a process that is not there. Its
 * `validate` would separately reject the token as unknown. Both live outside
 * this slice's surface.
 *
 * So the conflation is removed from the MODEL here, and the wire token is left
 * exactly as safe as it was. Changing it is a coupled edit to laneRegistry and
 * to the baseline tests that pin this value, and it is escalated rather than
 * taken unilaterally.
 */
export function observedCapacity(row, { now, staleAfterMs = STALE_AFTER_MS } = {}) {
  if (!isAvailable(row, { now, staleAfterMs })) return 'offline';
  return CAPACITIES.includes(row?.capacity) ? row.capacity : 'idle';
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
      /*
       * THE SEPARATED FACTS TRAVEL WITH THE ROW.
       *
       * The original defect was a second implementation at the read site: the
       * rule existed here and the edge function derived its own answer. Leaving
       * consumers to recompute presence and liveness from `heartbeat_at` would
       * rebuild that exact shape, one reader at a time, and the copies would
       * disagree the first time one was fixed.
       *
       * `capacity` stays the availability projection the dispatch path branches
       * on. These three are what a READER needs to tell a fault from an orderly
       * shutdown, and they are computed by the same functions, in one place.
       */
      presence: presenceOf(r),
      liveness: livenessOf(r, { now, staleAfterMs }),
      available: isAvailable(r, { now, staleAfterMs }),
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
