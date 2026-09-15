
export function globToRegex(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') { i++; out += '(?:.*/)?'; }
        else out += '.*';
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) out += '\\' + c;
    else if (c === '/') out += '/';
    else out += c;
  }
  return new RegExp('^' + out + '$');
}

export function matchesAny(p, patterns) {
  const norm = String(p).replace(/\\/g, '/').replace(/^\.\//, '');
  return patterns.some((pat) => globToRegex(String(pat).replace(/\\/g, '/')).test(norm));
}

export function ownerOf(p, lanes) {
  for (const [lane, patterns] of Object.entries(lanes || {})) {
    if (matchesAny(p, patterns || [])) return lane;
  }
  return null;
}

export function detectCollisions(sessions, { lanes = null, staleAfterSeconds = 90, now = Date.now() } = {}) {
  const findings = [];
  const add = (severity, code, message, evidence) => findings.push({ severity, code, message, evidence });
  const live = sessions.filter((s) => s.git?.ok !== false);

  const byWorktree = new Map();
  for (const s of sessions) {
    const k = String(s.worktree).replace(/[\\/]+$/, '').toLowerCase();
    byWorktree.set(k, [...(byWorktree.get(k) ?? []), s]);
  }
  for (const [wt, group] of byWorktree) {
    if (group.length > 1) {
      add('critical', 'shared-worktree',
        `${group.length} agents registered to the same worktree`,
        { worktree: wt, agents: group.map((s) => s.agentId) });
    }
  }

  const byLane = new Map();
  for (const s of sessions) byLane.set(s.lane, [...(byLane.get(s.lane) ?? []), s.agentId]);
  for (const [lane, agents] of byLane) {
    if (agents.length > 1) {
      add('critical', 'duplicate-lane', `lane "${lane}" claimed by ${agents.length} agents`,
        { lane, agents });
    }
  }

  const byResource = new Map();
  for (const s of sessions) {
    for (const l of s.locks ?? []) {
      byResource.set(l.resource, [...(byResource.get(l.resource) ?? []), { agentId: s.agentId, ...l }]);
      if (l.heldBy && l.heldBy !== s.agentId) {
        add('critical', 'foreign-lock',
          `lock "${l.resource}" in ${s.agentId}'s worktree is held by ${l.heldBy}`,
          { worktree: s.worktree, resource: l.resource, heldBy: l.heldBy, registeredAgent: s.agentId });
      }
    }
  }
  for (const [resource, holders] of byResource) {
    if (holders.length > 1) {
      add('critical', 'lock-contention', `resource "${resource}" locked in ${holders.length} worktrees`,
        { resource, holders: holders.map((h) => ({ agent: h.agentId, ageSeconds: h.ageSeconds })) });
    }
  }

  if (lanes && Object.keys(lanes).length) {
    for (const s of live) {
      const touched = [...(s.git?.staged ?? []), ...(s.git?.dirty ?? [])];
      const foreign = [];
      for (const f of touched) {
        if (f.sensitive) continue;              // redacted path: cannot be matched
        const owner = ownerOf(f.path, lanes);
        if (owner && owner !== s.lane) foreign.push({ path: f.path, owner });
      }
      if (foreign.length) {
        add('critical', 'cross-lane-write',
          `${s.agentId} (lane ${s.lane}) has uncommitted changes in ${foreign.length} file(s) owned by another lane`,
          { agent: s.agentId, lane: s.lane, files: foreign.slice(0, 50) });
      }
    }
  } else {
    add('info', 'no-lane-map',
      'no lanes map supplied; cross-lane file ownership was not evaluated',
      { hint: 'publish lanes.yml path globs to enable cross-lane-write detection' });
  }

  for (const s of live) {
    const g = s.git;
    if (g?.unpushed > 0) {
      add('warn', 'unpushed-commits',
        `${s.agentId} has ${g.unpushed} commit(s) not on the remote`,
        { agent: s.agentId, branch: g.branch, head: g.head, basis: g.unpushedReason });
    }
    if (g && g.unpushed > 0 && !g.upstream) {
      add('warn', 'no-upstream', `${s.agentId}'s branch has never been pushed`,
        { agent: s.agentId, branch: g.branch });
    }
  }

  for (const s of live) {
    const g = s.git;
    if (g?.branch === 'main' && g.aheadOfMain > 0) {
      add('critical', 'local-main-ahead',
        `${s.agentId} is on main with ${g.aheadOfMain} unpushed commit(s)`,
        { agent: s.agentId, worktree: s.worktree, ahead: g.aheadOfMain });
    }
    if (g && g.behindMain > 0) {
      add('info', 'behind-main', `${s.agentId} is ${g.behindMain} commit(s) behind ${g.mainRef}`,
        { agent: s.agentId, behind: g.behindMain, base: g.baseSha });
    }
  }
  const mainShas = new Set(live.map((s) => s.git?.mainSha).filter(Boolean));
  if (mainShas.size > 1) {
    add('warn', 'divergent-origin-main',
      `worktrees disagree on ${live[0]?.git?.mainRef ?? 'origin/main'} — at least one has a stale fetch`,
      { observed: [...mainShas], perAgent: live.map((s) => ({ agent: s.agentId, mainSha: s.git?.mainSha })) });
  }

  for (const s of sessions) {
    const seen = s.lastSeenAt ? Date.parse(s.lastSeenAt) : null;
    if (seen && (now - seen) / 1000 > staleAfterSeconds) {
      add('warn', 'stale-session',
        `no heartbeat from ${s.agentId} for ${Math.round((now - seen) / 1000)}s`,
        { agent: s.agentId, lastSeenAt: s.lastSeenAt });
    }
  }

  for (const s of sessions) {
    if (s.git?.ok === false) {
      add('warn', 'worktree-unreadable', `cannot read git state for ${s.agentId}: ${s.git.reason}`,
        { agent: s.agentId, worktree: s.worktree });
    }
    if (s.processProbeOk === false) {
      add('info', 'process-probe-failed',
        `process list unavailable for ${s.agentId}; "nothing running" cannot be confirmed`,
        { agent: s.agentId });
    }
  }

  const rank = { critical: 0, warn: 1, info: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return {
    generatedAt: new Date(now).toISOString(),
    counts: {
      critical: findings.filter((f) => f.severity === 'critical').length,
      warn: findings.filter((f) => f.severity === 'warn').length,
      info: findings.filter((f) => f.severity === 'info').length,
    },
    findings,
  };
}

export const SCOPE_PRECEDENCE = { bridge: 0, project: 1, repo: 2, lane: 3, task: 4 };
export const SCOPE_TYPES = Object.keys(SCOPE_PRECEDENCE);

export const EFFECTS = ['allow', 'deny', 'require_owner'];

export const OUTCOMES = ['allowed', 'denied', 'owner_required', 'no_decision'];

const SCOPE_KEY = { project: 'project', repo: 'repo', lane: 'lane', task: 'task' };

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

export function capabilityMatches(capability, action) {
  if (!isNonEmptyString(capability) || !isNonEmptyString(action)) return false;
  const cap = capability.trim();
  const act = action.trim();
  if (cap === '*') return true;
  if (cap === act) return true;
  if (cap.endsWith('.*')) {
    const prefix = cap.slice(0, -2);
    return act.startsWith(`${prefix}.`);
  }
  return false;
}

export function scopeMatches(decision, context = {}) {
  const type = decision?.scope_type;
  if (type === 'bridge') return true;
  const key = SCOPE_KEY[type];
  if (!key) return false;
  const want = decision?.scope_id;
  const have = context?.[key];
  if (!isNonEmptyString(want) || !isNonEmptyString(have)) return false;
  return want === have;
}

export function validateDecision(d) {
  const errors = [];
  if (!isPlainObject(d)) return { ok: false, errors: ['decision must be an object'] };

  if (!isNonEmptyString(d.decision_id)) errors.push('decision_id is required');
  if (!isNonEmptyString(d.owner_id)) errors.push('owner_id is required');
  if (!isNonEmptyString(d.statement)) errors.push('statement is required — the builder\'s own words are the audit');
  if (!SCOPE_TYPES.includes(d.scope_type)) errors.push(`scope_type must be one of ${SCOPE_TYPES.join(', ')}`);
  if (!EFFECTS.includes(d.effect)) errors.push(`effect must be one of ${EFFECTS.join(', ')}`);

  if (d.scope_type && d.scope_type !== 'bridge' && !isNonEmptyString(d.scope_id)) {
    errors.push(`scope_type "${d.scope_type}" requires a scope_id`);
  }
  if (d.scope_type === 'bridge' && isNonEmptyString(d.scope_id)) {
    errors.push('scope_type "bridge" must not carry a scope_id — it is the whole bridge');
  }

  if (!Array.isArray(d.capabilities) || d.capabilities.length === 0) {
    errors.push('capabilities must be a non-empty array — a decision about nothing applies to everything');
  } else if (!d.capabilities.every(isNonEmptyString)) {
    errors.push('every capability must be a non-empty string');
  }

  if (d.constraints != null && !isPlainObject(d.constraints)) {
    errors.push('constraints must be an object when present');
  }

  if (!isNonEmptyString(d.created_by)) errors.push('created_by is required');
  else if (isNonEmptyString(d.owner_id) && d.created_by !== d.owner_id) {
    errors.push(`created_by "${d.created_by}" is not the owner "${d.owner_id}": a worker cannot record a decision on the owner's behalf`);
  }

  if (!isNonEmptyString(d.created_at)) errors.push('created_at is required');

  return { ok: errors.length === 0, errors };
}

export function createDecision({
  decision_id, owner_id, decision_type = 'policy', statement,
  scope_type, scope_id = null, effect, capabilities = [], constraints = null,
  created_by, created_at, supersedes = null,
}) {
  return {
    decision_id, owner_id, decision_type, statement,
    scope_type, scope_id: scope_type === 'bridge' ? null : scope_id,
    effect,
    capabilities: [...capabilities],
    constraints: constraints ?? {},
    created_at, created_by,
    supersedes,
    revoked_at: null,
    revoked_by: null,
    history: [{ event: 'created', at: created_at, by: created_by }],
  };
}

export function activeDecisions(rows) {
  if (!Array.isArray(rows)) throw new TypeError('activeDecisions requires an array');

  const valid = rows.filter((d) => validateDecision(d).ok);
  const notRevoked = valid.filter((d) => !d.revoked_at);

  const superseded = new Set(
    notRevoked.map((d) => d.supersedes).filter(isNonEmptyString),
  );

  return notRevoked.filter((d) => !superseded.has(d.decision_id));
}

export function resolveOwnerDecision(rows, action, context = {}) {
  if (!isNonEmptyString(action)) {
    return {
      outcome: 'owner_required', decision_id: null, matched_scope: null,
      reason: 'the requested action was not classified, so no decision can be matched',
      constraints: {}, statement: null, candidates: [],
    };
  }

  const live = activeDecisions(rows);
  const matches = live.filter((d) =>
    scopeMatches(d, context) && d.capabilities.some((c) => capabilityMatches(c, action)));

  if (matches.length === 0) {
    return {
      outcome: 'no_decision', decision_id: null, matched_scope: null,
      reason: `no owner decision covers "${action}" in this context — ask once, then record the answer`,
      constraints: {}, statement: null, candidates: [],
    };
  }

  const best = Math.max(...matches.map((d) => SCOPE_PRECEDENCE[d.scope_type]));
  const winners = matches.filter((d) => SCOPE_PRECEDENCE[d.scope_type] === best);
  const matched_scope = SCOPE_TYPES.find((s) => SCOPE_PRECEDENCE[s] === best);

  const effects = [...new Set(winners.map((d) => d.effect))];

  if (effects.length > 1) {
    return {
      outcome: 'owner_required',
      decision_id: null,
      matched_scope,
      reason: `conflicting decisions at ${matched_scope} scope (${effects.join(' vs ')}) — the owner must resolve this`,
      constraints: {},
      statement: null,
      candidates: winners.map((d) => d.decision_id),
    };
  }

  const chosen = [...winners].sort((a, b) =>
    String(b.created_at).localeCompare(String(a.created_at))
    || String(a.decision_id).localeCompare(String(b.decision_id)))[0];

  const outcome = { allow: 'allowed', deny: 'denied', require_owner: 'owner_required' }[chosen.effect];

  return {
    outcome,
    decision_id: chosen.decision_id,
    matched_scope,
    reason: `${matched_scope}-scoped decision ${chosen.decision_id}: ${chosen.statement}`,
    constraints: chosen.constraints ?? {},
    statement: chosen.statement,
    candidates: winners.map((d) => d.decision_id),
  };
}

export function revokeDecision(d, { at, by, reason = null }) {
  if (!isPlainObject(d)) return { ok: false, errors: ['no such decision'] };
  if (d.revoked_at) return { ok: false, errors: [`decision ${d.decision_id} was already revoked at ${d.revoked_at}`] };
  if (!isNonEmptyString(at) || !isNonEmptyString(by)) {
    return { ok: false, errors: ['revocation requires a timestamp and an author'] };
  }
  if (isNonEmptyString(d.owner_id) && by !== d.owner_id) {
    return { ok: false, errors: [`"${by}" is not the owner "${d.owner_id}": a worker cannot revoke the owner's decision`] };
  }
  return {
    ok: true,
    record: {
      ...d,
      revoked_at: at,
      revoked_by: by,
      history: [...(d.history ?? []), { event: 'revoked', at, by, reason }],
    },
  };
}

export const STALE_AFTER_MS = 10 * 60 * 1000;

export const CAPACITIES = ['idle', 'busy', 'blocked', 'offline'];

const str = (v) => (typeof v === 'string' && v.trim().length ? v.trim() : null);

export function heartbeatAgeMs(row, now) {
  const at = row?.heartbeat_at ?? row?.lastSeenAt ?? row?.last_seen_at ?? null;
  if (!at) return null;
  const t = Date.parse(at);
  const n = Date.parse(now);
  if (Number.isNaN(t) || Number.isNaN(n)) return null;
  return n - t;
}

export function isLive(row, { now, staleAfterMs = STALE_AFTER_MS } = {}) {
  if (row?.capacity === 'offline') return false;
  const age = heartbeatAgeMs(row, now);
  if (age === null) return false;
  return age >= 0 && age <= staleAfterMs;
}

export function registryFromSessions(rows, { now, staleAfterMs = STALE_AFTER_MS } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('registryFromSessions requires an array');
  if (!str(now)) throw new TypeError('registryFromSessions requires a `now` timestamp');

  const sessions = [];
  const agentIds = new Set();

  for (const r of rows) {
    const agent_id = str(r?.agent_id);
    const session_id = str(r?.session_id);
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
      capacity: isLive(r, { now, staleAfterMs })
        ? (CAPACITIES.includes(r?.capacity) ? r.capacity : 'idle')
        : 'offline',
    });
  }

  return {
    agents: [...agentIds].sort().map((agent_id) => ({ agent_id, display_name: agent_id })),
    sessions,
    lanes: [],
    assignments: [],
  };
}

