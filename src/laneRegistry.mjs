import { parseYamlSubset } from './yamlSubset.mjs';

/**
 * The lane registry: lanes, agents, sessions and assignments as DATA.
 *
 * WHY THIS SHAPE, and what it replaces.
 *
 * The first cut of this system had four lanes named after the four agents
 * running that night -- code-a, code-b, code-c, code-d -- and the registry
 * recorded `{agentId: 'code-c', lane: 'messaging'}` as though the two were one
 * fact. They are not, and the cost of pretending showed up within hours:
 *
 *   - Code C was reassigned from the FO40 funnel to messaging mid-session.
 *     Under the old shape that is an agent changing its own identity.
 *   - Three sessions each believed they were "Code C" at the same time. With
 *     agent and lane fused there was no way to express "same lane, different
 *     session" or to ask who actually held it.
 *   - Code A's integration role was a property of being called Code A. So
 *     when the seat turned out to be occupied-but-unattributed, nothing in
 *     the data could say who currently had the capability to integrate.
 *
 * So three entities, joined by a fourth:
 *
 *   agent       a worker identity that persists across sessions
 *   session     one runtime of one agent; dies, agent does not
 *   lane        a work domain: messaging, payments, ar-hunt, fo40-funnel
 *   assignment  who holds which lane, right now
 *
 * LANES ARE DATA, NOT CODE. Creating `payments` or `ar-hunt` tomorrow is an
 * edit to a YAML file. Nothing in this module knows the name of any lane, and
 * there is no enumeration of agents anywhere in the source. A/B/C/D appear in
 * exactly one place -- the seeded example -- and are examples, not the model.
 *
 * MANY-TO-MANY ON PURPOSE. One agent may hold several lanes at once, and one
 * lane may be held by several agents (pairing, or a handover window where both
 * are live). Assignments are a list precisely so neither is special-cased.
 *
 * CAPABILITIES, NOT MAGIC NAMES. `merge_main`, `deploy`, `apply_sql` are
 * granted by a lane and inherited through assignment. "Code A may deploy" is
 * therefore a fact about which lane Code A currently holds, and it moves when
 * the assignment moves.
 */

/**
 * Capabilities a lane may grant. Closed on purpose: a typo like `deploy_prod`
 * must fail validation rather than silently granting nothing, which would read
 * as a working permission in the file and a denial at runtime.
 */
export const CAPABILITIES = ['merge_main', 'deploy', 'apply_sql', 'push_shared', 'rewrite_history'];

export const LANE_STATUSES = ['active', 'paused', 'archived'];

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Path classification, in precedence order. */
export const OWNED = 'owned';
export const SHARED = 'shared';
export const FOREIGN = 'foreign';
export const UNCLAIMED = 'unclaimed';

// ── parsing ─────────────────────────────────────────────────────────────────

/**
 * Accepts the rich registry, or the legacy flat `{lane: [globs]}` map.
 *
 * The legacy format is still the committed lanes.example.yml and is still
 * valid input. Upgrading it in place rather than rejecting it means adopting
 * the new shape never requires a flag day, and a repo that only cares about
 * path ownership never has to write the other three sections.
 */
export function parseLaneRegistry(text, { source = 'lanes' } = {}) {
  const doc = /^\s*[[{]/.test(text) ? JSON.parse(text) : parseYamlSubset(text);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`${source}: top level must be a mapping`);
  }
  const looksRich = ['lanes', 'agents', 'sessions', 'assignments'].some((k) => k in doc);
  return looksRich ? normalise(doc, source) : upgradeLegacy(doc, source);
}

function upgradeLegacy(flat, source) {
  const lanes = [];
  for (const [lane_id, globs] of Object.entries(flat)) {
    if (!Array.isArray(globs)) {
      throw new Error(`${source}: legacy lane "${lane_id}" must be a list of globs`);
    }
    lanes.push({
      lane_id,
      display_name: lane_id,
      owned_paths: globs.map(String),
      shared_paths: [],
      branch_patterns: [],
      worktrees: [],
      capabilities: [],
      status: 'active',
      legacy: true,
    });
  }
  return normalise({ lanes }, source);
}

