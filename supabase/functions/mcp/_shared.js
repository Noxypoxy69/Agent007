
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

  /*
   * WHO COULD ACTUALLY BE COLLIDING RIGHT NOW.
   *
   * A "collision" between two sessions that are both dead is not an incident,
   * it is two gravestones in the same plot. Two offline probe sessions sharing
   * lane "probe" raised a CRITICAL nobody could act on, and so did three agents
   * holding lane "agentbridge" of which exactly one was alive. A critical that
   * cannot be acted on is how a reader learns to skim the criticals -- which
   * costs you the one that mattered.
   *
   * So severity follows whether the parties could be acting AT THE SAME TIME.
   *
   * NOTHING IS DROPPED. A dormant collision keeps every agent it named and
   * gains each one's state, so the raw evidence is richer after the demotion
   * than before it. Filtering these out entirely would destroy the record of a
   * misconfiguration that is still sitting in the registry waiting to matter
   * again the moment somebody restarts one of them.
   *
   * DEMOTION REQUIRES POSITIVE EVIDENCE OF ABSENCE. A session that declared
   * itself offline, or whose heartbeat is provably past the window, is known to
   * be out. A session carrying no heartbeat information at all is NOT: absence
   * of evidence is not evidence of death, and guessing in that direction would
   * silently downgrade real, live contention.
   */
  const stateOf = (s) => {
    if (s?.capacity === 'offline') return 'offline';
    const seen = s?.lastSeenAt ? Date.parse(s.lastSeenAt) : null;
    if (seen === null || Number.isNaN(seen)) return 'unknown';
    return (now - seen) / 1000 > staleAfterSeconds ? 'stale' : 'operational';
  };
  const couldBeActing = (s) => ['operational', 'unknown'].includes(stateOf(s));
  // Two dead agents cannot contend for anything. Two live ones can.
  const contendingNow = (group) => group.filter(couldBeActing).length > 1;
  const withState = (group) => group.map((s) => ({ agent: s.agentId, state: stateOf(s) }));

  const byWorktree = new Map();
  for (const s of sessions) {
    const k = String(s.worktree).replace(/[\\/]+$/, '').toLowerCase();
    byWorktree.set(k, [...(byWorktree.get(k) ?? []), s]);
  }
  for (const [wt, group] of byWorktree) {
    if (group.length > 1) {
      if (contendingNow(group)) {
        add('critical', 'shared-worktree',
          `${group.length} agents registered to the same worktree`,
          { worktree: wt, agents: group.map((s) => s.agentId) });
      } else {
        add('info', 'shared-worktree-dormant',
          `${group.length} agents share a worktree, but fewer than two could be acting`,
          { worktree: wt, agents: withState(group) });
      }
    }
  }

  const byLane = new Map();
  for (const s of sessions) byLane.set(s.lane, [...(byLane.get(s.lane) ?? []), s]);
  for (const [lane, group] of byLane) {
    if (group.length > 1) {
      if (contendingNow(group)) {
        add('critical', 'duplicate-lane', `lane "${lane}" claimed by ${group.length} agents`,
          { lane, agents: group.map((s) => s.agentId) });
      } else {
        add('info', 'duplicate-lane-dormant',
          `lane "${lane}" is claimed by ${group.length} agents, but fewer than two could be acting`,
          { lane, agents: withState(group) });
      }
    }
  }

  const byResource = new Map();
  for (const s of sessions) {
    for (const l of s.locks ?? []) {
      byResource.set(l.resource, [...(byResource.get(l.resource) ?? []), { agentId: s.agentId, owner: s, ...l }]);
      if (l.heldBy && l.heldBy !== s.agentId) {
        add('critical', 'foreign-lock',
          `lock "${l.resource}" in ${s.agentId}'s worktree is held by ${l.heldBy}`,
          { worktree: s.worktree, resource: l.resource, heldBy: l.heldBy, registeredAgent: s.agentId });
      }
    }
  }
  for (const [resource, holders] of byResource) {
    if (holders.length > 1) {
      if (contendingNow(holders.map((h) => h.owner))) {
        add('critical', 'lock-contention', `resource "${resource}" locked in ${holders.length} worktrees`,
          { resource, holders: holders.map((h) => ({ agent: h.agentId, ageSeconds: h.ageSeconds })) });
      } else {
        add('info', 'lock-contention-dormant',
          `resource "${resource}" is locked in ${holders.length} worktrees, but fewer than two could be acting`,
          { resource,
            holders: holders.map((h) => ({
              agent: h.agentId, state: stateOf(h.owner), ageSeconds: h.ageSeconds,
            })) });
      }
    }
  }
  /*
   * foreign-lock IS DELIBERATELY NOT DEMOTED. It does not describe two parties
   * contending; it records that a lock in one agent's worktree is held under
   * another agent's name. That is evidence of something that already happened,
   * and it stays true and worth reading whether or not either party is running.
   */

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