export const VERIFICATION = {
  VERIFIED: 'verified',
  LEGACY: 'legacy-unverified',
};

export function verificationOf(delegation) {
  const v = str(delegation?.target_verification);
  return v === VERIFICATION.VERIFIED ? VERIFICATION.VERIFIED : VERIFICATION.LEGACY;
}

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const arr = (v) => (Array.isArray(v) ? v : []);

export const MESSAGE_TYPES = ['assignment', 'question', 'answer', 'status', 'blocker', 'handoff', 'review'];

export const ASSIGNABLE_FROM = ['runnable', 'returned'];

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

export function resolveLiveAgent(sessions, agent_id) {
  if (!nonEmpty(agent_id)) return { ok: false, reason: 'no-agent-named', candidates: [] };
  const all = arr(sessions);

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

  const live = typeof context.isLive === 'function' ? context.isLive(worker) : null;
  if (live === null) errors.push('liveness was not evaluated: refusing rather than guessing');
  else if (!live) errors.push(`worker ${worker.session_id} is not live (capacity ${worker.capacity ?? 'unknown'})`);

  if (worker.capacity === 'offline') errors.push(`worker ${worker.session_id} declared itself offline`);

  if (nonEmpty(task.repo_id) && nonEmpty(worker.repo_id)
      && task.repo_id !== worker.repo_id) {
    errors.push(`task is in repo "${task.repo_id}" but ${worker.session_id} is in "${worker.repo_id}"`);
  }
  if (nonEmpty(task.lane_id) && nonEmpty(worker.lane_id)
      && task.lane_id !== worker.lane_id) {
    errors.push(`task is in lane "${task.lane_id}" but ${worker.session_id} holds lane "${worker.lane_id}"`);
  }

  const byId = new Map(tasks.map((t) => [t?.task_id, t]));
  for (const dep of arr(task.depends_on)) {
    const d = byId.get(dep);
    if (!d) {
      errors.push(`depends on "${dep}", which does not exist`);
    } else if (d.state !== 'accepted') {
      errors.push(`depends on "${dep}", which is "${d.state}" and not accepted`);
    }
  }

  if (nonEmpty(task.supersededBy)) {
    errors.push(`already satisfied by "${task.supersededBy}"`);
  }

  const mine = new Set([...arr(task.allowed_paths), ...arr(task.shared_paths)]);
  const forbidden = new Set(arr(task.forbidden_paths));
  for (const p of mine) {
    if (forbidden.has(p)) {
      errors.push(`path "${p}" is both allowed and forbidden: ambiguous contract`);
    }
  }

  for (const a of assignments) {
    if (!a || a.task_id === task.task_id) continue;
    if (!['assigned', 'returned'].includes(a.state)) continue;
    const theirs = new Set(arr(a.allowed_paths));
    for (const p of arr(task.allowed_paths)) {
      if (theirs.has(p) && !arr(a.shared_paths).includes(p) && !arr(task.shared_paths).includes(p)) {
        errors.push(`path "${p}" is already held by task "${a.task_id}" (${a.assigned_session ?? 'unassigned'})`);
      }
    }
  }

  if (nonEmpty(context.headSha) && nonEmpty(task.base_sha)
      && task.base_sha !== context.headSha) {
    errors.push(`base ${task.base_sha.slice(0, 12)} is stale; the tree is at ${context.headSha.slice(0, 12)}. `
      + 're-resolve the base rather than assigning work from a commit the tree has moved past');
  }

  return { ok: errors.length === 0, errors };
}

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

