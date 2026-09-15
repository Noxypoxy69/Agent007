import { ownerOf } from '../src/glob.mjs';

/**
 * Pure collision detection over the latest session snapshots.
 * No I/O, so it is directly unit-testable and can run identically
 * server-side or in `agentbridge status`.
 *
 * Every finding states the evidence it was derived from. A coordinator acting
 * on a finding should be able to check the claim without asking anyone.
 */
export function detectCollisions(sessions, { lanes = null, staleAfterSeconds = 90, now = Date.now() } = {}) {
  const findings = [];
  const add = (severity, code, message, evidence) => findings.push({ severity, code, message, evidence });
  const live = sessions.filter((s) => s.git?.ok !== false);

  // 1. Two agents registered to the same worktree.
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

  // 2. Multiple agents claiming the same lane.
  const byLane = new Map();
  for (const s of sessions) byLane.set(s.lane, [...(byLane.get(s.lane) ?? []), s.agentId]);
  for (const [lane, agents] of byLane) {
    if (agents.length > 1) {
      add('critical', 'duplicate-lane', `lane "${lane}" claimed by ${agents.length} agents`,
        { lane, agents });
    }
  }

  // 3. Locks: same resource held in more than one worktree, or held by an
  //    agent other than the one registered to that worktree.
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

  // 4. Cross-lane dirty files. Requires a lanes map; without one we say so
  //    rather than silently reporting "no collisions".
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

  // 5. Local work not yet visible to anyone else.
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

  // 6. main divergence, and fetch staleness across worktrees.
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

  // 7. Staleness. An agent we stopped hearing from is not a silent agent.
  for (const s of sessions) {
    const seen = s.lastSeenAt ? Date.parse(s.lastSeenAt) : null;
    if (seen && (now - seen) / 1000 > staleAfterSeconds) {
      add('warn', 'stale-session',
        `no heartbeat from ${s.agentId} for ${Math.round((now - seen) / 1000)}s`,
        { agent: s.agentId, lastSeenAt: s.lastSeenAt });
    }
  }

  // 8. Unreadable worktrees are reported, never dropped.
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