/**
 * ═══ CLOSING THE LOOP: RETURN, THEN ACCEPT ═══════════════════════════════════
 *
 * assign_task shipped alone, so the hosted plane could hand work out and had no
 * way to take it back. A coordinator that can only assign is a dispatcher with
 * no idea whether anything was done.
 *
 * WHO MAY MOVE A TASK, AND WHY IT MATTERS THAT THEY ARE DIFFERENT PEOPLE.
 *
 *   assign   coordinator   "do this"
 *   return   THE WORKER    "I did this, here is the commit"
 *   accept   coordinator   "I looked, it counts"
 *
 * The middle one is the worker's OWN testimony about its OWN work, and it is
 * the reason this is not simply three coordinator tools. A coordinator that
 * could record a return would be writing the worker's evidence for it, and the
 * accept that followed would be the same party on both sides of a review. The
 * whole point of a returned state is that somebody else put it there.
 *
 * That was the temptation worth naming: the quickest way to give a coordinator
 * an accept button is to let it mark work returned first. It would have closed
 * the loop on screen and proved nothing at all.
 */

/** Only work a worker has RETURNED can be accepted. */
export const ACCEPTABLE_FROM = ['returned'];

/** Terminal states. Nothing moves out of these. */
export const TERMINAL = ['accepted', 'cancelled'];

/**
 * MAY THIS WORKER RETURN THIS TASK?
 *
 * The worker names itself; the caller supplies the registry row it resolved to.
 * A return is only accepted for the session the task was ASSIGNED to, so a
 * worker cannot return somebody else's work -- by accident or otherwise.
 */
export function canReturn(task, worker, { headSha } = {}) {
  const errors = [];

  if (!task || !nonEmpty(task.task_id)) return { ok: false, errors: ['no such task'] };
  if (!worker || !nonEmpty(worker.session_id)) {
    return { ok: false, errors: ['no resolved worker: a return must come from a registered session'] };
  }

  if (task.state !== 'assigned') {
    errors.push(`task is "${task.state}"; only assigned work can be returned`);
  }

  /*
   * THE SESSION MUST MATCH, NOT THE AGENT.
   *
   * Matching on agent_id alone would let any session claiming to be code-b
   * return code-b's work, and sessions are exactly what this registry exists to
   * tell apart. The agent is checked too, so a session id reused under a new
   * identity cannot inherit the assignment.
   */
  if (nonEmpty(task.assigned_session) && task.assigned_session !== worker.session_id) {
    errors.push(`task is assigned to session "${task.assigned_session}", not "${worker.session_id}"`);
  }
  if (nonEmpty(task.assigned_agent) && nonEmpty(worker.agent_id)
      && task.assigned_agent !== worker.agent_id) {
    errors.push(`task is assigned to agent "${task.assigned_agent}", not "${worker.agent_id}"`);
  }

  /*
   * A RETURN CARRIES A COMMIT OR IT IS NOT A RETURN.
   *
   * "Done" with no sha is a claim nobody can check, and it is the shape every
   * unverifiable status update in this project has taken. The reviewer needs
   * something to look at.
   */
  if (!nonEmpty(headSha)) {
    errors.push('a return requires the head sha of the work, resolved through git and never typed');
  } else if (!/^[0-9a-f]{40}$/i.test(headSha)) {
    errors.push('head sha must be a full 40-character sha');
  }

  return { ok: errors.length === 0, errors };
}

/** The record written when a return is permitted. */
export function returnRecord(task, worker, { headSha, notes = null, at }) {
  return {
    task_id: task.task_id,
    state: 'returned',
    returned_by: worker.session_id,
    returned_at: at,
    returned_head_sha: headSha,
    returned_notes: nonEmpty(notes) ? notes : null,
  };
}

/**
 * MAY THIS BE ACCEPTED?
 *
 * Acceptance is the coordinator's own act and needs no worker, but it refuses
 * on a task nobody returned -- accepting straight from `assigned` would be
 * signing off work that was never handed in.
 */
export function canAccept(task, { at } = {}) {
  const errors = [];

  if (!task || !nonEmpty(task.task_id)) return { ok: false, errors: ['no such task'] };

  if (TERMINAL.includes(task.state)) {
    errors.push(`task is already "${task.state}"`);
  } else if (!ACCEPTABLE_FROM.includes(task.state)) {
    errors.push(`task is "${task.state}"; only returned work can be accepted`
      + ' — accepting unreturned work signs off something nobody handed in');
  }

  // The sha the worker returned is what is being accepted. Without it there is
  // nothing to point at afterwards and "accepted" means only that somebody said so.
  if (task.state === 'returned' && !nonEmpty(task.returned_head_sha)) {
    errors.push('the return carries no head sha, so there is nothing to accept');
  }

  if (!nonEmpty(at)) errors.push('a timestamp is required');

  return { ok: errors.length === 0, errors };
}

export function acceptRecord(task, { by, at }) {
  return {
    task_id: task.task_id,
    state: 'accepted',
    accepted_by: by,
    accepted_at: at,
    // The accepted sha is pinned from the RETURN, never re-read at accept time:
    // the reviewer accepted a specific commit, and the branch may have moved on
    // between the review and the click.
    accepted_head_sha: task.returned_head_sha ?? null,
  };
}

/**
 * MAY THIS BE CANCELLED?
 *
 * Cancelling accepted work would erase a completed contract rather than
 * withdraw an outstanding one, so it is refused; supersede it instead.
 */