export const jsonResult = (data) => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

export const INSTRUCTIONS =
  'Live engineering state for multi-agent Git worktrees. Every field is observed from git ' +
  'plumbing and the process table on the developer machine, not reported by the agents ' +
  'themselves, so an agent cannot misreport its own state here. Fields that could not be ' +
  'determined are null — treat null as unknown, never as zero. This server is read-only: ' +
  'it cannot assign tasks, send messages, or run commands.\n\n' +
  'QUERY THIS SERVER BEFORE ASKING A PERSON. Branches, HEADs, bases, worktrees, locks and ' +
  'running processes are all here and are authoritative. Do not ask the operator to paste a ' +
  'status brief or a file list; call the tool. A pasted summary is a stale copy of something ' +
  'this server holds live.\n\n' +
  'THEN SPEAK ONLY TO WHAT CHANGED. Report deltas, decisions, anomalies and unresolved risk. ' +
  'Do not restate state you just read — reference the agent or task id instead and let the ' +
  'reader query it.\n\n' +
  'EXCEPT FOR EVIDENCE, WHICH IS NEVER ABBREVIATED. Security findings, failed gates, mutation ' +
  'results, contract violations, ambiguous provenance and unresolved risk are reported in full ' +
  'every time. Brevity applies to restating known state, never to the proof that something was ' +
  'actually checked. A short report that drops evidence is worse than a long one that carries it.';