function normalise(doc, source) {
  const lanes = (doc.lanes ?? []).map((l, i) => {
    if (!l || typeof l !== 'object') throw new Error(`${source}: lanes[${i}] must be a mapping`);
    return {
      lane_id: l.lane_id,
      display_name: l.display_name ?? l.lane_id,
      owned_paths: list(l.owned_paths),
      shared_paths: list(l.shared_paths),
      branch_patterns: list(l.branch_patterns),
      worktrees: list(l.worktrees),
      capabilities: list(l.capabilities),
      status: l.status ?? 'active',
      legacy: l.legacy === true,
    };
  });
  return {
    source,
    lanes,
    /*
     * ONE NAMESPACE FOR EVERY REPOSITORY, AND THAT IS THE POINT.
     *
     * An agent is a durable worker. It is not "the Bridge's code-b" and
     * separately "the product's code-b" — those are one worker holding two
     * assignments, and modelling them as two identities is how one session ends
     * up with two histories that cannot be reconciled. `repo_id` is therefore
     * ASSIGNMENT CONTEXT and never part of who somebody is: a worker moves
     * between agentbridge and social-sparks by changing an assignment, not by
     * becoming a different agent.
     *
     * Three levels, and what each is allowed to outlive:
     *
     *   agent_id             durable, repo-independent, survives every restart
     *   session_id           one runtime; dies when the process does
     *   repo/worktree/lane   where that runtime is working RIGHT NOW
     *
     * Today's collision came from fusing the first two. Three sessions each
     * believed they were "Code C", and because the lane was treated as the
     * identity, a reassignment looked like an agent changing who it was.
     */
    agents: (doc.agents ?? []).map((a) => ({
      agent_id: a?.agent_id,
      display_name: a?.display_name ?? a?.agent_id,
    })),
    sessions: (doc.sessions ?? []).map((s) => ({
      session_id: s?.session_id,
      agent_id: s?.agent_id,
      /*
       * Where this runtime is, not who it is. `null` means "not reported yet",
       * which is NOT the same as "nowhere" and must never satisfy a match — an
       * unreported worktree that compares equal to a requested one would bind a
       * delegation to a session that is not actually there.
       */
      repo_id: s?.repo_id ?? null,
      worktree_id: s?.worktree_id ?? null,
      capacity: s?.capacity ?? 'idle',
      last_seen: s?.last_seen ?? null,
    })),
    assignments: (doc.assignments ?? []).map((x) => ({
      lane_id: x?.lane_id,
      agent_id: x?.agent_id ?? null,
      session_id: x?.session_id ?? null,
      repo_id: x?.repo_id ?? null,
      worktree: x?.worktree ?? null,
      status: x?.status ?? 'active',
    })),
  };
}