export function canCancel(task, { reason } = {}) {
  const errors = [];
  if (!task || !nonEmpty(task.task_id)) return { ok: false, errors: ['no such task'] };
  if (TERMINAL.includes(task.state)) {
    errors.push(`task is already "${task.state}" and cannot be cancelled`);
  }
  if (!nonEmpty(reason)) {
    errors.push('a reason is required: a task that vanishes without one is indistinguishable from a bug');
  }
  return { ok: errors.length === 0, errors };
}

export function cancelRecord(task, { by, at, reason }) {
  return {
    task_id: task.task_id,
    state: 'cancelled',
    cancelled_by: by,
    cancelled_at: at,
    cancelled_reason: reason,
  };
}

/**
 * THE SUPERVISED DISPATCHER: it PREPARES, it does not decide.
 *
 * The coordinator polls hourly at best, so every handoff waited on a human to
 * relay it. An always-running dispatcher fixes the latency and raises an
 * obvious question: may it assign work by itself?
 *
 * The owner's answer was no. It prepares an assignment; the coordinator
 * confirms on its pass. So this module produces PROPOSALS, and a proposal is a
 * suggestion with a timestamp -- never a stored permission.
 *
 * THAT DISTINCTION IS THE WHOLE DESIGN, and it is easy to lose.
 *
 * The tempting shortcut is to record the verdict at proposal time and let
 * confirmation trust it. Then the dispatcher's judgment, formed minutes or an
 * hour earlier against a world that has since moved, becomes the authority --
 * and "supervised" degrades into "autonomous, with a delay". The worker may
 * have gone offline, taken other work, or had its lane reassigned; the task may
 * have been cancelled or already returned.
 *
 * So canConfirm RE-RUNS the guard against live state and ignores the recorded
 * verdict entirely. The stored reasoning exists to be READ by whoever confirms,
 * not to be relied on by the code.
 *
 * ROUTING IS BY LANE, NOT BY A CHAIN. A fixed C -> B -> D -> A rotation was
 * proposed; it describes today's roster rather than a rule, and canAssign
 * already refuses on lane and repo mismatch, so most hops in such a chain would
 * produce refusals instead of handoffs. The registry records which lane a
 * session holds. That is the routing table.
 *
 * PURE. Rows and the clock arrive as arguments.
 */

/** How long a proposal is worth looking at before the world has moved. */
export const PROPOSAL_STALE_AFTER_MS = 60 * 60 * 1000;

export const PROPOSAL_KINDS = ['assign', 'review'];

/**
 * What the dispatcher would suggest, given the world as it is now.
 *
 * @returns {{proposals: object[], idle: object[], blocked: object[]}}
 */
export function proposeWork({ tasks = [], sessions = [], now, isLive }) {
  if (!nonEmpty(now)) throw new TypeError('proposeWork requires a `now` timestamp');
  if (typeof isLive !== 'function') {
    /*
     * Liveness is INJECTED, as it is everywhere else in this system. A
     * dispatcher that decided for itself whether a worker was alive would be
     * the second opinion on the question the registry exists to answer.
     */
    throw new TypeError('proposeWork requires an isLive predicate');
  }

  const live = arr(sessions).filter((s) => s && isLive(s) && s.capacity !== 'offline');
  const taken = new Set(
    arr(tasks).filter((t) => t?.state === 'assigned').map((t) => t.assigned_session),
  );

  const proposals = [];
  const idle = live
    .filter((s) => !taken.has(s.session_id))
    .map((s) => ({ agent_id: s.agent_id, session_id: s.session_id, lane_id: s.lane_id ?? null }));

  const blocked = [];

  for (const task of arr(tasks)) {
    if (!task || !nonEmpty(task.task_id)) continue;

    /*
     * RETURNED WORK IS A REVIEW, NOT A REASSIGNMENT.
     *
     * The dispatcher must never propose handing returned work to somebody
     * else: it has been done, and what it needs is a coordinator to look at
     * the commit. Proposing a reassignment here would quietly discard a
     * worker's finished contract.
     */
    if (task.state === 'returned') {
      const verdict = canAccept(task, { at: now });
      proposals.push({
        kind: 'review',
        task_id: task.task_id,
        // Who did it, and what to look at. The dispatcher forms no opinion on
        // whether the work is GOOD -- it cannot read a diff.
        returned_by: task.returned_by ?? null,
        head_sha: task.returned_head_sha ?? null,
        notes: task.returned_notes ?? null,
        would_be_accepted: verdict.ok,
        reasons: verdict.ok ? [] : verdict.errors,
        prepared_at: now,
      });
      continue;
    }

    if (task.state === 'blocked') {
      blocked.push({ task_id: task.task_id, reason: task.blocked_reason ?? null });
      continue;
    }

    if (task.state !== 'runnable') continue;

    // ── routing, by lane ────────────────────────────────────────────────────
    const lane = task.lane_id ?? null;
    const candidates = live.filter((s) => {
      if (taken.has(s.session_id)) return false;
      if (nonEmpty(lane) && nonEmpty(s.lane_id) && s.lane_id !== lane) return false;
      if (nonEmpty(task.repo_id) && nonEmpty(s.repo_id) && s.repo_id !== task.repo_id) return false;
      return true;
    });

    if (candidates.length === 0) {
      blocked.push({
        task_id: task.task_id,
        reason: nonEmpty(lane)
          ? `no idle live worker holds lane "${lane}"`
          : 'no idle live worker is available',
      });
      continue;
    }

    /*
     * AMBIGUITY IS REPORTED, NOT BROKEN BY A TIE-RULE.
     *
     * Picking "the first" would be a decision about who does the work, made by
     * the component explicitly told not to make those. Two eligible workers is
     * something a supervisor should see.
     */
    if (candidates.length > 1) {
      blocked.push({
        task_id: task.task_id,
        reason: `${candidates.length} idle workers are eligible; choose one`,
        candidates: candidates.map((s) => s.agent_id),
      });
      continue;
    }

    const worker = candidates[0];
    const verdict = canAssign(task, worker, {
      tasks,
      assignments: arr(tasks).filter((t) => t?.task_id !== task.task_id),
      isLive,
    });

    proposals.push({
      kind: 'assign',
      task_id: task.task_id,
      agent_id: worker.agent_id,
      session_id: worker.session_id,
      lane_id: lane,
      // RECORDED TO BE READ, NOT TRUSTED. canConfirm re-runs this against live
      // state; a stale ok here confirms nothing.
      would_be_accepted: verdict.ok,
      reasons: verdict.ok ? [] : verdict.errors,
      prepared_at: now,
    });
  }

  return { proposals, idle, blocked };
}

