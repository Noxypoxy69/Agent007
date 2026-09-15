/**
 * THE COORDINATION GUARD: what may be assigned, to whom, and what may be said.
 *
 * ChatGPT becomes a coordinator here rather than an observer, which means these
 * rules are the only thing between "traffic control" and "an LLM handing
 * production work to a machine that died ten minutes ago".
 *
 * PURE. No clock, no network, no database. Liveness, collisions and dependency
 * state all arrive as arguments, so every refusal below can be tested without
 * standing anything up -- and the refusals are the point. An assignment guard
 * that has only been exercised on the happy path is decoration.
 *
 * WHAT A COORDINATOR MAY DO: assign existing tasks, send structured messages,
 * record owner decisions. WHAT IT MAY NOT: run a command, write a file, deploy,
 * merge, or execute SQL. None of those exist as a tool, so none can be reached
 * by phrasing a request cleverly -- the absence is the control, not a refusal
 * string a model could be talked out of.
 */

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const arr = (v) => (Array.isArray(v) ? v : []);

/** Message types. A closed set: an unknown type is refused, not passed through. */
export const MESSAGE_TYPES = ['assignment', 'question', 'answer', 'status', 'blocker', 'handoff', 'review'];

/** Task states a task may be assigned FROM. */
export const ASSIGNABLE_FROM = ['runnable', 'returned'];

/**
 * Does this text look like something meant to be EXECUTED rather than read?
 *
 * A structured message carries prose for a person or an agent to read. The
 * moment it carries a command, the messaging channel becomes a remote shell
 * with extra steps -- and it would be a shell nobody audited, because it would
 * look like coordination traffic.
 *
 * DELIBERATELY CONSERVATIVE AND DELIBERATELY INCOMPLETE. This cannot catch
 * every way of expressing a command, and pretending otherwise would be worse
 * than useless. It catches the shapes that would actually be pasted into a
 * terminal, and the real control is that nothing downstream EXECUTES a message
 * body. This is defence in depth on top of that, not instead of it.
 */