const list = (v) => (v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

// ── validation ──────────────────────────────────────────────────────────────

/**
 * Structural validation. Returns errors rather than throwing, so a CLI can
 * print all of them at once instead of one per run -- an operator fixing a
 * lane file should not have to discover its problems serially.
 */
export function validateRegistry(reg) {
  const errors = [];
  const seenLane = new Set(), seenAgent = new Set(), seenSession = new Set();

  for (const l of reg.lanes) {
    if (!ID.test(String(l.lane_id ?? ''))) { errors.push(`lane_id "${l.lane_id}" is not a valid id`); continue; }
    if (seenLane.has(l.lane_id)) errors.push(`duplicate lane_id "${l.lane_id}"`);
    seenLane.add(l.lane_id);
    if (!LANE_STATUSES.includes(l.status)) {
      errors.push(`lane "${l.lane_id}" has unknown status "${l.status}" (expected ${LANE_STATUSES.join(', ')})`);
    }
    for (const c of l.capabilities) {
      if (!CAPABILITIES.includes(c)) {
        errors.push(`lane "${l.lane_id}" grants unknown capability "${c}" (expected ${CAPABILITIES.join(', ')})`);
      }
    }
    // A path owned by this lane AND declared shared is genuinely ambiguous:
    // shared wins at classification time, so say so rather than let the file
    // imply exclusive ownership it will not get.
    for (const p of l.owned_paths) {
      if (l.shared_paths.includes(p)) {
        errors.push(`lane "${l.lane_id}" lists "${p}" as both owned and shared`);
      }
    }
  }

  for (const a of reg.agents) {
    if (!ID.test(String(a.agent_id ?? ''))) { errors.push(`agent_id "${a.agent_id}" is not a valid id`); continue; }
    if (seenAgent.has(a.agent_id)) errors.push(`duplicate agent_id "${a.agent_id}"`);
    seenAgent.add(a.agent_id);
  }

  for (const s of reg.sessions) {
    if (!ID.test(String(s.session_id ?? ''))) { errors.push(`session_id "${s.session_id}" is not a valid id`); continue; }
    if (seenSession.has(s.session_id)) errors.push(`duplicate session_id "${s.session_id}"`);
    seenSession.add(s.session_id);
    if (s.agent_id != null && !seenAgent.has(s.agent_id)) {
      errors.push(`session "${s.session_id}" belongs to unknown agent "${s.agent_id}"`);
    }
    /*
     * A SESSION WITH NO AGENT IS THE 15 SEP FAILURE IN DATA FORM. It is a
     * runtime nobody can attribute: it can commit, hold a lane and be handed
     * work, and no later question can establish who did any of it. Four commits
     * on one branch came from three sessions under one git identity precisely
     * because nothing required this link.
     */
    if (s.agent_id == null) {
      errors.push(`session "${s.session_id}" names no agent — a runtime that cannot be attributed`);
    }
    if (!CAPACITIES.includes(s.capacity)) {
      errors.push(`session "${s.session_id}" has unknown capacity "${s.capacity}" (${CAPACITIES.join(', ')})`);
    }
  }

  for (const x of reg.assignments) {
    if (!seenLane.has(x.lane_id)) errors.push(`assignment references unknown lane "${x.lane_id}"`);
    if (!x.agent_id && !x.session_id) errors.push(`assignment to lane "${x.lane_id}" names neither an agent nor a session`);
    if (x.agent_id && !seenAgent.has(x.agent_id)) errors.push(`assignment references unknown agent "${x.agent_id}"`);
    if (x.session_id && !seenSession.has(x.session_id)) errors.push(`assignment references unknown session "${x.session_id}"`);
  }

  // Two lanes claiming the same exact owned path is the collision this whole
  // system exists to prevent, so it is an error in the file, not a runtime
  // surprise on somebody's commit.
  const owner = new Map();
  for (const l of reg.lanes) {
    for (const p of l.owned_paths) {
      if (owner.has(p)) errors.push(`path "${p}" is owned by both "${owner.get(p)}" and "${l.lane_id}"`);
      else owner.set(p, l.lane_id);
    }
  }

  return { ok: errors.length === 0, errors };
}

// ── resolution ──────────────────────────────────────────────────────────────

const activeAssignments = (reg) => reg.assignments.filter((a) => a.status === 'active');

/** Every lane an agent currently holds. An agent may hold several. */
export function lanesForAgent(reg, agentId) {
  const sessionIds = new Set(reg.sessions.filter((s) => s.agent_id === agentId).map((s) => s.session_id));
  return unique(activeAssignments(reg)
    .filter((a) => a.agent_id === agentId || (a.session_id && sessionIds.has(a.session_id)))
    .map((a) => a.lane_id));
}

/** Every lane a specific session holds -- narrower than its agent's lanes. */
export function lanesForSession(reg, sessionId) {
  const s = reg.sessions.find((x) => x.session_id === sessionId);
  return unique(activeAssignments(reg)
    .filter((a) => a.session_id === sessionId || (s && a.agent_id === s.agent_id))
    .map((a) => a.lane_id));
}

/** Everyone holding a lane. More than one is a collision worth naming. */
export function holdersOfLane(reg, laneId) {
  return activeAssignments(reg)
    .filter((a) => a.lane_id === laneId)
    .map((a) => ({ agent_id: a.agent_id, session_id: a.session_id, worktree: a.worktree }));
}

/** Lanes held by more than one distinct agent at once. */
export function contestedLanes(reg) {
  const out = [];
  for (const l of reg.lanes) {
    const holders = holdersOfLane(reg, l.lane_id);
    const agents = unique(holders.map((h) => h.agent_id ?? agentOfSession(reg, h.session_id)).filter(Boolean));
    if (agents.length > 1) out.push({ lane_id: l.lane_id, agents, holders });
  }
  return out;
}

const agentOfSession = (reg, sid) => reg.sessions.find((s) => s.session_id === sid)?.agent_id ?? null;

/**
 * Capabilities held, unioned across every active lane.
 *
 * Union rather than intersection: holding a lane that may deploy means you may
 * deploy. Anything stricter would make holding a second lane silently REMOVE a
 * privilege, which is the kind of rule people route around.
 */
export function capabilitiesFor(reg, { agentId = null, sessionId = null } = {}) {
  const laneIds = sessionId ? lanesForSession(reg, sessionId) : agentId ? lanesForAgent(reg, agentId) : [];
  const caps = new Set();
  for (const id of laneIds) {
    const lane = reg.lanes.find((l) => l.lane_id === id);
    if (lane && lane.status === 'active') for (const c of lane.capabilities) caps.add(c);
  }
  return [...caps].sort();
}

// ── path classification ─────────────────────────────────────────────────────

/**
 * Glob matching, small and explicit.
 *   **  any number of segments
 *   *   within one segment
 *   ?   one character
 * Separators normalised so a Windows path and a POSIX glob agree.
 */
export function globToRegExp(glob) {
  const g = String(glob).replace(/\\/g, '/');
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        const slash = g[i + 2] === '/';
        out += '.*';
        i += slash ? 2 : 1;
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

export function matchesAny(path, globs) {
  const p = String(path).replace(/\\/g, '/').replace(/^\.\//, '');
  return globs.some((g) => globToRegExp(g).test(p));
}

/**
 * Classify a repo-relative path from one lane's point of view.
 *
 * SHARED OUTRANKS OWNED, deliberately. package.json and scripts/verify.mjs are
 * touched by every lane; whoever also lists them as owned does not thereby get
 * to change them unreviewed. This ordering is what stopped two lanes from
 * reconciling the gate registry independently.
 *
 * UNCLAIMED IS NOT FOREIGN. A path no lane owns is reported as unclaimed so a
 * caller can decide policy. Treating unowned files as foreign would block
 * ordinary work in a repo whose lane map is still partial, and a guard that
 * blocks ordinary work gets turned off.
 */
export function classifyPath(reg, laneId, filePath) {
  const mine = reg.lanes.find((l) => l.lane_id === laneId) ?? null;

  const sharedAnywhere = reg.lanes.some((l) => matchesAny(filePath, l.shared_paths));
  if (sharedAnywhere) return SHARED;

  if (mine && matchesAny(filePath, mine.owned_paths)) return OWNED;

  const owners = reg.lanes.filter((l) => l.lane_id !== laneId && matchesAny(filePath, l.owned_paths));
  if (owners.length) return FOREIGN;

  return UNCLAIMED;
}

/** Who owns a path, for an error message that names the lane to talk to. */
export function ownersOfPath(reg, filePath) {
  return reg.lanes.filter((l) => matchesAny(filePath, l.owned_paths)).map((l) => l.lane_id);
}

/** Does a branch name belong to a lane? Empty patterns mean "no opinion". */
export function laneMatchesBranch(lane, branch) {
  if (!branch || !lane.branch_patterns.length) return null;
  return matchesAny(branch, lane.branch_patterns);
}

const unique = (a) => [...new Set(a)];

// ── worker federation ───────────────────────────────────────────────────────

/**
 * WHAT A WORKER IS DOING, WHICH IS NOT THE SAME AS WHETHER IT EXISTS.
 *
 * `offline` is a reported state, not an absence: a session that has gone away
 * without saying so is still `busy` in the file, and the difference between
 * "told us it stopped" and "stopped telling us" is exactly the difference
 * between a safe reassignment and two workers in one worktree.
 */
export const CAPACITIES = ['idle', 'busy', 'blocked', 'offline'];

/** Capacities that can take new work. `blocked` cannot; it is waiting on someone. */
export const AVAILABLE_CAPACITIES = ['idle'];

/**
 * Every live session belonging to one durable agent.
 *
 * An agent may legitimately have several: a worker running in two repositories
 * at once is one identity holding two runtimes, which is the case that a
 * per-repo namespace would have modelled as two different workers.
 */
export function sessionsOfAgent(reg, agentId) {
  return reg.sessions.filter((s) => s.agent_id === agentId);
}

/**
 * Resolve a durable agent to the ONE live runtime a delegation should bind to.
 *
 * A delegation names an agent because that is the thing that survives a
 * restart; it has to be executed by a session, which does not. This is the
 * join, and it REFUSES rather than guesses:
 *
 *   unknown agent            refuse. A delegation to a worker nobody has
 *                            registered is a typo or a stale config, and
 *                            inventing the agent to accept it is how a contract
 *                            stops meaning anything.
 *   no live session          refuse. The agent exists but is not running.
 *   several candidates       refuse, and NAME them. This is the 15 Sep failure
 *                            exactly: three sessions answering to one identity.
 *                            Picking the newest would have "worked" that day and
 *                            silently sent the work to the wrong one.
 *   offline session          not a candidate.
 *
 * `repo_id` and `worktree_id` narrow the search when given. A session that has
 * not reported its repo is never a match for a specific one — see the note in
 * normalise: null is "unknown", not "anywhere".
 */
export function resolveWorker(reg, { agent_id, repo_id = null, worktree_id = null } = {}) {
  if (!agent_id) return { ok: false, reason: 'no-agent-named', candidates: [] };

  const known = reg.agents.some((a) => a.agent_id === agent_id);
  if (!known) return { ok: false, reason: 'unknown-agent', candidates: [] };

  let candidates = sessionsOfAgent(reg, agent_id).filter((s) => s.capacity !== 'offline');
  if (repo_id !== null) candidates = candidates.filter((s) => s.repo_id === repo_id);
  if (worktree_id !== null) candidates = candidates.filter((s) => s.worktree_id === worktree_id);

  if (candidates.length === 0) return { ok: false, reason: 'no-live-session', candidates: [] };
  if (candidates.length > 1) {
    return { ok: false, reason: 'ambiguous-session', candidates: candidates.map((s) => s.session_id) };
  }

  const s = candidates[0];
  return {
    ok: true,
    agent_id,
    session_id: s.session_id,
    repo_id: s.repo_id,
    worktree_id: s.worktree_id,
    capacity: s.capacity,
  };
}

/**
 * Bind a delegation to a live runtime, or say precisely why it cannot be.
 *
 * The delegation carries a durable `to_agent`; this supplies the ephemeral
 * half. It deliberately does NOT mutate the delegation — a binding is a fact
 * about right now, and writing it into a durable record would make it a claim
 * about for ever, which is the mistake one layer down.
 *
 * A session that is `busy` still binds. Refusing there would mean a worker
 * could never be given its next task while finishing the current one, and the
 * queue is the point. `blocked` and `offline` do not bind.
 */
export function bindDelegation(reg, delegation, { repo_id = null, worktree_id = null } = {}) {
  const agentId = delegation?.to_agent ?? delegation?.to ?? null;
  const resolved = resolveWorker(reg, { agent_id: agentId, repo_id, worktree_id });
  if (!resolved.ok) return { ok: false, reason: resolved.reason, candidates: resolved.candidates, delegation_id: delegation?.id ?? null };
  if (resolved.capacity === 'blocked') {
    return { ok: false, reason: 'worker-blocked', candidates: [resolved.session_id], delegation_id: delegation?.id ?? null };
  }
  return {
    ok: true,
    delegation_id: delegation?.id ?? null,
    agent_id: resolved.agent_id,
    session_id: resolved.session_id,
    repo_id: resolved.repo_id,
    worktree_id: resolved.worktree_id,
  };
}

/**
 * The whole worker roster, across every repository, as one list.
 *
 * Deliberately not grouped by repo. The moment this is presented per-repository
 * it invites a second registry per repository, and then the same worker has two
 * identities and today's confusion is back with tooling to enforce it.
 */
export function workerRoster(reg) {
  return reg.agents.map((a) => {
    const sessions = sessionsOfAgent(reg, a.agent_id);
    const live = sessions.filter((s) => s.capacity !== 'offline');
    const lanes = unique(
      activeAssignments(reg)
        .filter((x) => x.agent_id === a.agent_id || sessions.some((s) => s.session_id === x.session_id))
        .map((x) => x.lane_id),
    );
    return {
      agent_id: a.agent_id,
      display_name: a.display_name,
      lanes,
      repos: unique(live.map((s) => s.repo_id).filter(Boolean)),
      sessions: live.map((s) => ({
        session_id: s.session_id,
        repo_id: s.repo_id,
        worktree_id: s.worktree_id,
        capacity: s.capacity,
      })),
      capacity: live.length === 0 ? 'offline' : live.some((s) => s.capacity === 'idle') ? 'idle' : live.every((s) => s.capacity === 'blocked') ? 'blocked' : 'busy',
    };
  });
}