const OUTSTANDING = ['assigned', 'rejected'];
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required });

export function toolDefs(store) {
  if (!store || typeof store.listSessions !== 'function' || typeof store.getLanes !== 'function') {
    throw new TypeError('toolDefs(store): store must provide listSessions() and getLanes()');
  }
  const { listSessions, getLanes, listDelegations, listDecisions } = store;

  const defs = [
    {
      name: 'list_agents',
      title: 'List agents',
      description: 'All registered agents with lane, branch, HEAD, and staleness. Start here.',
      input: obj(),
      run: async () => jsonResult((await listSessions()).map((s) => ({
        agentId: s.agentId, lane: s.lane, machine: s.machineLabel,
        sessionId: s.sessionId ?? null,
        repoId: s.repoId ?? null,
        worktree: s.worktree ?? null,
        capacity: s.capacity ?? null,
        branch: s.git?.branch ?? null, head: s.git?.head ?? null,
        baseSha: s.git?.baseSha ?? null,
        unpushed: s.git?.unpushed ?? null,
        dirtyFiles: (s.git?.dirty ?? []).length,
        locksHeld: (s.locks ?? []).map((l) => l.resource),
        running: (s.processes ?? []).map((p) => p.kind),
        lastSeenAt: s.lastSeenAt,
      }))),
    },
    {
      name: 'get_agent_state',
      title: 'Get agent state',
      description: 'Full snapshot for one agent: git state, locks, processes, file lists.',
      input: obj({ agentId: { type: 'string', description: 'e.g. "code-c"' } }, ['agentId']),
      run: async ({ agentId }) => {
        const s = (await listSessions()).find((x) => x.agentId === agentId);
        return jsonResult(s ?? { error: 'no such agent', agentId });
      },
    },
    {
      name: 'list_worktrees',
      title: 'List worktrees',
      description: 'Worktree paths and which agent is registered to each.',
      input: obj(),
      run: async () => jsonResult((await listSessions()).map((s) => ({
        worktree: s.worktree, agentId: s.agentId, lane: s.lane, branch: s.git?.branch ?? null,
      }))),
    },
    {
      name: 'get_git_state',
      title: 'Get git state',
      description: 'Branch, HEAD, merge-base, origin/main, upstream, unpushed count, ahead/behind.',
      input: obj({ agentId: { type: 'string', description: 'omit for all agents' } }),
      run: async ({ agentId } = {}) => {
        const all = await listSessions();
        return jsonResult((agentId ? all.filter((s) => s.agentId === agentId) : all)
          .map((s) => ({ agentId: s.agentId, lane: s.lane, ...(s.git ?? {}) })));
      },
    },
    {
      name: 'list_active_processes',
      title: 'List active processes',
      description:
        'Verify/test/lint/agent processes associated with each worktree. `confidence:"cwd"` is ' +
        'an exact match; `"commandline"` is a substring match and can miss processes. If ' +
        'processProbeOk is false, an empty list does NOT mean nothing is running.',
      input: obj(),
      run: async () => jsonResult((await listSessions()).map((s) => ({
        agentId: s.agentId, processProbeOk: s.processProbeOk !== false, processes: s.processes ?? [],
      }))),
    },
    {
      name: 'list_locks',
      title: 'List locks',
      description: 'Observed lock files per worktree, with holder and age.',
      input: obj(),
      run: async () => jsonResult((await listSessions()).flatMap((s) =>
        (s.locks ?? []).map((l) => ({ agentId: s.agentId, worktree: s.worktree, ...l })))),
    },
    {
      name: 'get_collision_summary',
      title: 'Get collision summary',
      description:
        'Derived findings: shared worktrees, duplicate lanes, lock contention, cross-lane ' +
        'uncommitted writes, unpushed work, main divergence, stale sessions. Each finding ' +
        'carries the evidence it was derived from.',
      input: obj(),
      run: async () => {
        const [sessions, lanes] = await Promise.all([listSessions(), getLanes()]);
        return jsonResult(detectCollisions(sessions, { lanes }));
      },
    },
  ];

  if (typeof listDelegations === 'function') {
    defs.push({
      name: 'list_delegations',
      title: 'List delegations',
      description:
        'Task contracts: who owes what, from which base commit, and which files they may and ' +
        'may not touch. READ THIS INSTEAD OF ASKING FOR A BRIEF — it is the authoritative copy. ' +
        'Defaults to outstanding work only (assigned or rejected); pass includeAll for history. ' +
        'NOTE: contracts are addressed by session id, which does not yet resolve to the agentId ' +
        'used by the other tools — that mapping is being built, so do not infer it.',
      input: obj({
        session: { type: 'string', description: 'filter to one session id, e.g. "danny-win-f1"' },
        includeAll: { type: 'boolean', description: 'include returned/accepted/withdrawn too' },
      }),
      run: async ({ session, includeAll = false } = {}) => {
        const rows = await listDelegations();
        const mine = session ? rows.filter((d) => d?.assigned_session === session) : rows;
        const picked = includeAll ? mine : mine.filter((d) => OUTSTANDING.includes(d?.state));
        return jsonResult(picked.map((d) => ({
          id: d.id, state: d.state, task: d.task, lane: d.lane_id ?? null,
          from: d.assigning_session, to: d.assigned_session,
          baseSha: d.base_sha, headSha: d.head_sha ?? null,
          allowedPaths: d.allowed_paths ?? [],
          sharedPaths: d.shared_paths ?? [],
          forbiddenPaths: d.forbidden_paths ?? [],
          auditOk: d.audit ? d.audit.ok : null,
        })));
      },
    });
    defs.push({
      name: 'get_delegation',
      title: 'Get delegation',
      description:
        'One contract in full, including its audit result and state history. Use after ' +
        'list_delegations when you need the evidence rather than the summary.',
      input: obj({ id: { type: 'string', description: 'e.g. "d-schedule-safety"' } }, ['id']),
      run: async ({ id }) => {
        const d = (await listDelegations()).find((x) => x.id === id);
        return jsonResult(d ?? { error: 'no such delegation', id });
      },
    });
  }

  if (typeof listDecisions === 'function') {
    defs.push({
      name: 'resolve_owner_decision',
      title: 'Resolve owner decision',
      description:
        'ASK THIS BEFORE ASKING THE BUILDER ANYTHING. Returns what the owner has already '
        + 'decided about an action in this context, so the same question is never put to them '
        + 'twice. Outcomes: "allowed" (proceed, do not ask), "denied" (refuse, do not ask), '
        + '"owner_required" (escalate), "no_decision" (ask ONCE, then record the answer with '
        + '`agentbridge owner-decide`). Narrower scope wins: task > lane > repo > project > '
        + 'bridge. A narrow approval NEVER widens — approval to deploy staging for one task is '
        + 'not approval to deploy production, nor to deploy for another task.',
      input: obj({
        action: {
          type: 'string',
          description: 'the classified action, e.g. "deploy.production", "commit", "spend.cloudflare"',
        },
        project: { type: 'string', description: 'project scope, if known' },
        repo: { type: 'string', description: 'repository scope, if known' },
        lane: { type: 'string', description: 'lane scope, if known' },
        task: { type: 'string', description: 'task or delegation id, if known' },
      }, ['action']),
      run: async ({ action, project, repo, lane, task } = {}) => {
        const rows = await listDecisions();
        return jsonResult(resolveOwnerDecision(rows, action, { project, repo, lane, task }));
      },
    });
  }

  const { listTasks, assignTask, sendMessage, recordOwnerDecision } = store;

  if (typeof listTasks === 'function') {
    defs.push({
      name: 'list_tasks',
      title: 'List tasks',
      description:
        'Coordination tasks with state (runnable, assigned, blocked, returned, accepted, '
        + 'cancelled), lane, repo, base commit, path contract and dependencies. Read this '
        + 'before assigning anything: a task that is blocked or already assigned is not work '
        + 'you can hand out.',
      input: obj({ state: { type: 'string', description: 'filter to one state' } }),
      run: async ({ state } = {}) => {
        const rows = await listTasks();
        return jsonResult(state ? rows.filter((t) => t?.state === state) : rows);
      },
    });
  }

  if (typeof assignTask === 'function') {
    defs.push({
      name: 'assign_task',
      title: 'Assign task',
      description:
        'Assign an existing task to a worker, BY DURABLE AGENT ID. The Bridge resolves the '
        + 'agent to its live session itself — never pass a session id you read somewhere. '
        + 'REFUSES, rather than warning, when: the worker is stale, offline or ambiguous; the '
        + 'task is not runnable or returned; a dependency is unsatisfied; the work is already '
        + 'satisfied upstream; a path collides with another assignment; the repo or lane does '
        + 'not match; or the base commit is stale. A refusal names every reason at once.',
      input: obj({
        task_id: { type: 'string', description: 'an existing task id' },
        agent_id: { type: 'string', description: 'durable agent id, e.g. "code-b"' },
      }, ['task_id', 'agent_id']),
      run: async ({ task_id, agent_id }) => jsonResult(await assignTask({ task_id, agent_id })),
    });
  }

  if (typeof sendMessage === 'function') {
    defs.push({
      name: 'send_message',
      title: 'Send message',
      description:
        'Send a STRUCTURED coordination message to a worker. Fixed fields only: task_id, '
        + 'from_agent, to_agent, type, body. The body is prose for a person or an agent to '
        + 'READ — it is never executed by anything, and a body that looks like a command is '
        + 'refused. This is not a way to run something on another machine.',
      input: obj({
        to_agent: { type: 'string', description: 'durable agent id of the recipient' },
        from_agent: { type: 'string', description: 'who is speaking' },
        type: {
          type: 'string',
          description: 'assignment | question | answer | status | blocker | handoff | review',
        },
        body: { type: 'string', description: 'plain prose, max 8000 chars' },
        task_id: { type: 'string', description: 'the task this concerns, if any' },
      }, ['to_agent', 'from_agent', 'type', 'body']),
      run: async (m) => jsonResult(await sendMessage(m)),
    });
  }

  if (typeof recordOwnerDecision === 'function') {
    defs.push({
      name: 'record_owner_decision',
      title: 'Record owner decision',
      description:
        'Append a scoped decision the OWNER has made, so no worker asks it again. '
        + 'Append-only: an existing decision is never edited, only superseded or revoked. '
        + 'owner_id and created_by must be the same person — a coordinator may RECORD what '
        + 'the owner decided, and may not decide on their behalf.',
      input: obj({
        decision_id: { type: 'string' },
        owner_id: { type: 'string', description: 'the builder whose decision this is' },
        statement: { type: 'string', description: "the owner's own words" },
        scope_type: { type: 'string', description: 'bridge | project | repo | lane | task' },
        scope_id: { type: 'string', description: 'required unless scope_type is bridge' },
        effect: { type: 'string', description: 'allow | deny | require_owner' },
        capabilities: { type: 'array', items: { type: 'string' }, description: 'e.g. ["deploy.*"]' },
        supersedes: { type: 'string', description: 'a decision id this replaces' },
      }, ['decision_id', 'owner_id', 'statement', 'scope_type', 'effect', 'capabilities']),
      run: async (d) => jsonResult(await recordOwnerDecision(d)),
    });
  }

  if (typeof listDecisions === 'function') {
    defs.push({
      name: 'get_owner_decisions',
      title: 'Get owner decisions',
      description:
        'Every standing decision, including superseded and revoked ones, so the history of '
        + 'what the owner said is visible and not just what is currently in force. Use '
        + 'resolve_owner_decision to ask whether a specific action is permitted.',
      input: obj({ includeInactive: { type: 'boolean', description: 'default true' } }),
      run: async ({ includeInactive = true } = {}) => {
        const rows = await listDecisions();
        const live = new Set(activeDecisions(rows).map((d) => d.decision_id));
        return jsonResult(rows
          .filter((d) => includeInactive || live.has(d.decision_id))
          .map((d) => ({
            ...d,
            state: d.revoked_at ? 'revoked' : (live.has(d.decision_id) ? 'active' : 'superseded'),
          })));
      },
    });
  }

  return defs;
}