/**
 * MAY THIS PROPOSAL BE CONFIRMED, RIGHT NOW?
 *
 * Re-runs the guard against live rows. The proposal's own `would_be_accepted`
 * is deliberately ignored: it was formed against a world that has since moved,
 * and trusting it would turn a supervised dispatcher into an autonomous one
 * with an hour of lag.
 */
export function canConfirm(proposal, { task, worker, tasks = [], now, isLive, staleAfterMs = PROPOSAL_STALE_AFTER_MS } = {}) {
  const errors = [];

  if (!proposal || !PROPOSAL_KINDS.includes(proposal.kind)) {
    return { ok: false, errors: ['no such proposal'] };
  }
  if (!nonEmpty(now)) return { ok: false, errors: ['a timestamp is required'] };

  /*
   * A PROPOSAL GOES STALE.
   *
   * An hour-old suggestion confirmed without a fresh look is the dispatcher
   * deciding late rather than the supervisor deciding now. Past the window it
   * must be re-prepared, which costs nothing and forces the guard to run
   * against the present.
   */
  const prepared = Date.parse(proposal.prepared_at);
  const t = Date.parse(now);
  if (Number.isNaN(prepared) || Number.isNaN(t)) {
    errors.push('the proposal cannot be dated, so its age cannot be checked');
  } else if (t - prepared > staleAfterMs) {
    errors.push(`prepared ${Math.round((t - prepared) / 60000)} minutes ago and is stale; re-prepare it`);
  } else if (t < prepared) {
    errors.push('the proposal is dated in the future');
  }

  if (!task) {
    errors.push(`no such task: ${proposal.task_id}`);
    return { ok: false, errors };
  }

  if (proposal.kind === 'review') {
    const verdict = canAccept(task, { at: now });
    if (!verdict.ok) errors.push(...verdict.errors);
    return { ok: errors.length === 0, errors };
  }

  // kind === 'assign'
  if (!worker) {
    errors.push(`${proposal.agent_id} has no live session now; it may have gone offline since`);
    return { ok: false, errors };
  }
  if (worker.session_id !== proposal.session_id) {
    /*
     * The session is part of the proposal. A worker that restarted has a new
     * runtime, and confirming onto it would be assigning to something nobody
     * proposed -- the same session/agent confusion the registry exists to
     * prevent.
     */
    errors.push(`proposed for session "${proposal.session_id}" but ${proposal.agent_id} is now "${worker.session_id}"`);
  }

  const verdict = canAssign(task, worker, {
    tasks,
    assignments: arr(tasks).filter((t) => t?.task_id !== task.task_id),
    isLive,
  });
  if (!verdict.ok) errors.push(...verdict.errors);

  return { ok: errors.length === 0, errors };
}

/** How long a worker may be silent before its absence is a finding, not a gap. */
export const WORKER_STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * WHICH WORKERS STOPPED, AS DISTINCT FROM WHICH WERE NEVER THERE.
 *
 * Nothing here could previously tell those apart. Both surfaced only as an
 * absence: the dispatcher reported "no idle live worker holds lane X", which
 * reads as "that lane was never staffed" rather than "the worker on it died".
 *
 * That is precisely what happened on 2026-09-15. Three of four watchers were
 * killed by the host for memory, at unrelated times, and the production line
 * reported itself as merely idle -- a roster that looked healthy because most
 * of it was gone. A worker that STOPS is a failure. A lane nobody staffed is a
 * plan. They need different words.
 *
 * A DECLARED SHUTDOWN IS NOT AN ALERT. capacity 'offline' is a worker saying so
 * on its way out, which is the behaviour we want rather than a fault. Neither
 * is a session that never heartbeated at all: that never started, and reporting
 * it as lost would invent a worker in order to mourn it.
 */
