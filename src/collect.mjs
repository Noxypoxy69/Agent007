import { gitState } from './git.mjs';
import { discoverLocks } from './locks.mjs';
import { probeProcesses } from './processes.mjs';
import { redactPaths } from './redact.mjs';
import { machineInfo } from './config.mjs';
import { loadLanes } from './lanes.mjs';

export const HEARTBEAT_SCHEMA = 'agentbridge.heartbeat.v1';

/**
 * Assemble one heartbeat. Read-only by construction: every call site below is
 * an observation (git plumbing, directory listing, process listing). Nothing
 * in this file writes to the worktree.
 */
export async function collect(cfg, registry) {
  const agents = registry.agents ?? [];
  const worktrees = [...new Set(agents.map((a) => a.worktree))];
  const [proc, ...states] = await Promise.all([
    probeProcesses(worktrees),
    ...agents.map((a) => gitState(a.worktree, { mainRef: cfg.mainRef })),
  ]);

  const sessions = [];
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    const g = states[i];
    const locks = await discoverLocks(a.worktree, cfg.lockDirs);
    const redact = cfg.redactSensitivePaths !== false;

    sessions.push({
      agentId: a.agentId,
      lane: a.lane,
      worktree: a.worktree,
      git: g.ok
        ? {
            ...g,
            staged: redactPaths(g.staged, redact),
            dirty: redactPaths(g.dirty, redact),
            untracked: redactPaths(g.untracked, redact),
          }
        : g,
      locks,
      processes: proc.byWorktree[a.worktree] ?? [],
      processProbeOk: proc.probeOk,
    });
  }

  // Lane ownership travels with the heartbeat so the bridge evaluates
  // cross-lane writes against the same lanes file the repo is using.
  let lanes = null, lanesError = null;
  try { lanes = await loadLanes(cfg.lanesFile); }
  catch (e) { lanesError = String(e.message); }

  return {
    schema: HEARTBEAT_SCHEMA,
    lanes,
    lanesError,
    sentAt: new Date().toISOString(),
    machine: machineInfo(cfg),
    processProbe: { ok: proc.probeOk, error: proc.error ?? null },
    sessions,
  };
}
