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

  // 1. Two agents registered to the same worktree.
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

  // 2. Multiple agents claiming the same lane.
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

  // 3. Locks: same resource held in more than one worktree, or held by an
  //    agent other than the one registered to that worktree.
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