export function wentStale({ sessions = [], now, staleAfterMs = WORKER_STALE_AFTER_MS } = {}) {
  if (!nonEmpty(now)) throw new TypeError('wentStale requires a `now` timestamp');
  const t = Date.parse(now);
  if (Number.isNaN(t)) throw new TypeError(`now is not a timestamp: ${now}`);

  const out = [];
  for (const s of arr(sessions)) {
    if (!s || !nonEmpty(s.session_id)) continue;
    if (s.capacity === 'offline') continue;

    const seen = s.heartbeat_at ? Date.parse(s.heartbeat_at) : NaN;
    if (Number.isNaN(seen)) continue;

    const silent = t - seen;
    if (silent <= staleAfterMs) continue;

    out.push({
      agent_id: s.agent_id ?? null,
      session_id: s.session_id,
      lane_id: s.lane_id ?? null,
      last_heartbeat_at: s.heartbeat_at,
      silent_for_seconds: Math.round(silent / 1000),
      /*
       * THE COMMIT IT WAS LAST PUBLISHING. A head_sha frozen at an old commit
       * is how you tell a worker that died mid-task from one that finished and
       * went quiet -- and it is the field that gave the memory kills away.
       */
      last_head_sha: s.head_sha ?? null,
      capacity_when_last_seen: s.capacity ?? null,
    });
  }

  // Most recently lost first: that is the one still worth chasing.
  out.sort((a, b) => a.silent_for_seconds - b.silent_for_seconds);
  return out;
}

/**
 * The hourly supervisory report: what a person or a coordinator needs to see.
 *
 * Counts first so a quiet hour reads as quiet, then the things that need a
 * decision. A report that buries two blocked tasks in a list of forty healthy
 * ones is a report nobody finishes reading.
 */
export function supervisoryReport({
  proposals = [], idle = [], blocked = [], tasks = [], sessions = [], now,
  staleAfterMs = WORKER_STALE_AFTER_MS,
}) {
  if (!nonEmpty(now)) throw new TypeError('supervisoryReport requires a `now` timestamp');

  const byState = {};
  for (const t of arr(tasks)) {
    if (!t?.state) continue;
    byState[t.state] = (byState[t.state] ?? 0) + 1;
  }

  const lost = wentStale({ sessions, now, staleAfterMs });

  return {
    at: now,
    counts: {
      proposals: arr(proposals).length,
      awaiting_review: arr(proposals).filter((p) => p.kind === 'review').length,
      idle_workers: arr(idle).length,
      blocked: arr(blocked).length,
      workers_went_stale: lost.length,
      tasks: byState,
    },
    /*
     * LOST WORKERS COME FIRST, BECAUSE THEY EXPLAIN THE REST.
     *
     * A blocked task under a dead worker is one fact, not two, and reading them
     * in the other order invites the wrong fix -- re-routing work around a lane
     * whose only problem is that nobody is standing on it.
     */
    worker_went_stale: lost,
    // Everything below needs somebody to act. Nothing here is a status update.
    awaiting_review: arr(proposals).filter((p) => p.kind === 'review'),
    ready_to_assign: arr(proposals).filter((p) => p.kind === 'assign' && p.would_be_accepted),
    would_refuse: arr(proposals).filter((p) => p.kind === 'assign' && !p.would_be_accepted),
    blocked: arr(blocked),
    idle_workers: arr(idle),
  };
}

/**
 * WHAT IS NEW FOR ONE WORKER, SINCE IT LAST LOOKED.
 *
 * THE SHAPE, AND WHY IT IS INVERTED.
 *
 * The obvious event-driven design is a webhook: the Bridge POSTs to a URL when
 * something changes. It is wrong here twice over.
 *
 *   It cannot work. The workers are local Claude Code sessions and ChatGPT is a
 *   hosted client; none of them has an inbound address. There is nothing to
 *   POST to.
 *
 *   It should not work. "There is no path from this server to a command on any
 *   machine" is the property this whole system is built around, and a data
 *   plane that makes outbound requests to a URL supplied with a registration
 *   token is an SSRF engine aimed at whatever that token holder names.
 *
 * So the client waits and the server answers. The latency is the same, the
 * outbound capability is zero, and no new credential exists.
 *
 * THE PAYLOAD IS A DOORBELL, NOT A DISPATCH. An event says "this changed, at
 * this time, with this id". It never carries the instruction itself: a worker
 * reads the task or the message through the authenticated path it already has,
 * so nothing in a wake-up is capable of being mistaken for a command.
 *
 * PURE. Rows and the clock arrive as arguments.
 */

/** Event kinds a worker can be woken for. */
export const EVENT_KINDS = ['assigned', 'cancelled', 'message'];

