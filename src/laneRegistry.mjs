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
    agents: (doc.agents ?? []).map((a) => ({ agent_id: a?.agent_id, display_name: a?.display_name ?? a?.agent_id })),
    sessions: (doc.sessions ?? []).map((s) => ({ session_id: s?.session_id, agent_id: s?.agent_id })),
    assignments: (doc.assignments ?? []).map((x) => ({
      lane_id: x?.lane_id,
      agent_id: x?.agent_id ?? null,
      session_id: x?.session_id ?? null,
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