export function looksExecutable(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();

  const patterns = [
    /(^|[\s;&|`])(rm|curl|wget|chmod|chown|kill|sudo|scp|ssh|nc|eval|exec)\s+-?\w/i,
    /(^|[\s;&|`])(git|npm|npx|node|python|bash|sh|powershell|pwsh|cmd)\s+\S/i,
    /\$\(|\bbacktick\b|`[^`]*`/,
    /\|\s*(sh|bash|zsh|pwsh|powershell)\b/i,
    /\b(drop|delete|truncate|alter|insert|update)\s+(table|from|into)\b/i,
    /<script\b/i,
  ];
  return patterns.some((re) => re.test(t));
}

/**
 * Validate a structured message.
 *
 * Fixed fields only. There is no free-form envelope, no attachment, and no
 * field whose contents are interpreted by anything.
 */
export function validateMessage(m = {}) {
  const errors = [];

  if (!nonEmpty(m.from_agent)) errors.push('from_agent is required');
  if (!nonEmpty(m.to_agent)) errors.push('to_agent is required');
  if (!MESSAGE_TYPES.includes(m.type)) {
    errors.push(`type must be one of ${MESSAGE_TYPES.join(', ')}`);
  }
  if (!nonEmpty(m.body)) errors.push('body is required');
  else if (m.body.length > 8000) errors.push('body exceeds 8000 characters');
  else if (looksExecutable(m.body)) {
    errors.push('body looks like a command rather than a message: a coordination '
      + 'channel that carries executable text is a remote shell nobody audited');
  }
  if (m.task_id != null && !nonEmpty(m.task_id)) errors.push('task_id must be a string when present');

  return { ok: errors.length === 0, errors };
}

/**
 * Resolve a DURABLE agent id to its one live session.
 *
 * ONE IMPLEMENTATION, SHARED BY THE CLI AND THE EDGE. laneRegistry.resolveWorker
 * answers the same question for a registry parsed from a YAML FILE, and its
 * input shape is different; bundling it to the edge would also drag a 188-line
 * YAML parser somewhere no file exists. So LIVE-registry resolution lives here,
 * where both callers already load it, rather than being written twice and
 * drifting the first time one is fixed.
 *
 * The three outcomes are the ones this system turns on everywhere: exactly one
 * live session resolves, none refuses, several refuse as ambiguous AND name the
 * candidates. Silently picking the newest would "work" and send the contract to
 * the wrong runtime, which is the failure the registry exists to prevent.
 *
 * @param {Array}  sessions  rows from registryFromSessions — capacity is already
 *                           staleness-adjusted there, so a stale row reads
 *                           'offline' and is excluded without a second clock.
 * @param {string} agent_id  the durable identity a person types
 */
export function resolveLiveAgent(sessions, agent_id) {
  if (!nonEmpty(agent_id)) return { ok: false, reason: 'no-agent-named', candidates: [] };
  const all = arr(sessions);

  // "Unknown" and "known but not running" are different answers, and a
  // coordinator needs to tell a typo from a worker that has gone away.
  if (!all.some((s) => s?.agent_id === agent_id)) {
    return { ok: false, reason: 'unknown-agent', candidates: [] };
  }

  const candidates = all.filter((s) => s?.agent_id === agent_id && s?.capacity !== 'offline');
  if (candidates.length === 0) return { ok: false, reason: 'no-live-session', candidates: [] };
  if (candidates.length > 1) {
    return { ok: false, reason: 'ambiguous-session', candidates: candidates.map((s) => s.session_id) };
  }

  const s = candidates[0];
  return {
    ok: true,
    agent_id,
    session_id: s.session_id,
    repo_id: s.repo_id ?? null,
    worktree_id: s.worktree_id ?? null,
    lane_id: s.lane_id ?? null,
    capacity: s.capacity ?? null,
    heartbeat_at: s.heartbeat_at ?? null,
  };
}

/**
 * MAY THIS TASK GO TO THIS WORKER, RIGHT NOW?
 *
 * Every refusal is separately reachable, and each is here because the
 * alternative is a specific, nameable failure:
 *
 *   no task / no worker      a contract addressed to nothing
 *   wrong state              re-assigning work somebody already holds
 *   unsatisfied dependency   starting work whose input does not exist yet
 *   upstream already done    burning a worker on work that is no longer needed
 *   not live / stale         a contract addressed to a machine that is gone
 *   ambiguous                the right agent, the wrong runtime
 *   repo or lane mismatch    correct work, wrong tree
 *   path collision           two workers editing the same file
 *   stale base               work branched from a commit master has moved past
 *
 * @param {object} task       the task row
 * @param {object} worker     resolved session {session_id, agent_id, repo_id, capacity, ...}
 * @param {object} context    {tasks, assignments, headSha, isLive}
 */
export function canAssign(task, worker, context = {}) {
  const errors = [];
  const tasks = arr(context.tasks);
  const assignments = arr(context.assignments);

  if (!task || !nonEmpty(task.task_id)) {
    return { ok: false, errors: ['no such task'] };
  }
  if (!worker || !nonEmpty(worker.session_id) || !nonEmpty(worker.agent_id)) {
    return { ok: false, errors: ['no resolved worker: the target must come from the live registry, not a typed name'] };
  }

  if (!ASSIGNABLE_FROM.includes(task.state)) {
    errors.push(`task is "${task.state}"; only ${ASSIGNABLE_FROM.join(' or ')} work can be assigned`);
  }

  /*
   * LIVENESS IS INJECTED, NOT ASSUMED. The caller passes the same isLive used
   * everywhere else; a guard with its own idea of "live" is a second answer to
   * a question that must have one.
   */
  const live = typeof context.isLive === 'function' ? context.isLive(worker) : null;
  if (live === null) errors.push('liveness was not evaluated: refusing rather than guessing');
  else if (!live) errors.push(`worker ${worker.session_id} is not live (capacity ${worker.capacity ?? 'unknown'})`);

  if (worker.capacity === 'offline') errors.push(`worker ${worker.session_id} declared itself offline`);

  // Repo and lane must match where the work actually is.
  if (nonEmpty(task.repo_id) && nonEmpty(worker.repo_id)
      && task.repo_id !== worker.repo_id) {
    errors.push(`task is in repo "${task.repo_id}" but ${worker.session_id} is in "${worker.repo_id}"`);
  }
  if (nonEmpty(task.lane_id) && nonEmpty(worker.lane_id)
      && task.lane_id !== worker.lane_id) {
    errors.push(`task is in lane "${task.lane_id}" but ${worker.session_id} holds lane "${worker.lane_id}"`);
  }

  // ── dependencies ────────────────────────────────────────────────────────
  const byId = new Map(tasks.map((t) => [t?.task_id, t]));
  for (const dep of arr(task.depends_on)) {
    const d = byId.get(dep);
    if (!d) {
      errors.push(`depends on "${dep}", which does not exist`);
    } else if (d.state !== 'accepted') {
      errors.push(`depends on "${dep}", which is "${d.state}" and not accepted`);
    }
  }

  /*
   * ALREADY-SATISFIED UPSTREAM. A task whose work another task has already
   * delivered is not runnable, it is finished -- assigning it spends a worker
   * on a diff that will come back empty, and the delegation lifecycle then
   * refuses the return because head equals base. Catching it here is the
   * difference between a refusal now and a wasted session.
   */
  if (nonEmpty(task.supersededBy)) {
    errors.push(`already satisfied by "${task.supersededBy}"`);
  }

  // ── path collisions against work already assigned ───────────────────────
  const mine = new Set([...arr(task.allowed_paths), ...arr(task.shared_paths)]);
  const forbidden = new Set(arr(task.forbidden_paths));
  for (const p of mine) {
    if (forbidden.has(p)) {
      // Precedence is forbidden > allowed, so an ambiguous contract fails
      // closed rather than granting the wider permission.
      errors.push(`path "${p}" is both allowed and forbidden: ambiguous contract`);
    }
  }

  for (const a of assignments) {
    if (!a || a.task_id === task.task_id) continue;
    if (!['assigned', 'returned'].includes(a.state)) continue;
    const theirs = new Set(arr(a.allowed_paths));
    for (const p of arr(task.allowed_paths)) {
      // SHARED paths are declared overlap and are allowed to collide; ALLOWED
      // paths are exclusive, and two workers holding one is the collision this
      // whole system exists to prevent.
      if (theirs.has(p) && !arr(a.shared_paths).includes(p) && !arr(task.shared_paths).includes(p)) {
        errors.push(`path "${p}" is already held by task "${a.task_id}" (${a.assigned_session ?? 'unassigned'})`);
      }
    }
  }

  // ── base freshness ──────────────────────────────────────────────────────
  if (nonEmpty(context.headSha) && nonEmpty(task.base_sha)
      && task.base_sha !== context.headSha) {
    errors.push(`base ${task.base_sha.slice(0, 12)} is stale; the tree is at ${context.headSha.slice(0, 12)}. `
      + 're-resolve the base rather than assigning work from a commit the tree has moved past');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * The record written when an assignment is permitted.
 *
 * Provenance travels WITH the assignment rather than being reconstructed later:
 * who assigned it, to which runtime, and from which base. A coordinator that
 * cannot be traced is a coordinator nobody can audit.
 */
export function assignmentRecord(task, worker, { by, at }) {
  return {
    task_id: task.task_id,
    state: 'assigned',
    assigned_agent: worker.agent_id,
    assigned_session: worker.session_id,
    assigned_by: by,
    assigned_at: at,
  };
}