const parse = (v) => {
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

/**
 * Events for one session, strictly AFTER `since`.
 *
 * @param {object} args
 *   tasks     task rows
 *   messages  message rows
 *   agent_id  the durable identity messages are addressed to
 *   session_id the runtime messages' work is assigned to
 *   since     ISO timestamp, exclusive; omit for "everything current"
 */
export function eventsFor({ tasks = [], messages = [], agent_id, session_id, since = null }) {
  if (!nonEmpty(session_id)) {
    throw new TypeError('eventsFor requires a session_id: an event feed for nobody is a bug');
  }

  /*
   * AN UNPARSEABLE CURSOR IS NOT "FROM THE BEGINNING".
   *
   * Treating a bad `since` as null would replay the entire history as new
   * work, and a worker waking to a hundred stale assignments is worse than one
   * that never wakes at all -- it acts on them.
   */
  let after = null;
  if (since !== null && since !== undefined) {
    after = parse(since);
    if (after === null) throw new TypeError(`since is not a timestamp: ${since}`);
  }

  const newer = (v) => {
    const t = parse(v);
    if (t === null) return false;          // undateable rows are never "new"
    return after === null || t > after;
  };

  const out = [];

  for (const t of arr(tasks)) {
    if (!t || t.assigned_session !== session_id) continue;

    if (t.state === 'assigned' && newer(t.assigned_at)) {
      out.push({
        kind: 'assigned',
        at: t.assigned_at,
        task_id: t.task_id,
        // Enough to know WHICH task, never enough to act without reading it.
        lane_id: t.lane_id ?? null,
        repo_id: t.repo_id ?? null,
      });
    }

    if (t.state === 'cancelled' && newer(t.cancelled_at)) {
      out.push({ kind: 'cancelled', at: t.cancelled_at, task_id: t.task_id });
    }
  }

  for (const m of arr(messages)) {
    if (!m || !nonEmpty(agent_id) || m.to_agent !== agent_id) continue;
    if (!newer(m.created_at)) continue;
    out.push({
      kind: 'message',
      at: m.created_at,
      message_id: m.message_id,
      from: m.from_agent ?? null,
      type: m.type ?? null,
      task_id: m.task_id ?? null,
      /*
       * THE BODY IS DELIBERATELY ABSENT.
       *
       * A wake-up that delivers the coordinator's prose straight into a
       * worker's loop is a dispatch wearing a doorbell's clothes. The worker
       * fetches the body through the read path, where it is plainly something
       * it chose to go and read.
       */
    });
  }

  // Oldest first: a worker processes what happened in the order it happened.
  out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return out;
}

/**
 * The cursor to pass back next time.
 *
 * The newest event's timestamp, or the previous cursor when nothing happened --
 * NEVER "now". Using the clock would silently skip anything written between the
 * last row read and the moment the answer was composed, and a skipped
 * assignment is indistinguishable from one that was never made.
 */
export function nextCursor(events, previous = null) {
  const list = arr(events).filter((e) => nonEmpty(e?.at));
  if (!list.length) return previous;
  return list.reduce((max, e) => (String(e.at) > String(max) ? String(e.at) : max), String(list[0].at));
}

/**
 * PROTOCOL VERSIONS, NEWEST FIRST, AND WHY THIS IS NEGOTIATED RATHER THAN FIXED.
 *
 * This answered '2024-11-05' to every client regardless of what it asked for.
 * That is legal but it is the wrong answer, and it is a trap: 2024-11-05
 * predates Streamable HTTP, so a modern client that asks for 2025-06-18 and is
 * told 2024-11-05 can reasonably conclude this server speaks the LEGACY
 * HTTP+SSE transport -- and go looking for an SSE endpoint that deliberately
 * does not exist here, because GET /mcp answers 405 by design.
 *
 * The client then connects, authorizes, and lists no tools. Which is exactly
 * what ChatGPT did: a live read+write grant, a server returning all thirteen
 * tools to a plain POST, and "No app actions available yet" on screen.
 *
 * This server really does speak Streamable HTTP -- POST returns JSON, there is
 * no stream -- so it should say so. Echo the client's version when it is one we
 * speak; otherwise answer with the newest we speak and let the client decide.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export const negotiateProtocol = (asked) =>
  (SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSION);

/**
 * Build the PostgREST query for the coordination log.
 *
 * PURE, AND HERE RATHER THAN IN index.ts ON PURPOSE. index.ts is Deno-only and
 * cannot be imported by the suite, so anything left in it is untested by
 * construction -- which is how a line deciding every client's protocol version
 * went unguarded until a live client fell over it. This has real logic in it
 * (clamping, escaping, a timestamp that must parse), so it lives where a test
 * can reach it.
 *
 * EVERY VALUE IS ESCAPED. These arrive from a model's tool call; an unescaped
 * one could smuggle extra PostgREST operators into the request and widen the
 * read past what was asked for.
 */
export function messagesQuery({ to_agent, from_agent, task_id, type, since, limit } = {}) {
  const n = Math.min(Math.max(Number.parseInt(limit ?? 50, 10) || 50, 1), 200);
  const q = ['select=*', 'order=created_at.desc', `limit=${n}`];

  const eq = (col, v) => {
    if (typeof v === 'string' && v.trim()) q.push(`${col}=eq.${encodeURIComponent(v.trim())}`);
  };
  eq('to_agent', to_agent);
  eq('from_agent', from_agent);
  eq('task_id', task_id);
  eq('type', type);

  /*
   * `since` is EXCLUSIVE, so a caller passes back the newest created_at it has
   * already seen and receives only what is new -- polling without re-reading
   * and without inventing a cursor format.
   *
   * An unparseable timestamp THROWS rather than being dropped. Silently
   * ignoring it would return the whole recent log to a caller that asked for a
   * slice, and it would read as "nothing new" inverted: far too much, not too
   * little, with no indication the filter was discarded.
   */
  if (typeof since === 'string' && since.trim()) {
    const t = Date.parse(since);
    if (Number.isNaN(t)) throw new Error(`since is not a timestamp: ${since}`);
    q.push(`created_at=gt.${encodeURIComponent(new Date(t).toISOString())}`);
  }

  return `messages?${q.join('&')}`;
}

export const jsonResult = (data) => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

export const INSTRUCTIONS =
  'Live engineering state for multi-agent Git worktrees. Every field is observed from git ' +
  'plumbing and the process table on the developer machine, not reported by the agents ' +
  'themselves, so an agent cannot misreport its own state here. Fields that could not be ' +
  'determined are null — treat null as unknown, never as zero.\n\n' +
  'WHAT THIS SERVER CAN DO DEPENDS ON YOUR TOKEN, AND THE TOOL LIST IS THE ANSWER. A reader ' +
  'sees only read tools; a coordinator additionally sees assign_task, send_message and ' +
  'record_owner_decision. If a tool is not in tools/list you do not have it — that is not a ' +
  'temporary condition to retry or work around. This text said "this server is read-only" ' +
  'for as long as that was true of every caller, and saying it to a coordinator that can in ' +
  'fact assign work would be the server lying about its own authority.\n\n' +
  'WHAT IS ABSENT AT EVERY SCOPE, INCLUDING COORDINATOR: shell, SQL, file writes, deploy, ' +
  'merge, command execution. A message body is prose for a person or an agent to READ and is ' +
  'never executed by anything. There is no path from this server to a command on any ' +
  'machine.\n\n' +
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
  const {
    listSessions, getLanes, listDelegations, listDecisions, listMessages,
  } = store;

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
        'carries the evidence it was derived from. ' +
        'A finding whose code ends in -dormant is a real registry conflict in which fewer ' +
        'than two of the parties could be acting, so it is reported as info rather than ' +
        'critical: two offline sessions cannot contend. It is DEMOTED, NEVER HIDDEN, and ' +
        'carries the state of each party, so it still tells you what to clean up.',
      input: obj(),
      run: async () => {
        const [sessions, lanes] = await Promise.all([listSessions(), getLanes()]);
        /*
         * ONE QUESTION, ONE ANSWER: the staleness window is the SHARED one.
         *
         * detectCollisions defaults to 90 seconds, which predates both the
         * 120-second heartbeat interval and the 600-second liveness window the
         * rest of this system uses. Left at the default, a perfectly healthy
         * worker is reported stale for a quarter of every heartbeat cycle --
         * and it was: get_supervisory_report called code-c an idle live worker
         * while get_collision_summary called the same agent stale, in the same
         * second, on the same rows.
         *
         * Worse, that wrong arithmetic reached a real conclusion: lane
         * "agentbridge" was demoted to dormant because the guard believed all
         * three claimants were stale, when one of them was live. The verdict
         * happened to be right; the reasoning was not, which is the kind of
         * agreement that stops being lucky at the worst moment.
         */
        return jsonResult(detectCollisions(sessions, {
          lanes, staleAfterSeconds: STALE_AFTER_MS / 1000,
        }));
      },
    },
  ];

  if (typeof listMessages === 'function') {
    defs.push({
      name: 'list_messages',
      title: 'List messages',
      description:
        'READ THE COORDINATION LOG, INCLUDING REPLIES TO YOU. send_message puts a message '
        + 'here; this is how you find out what came back. Newest first. Filter by to_agent '
        + '(your own inbox), from_agent, task_id or type, and pass `since` with the newest '
        + 'created_at you have already seen to poll for only what is new. '
        + 'AN EMPTY RESULT MEANS NOBODY HAS REPLIED YET, NOT THAT THE MESSAGE FAILED — '
        + 'delivery is recorded when send_message returns; whether a worker has read it and '
        + 'answered is a separate question this tool is the only way to ask.',
      input: obj({
        to_agent: { type: 'string', description: 'messages addressed to this agent, e.g. your own id' },
        from_agent: { type: 'string', description: 'messages sent by this agent' },
        task_id: { type: 'string', description: 'messages about one task' },
        type: {
          type: 'string',
          description: 'assignment | question | answer | status | blocker | handoff | review',
        },
        since: { type: 'string', description: 'ISO timestamp; returns only messages AFTER it' },
        limit: { type: 'number', description: 'default 50, max 200' },
      }),
      run: async (a = {}) => jsonResult((await listMessages(a)).map((m) => ({
        message_id: m.message_id,
        at: m.created_at,
        from: m.from_agent,
        to: m.to_agent,
        type: m.type,
        task_id: m.task_id ?? null,
        body: m.body,
      }))),
    });
  }

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

  const {
    listTasks, assignTask, sendMessage, recordOwnerDecision, acceptTask, cancelTask,
    listProposals, confirmProposal, supervisoryReport: report,
  } = store;

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

  if (typeof acceptTask === 'function') {
    defs.push({
      name: 'accept_task',
      title: 'Accept task',
      description:
        'Sign off work a worker has RETURNED. Refuses anything not in the returned state: '
        + 'accepting straight from assigned would sign off work nobody handed in, and the '
        + 'point of a returned state is that somebody OTHER than you put it there. '
        + 'The commit accepted is the one the worker returned, pinned at return time — not '
        + 're-read now, because the branch may have moved since you reviewed it. '
        + 'Read the return first with list_tasks or list_messages.',
      input: obj({
        task_id: { type: 'string', description: 'a task in the returned state' },
        note: { type: 'string', description: 'optional: what you checked' },
      }, ['task_id']),
      run: async (a) => jsonResult(await acceptTask(a)),
    });
  }

  if (typeof cancelTask === 'function') {
    defs.push({
      name: 'cancel_task',
      title: 'Cancel task',
      description:
        'Withdraw an outstanding task. A REASON IS REQUIRED — a task that vanishes without '
        + 'one is indistinguishable from a bug. Accepted work cannot be cancelled: that '
        + 'would erase a completed contract rather than withdraw an open one, so supersede '
        + 'it with a new task instead.',
      input: obj({
        task_id: { type: 'string' },
        reason: { type: 'string', description: 'why this is being withdrawn' },
      }, ['task_id', 'reason']),
      run: async (a) => jsonResult(await cancelTask(a)),
    });
  }

  if (typeof listProposals === 'function') {
    defs.push({
      name: 'list_proposals',
      title: 'List proposals',
      description:
        'What the dispatcher has PREPARED for you to confirm. A proposal is a suggestion, '
        + 'never a permission: `would_be_accepted` and `reasons` record what the guard said '
        + 'WHEN IT WAS PREPARED, and confirm_proposal re-runs that guard against live state '
        + 'before doing anything. Read them; do not rely on them. '
        + 'kind=assign names a task and the worker whose lane it matches. kind=review means a '
        + 'worker RETURNED work and it needs looking at — head_sha is the commit to read. '
        + 'The dispatcher forms no opinion on whether work is good; it cannot read a diff.',
      input: obj({ state: { type: 'string', description: 'open (default) | confirmed | superseded' } }),
      run: async (a = {}) => jsonResult((await listProposals(a)).map((p) => ({
        proposal_id: p.proposal_id,
        kind: p.kind,
        task_id: p.task_id,
        agent_id: p.agent_id ?? null,
        session_id: p.session_id ?? null,
        lane_id: p.lane_id ?? null,
        returned_by: p.returned_by ?? null,
        head_sha: p.head_sha ?? null,
        notes: p.notes ?? null,
        prepared_at: p.prepared_at,
        would_be_accepted_when_prepared: p.would_be_accepted,
        reasons_when_prepared: p.reasons ?? [],
      }))),
    });
  }

  if (typeof confirmProposal === 'function') {
    defs.push({
      name: 'confirm_proposal',
      title: 'Confirm proposal',
      description:
        'Act on a prepared proposal. THE GUARD IS RE-RUN AGAINST LIVE STATE FIRST and the '
        + 'recorded verdict is ignored — the worker may have gone offline, taken other work, '
        + 'or restarted under a new session, and the task may have been cancelled or returned '
        + 'by somebody else since. A refusal shows the live reasons NEXT TO what the '
        + 'dispatcher thought, so the difference between then and now is visible. '
        + 'Proposals older than an hour are refused as stale and must be re-prepared. '
        + 'kind=assign performs the assignment; kind=review performs the acceptance.',
      input: obj({
        proposal_id: { type: 'string' },
        note: { type: 'string', description: 'for a review: what you checked' },
      }, ['proposal_id']),
      run: async (a) => jsonResult(await confirmProposal(a)),
    });
  }

  if (typeof report === 'function') {
    defs.push({
      name: 'get_supervisory_report',
      title: 'Get supervisory report',
      description:
        'The state of the production line in one call: counts first, then only what needs a '
        + 'decision. '
        + 'READ worker_went_stale FIRST — it lists workers that were heartbeating and STOPPED, '
        + 'which is different from a lane nobody staffed and usually explains everything under '
        + 'it. Each entry carries how long the worker has been silent and the commit it was '
        + 'last publishing; a head_sha frozen at an old commit means it died mid-task. A worker '
        + 'that declared itself offline is NOT listed — that is an orderly shutdown, not a '
        + 'fault. '
        + 'awaiting_review is work a worker has handed back. ready_to_assign would '
        + 'be accepted right now. would_refuse means the dispatcher found work and something '
        + 'is STOPPING it — that is the most interesting section, not the least. blocked names '
        + 'tasks with no eligible worker, or more than one. idle_workers are live and holding '
        + 'nothing.',
      input: obj(),
      run: async () => jsonResult(await report()),
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
