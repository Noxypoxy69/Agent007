
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

/**
 * WHO THE OWNER ACTUALLY IS. Spliced from src/ownerDecisions.mjs — see the long
 * comment there for the measurement. Short version: requiring
 * `created_by === owner_id` compares the record against itself, so a
 * coordinator writing `{owner_id: "c8", created_by: "c8"}` minted whatever it
 * typed. Two rows in the live ledger carry `owner_id: "main"` and one of them
 * was ACTIVE. Aliases are included because `canonicalActor` resolves `owner`
 * to `danny`.
 */
export const OWNER_IDS = Object.freeze(['danny', 'owner']);

export function isOwnerId(value, owners = OWNER_IDS) {
  if (!isNonEmptyString(value)) return false;
  const want = value.trim().toLowerCase();
  return owners.some((o) => isNonEmptyString(o) && o.trim().toLowerCase() === want);
}

export function validateDecision(d, { owners = OWNER_IDS } = {}) {
  const errors = [];
  if (!isPlainObject(d)) return { ok: false, errors: ['decision must be an object'] };

  if (!isNonEmptyString(d.decision_id)) errors.push('decision_id is required');
  if (!isNonEmptyString(d.owner_id)) errors.push('owner_id is required');
  else if (!isOwnerId(d.owner_id, owners)) {
    errors.push(`owner_id "${d.owner_id}" is not the owner: a decision can only be recorded in the owner's name, and naming somebody else does not make them one`);
  }
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

  /*
   * ON ITS OWN THIS CHECK STOPS NOTHING — both fields come off the same record
   * from the same caller, so it only ever established that the writer was
   * CONSISTENT. The `isOwnerId` call above is the half that anchors it to
   * somebody outside the record.
   */
  if (!isNonEmptyString(d.created_by)) errors.push('created_by is required');
  else if (!isOwnerId(d.created_by, owners)) {
    /*
     * ASKS THE SAME QUESTION OF THE AUTHOR rather than comparing the two fields
     * to each other. Strict equality meant the alias and case folding could not
     * be used, and on THIS surface created_by is not caller-supplied -- it is
     * the authenticated coordinator_tokens.label -- so any spelling difference
     * between the label and the payload's owner_id voided a real decision.
     */
    errors.push(`created_by "${d.created_by}" is not the owner: a worker cannot record a decision on the owner's behalf`);
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

/* ── liveness: spliced from src/livenessProbe.mjs ────────────────────────── */

/**
 * SPLICED SO THE /ack ROUTE CAN DECIDE WITHOUT REIMPLEMENTING.
 *
 * The full module — four states, the attempt budget, the probe schedule — lives
 * in src/livenessProbe.mjs with its own tests. Only what the route needs is
 * here: is this ack the answer to the probe we actually sent, and what does the
 * row look like afterwards.
 *
 * test/livenessAckSplice.test.mjs compares the two copies BEHAVIOURALLY, which
 * is the only comparison that catches a splice drifting.
 */
const PROBE_CLOCK_SKEW_MS = 2 * 60 * 1000;

/**
 * THE WHOLE ANTI-PROXY ARGUMENT IS IN THIS FUNCTION.
 *
 * An ack counts only when it names the OUTSTANDING probe id and is not dated
 * before that probe or meaningfully after now. If any ack counted, a supervisor
 * could close the loop by replaying an old id and a second worker could answer
 * for a dead one — and the probe would join the three signals that already
 * measure something adjacent to what the roster claims.
 *
 * Exact string match, deliberately: a probe id is opaque, and any normalising
 * is a widening nobody asked for.
 */
export function ackMatches(session, ack, now = Date.now()) {
  if (!isPlainObject(session) || !isPlainObject(ack)) return false;
  if (!nonEmpty(session.probe_id) || !nonEmpty(ack.probe_id)) return false;
  if (session.probe_id !== ack.probe_id) return false;

  const sentAt = Date.parse(session.probe_sent_at);
  const ackedAt = Date.parse(ack.at);
  if (Number.isNaN(sentAt) || Number.isNaN(ackedAt)) return false;
  // Before its own probe is a replay; far ahead of our clock is the measured
  // party minting time, which is worth more to a liar than the id is.
  if (ackedAt < sentAt) return false;
  return ackedAt <= now + PROBE_CLOCK_SKEW_MS;
}

/**
 * The row after a valid ack. Returns it UNCHANGED when the ack does not answer
 * the outstanding probe, so a caller that forgets to check cannot mark a dead
 * session live — the refusal is the default rather than a step to remember.
 */
export function applyAck(session, ack, now = Date.now()) {
  if (!ackMatches(session, ack, now)) return session;
  return {
    ...session,
    last_ack_at: ack.at,
    probe_id: null,
    probe_sent_at: null,
    probe_attempts: 0,   // the budget is CONSECUTIVE failures, so an answer clears it
  };
}

/* ── tasks: spliced from src/taskRecord.mjs ──────────────────────────────── */

/**
 * SPLICED SO A CREATE ROUTE CAN REFUSE BEFORE IT WRITES.
 *
 * There is no way to create a task on this bridge: assign_task assigns an
 * existing one, the CLI has no create command, and agentbridge.tasks is written
 * only by this function and by migrations. The record half lives in
 * src/taskRecord.mjs with its own tests; this is the copy the edge function can
 * reach, because a Supabase edge function cannot import from outside its own
 * directory.
 *
 * test/taskRecordSplice.test.mjs compares the two copies BEHAVIOURALLY, which is
 * the only comparison that catches a splice drifting — see the note in
 * CLAUDE.md about fixtures that cannot reach the branch that diverged.
 */
export const RUNNABLE_STATES = Object.freeze(['runnable', 'returned']);

/**
 * CLAIMABLE AND CREATABLE ARE NOT THE SAME SET. `returned` is claimable and not
 * creatable: the table's `returned_carries_evidence` CHECK requires returned_by
 * and returned_head_sha, which no create path writes, so such a record passed
 * every check and failed the INSERT with a 400 the caller sees as a 500.
 */
export const CREATABLE_STATES = Object.freeze(['runnable']);

/** Matches the table's own tasks_base_sha_check. Lowercase, full length, or null. */
export const BASE_SHA = /^[0-9a-f]{40}$/;

export const TASK_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
export const REPO_PATH = /^(?!\/)(?![A-Za-z]:)[^\\\0]+$/;

const hasDotDot = (p) => String(p).split('/').includes('..');

export function validateTask(t) {
  const errors = [];
  if (!isPlainObject(t)) return { ok: false, errors: ['task must be an object'] };

  if (!isNonEmptyString(t.task_id)) errors.push('task_id is required');
  else if (!TASK_ID.test(t.task_id.trim())) {
    errors.push(`task_id "${t.task_id}" must be a file-safe token: letters, digits, dot, dash, underscore, 64 max`);
  }

  if (!isNonEmptyString(t.title)) {
    errors.push('title is required — a task nobody can identify from the roster is one nobody picks up');
  }

  if (!isNonEmptyString(t.lane_id)) errors.push('lane_id is required — assign_task refuses a lane mismatch');
  if (!isNonEmptyString(t.repo_id)) errors.push('repo_id is required — assign_task refuses a repo mismatch');

  if (!CREATABLE_STATES.includes(t.state)) {
    errors.push(`state must be one of ${CREATABLE_STATES.join(', ')} at creation — `
      + `${RUNNABLE_STATES.join(' and ')} are both CLAIMABLE, but "returned" additionally requires `
      + 'returned_by and returned_head_sha, which nothing sets at creation, so the database refuses it');
  }

  if (t.base_sha !== null && t.base_sha !== undefined) {
    if (!isNonEmptyString(t.base_sha) || !BASE_SHA.test(t.base_sha)) {
      errors.push(`base_sha "${t.base_sha}" must be a full lowercase 40-character commit sha, `
        + 'or null — the table refuses anything else');
    }
  }

  if (!Array.isArray(t.allowed_paths) || t.allowed_paths.length === 0) {
    errors.push('allowed_paths must be a non-empty array — an empty list means "unrestricted" to a '
      + 'reader and "nothing" to a collision check, and the difference is a race nobody sees');
  } else {
    for (const p of t.allowed_paths) {
      if (!isNonEmptyString(p)) { errors.push('every allowed path must be a non-empty string'); break; }
      if (!REPO_PATH.test(p) || hasDotDot(p)) {
        errors.push(`allowed path "${p}" must be repo-relative with forward slashes and no ".." segment`);
      }
    }
  }

  for (const field of ['forbidden_paths', 'shared_paths', 'depends_on']) {
    if (t[field] !== undefined && !Array.isArray(t[field])) errors.push(`${field} must be an array when present`);
  }

  if (Array.isArray(t.depends_on) && isNonEmptyString(t.task_id)
      && t.depends_on.includes(t.task_id)) {
    errors.push(`task "${t.task_id}" depends on itself, so it can never become assignable`);
  }

  if (!isNonEmptyString(t.created_at)) errors.push('created_at is required');
  if (!isNonEmptyString(t.created_by)) {
    errors.push('created_by is required — an unattributed assignment is one nobody can ask about');
  }

  return { ok: errors.length === 0, errors };
}

export function createTask({
  task_id, title, lane_id, repo_id,
  state = 'runnable',
  allowed_paths = [],
  forbidden_paths = [],
  shared_paths = [],
  depends_on = [],
  base_sha = null,
  created_at,
  created_by,
  notes = null,
}) {
  const copy = (v) => (Array.isArray(v) ? [...v] : v);
  // Validated trimmed, so stored trimmed: otherwise "  abc  " and "abc" are two
  // rows a human reads as one id, and the duplicate check compares the raw value.
  const id = typeof task_id === 'string' ? task_id.trim() : task_id;
  return {
    task_id: id, title, lane_id, repo_id, state,
    allowed_paths: copy(allowed_paths),
    forbidden_paths: copy(forbidden_paths),
    shared_paths: copy(shared_paths),
    depends_on: copy(depends_on),
    base_sha,
    created_at,
    created_by,
    notes,
    assigned_agent: null,
    assigned_session: null,
    assigned_at: null,
    assigned_by: null,
    lease_token: null,
    lease_expires_at: null,
    attempt: 0,
  };
}

/*
 * FIVE TRIVIAL ALIASES DEFEATED THIS, and validateTask accepted all of them:
 * ./src/a, src//a, SRC/a, src/./a and a trailing space. Two tasks could claim
 * the same file with the gate silent. Fixed at the matcher rather than by
 * listing the five somebody happened to try. See src/taskRecord.mjs.
 */
// Segment-based, not a chain of substitutions whose order matters: dropping the
// interior "./" left `./src/a` as `/src/a`. A path IS its parts, and empty and
// "." segments carry no meaning. See src/taskRecord.mjs.
const canonPath = (p) => String(p ?? '')
  .trim()
  .replace(/\\/g, '/')
  .split('/')
  .filter((seg) => seg !== '' && seg !== '.')
  .join('/')
  .toLowerCase();

export function pathsCollide(a = [], b = []) {
  const covers = (x, y) => x === y || y.startsWith(`${x}/`);
  const hits = [];
  for (const p of (Array.isArray(a) ? a : []).map(canonPath)) {
    if (!p) continue;
    for (const q of (Array.isArray(b) ? b : []).map(canonPath)) {
      if (!q) continue;
      if (covers(p, q) || covers(q, p)) hits.push([p, q]);
    }
  }
  return hits;
}

export function activeDecisions(rows, { owners = OWNER_IDS } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('activeDecisions requires an array');

  const present = rows.filter((d) => isPlainObject(d) && !d.revoked_at);

  /*
   * SUPERSESSION IS COMPUTED FROM EVERY SURVIVING ROW, VALID OR NOT. Filtering
   * for validity first meant refusing a row also UN-SUPERSEDED whatever it had
   * replaced: a standing DENY under a non-owner name, superseding an older
   * bridge-wide ALLOW, went from `denied` to `allowed` the moment the identity
   * anchor started refusing it. A refusal handed back a permission. So an
   * invalid row neither grants nor revives. See src/ownerDecisions.mjs.
   */
  const superseded = new Set(
    present.map((d) => d.supersedes).filter(isNonEmptyString),
  );

  const valid = present.filter((d) => validateDecision(d, { owners }).ok);

  return valid.filter((d) => !superseded.has(d.decision_id));
}

/**
 * Decisions that WOULD apply, suppressed only by rows that are not valid
 * decisions. Spliced from src/ownerDecisions.mjs — see the comment there.
 */
function orphanedDecisions(rows, action, context, owners) {
  if (!Array.isArray(rows)) return [];
  const present = rows.filter((d) => isPlainObject(d) && !d.revoked_at);

  /*
   * ORPHANED = REPLACED BY SOMETHING THAT DOES NOT APPLY EITHER. Spliced from
   * src/ownerDecisions.mjs; see the comment there.
   *
   * Asking "is the superseder INVALID?" missed two shapes built entirely from
   * rows that validate: a row superseding ITSELF, and a cycle. Both removed a
   * standing owner DENY with nothing taking its place, and the permission layer
   * then routed anything reversible to a COORDINATOR. This is the deployed
   * copy — resolve_owner_decision and settleOpenRequestsAgainstPolicy run here.
   */
  /*
   * FOLLOW THE CHAIN TO ITS HEAD. Asking whether the IMMEDIATE successor is in
   * force broke every revision history three steps long: in A <- B <- C, B is
   * superseded by C and therefore not in force, so A looked abandoned and the
   * action escalated forever even though C plainly stands. The one-line repair
   * — treat every valid row as in force — reopens self-supersession and cycles.
   * So the question is reachability. See src/ownerDecisions.mjs.
   */
  const supersededIds = new Set(present.map((x) => x.supersedes).filter(isNonEmptyString));
  const inForce = (d) => validateDecision(d, { owners }).ok
    && isNonEmptyString(d.decision_id)
    && !supersededIds.has(d.decision_id);

  const supersededBy = new Map();
  for (const d of present) {
    if (!isNonEmptyString(d.supersedes)) continue;
    if (!supersededBy.has(d.supersedes)) supersededBy.set(d.supersedes, []);
    supersededBy.get(d.supersedes).push(d);
  }

  const replacedByLive = (id) => {
    const seen = new Set();
    const stack = [id];
    while (stack.length) {
      const current = stack.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      for (const r of supersededBy.get(current) ?? []) {
        if (inForce(r)) return true;
        if (isNonEmptyString(r.decision_id)) stack.push(r.decision_id);
      }
    }
    return false;
  };

  return present.filter((d) => {
    if (!isNonEmptyString(d.decision_id)) return false;
    if (!validateDecision(d, { owners }).ok) return false;
    const replacements = supersededBy.get(d.decision_id);
    if (!replacements || replacements.length === 0) return false;
    if (replacedByLive(d.decision_id)) return false;
    return scopeMatches(d, context)
      && Array.isArray(d.capabilities)
      && d.capabilities.some((c) => capabilityMatches(c, action));
  });
}

export function resolveOwnerDecision(rows, action, context = {}, { owners = OWNER_IDS } = {}) {
  if (!isNonEmptyString(action)) {
    return {
      outcome: 'owner_required', decision_id: null, matched_scope: null,
      reason: 'the requested action was not classified, so no decision can be matched',
      constraints: {}, statement: null, candidates: [],
    };
  }

  /*
   * AN INVALID SUPERSEDER ESCALATES, IT DOES NOT DELETE. This is the deployed
   * path: resolve_owner_decision and settleOpenRequestsAgainstPolicy both run
   * on it. A bare { supersedes: <id> } object deleted a standing owner DENY and
   * the permission layer then routed the resulting no_decision to a COORDINATOR
   * for anything reversible. See src/ownerDecisions.mjs.
   */
  const orphaned = orphanedDecisions(rows, action, context, owners);
  if (orphaned.length > 0) {
    return {
      outcome: 'owner_required',
      decision_id: null,
      matched_scope: null,
      reason: `${orphaned.map((d) => `"${d.decision_id}"`).join(', ')} applies to "${action}" but was `
        + 'superseded by a record that is not itself in force — the ledger cannot say what the owner '
        + 'decided, so this goes back to the owner rather than being treated as unregulated',
      constraints: {},
      statement: null,
      candidates: orphaned.map((d) => d.decision_id),
    };
  }

  const live = activeDecisions(rows, { owners });
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

export function revokeDecision(d, { at, by, reason = null }, { owners = OWNER_IDS } = {}) {
  if (!isPlainObject(d)) return { ok: false, errors: ['no such decision'] };
  if (d.revoked_at) return { ok: false, errors: [`decision ${d.decision_id} was already revoked at ${d.revoked_at}`] };
  if (!isNonEmptyString(at) || !isNonEmptyString(by)) {
    return { ok: false, errors: ['revocation requires a timestamp and an author'] };
  }
  /*
   * ANCHORED. THIS IS THE HALF OF 62b3158 THAT NEVER LANDED HERE.
   *
   * That commit's message said revokeDecision was "Anchored." It was anchored
   * in src/ownerDecisions.mjs and left untouched in this file — the deployed
   * copy — so for three commits the two surfaces disagreed in three directions
   * at once: `by: "main"` was refused in src and accepted here, the owner alias
   * was accepted in src and refused here, and a row with no owner_id was
   * refused in src and revocable by anyone here.
   *
   * Nothing caught it: ownerIdentityAnchored never imports revokeDecision from
   * either surface, and sharedSpliceMatches covers only detectCollisions,
   * wentStale and supervisoryReport. CLAUDE.md is explicit that every edit to a
   * spliced module goes to both copies, and I claimed I had done it.
   */
  if (!isOwnerId(by, owners)) {
    return { ok: false, errors: [`"${by}" is not the owner: a worker cannot revoke the owner's decision`] };
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
      capacity: observedCapacity(r, { now, staleAfterMs }),
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

/* ─── src/permissionRequest.mjs ────────────────────────────────────────────
 * SPLICED. The original is src/permissionRequest.mjs and the tests exercise
 * THAT one; permissionSpliceMatches.test.mjs compares the two behaviourally,
 * because a hand-copied module that drifts is the failure this project has
 * already had twice.
 *
 * nonEmpty and arr are declared above and deliberately not repeated here --
 * a second `const nonEmpty` is a SyntaxError that takes the whole function
 * down at cold start, which is how the last botched splice announced itself.
 */
const pms = (v) => {
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

export const RISK = Object.freeze({
  ROUTINE: 'routine',
  ELEVATED: 'elevated',
  IRREVERSIBLE: 'irreversible',
});

export const DECIDER = Object.freeze({
  POLICY: 'policy',
  COORDINATOR: 'coordinator',
  OWNER: 'owner',
});

export const OWNER_ONLY_PREFIXES = Object.freeze([
  'deploy.production',
  'delete.',
  'drop.',
  'truncate.',
  'spend.',
  'rotate.',
  'revoke.',
  'customer.message',
  'merge.main',
]);

export const ELEVATED_PREFIXES = Object.freeze([
  'deploy.',
  'migrate.',
  'schema.',
  'sql.write',
]);

/**
 * THE ONLY ACTIONS THAT ARE ROUTINE, AS AN EXPLICIT ALLOW-LIST.
 *
 * This did not exist, and its absence is what made the escalation below
 * possible: `reversible: true` was the ONLY route to ROUTINE, so the caller's
 * own word was the classifier. Membership here is decided by this file, not by
 * the thing asking for permission.
 */
export const ROUTINE_PREFIXES = Object.freeze([
  'read.',
  'list.',
  'get.',
  'search.',
  'inspect.',
  'run.tests',
  'git.status',
  'git.diff',
  'git.log',

  /*
   * A LOCAL COMMIT IS ROUTINE BY THIS FILE'S OWN DEFINITION: reversible by the
   * actor alone, and nobody outside the machine sees it. `merge.main` is the
   * owner-only one and is on the deny-list above; `push` is deliberately on
   * NEITHER list, so it falls through to ELEVATED -- publishing is the step
   * that stops being local, and it should cost an approval until somebody
   * decides otherwise on purpose.
   */
  'commit',
]);

/**
 * CASE-INSENSITIVE, AND THAT IS A SECURITY PROPERTY RATHER THAN A CONVENIENCE.
 *
 * It was case-SENSITIVE, using startsWith and strict equality with no
 * normalisation, so "Deploy.Production" missed both deny-lists while
 * "deploy.production" hit them. Capitalising one letter was enough to leave the
 * owner-only list. Both sides are lowered here rather than only the action, so
 * an entry added to a list in mixed case still matches.
 */
export const hasPrefix = (action, list) => {
  const a = String(action).toLowerCase();
  return list.some((raw) => {
    const p = String(raw).toLowerCase();
    return p.endsWith('.') ? a.startsWith(p) : a === p || a.startsWith(`${p}.`);
  });
};

/**
 * Every segment-boundary suffix of an action, longest first.
 *
 *   "commit.deploy.production" -> ["commit.deploy.production",
 *                                  "deploy.production",
 *                                  "production"]
 *
 * SEGMENT boundaries, not every character offset, deliberately. Matching at
 * arbitrary offsets would make "xdeploy.production" contain "deploy.production"
 * and turn any action with an unlucky substring into an owner escalation, which
 * is a different way of making the gate useless.
 */
export const segmentSuffixes = (action) => {
  const parts = String(action).toLowerCase().split('.');
  return parts.map((_, i) => parts.slice(i).join('.'));
};

/**
 * A DENY-LIST MATCH WINS WHEREVER IT APPEARS, SO ADDING A PREFIX CANNOT
 * SUBTRACT AUTHORITY.
 *
 * ══ ROUND 2: THE SAME CLASS AS ROUND 1, ONE LEVEL UP ══
 *
 * code-d probed again after the case-sensitivity fix and found five more, every
 * one reaching the coordinator instead of Danny:
 *
 *     commit.deploy.production   -> routine   COORDINATOR
 *     read.deploy.production     -> routine   COORDINATOR
 *     get.delete.everything      -> routine   COORDINATOR
 *     list.merge.main            -> routine   COORDINATOR
 *     inspect.drop.table_users   -> routine   COORDINATOR
 *
 * The action string is chosen by the CALLER and both lists anchored at position
 * zero, so prefixing the thing you want with something allow-listed defeated
 * the deny-list completely.
 *
 * ══ WHY THIS IS A MATCHER CHANGE AND NOT FIVE MORE TEST CASES ══
 *
 * code-d's sentence, which is the most useful thing written here today:
 * "Round 1 I probed with capitalisation, because capitalisation is what I
 * thought of. Round 2 I probed with prefixing, because your fix made me look
 * again. There will be a round 3 and neither of us will have thought of it."
 *
 * AN ADVERSARIAL PROBE IS EVIDENCE THAT A SPECIFIC ATTACK WORKS. IT IS NEVER
 * EVIDENCE THAT THE REMAINING ONES DO NOT. Adding the five strings code-d
 * happened to try would fix those five and leave the class open -- which is the
 * hollow-gate shape again, in yet another costume: a fix whose evidence and
 * whose claim are about different things.
 *
 * ══ THE ASYMMETRY IS THE DESIGN ══
 *
 *   DENY-lists  match ANYWHERE at a segment boundary  -- maximally broad.
 *   ALLOW-list  matches only from the START           -- maximally narrow.
 *
 * A prefix can therefore never remove a denial, and never add an allowance the
 * whole action did not already have. Both errors fail toward the owner.
 *
 * KNOWN, ACCEPTED RESIDUAL: this over-blocks. "read.deploy.notes" is now
 * ELEVATED because "deploy." appears at a boundary. That costs one coordinator
 * approval, and it is the correct direction to be wrong in. An action that
 * merely RESEMBLES a denied one -- "xdeploy.production" -- is not caught; it is
 * an unrecognised action and lands on ELEVATED by the default, which is the
 * documented behaviour for anything nobody classified.
 */
export const denies = (action, list) => segmentSuffixes(action).some((s) => hasPrefix(s, list));

/**
 * Classify by risk. UNKNOWN ACTIONS ARE NOT ROUTINE.
 *
 * An action this function does not recognise is classified ELEVATED, never
 * routine. The cost of that is one extra coordinator approval; the cost of the
 * other default is a capability nobody reviewed slipping through because it was
 * new.
 *
 * ══ THE ESCALATION THIS SHAPE EXISTS TO PREVENT, AND ONCE FAILED TO ══
 *
 * Found by code-d probing the real module, reproduced here before anything was
 * changed. Six spellings, every one an owner-only action reaching the
 * coordinator instead of Danny:
 *
 *     Deploy.Production  reversible:true  ->  routine      coordinator
 *     DEPLOY.PRODUCTION  reversible:true  ->  routine      coordinator
 *     deploy.Production  reversible:true  ->  elevated     coordinator
 *     Delete.everything  reversible:true  ->  routine      coordinator
 *     DROP.table_users   reversible:true  ->  routine      coordinator
 *     Merge.main         reversible:true  ->  routine      coordinator
 *
 * TWO CAUSES THAT COMPOSED, neither fatal alone:
 *
 *   1. hasPrefix matched case-sensitively, so a capital letter missed both
 *      deny-lists. (deploy.Production landing on ELEVATED rather than ROUTINE
 *      is its own small horror: a PARTIAL case match downgraded it.)
 *   2. `if (reversible === true) return RISK.ROUTINE` sat BEFORE the
 *      unknown-action default, so an unrecognised spelling did not fall through
 *      to the safe default -- it landed on the CALLER'S OWN DECLARATION.
 *
 * Cause 2 is the one that matters, and it contradicted the paragraph directly
 * above it in writing. The header said UNKNOWN ACTIONS ARE NOT ROUTINE while
 * the code returned ROUTINE for any unknown action whose caller said so. That
 * is the confused deputy this module exists to prevent: the component asking
 * for permission was deciding its own risk class.
 *
 * ══ THE RULE NOW, AND WHY IT IS ASYMMETRIC ══
 *
 * `reversible` is EVIDENCE FROM AN INTERESTED PARTY, so it is believed only
 * when it argues against that party's interest:
 *
 *     reversible: false  ->  RAISES to irreversible. Believed: nobody declares
 *                            their own action dangerous to gain something.
 *     reversible: true   ->  LOWERS NOTHING, EVER. Self-serving, so it cannot
 *                            move the classification down by itself.
 *
 * ROUTINE is now reachable only by membership of ROUTINE_PREFIXES, which this
 * file decides. The caller can still raise its own risk and can no longer lower
 * it at all -- which is what the test on this property always claimed to
 * assert, and did not, because it only ever tried exact lowercase spellings.
 */
export function riskOf(action, { reversible } = {}) {
  if (!nonEmpty(action)) return RISK.IRREVERSIBLE;
  const a = action.trim();

  // Deny-lists first. Case-insensitive, and matched at EVERY segment boundary
  // rather than only at position zero -- see `denies` for why that is
  // structural rather than a wider fixture.
  if (denies(a, OWNER_ONLY_PREFIXES)) return RISK.IRREVERSIBLE;
  // An explicit reversible:false raises. This is the one direction a caller's
  // own declaration is trusted in, because it argues against its own interest.
  if (reversible === false) return RISK.IRREVERSIBLE;
  if (denies(a, ELEVATED_PREFIXES)) return RISK.ELEVATED;

  /*
   * ROUTINE IS AN ALLOW-LIST, NOT A CALLER'S CLAIM.
   *
   * reversible:true no longer appears in this decision at all. It is recorded
   * on the request for a human to read, and it classifies nothing downward.
   */
  if (hasPrefix(a, ROUTINE_PREFIXES)) return RISK.ROUTINE;

  // Not recognised: somebody looks at it. This is now genuinely unreachable
  // from the caller's side, which is what the header always promised.
  return RISK.ELEVATED;
}

/**
 * A stable identity for "the same request", so repeats collapse.
 *
 * KEYED ON WHAT IS BEING DECIDED, NOT ON WHEN OR BY WHOM. A worker retrying
 * after a crash asks the identical question; if the attempt number or a
 * timestamp were in the key, the owner would be asked again for a decision they
 * have already made. The task is in the key because the same action on a
 * different task IS a different decision.
 */
export function requestKey({ action, task_id = null, scope_id = null } = {}) {
  if (!nonEmpty(action)) throw new TypeError('requestKey requires an action');
  return [action.trim(), task_id ?? '-', scope_id ?? '-'].join('::');
}

export function classifyRequest(request, decisions, { now } = {}) {
  if (pms(now) === null) throw new TypeError('classifyRequest requires a `now` timestamp');
  if (!request || !nonEmpty(request.action)) {
    return {
      decider: DECIDER.OWNER,
      risk: RISK.IRREVERSIBLE,
      reason: 'the request names no action, so nothing about it can be classified',
      key: null,
      decision_id: null,
    };
  }

  const action = request.action.trim();
  const risk = riskOf(action, { reversible: request.reversible });
  const key = requestKey(request);

  const resolved = resolveOwnerDecision(arr(decisions), action, {
    project: request.project,
    repo: request.repo,
    lane: request.lane,
    task: request.task ?? request.task_id,
  });

  if (resolved.outcome === 'allowed') {
    return {
      decider: DECIDER.POLICY, risk, key,
      decision_id: resolved.decision_id,
      allowed: true,
      reason: resolved.reason,
      constraints: resolved.constraints ?? {},
    };
  }
  if (resolved.outcome === 'denied') {
    return {
      decider: DECIDER.POLICY, risk, key,
      decision_id: resolved.decision_id,
      allowed: false,
      reason: resolved.reason,
      constraints: resolved.constraints ?? {},
    };
  }

  if (resolved.outcome === 'owner_required') {
    return {
      decider: DECIDER.OWNER, risk, key,
      decision_id: resolved.decision_id,
      reason: `the owner's standing decision requires them personally: ${resolved.reason}`,
    };
  }

  if (risk === RISK.IRREVERSIBLE) {
    return {
      decider: DECIDER.OWNER, risk, key, decision_id: null,
      reason: `"${action}" is irreversible, destructive or spends money; `
        + 'the coordinator may not approve it on the owner\'s behalf',
    };
  }

  return {
    decider: DECIDER.COORDINATOR, risk, key, decision_id: null,
    reason: `"${action}" is ${risk} and no standing decision covers it; `
      + 'routine approval is delegated to the coordinator',
  };
}

export function pendingRequests(requests, { now, windowMs = 24 * 60 * 60 * 1000 } = {}) {
  const at = pms(now);
  if (at === null) throw new TypeError('pendingRequests requires a `now` timestamp');

  const byKey = new Map();

  for (const r of arr(requests)) {
    if (!r || !nonEmpty(r.key)) continue;
    const t = pms(r.requested_at);
    if (t === null || at - t > windowMs) continue;

    const prev = byKey.get(r.key);
    if (!prev) {
      byKey.set(r.key, {
        key: r.key,
        action: r.action ?? null,
        task_id: r.task_id ?? null,
        decider: r.decider ?? null,
        risk: r.risk ?? null,
        occurrences: 1,
        first_at: r.requested_at,
        last_at: r.requested_at,
        decided: nonEmpty(r.decided_at),
        outcome: r.outcome ?? null,
      });
      continue;
    }
    prev.occurrences += 1;
    if (String(r.requested_at) < String(prev.first_at)) prev.first_at = r.requested_at;
    if (String(r.requested_at) > String(prev.last_at)) prev.last_at = r.requested_at;
    if (nonEmpty(r.decided_at)) {
      prev.decided = true;
      prev.outcome = r.outcome ?? prev.outcome;
    }
  }

  return [...byKey.values()]
    .filter((x) => !x.decided)
    .sort((a, b) => {
      if (a.decider !== b.decider) return a.decider === DECIDER.OWNER ? -1 : 1;
      return String(b.last_at).localeCompare(String(a.last_at));
    });
}

export function pausedTasks(requests, { now } = {}) {
  const at = pms(now);
  if (at === null) throw new TypeError('pausedTasks requires a `now` timestamp');

  const paused = new Set();
  for (const r of arr(requests)) {
    if (!r || nonEmpty(r.decided_at)) continue;
    if (!nonEmpty(r.task_id)) continue;
    paused.add(r.task_id);
  }
  return [...paused].sort();
}

/**
 * MAY THIS CALLER ANSWER THIS REQUEST?
 *
 * PURE, AND IN src/ FOR A SPECIFIC REASON. The first version of this guard
 * lived inside the edge function, where the test suite cannot import it -- the
 * same position as confirm_proposal, which was listed, documented, scope-gated
 * and threw on every call it ever received because nothing could invoke it.
 * A guard that cannot be tested is a guard nobody has watched fail.
 *
 * THE REFUSAL IS THE FEATURE. If a coordinator could answer an owner-routed
 * request, the routing would be advisory and "irreversible actions are the
 * owner's" would be a sentence in a comment rather than a property of the
 * system.
 *
 * THE ROUTING COMES FROM THE ROW, NOT FROM THE ACTION. Recomputing it here
 * would let a later edit to OWNER_ONLY_PREFIXES silently hand the coordinator a
 * question that was escalated to the owner when it was asked, with nothing
 * recording that the routing had moved.
 *
 * @param row  the stored request
 * @param by   { decider } the authority the caller is acting with
 */
export function canDecidePermission(row, { as = DECIDER.COORDINATOR, outcome, decided_by } = {}) {
  const errors = [];

  if (!row) return { ok: false, errors: ['no such permission request'] };

  if (outcome !== 'allowed' && outcome !== 'denied') {
    errors.push('outcome must be exactly "allowed" or "denied"');
  }
  if (!nonEmpty(decided_by)) {
    // An answer nobody signed is not reviewable afterwards, and the whole point
    // of moving off a keypress was that the record survives the moment.
    errors.push('decided_by is required: an unsigned decision cannot be reviewed');
  }
  if (nonEmpty(row.decided_at)) {
    errors.push(`already decided "${row.outcome}" by ${row.decided_by} at ${row.decided_at}`);
  }
  if (row.decider !== as) {
    errors.push(
      `"${row.action}" was routed to the ${row.decider} when it was asked, and a ${as} `
      + 'may not answer it on their behalf',
    );
    if (row.decider === DECIDER.OWNER) {
      errors.push(
        'the owner answers by recording a standing decision, which settles this request AND '
        + 'stops the same question being asked again',
      );
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}

/* ─── end src/permissionRequest.mjs ───────────────────────────────────────── */


export const MESSAGE_TYPES = ['assignment', 'question', 'answer', 'status', 'blocker', 'handoff', 'review'];

export const ASSIGNABLE_FROM = ['runnable', 'returned'];

/** Unambiguous wherever they appear: no sentence contains these by accident. */
const ALWAYS = [
  ['substitution', /\$\([^)]*\)/],
  ['backtick-substitution', /`[^`\n]+`/],
  ['script-tag', /<script\b/i],
  ['pipe-to-shell', /\|\s*(sh|bash|zsh|pwsh|powershell)\b/i],
  ['recursive-remove', /\brm\s+-[a-z]*[rf]/i],
  ['privilege-escalation', /(^|[\s;&|])sudo\s+\S/i],
];

/** Words that are only a command when they START a command. */
const COMMANDS =
  'rm|curl|wget|chmod|chown|kill|scp|ssh|nc|eval|exec|git|npm|npx|node|python|bash|sh|powershell|pwsh|cmd';

/**
 * Command-SHAPED, not merely command-adjacent: a flag, a path, a URL, a quoted
 * argument, or a redirect. "npm run verify" qualifies; "npm is the package
 * manager" does not.
 */
const ARGUMENT = String.raw`(-{1,2}[a-z]|[./~]|[a-z]+:\/\/|["']|\w+\s+-{1,2}[a-z]` +
  // a runner naming a package and then an action: "npx wrangler deploy"
  String.raw`|[\w@/-]+\s+(deploy|install|run|publish|start|build|test)\b` +
  String.raw`|(deploy|install|run|publish|start|build|test)\b)`;

/** At the start of a line, allowing indentation and a shell prompt. */
const AT_LINE_START = new RegExp(
  String.raw`^[ \t]*[$>#]?[ \t]*(${COMMANDS})\s+${ARGUMENT}`,
  'im',
);

/** Or chained after an operator, which is a command position wherever it sits. */
const AFTER_OPERATOR = new RegExp(String.raw`[;&|]{1,2}\s*(${COMMANDS})\s+${ARGUMENT}`, 'i');

/** A statement, not a sentence containing a verb that is also a keyword. */
const SQL_STATEMENT = new RegExp(
  String.raw`^[ \t]*(drop|delete|truncate|alter|insert|update)\s+(table|from|into)\b`,
  'im',
);

/**
 * What matched, and where. The refusal already knows this; withholding it is
 * what turned a one-second correction into a morning of bisection.
 */
export function executableMatch(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();

  for (const [rule, re] of ALWAYS) {
    const m = re.exec(t);
    if (m) return { rule, token: m[0].slice(0, 40) };
  }
  for (const [rule, re] of [
    ['command-at-line-start', AT_LINE_START],
    ['command-after-operator', AFTER_OPERATOR],
    ['sql-statement', SQL_STATEMENT],
  ]) {
    const m = re.exec(t);
    if (m) return { rule, token: m[0].trim().slice(0, 40) };
  }
  return null;
}

export function looksExecutable(text) {
  return executableMatch(text) !== null;
}

/**
 * THE CANONICAL ROSTER, AND WHY AN ALIAS TABLE IS NOT BUREAUCRACY.
 *
 * A REGISTRY RULE WITHOUT ALIASES WOULD HAVE SEVERED THE ONE WORKING CHANNEL.
 * The rule committed earlier today refuses a recipient that is not in the live
 * roster. The live roster is built from daemon heartbeats, so it holds code-b,
 * code-c, code-d and b6 and nothing else. Every message code-c has ever sent
 * upward went to "chatgpt-work", which no daemon registers and which that rule
 * would therefore have refused the moment its call site started passing live
 * sessions. The fix was written to stop messages vanishing and would instead
 * have stopped them being sent. Its positive control did not catch this because
 * it asserted the SHAPE rule against the real ids and the REGISTRY rule against
 * an invented roster that contained the coordinator -- a fixture that could not
 * construct the real case, so it could not fail for it.
 *
 * REGISTRATION IS NOT EXISTENCE. A coordinator and an owner are actors with no
 * daemon and no worktree; they are addressed constantly and heartbeat never.
 * Absence from the heartbeat roster means "not running", which for a worker is
 * information and for a coordinator is just how coordinators are.
 *
 * SO IDENTITY RESOLVES BEFORE IT IS CHECKED. Ten identity strings were in use
 * for six actors, and the coordinator seat alone answered to four. Renaming by
 * decree loses the mail addressed to the old name; the alias table keeps every
 * historical string routable while there is one canonical id per seat.
 *
 * WHAT IS RECORDED HERE AND WHAT IS NOT. The letters are the owner's decision
 * ledger, not an inference: d-owner-team-order-20260915 fixes the team as
 * C, B, D, A, and d-owner-identity-a-20260915 states that b6 is Agent A. Those
 * are recorded owner words. Identity is NEVER inferred from a branch, a
 * worktree or a session name -- b6 runs in a worktree called wt-release-verify
 * and that says nothing about who b6 is.
 */
export const ACTORS = [
  { actor_id: 'code-c', actor_type: 'worker', display_name: 'C', aliases: ['c'] },
  /*
   * b6 IS CODE-A, AND THIS TABLE SAID OTHERWISE FOR MOST OF A DAY.
   *
   * The ledger moved three times and I followed it one step behind each time:
   *   d-owner-identity-a-20260915    "b6 is Agent A."      superseded
   *   d-owner-identity-b6-20260916   "b6 is b"             superseded
   *   d-owner-identity-b6-20260916b  "b6 is code-a"        ACTIVE, 08:30:48Z
   *
   * I built the whole alias layer on the middle one AT 09:24Z -- fifty-four
   * minutes after it had already been superseded. Nothing was wrong with the
   * ledger; I stopped reading it and started working from what I remembered it
   * saying. Code C caught this by going back to the source when my instruction
   * and the record disagreed, which is the behaviour this file exists to support
   * and which I had stopped practising myself.
   *
   * SO THE DECISION IS READ, NOT REMEMBERED. Anyone changing this table checks
   * get_owner_decisions first and matches the ACTIVE row; a superseded statement
   * still reads perfectly true on its own, which is exactly why quoting the one
   * you happen to recall is not evidence.
   *
   * THE SEAT IS OCCUPIED, WHICH MATTERS MORE THAN THE NAME. A liveness check
   * answers "is anybody running under this id". Ownership asks "does this id
   * belong to somebody". They differ precisely when a worker is offline -- b6 is
   * offline right now -- and taking a free-looking seat is how two workers end up
   * with one name the moment the sleeper wakes.
   */
  { actor_id: 'code-a', actor_type: 'worker', display_name: 'A', aliases: ['a', 'b6'] },
  { actor_id: 'code-b', actor_type: 'worker', display_name: 'B', aliases: ['b'] },
  { actor_id: 'code-d', actor_type: 'worker', display_name: 'D', aliases: ['d'] },
  {
    actor_id: 'c8',
    actor_type: 'coordinator',
    display_name: 'Work lane / execution lead',
    aliases: ['claude-work', 'chatgpt-work', 'chatgpt-work-coordinator'],
  },
  {
    actor_id: 'chatgpt',
    actor_type: 'coordinator',
    display_name: 'Command center',
    aliases: ['chatgpt-command-center'],
  },
  { actor_id: 'danny', actor_type: 'owner', display_name: 'Danny', aliases: ['owner'] },
];

/**
 * An alias resolves to its canonical id; anything else is returned unchanged.
 *
 * Unchanged rather than null on purpose: this function answers "what is this
 * called canonically", and refusing an unknown name is a DIFFERENT question
 * that validateMessage asks against the roster. Folding the two would make an
 * unknown recipient indistinguishable from an unaliased one.
 */
export function canonicalActor(value, actors = ACTORS) {
  if (!nonEmpty(value)) return null;
  const want = value.trim().toLowerCase();
  for (const a of arr(actors)) {
    if (!a) continue;
    if (String(a.actor_id).toLowerCase() === want) return a.actor_id;
    if (arr(a.aliases).some((x) => String(x).toLowerCase() === want)) return a.actor_id;
  }
  return value.trim();
}

/**
 * Every id a message may be addressed to: the live roster PLUS the declared
 * actors that have no daemon. Canonical ids only -- the caller canonicalises
 * first, so an alias is never separately listed as a name you could have meant.
 */
export function knownActorIds(sessions, actors = ACTORS) {
  const ids = new Set();
  for (const s of arr(sessions)) if (s?.agent_id) ids.add(canonicalActor(s.agent_id, actors));
  /*
   * EVERY DECLARED ACTOR IS KNOWN, WORKER OR NOT. The roster decides whether a
   * recipient is LIVE, never whether it EXISTS.
   *
   * This line used to skip workers, so a worker was addressable only while it
   * was heartbeating. With nobody registered -- which is the state this project
   * was in the first time the check ever ran in production -- knownActorIds
   * returned only the non-workers, and a message to code-c was refused as "not
   * a known actor" while chatgpt, removed from the team, stayed addressable
   * forever because it is not typed as a worker.
   *
   * That contradicted the rule written directly above validateMessage's call
   * site: an unknown recipient is refused, a KNOWN one that is offline is a
   * note, because queueing work for a worker that is restarting is what a
   * durable channel is for. Existence comes from this table; liveness comes
   * from reachabilityNote, and conflating them broke the durability.
   *
   * A genuine typo is still refused: an id that is in neither the table nor the
   * roster resolves to nothing and is not invented into the list.
   */
  for (const a of arr(actors)) if (a?.actor_id) ids.add(a.actor_id);
  return [...ids].sort();
}

/**
 * EVERY STRING AN ACTOR MUST POLL TO SEE ALL OF ITS OWN MAIL.
 *
 * CANONICALISING ON THE WAY IN IS ONLY HALF OF IT, AND THE HALF I HAD DONE.
 * A message is stored under the literal recipient string it was sent with, and a
 * reader asks for its own id. So folding b6 into code-b fixes what a SENDER may
 * write and fixes nothing about what B can READ: mail addressed to code-b sits
 * in a string the live b6 session never queries, and mail addressed to b6 sits
 * in one the other registration never queries. That is how one actor with two
 * registrations ends up with nineteen unread in one pile and ten in the other.
 *
 * Until every reader expands its own aliases, a canonical id is the RIGHT name
 * and not always the REACHABLE one, and the two have to be said separately
 * rather than hoped to coincide.
 */
export function inboxNames(value, actors = ACTORS) {
  const id = canonicalActor(value, actors);
  if (!id) return [];
  const actor = arr(actors).find((a) => a?.actor_id === id);
  if (!actor) return [id];
  return [...new Set([actor.actor_id, ...arr(actor.aliases)])];
}

/**
 * The line every message opens with, naming who is speaking and what that is worth.
 *
 * WRITTEN BECAUSE THE TEAM READ MY MESSAGES AS DANNY'S. Four handoffs went out
 * this morning and came back reported as instructions from the owner. The
 * envelope carries from_agent correctly; whatever surfaces these to a worker
 * does not show it, so the body is the only place provenance survives, and a
 * body that does not say who is speaking gets attributed to whoever pasted it.
 *
 * THIS IS NOT A COURTESY, IT IS THE AUTHORITY BOUNDARY. An owner decision is
 * recorded, superseded rather than edited, and binding. A coordinator handoff is
 * prose with no authority at all, and the entire decision ledger is worthless if
 * the two are indistinguishable on arrival -- a worker that takes coordination
 * for a ruling has been given an owner it never checked. Advisory text must
 * never be able to become authority just by being read.
 */
export function messagePreamble(from, actors = ACTORS) {
  const id = canonicalActor(from, actors);
  const actor = arr(actors).find((a) => a?.actor_id === id);
  const kind = actor?.actor_type ?? 'unknown';
  const weight = kind === 'owner'
    ? 'This is the owner speaking. It is binding, and it is in the decision ledger.'
    : 'This is coordination and carries NO owner authority. Only the decision '
      + 'ledger does. If it reads like a ruling from Danny, it is not one.';
  return `[from ${id ?? 'unknown'} -- ${kind}] ${weight}`;
}

/**
 * A SESSION MAY NOT REGISTER UNDER ANOTHER ACTOR'S NAME.
 *
 * MEASURED, NOT IMAGINED. `social-sparks-app-c8` registered as agent `code-b`
 * at 07:49Z, two minutes before this lane first signed as c8. Everything
 * downstream then recorded B's work under a string that reads as mine --
 * `t-loop-proof` is stored with `returned_by: social-sparks-app-c8`, which is
 * the first end-to-end loop this system ever ran, attributed on its face to the
 * wrong actor.
 *
 * NOTHING WAS WRONG IN THE DATA. The registration correctly maps that session
 * to code-b, so a resolver gets the right answer. The damage is to every human
 * and every log line that reads the session id and believes it, which is most
 * of them -- an identifier that lies is worse than one that is missing, because
 * a missing one gets looked up.
 *
 * WHY THE LAST SEGMENT AND NOT THE WHOLE STRING. These ids are
 * `<where-it-was-launched>-<which-session>`, and the prefix is a machine or a
 * repository. `danny-win-10` legitimately begins with the OWNER's id; refusing
 * on any segment would reject the three sessions that have worked all week and
 * teach everyone to switch the check off. The suffix is the part that names the
 * session, and it is the part that collided.
 *
 * AN ALIAS OF YOUR OWN ACTOR IS FINE, and this is the case that shows the rule
 * is about identity rather than about strings: `social-sparks-app-b6`
 * registering as `code-a` is correct, because `b6` IS code-a by
 * d-owner-identity-b6-20260916b, ACTIVE since 08:30:48Z. The same table that
 * resolves a recipient answers this, so the two cannot drift apart.
 *
 * THIS COMMENT CITED THE SUPERSEDED DECISION UNTIL 2026-09-17, and said b6 was
 * code-b. The commit that introduced it is titled "I built the alias table on a
 * decision that had already been superseded" -- the TABLE was corrected and the
 * same stale citation was left standing beside it, justifying the old answer.
 * Nothing behaved wrongly, because the code and the tests both followed the
 * active row; the risk was purely that a later reader would trust the prose and
 * revert a correct table. Read the ledger, do not quote the decision you
 * remember: a superseded statement still reads perfectly true on its own.
 */
export function validateSessionId(sessionId, agentId, actors = ACTORS) {
  const shape = validateAgentId(sessionId, 'session_id');
  if (shape) return shape;

  const segments = String(sessionId).trim().toLowerCase().split(/[-_.]/).filter(Boolean);
  const suffix = segments[segments.length - 1];
  if (!suffix) return null;

  const claimed = canonicalActor(suffix, actors);
  const mine = nonEmpty(agentId) ? canonicalActor(agentId, actors) : null;

  /*
   * canonicalActor returns the input unchanged for a name it does not know, so
   * a suffix only "claims" an actor when it resolved to a DIFFERENT id than the
   * one it started as -- that is what distinguishes `c8` from `10` or `f1`.
   */
  const isAnActor = arr(actors).some(
    (a) => a?.actor_id === claimed
      && (String(a.actor_id).toLowerCase() === suffix
        || arr(a.aliases).some((x) => String(x).toLowerCase() === suffix)),
  );
  if (!isAnActor) return null;
  if (mine !== null && claimed === mine) return null;

  return `session_id ${JSON.stringify(sessionId)} ends in ${JSON.stringify(suffix)}, which is `
    + `${claimed}${mine ? `, not ${mine}` : ''}. A session named after another actor makes every `
    + 'log line and every returned-by field attribute this work to somebody who did not do it';
}

export const AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function validateAgentId(value, field) {
  if (!nonEmpty(value)) return `${field} is required`;
  if (!AGENT_ID.test(value.trim())) {
    return `${field} ${JSON.stringify(value)} is not an agent id: ids are slugs, `
      + 'so a space or punctuation usually means a description reached an identifier field';
  }
  return null;
}

/**
 * IS ANYBODY GOING TO READ THIS? Reported, never refused.
 *
 * WRITTEN AFTER SENDING FIVE REPORTS INTO A DEAD INBOX. Three went to code-b
 * and two to code-c on 2026-09-16; code-b's sessions had last been seen at
 * 17:19 and 17:07 and the first message went at 17:43, and code-c had been
 * silent since 12:30 when it was written to at 18:58 and 19:34. Nobody read any
 * of them. Nothing said so. docs/ORDER.md item 5 had predicted exactly this --
 * "with no chat open, a message to a name nobody reads is undetectable" -- and
 * counted twenty-nine before these.
 *
 * THE GAP WAS NEVER THE ROSTER CHECK. `to_agent` was validated as a KNOWN actor
 * and both recipients were known. Known and reachable are different questions
 * and only one of them was being asked.
 *
 * IT IS A NOTE AND NOT AN ERROR, and the comment above this function has said
 * so since the day it was written: queueing work for a worker that is
 * restarting is what a durable channel is for. Refusing would break the case
 * the channel exists for. So the message lands and the sender is told what it
 * landed in.
 *
 * THE WINDOW IS THE SHARED ONE. test/oneStalenessWindow.test.mjs exists because
 * two windows disagreed about the same rows in the same second and demoted a
 * live lane; a third private window here would be that bug again.
 */
function reachabilityNote(to, sessions, { now, staleAfterMs }) {
  const rows = arr(sessions).filter((s) => s?.agent_id && canonicalActor(s.agent_id) === to);

  /*
   * NO SESSION ROW IS NOT STALENESS. A coordinator or an owner is a known actor
   * that never heartbeats, and warning that they look offline on every message
   * is how a warning gets ignored -- which costs more than it saves, because the
   * one that matters is then indistinguishable from the noise.
   */
  if (rows.length === 0) return null;

  /*
   * WITHOUT A CLOCK, LIVENESS IS UNKNOWN AND UNKNOWN IS NOT LIVE. A caller that
   * passes sessions and forgets `now` would otherwise get silence, which reads
   * exactly like "the recipient is fine".
   */
  if (!nonEmpty(now)) {
    return `reachability of ${to} was not checked: sessions were supplied without a clock, `
      + 'so this message may be addressed to a worker that stopped';
  }

  if (rows.some((r) => isLive(r, { now, staleAfterMs }))) return null;

  const freshest = rows
    .map((r) => ({ id: r.session_id ?? '(no session id)', age: heartbeatAgeMs(r, now) }))
    .sort((a, b) => (a.age ?? Infinity) - (b.age ?? Infinity))[0];
  const silence = freshest?.age == null
    ? 'has never heartbeated'
    : `has been silent for ${Math.round(freshest.age / 1000)}s`;

  return `${to} is not live: its freshest session (${freshest.id}) ${silence}, past the `
    + `${Math.round(staleAfterMs / 1000)}s window. The message is stored and will be there if it `
    + 'comes back, but nothing is reading it now -- do not treat this as delivered';
}

export function validateMessage(
  m = {},
  { sessions = null, now = null, staleAfterMs = STALE_AFTER_MS } = {},
) {
  const errors = [];
  const notes = [];

  const fromBad = validateAgentId(m.from_agent, 'from_agent');
  if (fromBad) errors.push(fromBad);
  const toBad = validateAgentId(m.to_agent, 'to_agent');
  if (toBad) errors.push(toBad);

  /*
   * An unknown recipient is refused; a known one that is offline is fine and is
   * reported as a note rather than an error, because queueing work for a worker
   * that is restarting is what a durable channel is for.
   */
  if (!toBad && Array.isArray(sessions)) {
    const to = canonicalActor(m.to_agent);
    const roster = knownActorIds(sessions);
    if (!roster.includes(to)) {
      errors.push(
        `to_agent ${JSON.stringify(m.to_agent)} is not a known actor, so nothing would `
          + `ever read it. Known actors: ${roster.join(', ') || '(none)'}`,
      );
    } else {
      const note = reachabilityNote(to, sessions, { now, staleAfterMs });
      if (note) notes.push(note);
    }
  }
  if (!MESSAGE_TYPES.includes(m.type)) {
    errors.push(`type must be one of ${MESSAGE_TYPES.join(', ')}`);
  }
  if (!nonEmpty(m.body)) errors.push('body is required');
  else if (m.body.length > 8000) errors.push('body exceeds 8000 characters');
  else {
    const hit = executableMatch(m.body);
    if (hit) {
      errors.push(
        `body looks like a command rather than a message: a coordination channel that `
          + `carries executable text is a remote shell nobody audited. Matched ${hit.rule} `
          + `on ${JSON.stringify(hit.token)} -- this is a LEXICAL match on the text, not a `
          + `judgement about intent, so rephrasing that fragment is enough`,
      );
    }
  }
  if (m.task_id != null && !nonEmpty(m.task_id)) errors.push('task_id must be a string when present');

  return { ok: errors.length === 0, errors, notes };
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

/**
 * MICROSECONDS, because milliseconds silently lose mail. Spliced from
 * src/events.mjs — see the comment there.
 *
 * Postgres timestamptz is microsecond precision and Date.parse truncates to
 * milliseconds, so two events inside one millisecond collapsed to the same
 * value. The cursor is an event's own `at` and only moves forward, so the
 * second was never delivered again: a permanent mail drop in the mail path.
 * This is the deployed copy — /wait runs on it.
 */
const parse = (v) => {
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) return null;
  const frac = /\.(\d+)/.exec(String(v ?? ''));
  // Date.parse already consumed the first three fractional digits.
  const sub = frac ? Number(frac[1].slice(3, 6).padEnd(3, '0')) : 0;
  return ms * 1000 + (Number.isFinite(sub) ? sub : 0);
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
 *   actors    roster override for tests; omit to use the declared one.
 */
export function eventsFor({
  tasks = [], messages = [], agent_id, session_id, since = null, actors = undefined,
  // This session's own registration row, when the caller has it. Optional and
  // null-defaulting: every existing caller passes nothing and keeps working.
  session = null,
}) {
  if (!nonEmpty(session_id)) {
    throw new TypeError('eventsFor requires a session_id: an event feed for nobody is a bug');
  }

  /*
   * SPLICED FROM src/events.mjs. The only textual difference from the original
   * is that `fold` is declared INSIDE this function rather than beside
   * nonEmpty: this file is a hand-maintained concatenation and a new top-level
   * const is a duplicate-declaration outage waiting to happen -- artifactLoads
   * exists because one shipped. Behaviour is identical, which is what
   * sharedSpliceMatches compares.
   */

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

  /*
   * AN OUTSTANDING PROBE IS AN EVENT. Spliced from src/events.mjs — see there
   * for why this is the only liveness signal that cannot be produced from below
   * the agent, and why it is filtered by "still outstanding" rather than by the
   * cursor: a probe is an open question, not a thing that happened, and gating
   * it behind `since` would let a worker miss it once and then be called silent
   * for never having been asked.
   */
  const probeId = session?.probe_id ?? session?.probeId ?? null;
  if (nonEmpty(probeId)) {
    out.push({
      kind: 'probe',
      at: session?.probe_sent_at ?? session?.probeSentAt ?? null,
      probe_id: probeId,
      answer_with: 'ack_probe',
      attempt: Number.isFinite(Number(session?.probe_attempts))
        ? Number(session.probe_attempts) : null,
    });
  }

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
        /*
         * NO LEASE TOKEN HERE, AND THAT IS A REVERSAL OF 0f47999.
         *
         * The token WAS delivered on this event. It worked, and /task is
         * better -- c8 made the argument and it changed a decision already
         * committed:
         *
         *   THE WORKER MUST CALL /task ANYWAY. This event is deliberately not
         *   sufficient to act on, so the second call is not a cost the event
         *   avoided; it is a call that always happens. The token here was
         *   redundant rather than convenient.
         *
         *   A CREDENTIAL DOES NOT BELONG IN A REPLAYABLE FEED. Events are
         *   at-least-once and cursor-driven, so the same one can arrive twice
         *   or arrive late, carrying a credential that may no longer be
         *   current. /task returns the token only to the session that still
         *   holds the task, at the moment it asks.
         *
         *   AND IT ERODED THE DOORBELL. An event carrying a credential is an
         *   event that is ALMOST enough to act on, and "almost enough" is
         *   precisely what this design refuses. The test below is named
         *   "identifies the task without describing the work"; a credential is
         *   not a description, but it was the first thing ever added here that
         *   made acting-without-reading feel reasonable.
         */
      });
    }

    if (t.state === 'cancelled' && newer(t.cancelled_at)) {
      out.push({ kind: 'cancelled', at: t.cancelled_at, task_id: t.task_id });
    }
  }

  /*
   * A SEAT HAS MORE THAN ONE NAME, AND A MESSAGE IS STORED UNDER THE ONE THE
   * SENDER TYPED. This was a strict inequality against agent_id, so a message
   * addressed to a REGISTERED ALIAS never became an event -- the send path
   * stores the recipient verbatim, so the alias is what lands in the table.
   *
   * Measured 2026-09-18: fixer addressed code-b as "b", a real alias of that
   * seat, and the long poll would have held the request open while the message
   * sat stored. inboxNames is the read half, already in this file, previously
   * with no caller anywhere.
   *
   * AN UNKNOWN NAME STILL POLLS ITSELF: canonicalActor returns an unrecognised
   * name unchanged rather than null, so a seat absent from the roster keeps
   * receiving its own mail. That is the regression this could have shipped.
   */
  const fold = (v) => String(v ?? '').trim().toLowerCase();
  const inbox = new Set(inboxNames(agent_id, actors).map(fold));

  for (const m of arr(messages)) {
    if (!m || !nonEmpty(agent_id) || !inbox.has(fold(m.to_agent))) continue;
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

  /*
   * AN INBOX IS EVERY NAME THE SEAT ANSWERS TO, NOT THE ONE THE READER TYPED.
   *
   * `to_agent=eq.<id>` matched the LITERAL stored string, and the send path
   * stores the recipient verbatim. So asking for your own canonical id returned
   * nothing while mail addressed to your alias sat unread -- measured
   * 2026-09-18, seconds apart on the live bridge:
   *
   *   to_agent "code-b"  ->  []
   *   to_agent "b"       ->  the message
   *
   * That is worse than not polling. It is a CONFIDENT NEGATIVE, indistinguishable
   * from an empty inbox, so a reader doing exactly the right thing concludes it
   * has no mail. docs/ORDER.md predicted the symptom -- one actor with two
   * registrations ending up with nineteen unread in one pile and ten in the
   * other -- and named inboxNames as the read half nothing used.
   *
   * ONE NAME STILL USES eq, AND THAT IS NOT A CONCESSION TO A TEST. in.(x) and
   * eq.x are the same query; keeping eq for the single-name case leaves the
   * common query readable and leaves the escaping contract exactly where it was
   * already pinned. It also means an UNKNOWN recipient is untouched: canonicalActor
   * returns an unrecognised name unchanged, so inboxNames gives one element and
   * this takes the eq branch -- including for a hostile value, which therefore
   * still escapes through the same path it always did.
   *
   * VALUES ARE QUOTED AND ESCAPED INDIVIDUALLY, then joined with literal commas.
   * Encoding the whole list would turn the separators into %2C and PostgREST
   * would read one value containing commas, silently matching nothing.
   */
  /*
   * CASE IS FOLDED ON THE STORED VALUE, NOT ONLY ON THE READER'S INPUT.
   *
   * The first version of this used eq for one name and in.(...) for several.
   * Both compare EXACTLY, and Postgres string comparison is case-sensitive, so a
   * message stored as "B" was delivered by the long poll -- eventsFor folds case
   * -- and was invisible here. Half a contract landing green: the push path and
   * the pull path disagreed about the same seat, which is the divergence this
   * whole change exists to remove.
   *
   * Found by a blind audit, and predicted in writing beforehand by fixer: derive
   * the fold from what the send path already resolves with, and make a test fail
   * if the two paths ever disagree. test/inboxFoldParity.test.mjs is that test.
   *
   * ilike RATHER THAN eq, AND THE WILDCARDS MUST BE ESCAPED. ilike treats % and
   * _ as patterns, and AGENT_ID permits _ in a seat name, so an unescaped name
   * like code_b would match code-b, codeXb and more -- delivering one agent's
   * mail to another. That is the FAR worse direction: an empty inbox is visibly
   * wrong, a misrouted blocker reads as ordinary traffic. Escaped here, and
   * asserted in both directions.
   */
  /*
   * ilike IS ONLY USED FOR NAMES THAT CANNOT CARRY A PATTERN AT ALL.
   *
   * The first version escaped backslash, percent and underscore and called the
   * result literal. It was not. PostgREST documents `*` as an ALIAS for `%` in
   * like/ilike, and encodeURIComponent does not encode `*`, so `to_agent=*`
   * became the pattern `%` and matched every row -- and `C*` matched code-a,
   * code-b and chatgpt-work. Found by audit.
   *
   * The deeper mistake was the shape of the fix, not the missing character.
   * Enumerating the wildcards I happened to know is rule 8: a matcher written
   * against the strings a prober tried, which the next alias in the next
   * PostgREST version walks straight past.
   *
   * SO THIS ROUTES ON THE SHAPE OF THE NAME INSTEAD. A real seat matches
   * AGENT_ID -- letters, digits, dot, dash, underscore -- and can therefore
   * contain no pattern metacharacter except `_`, which is escaped. Anything
   * else is not a name this roster can hold, so it is matched EXACTLY with eq,
   * where no pattern language exists and nothing needs escaping. A caller
   * supplying `*` now gets rows addressed to the literal string `*`, which is
   * none.
   *
   * The cost is that a non-seat name loses case folding. That is the right
   * trade: case folding exists so a seat reaches its own mail, and a string
   * that cannot be a seat has no mail to reach.
   */
  const CAN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  const ilikePattern = (v) => encodeURIComponent(String(v).replace(/_/g, '\\_'));
  const clause = (v) => (CAN_PATTERN.test(String(v))
    ? `to_agent.ilike.${ilikePattern(v)}`
    : `to_agent.eq.${encodeURIComponent(String(v))}`);

  const inbox = inboxNames(to_agent);

  /*
   * A RECIPIENT THAT CANNOT BE PARSED IS A REFUSAL, NOT "NO FILTER".
   *
   * inboxNames returns [] for anything that is not a non-empty string, and the
   * branches below only push a clause when it returned names. So a blank or
   * non-string to_agent silently produced a query with NO recipient filter at
   * all, and list_messages answered with the newest 50 messages on the bridge.
   *
   * Measured live 2026-09-18: list_messages with to_agent of three spaces
   * returned other agents' mail. A caller polling its own inbox with a
   * malformed id got a populated, plausible, WRONG answer -- the same confident
   * shape as the alias bug, arriving from the opposite direction. There it
   * returned nothing and meant "no mail"; here it returns everything and means
   * "your mail".
   *
   * ABSENT IS STILL ABSENT. Omitting to_agent is a legitimate read -- the whole
   * coordination log is what a reader without an inbox wants -- so undefined and
   * null pass through unfiltered exactly as before. What is refused is a value
   * that was SUPPLIED and cannot be used.
   *
   * This mirrors `since` twenty lines below, which throws on a timestamp it
   * cannot parse for the same stated reason: silently dropping the filter
   * "would return the whole recent log to a caller that asked for a slice".
   * That argument was already written down here; it simply was not applied to
   * the recipient.
   */
  if (to_agent !== undefined && to_agent !== null && inbox.length === 0) {
    throw new Error(`to_agent is not a usable recipient: ${JSON.stringify(to_agent)}`);
  }

  if (inbox.length === 1) {
    q.push(clause(inbox[0]).replace(/^to_agent\./, 'to_agent='));
  } else if (inbox.length > 1) {
    /*
     * QUOTED INSIDE THE GROUP. PostgREST needs a value containing a reserved
     * character -- comma, dot, parenthesis -- double-quoted within an or group,
     * and AGENT_ID permits a dot. The in.(...) branch this replaced did quote;
     * dropping it here would have been a silent regression the moment somebody
     * registered a seat named code.b.
     */
    q.push(`or=(${inbox.map((v) => {
      const c = clause(v);
      const i = c.indexOf('.', 'to_agent'.length + 1);
      return `${c.slice(0, i)}."${c.slice(i + 1)}"`;
    }).join(',')})`);
  }

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

/**
 * CHECK-THEN-ACT ACROSS A NETWORK ROUND TRIP IS NOT A GUARD.
 *
 * Found by code-d verifying Autonomous Runtime v1. The coordinator's lifecycle
 * writes read rows over HTTP, evaluate a guard in JavaScript, and then PATCH
 * with `task_id=eq.<id>` AND NOTHING ELSE. The guard judges a snapshot fetched
 * in an earlier request and nothing revalidates at write time, so two
 * coordinators acting on one task both read "runnable", both pass, and both
 * write. Last writer wins, silently.
 *
 * This is STRUCTURAL, NOT PROBABILISTIC. The write carries no predicate, so it
 * cannot refuse a stale decision under ANY interleaving. It does not need a
 * demonstration to be real, and the window is a full network round trip --
 * wider than the transaction the lease layer was built to protect.
 *
 * WHY THIS AND NOT THE LEASE LAYER. claim_task already does this properly, with
 * a row lock and a fencing token. It also has no caller anywhere in the tree:
 * the safe implementation exists and is unreachable, while the reachable one is
 * unguarded. Moving the live surface onto leases is a much larger change; the
 * predicate is the small fix that closes the race on the path that runs today,
 * and it is worth doing whatever happens to the lease layer.
 */

/** What state a row must still be in for each write to be legitimate. */
export const TASK_WRITE_EXPECTS = Object.freeze({
  // canAssign admits both, so the predicate must admit both or it would refuse
  // legitimate re-assignment of returned work.
  assign: ['runnable', 'returned'],
  accept: ['returned'],
  // canCancel refuses only the terminal states; everything else may be withdrawn.
  cancel: ['runnable', 'assigned', 'returned', 'blocked'],
  // A return is only ever from assigned, and canReturn already says so.
  return: ['assigned'],
});

/**
 * Build a PATCH filter that pins the row to the state the guard judged.
 *
 * The state values come from the frozen table above and are never caller
 * supplied, but they are escaped anyway: the day one of these becomes a
 * parameter is the day the escaping matters, and that day will not announce
 * itself.
 */
export function taskWriteFilter(task_id, expected) {
  if (!nonEmpty(task_id)) throw new TypeError('taskWriteFilter requires a task_id');
  const states = arr(expected).filter(nonEmpty);
  if (!states.length) {
    // A write with no expectation is the bug this function exists to prevent.
    // Defaulting to "any state" would reintroduce it quietly.
    throw new TypeError('taskWriteFilter requires at least one expected state');
  }
  const inList = states.map((x) => encodeURIComponent(x)).join(',');
  return `tasks?task_id=eq.${encodeURIComponent(task_id)}&state=in.(${inList})`;
}

/**
 * DID THE WRITE ACTUALLY LAND?
 *
 * THE HALF THAT IS EASY TO MISS, and it matters more than the predicate itself.
 * Once a predicate is present, a LOST RACE is answered by PostgREST with 200
 * and an EMPTY ARRAY. Call sites that destructure the first element get
 * undefined and go on to report `ok: true` with an absent task -- so a lost
 * race reports SUCCESS and returns nothing.
 *
 * Without this half, adding the predicate makes the failure QUIETER RATHER THAN
 * SAFER: before, the second writer clobbered the first and at least the row
 * changed; after, it silently does nothing and says it worked.
 */
export function writeLanded(rows, { task_id, expected } = {}) {
  const list = arr(rows);
  if (list.length && list[0]) return { ok: true, row: list[0] };

  const states = arr(expected).filter(nonEmpty);
  return {
    ok: false,
    errors: [
      `the write did not land: "${task_id}" was no longer ${states.join(' or ')} `
      + 'when it reached the database. Somebody else moved it between the check and '
      + 'the write; re-read it and decide again.',
    ],
  };
}

export const jsonResult = (data) => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

/*
 * THE AUTHORITY PARAGRAPH IS DERIVED FROM THE TOOL LIST, NOT WRITTEN BESIDE IT.
 * Spliced from mcp/toolDefs.mjs, where the reasoning lives in full.
 *
 * The short version: this copy was corrected once already, and the node twin --
 * which serves the same tool names over stdio and the Worker -- kept telling the
 * old lie for two days, because nothing compared the two CONTRACTS. Copying this
 * text across would have been wrong as well: the hosted surface decides scope by
 * TOKEN and the twin decides by STORE SHAPE, so one fixed sentence is false
 * somewhere whichever one is chosen.
 *
 * The predicate is the presence of assign_task IN THE BUILT LIST, because that
 * list is literally what the client receives. Text and capability become two
 * readings of one fact.
 */
/*
 * SPLICED. This surface is the one the old sentence was FALSE on: index.ts
 * projects agentId, lane, machineLabel, worktree, capacity, sessionId, repoId
 * and git.head straight out of session_registrations, which its own comment
 * describes as "populated entirely from the POST /register body". Promising a
 * reader that an agent "cannot misreport its own state here" while serving
 * self-reported identity discourages exactly the scepticism that would catch
 * the lie. See mcp/toolDefs.mjs.
 */
const PREAMBLE =
  'Live engineering state for multi-agent Git worktrees. WHERE A FIELD CAME FROM DECIDES HOW ' +
  'MUCH IT IS WORTH, AND THIS SERVER WILL NOT PRETEND OTHERWISE. Dirty files, locks and ' +
  'running processes, when present, are OBSERVED from git plumbing and the process table, so ' +
  'an agent cannot misreport them. EVERYTHING ELSE IS SELF-REPORTED at registration and is ' +
  'only as honest as the agent that registered — agent id, session id, lane, repo, worktree, ' +
  'machine, declared capacity, AND THE COMMIT SHA, which the worker derived from git on its ' +
  'own machine and then told us. A HEAD here is a claim about a measurement, not a ' +
  'measurement. Fields that could not be determined are null — treat null as unknown, never ' +
  'as zero.\n\n';

const AUTHORITY_READER =
  'THIS CONNECTION IS READ-ONLY, AND THAT IS A PROPERTY OF YOUR TOOL LIST RATHER THAN A ' +
  'PROMISE ABOUT THE SERVER. Nothing you can call assigns work, sends a message, or records a ' +
  'decision: those tools are ABSENT from tools/list, not present and refusing. A caller with ' +
  'more authority sees a longer list than yours. If you expected a tool and it is not listed, ' +
  'you do not have it — that is not a temporary condition to retry or work around.\n\n';

const AUTHORITY_WRITER =
  'WHAT THIS SERVER CAN DO DEPENDS ON YOUR SCOPE, AND THE TOOL LIST IS THE ANSWER. This ' +
  'connection carries write tools: assign_task, send_message and record_owner_decision are in ' +
  'your list and they act. A read-only caller sees none of them. If a tool is not in ' +
  'tools/list you do not have it — that is not a temporary condition to retry or work around. ' +
  'This text said "this server is read-only" for as long as that was true of every caller, ' +
  'and saying it to someone who can in fact assign work would be the server lying about its ' +
  'own authority.\n\n';

const ABSENT_AT_EVERY_SCOPE =
  'WHAT IS ABSENT AT EVERY SCOPE, INCLUDING A WRITER: shell, SQL, file writes, deploy, ' +
  'merge, command execution. A message body is prose for a person or an agent to READ and is ' +
  'never executed by anything. There is no path from this server to a command on any ' +
  'machine.\n\n';

const GUIDANCE =
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

/**
 * The contract for THIS connection, given the tools it will actually be handed.
 *
 * @param {Array<{name:string}>} defs  the built tool list, as returned by toolDefs()
 */
export function instructionsFor(defs = []) {
  const writes = Array.isArray(defs) && defs.some((d) => d?.name === 'assign_task');
  return PREAMBLE + (writes ? AUTHORITY_WRITER : AUTHORITY_READER) + ABSENT_AT_EVERY_SCOPE + GUIDANCE;
}

/**
 * The read-only contract, kept as a named export because callers and tests
 * import it. DERIVED rather than written out, so it cannot drift from the reader
 * branch -- the same failure this change is about, one layer smaller.
 */
export const INSTRUCTIONS = instructionsFor([]);

const OUTSTANDING = ['assigned', 'rejected'];
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required });

/* ─── src/ownWork.mjs (spliced) ─── */

/**
 * The fields a worker needs to do the work and return it.
 *
 * `lease_token` IS here and that is deliberate: it is the worker's own
 * credential for its own task, it is already delivered on the assigned event,
 * and a worker that lost the event must be able to recover it rather than
 * holding work it cannot hand back. Withholding it here would only mean a
 * restarted worker abandons work it still legitimately owns.
 */
export const WORKER_TASK_FIELDS = Object.freeze([
  'task_id', 'state', 'title', 'notes',
  'lane_id', 'repo_id', 'allowed_paths', 'base_sha', 'depends_on',
  'attempt', 'assigned_at', 'assigned_session',
  'lease_token', 'lease_expires_at', 'leased_at',
]);

/**
 * THE GUARD. A worker sees its own assigned work and nothing else.
 *
 * NOT "tasks in its lane", NOT "tasks for its agent id". The session is the
 * unit, because the session is what the lease is minted for — an agent that
 * died and came back under a new session must not read the old session's work,
 * which is the same argument that makes a fencing token a fencing token.
 *
 * RETURNS A NEW OBJECT, never the row. A row passed through by reference is one
 * refactor away from carrying a column nobody reviewed.
 */
export function ownTask(tasks, { task_id, session_id } = {}) {
  if (!nonEmpty(task_id) || !nonEmpty(session_id)) return null;

  const row = arr(tasks).find((t) => t?.task_id === task_id);
  if (!row) return null;

  /*
   * NOT FOUND AND NOT YOURS ARE THE SAME ANSWER, deliberately. Distinguishing
   * them would let a worker enumerate which task ids exist by watching whether
   * it gets a 404 or a 403 — a small leak, but a free one to close, and the
   * caller has nothing to do differently in either case.
   */
  if (row.assigned_session !== session_id) return null;

  const out = {};
  for (const f of WORKER_TASK_FIELDS) out[f] = row[f] ?? null;
  return out;
}

/**
 * Every task this session currently holds.
 *
 * A worker restarting after a crash has no event to replay — the cursor is
 * gone with the process — so it needs to ask what it already holds, or it will
 * sit idle while its lease runs down on work nobody else can take.
 */
export function ownTasks(tasks, { session_id } = {}) {
  if (!nonEmpty(session_id)) return [];
  return arr(tasks)
    .filter((t) => t?.assigned_session === session_id)
    .map((t) => {
      const out = {};
      for (const f of WORKER_TASK_FIELDS) out[f] = t[f] ?? null;
      return out;
    });
}

/* ─── end src/ownWork.mjs ─── */

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
        /*
         * UNKNOWN SURVIVES THE READER. These three used to coerce with `?? []`,
         * so a store that reported "I did not look" was rendered as a confident
         * zero -- no dirty files, no locks, nothing running -- one layer after
         * the projection had been careful to say null. Fixing the store alone
         * would have been the partial fix: honest underneath, lying at the
         * surface the caller actually reads.
         */
        dirtyFiles: Array.isArray(s.git?.dirty) ? s.git.dirty.length : null,
        locksHeld: Array.isArray(s.locks) ? s.locks.map((l) => l.resource) : null,
        running: Array.isArray(s.processes) ? s.processes.map((p) => p.kind) : null,
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
        'an exact match; `"commandline"` is a substring match and can miss processes. ' +
        'processProbeOk is TRUE only when a probe actually ran: false means it ran and failed, ' +
        'null means this surface never looked. Unless it is true, an empty list does NOT mean ' +
        'nothing is running.',
      input: obj(),
      run: async () => jsonResult((await listSessions()).map((s) => ({
        /*
         * `!== false` READ null AS true, which is the worst of the three
         * possible answers: the tool's own description says a FALSE probe flag
         * makes an empty list inconclusive, so an unknown rendered as true made
         * that disclaimer unreachable and turned silence into "the probe ran and
         * found nothing". null now passes through as null, and the description
         * is honest for the first time.
         */
        agentId: s.agentId,
        processProbeOk: typeof s.processProbeOk === 'boolean' ? s.processProbeOk : null,
        processes: Array.isArray(s.processes) ? s.processes : null,
      }))),
    },
    {
      name: 'list_locks',
      title: 'List locks',
      description: 'Lock files per worktree, with holder and age. A FLAT LIST CANNOT SAY '
        + '"unknown": a session whose locks were never measured contributes nothing here and is '
        + 'indistinguishable from one holding no locks. Check locksHeld in list_agents — null '
        + 'there means unmeasured — before reading an absence as "not held".',
      input: obj(),
      run: async () => jsonResult((await listSessions()).flatMap((s) =>
        /*
         * THE DEPLOYED SURFACE, where this is unconditional: index.ts hardcodes
         * `locks: null` for every session, so list_locks answered `[]` on every
         * call while list_agents answered `null` about the same session. A
         * session whose locks were never measured contributes nothing rather
         * than contributing "no locks". See mcp/toolDefs.mjs.
         */
        (Array.isArray(s.locks) ? s.locks : []).map((l) => ({ agentId: s.agentId, worktree: s.worktree, ...l })))),
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


  /*
   * ASKING IS NOT A WRITE PRIVILEGE, WHICH IS WHY THESE SIT ON THE READ STORE.
   *
   * chatgpt-work, 21:58:17Z: "interactive Claude permission prompts are a
   * blocking defect, not an owner workflow." A worker stopped at a local
   * keypress is a worker stopped until a person walks to that machine. The
   * replacement has to be reachable by the thing that is blocked -- and the
   * thing that is blocked is a WORKER, which holds no coordinator token.
   *
   * So filing a question is available at reader scope. That reads oddly until
   * you notice what a filed row can do, which is nothing: it carries no grant,
   * its decider is computed here from the action and never taken from the
   * caller, and the unique index on (key) where undecided means a crash loop
   * inserts one row rather than sixty. A reader may ask. Only a coordinator may
   * answer, and only questions that are the coordinator's to answer.
   */
  const { submitPermissionRequest, listPermissionRequests, decidePermissionRequest } = store;

  if (typeof submitPermissionRequest === 'function') {
    defs.push({
      name: 'request_permission',
      title: 'Request permission',
      description:
        'ASK FOR PERMISSION WITHOUT STOPPING AT A KEYBOARD. Call this instead of blocking on '
        + 'a local prompt: the question is filed durably, routed to whoever may answer it, and '
        + 'survives the process that asked. '
        + 'THE ANSWER MAY COME BACK IMMEDIATELY: if the owner has already decided this, the '
        + 'reply is decider="policy" with allowed true or false and nothing is filed — the '
        + 'same question is never put to a person twice. '
        + 'Otherwise the reply is decider="coordinator" (routine, delegated) or "owner" '
        + '(irreversible, destructive or spending — the coordinator may NOT answer these). '
        + 'A repeat of a question already outstanding returns the SAME request, not a second '
        + 'one. Poll it with list_permission_requests; do not re-ask in a loop. '
        + 'THIS TOOL GRANTS NOTHING. It records a question and says who decides it.',
      input: obj({
        action: {
          type: 'string',
          description: 'the classified action, e.g. "deploy.production", "sql.write", "commit"',
        },
        requested_by: { type: 'string', description: 'durable agent id of the asker' },
        task_id: { type: 'string', description: 'the task this blocks; omit and NOTHING is paused' },
        scope_id: { type: 'string', description: 'repo, lane or other scope, if the action has one' },
        reversible: {
          type: 'boolean',
          description:
            'true only if the ASKER can undo it alone. This may raise the risk class and can '
            + 'never lower an owner-only action — self-declaring reversible is not a way out.',
        },
        arguments_summary: {
          type: 'string',
          description: 'what it touches, in one line. A decider approving from a phone sees this.',
        },
        environment: { type: 'string', description: 'e.g. "production", "staging", "local"' },
        project: { type: 'string' },
        repo: { type: 'string' },
        lane: { type: 'string' },
      }, ['action', 'requested_by']),
      run: async (a) => jsonResult(await submitPermissionRequest(a)),
    });
  }

  if (typeof listPermissionRequests === 'function') {
    defs.push({
      name: 'list_permission_requests',
      title: 'List permission requests',
      description:
        'Questions waiting on a decision, owner\'s first — a person is at the end of that list. '
        + 'Repeats of one question collapse into a single entry carrying `occurrences`, so a '
        + 'crash-looping worker reads as one decision to make and not sixty interruptions. '
        + 'ANSWERED REQUESTS ARE NOT LISTED as pending: a list of things waiting on you that '
        + 'contains things that are not is a list people stop reading. `paused_tasks` names the '
        + 'tasks actually held — only tasks with an outstanding request, never the whole worker.',
      input: obj({
        decider: { type: 'string', description: 'filter: owner | coordinator' },
        includeDecided: { type: 'boolean', description: 'default false; true returns the raw history' },
      }),
      run: async (a = {}) => jsonResult(await listPermissionRequests(a)),
    });
  }

  if (typeof decidePermissionRequest === 'function') {
    defs.push({
      name: 'decide_permission_request',
      title: 'Decide permission request',
      description:
        'Answer a question the COORDINATOR may answer. '
        + 'REFUSES anything routed to the owner, and the refusal is the point: irreversible, '
        + 'destructive and spending actions are the owner\'s, and a coordinator that could '
        + 'answer them on his behalf would make every gate below it decoration. '
        + 'The routing is re-read from the stored row rather than recomputed from the action, '
        + 'so a later edit to the risk table cannot quietly hand you a question that was '
        + 'escalated when it was asked. '
        + 'THE OWNER ANSWERS BY RECORDING A DECISION (record_owner_decision), not here — that '
        + 'way the answer is durable and the same question is never asked again, rather than '
        + 'being settled once in a row nobody will read.',
      input: obj({
        request_id: { type: 'string', description: 'from list_permission_requests' },
        outcome: { type: 'string', description: 'allowed | denied' },
        decided_by: { type: 'string', description: 'who is answering' },
        note: { type: 'string', description: 'why — read by the agent that asked' },
      }, ['request_id', 'outcome', 'decided_by']),
      run: async (a) => jsonResult(await decidePermissionRequest(a)),
    });
  }

  const {
    listTasks, assignTask, createTask: createTaskFn, sendMessage, recordOwnerDecision,
    acceptTask, cancelTask,
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

  if (typeof createTaskFn === 'function') {
    defs.push({
      name: 'create_task',
      title: 'Create task',
      description:
        'Put a new task in the queue. THIS IS NOT ASSIGNMENT — creating work and handing it out '
        + 'are separate acts, and a task is born unassigned. REFUSES, rather than writing a row '
        + 'that can never be used, when: the id is not file-safe or already exists; lane, repo, '
        + 'title or allowed_paths are missing; allowed_paths is empty (which means "unrestricted" '
        + 'to a reader and "nothing" to a collision check); a path escapes the repository; '
        + 'base_sha is not a full lowercase commit sha; the task depends on itself; or the paths '
        + 'overlap a task still in play. The author is taken from your token, never from this '
        + 'call — an author you can type is a claim, not a record.',
      input: obj({
        task_id: { type: 'string', description: 'file-safe id, e.g. "t-fix-the-cursor"' },
        title: { type: 'string', description: 'what this task is, readable on a roster' },
        lane_id: { type: 'string', description: 'the lane it belongs to' },
        repo_id: { type: 'string', description: 'the repo it belongs to' },
        allowed_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'repo-relative paths this task may touch. Non-empty: this is the collision guard.',
        },
        forbidden_paths: { type: 'array', items: { type: 'string' } },
        shared_paths: { type: 'array', items: { type: 'string' } },
        depends_on: { type: 'array', items: { type: 'string' }, description: 'task ids that must finish first' },
        base_sha: { type: 'string', description: 'full lowercase 40-character commit sha, or omit' },
      }, ['task_id', 'title', 'lane_id', 'repo_id', 'allowed_paths']),
      run: async (args) => jsonResult(await createTaskFn(args)),
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
