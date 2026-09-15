import { gitState } from './git.mjs';
import { discoverLocks } from './locks.mjs';
import { probeProcesses } from './processes.mjs';
import { redactPaths, redactHome } from './redact.mjs';
import { homedir } from 'node:os';
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

    /*
     * Strip the operator's home directory from anything leaving the machine.
     *
     * Separate from redactSensitivePaths, which governs secret-bearing
     * FILENAMES. This governs IDENTITY: the worktree path carries the
     * operator's real name and is transmitted twice per session, once as
     * `worktree` and once inside `git.worktree` -- and git spells it with
     * forward slashes while the OS spells it with backslashes, so both
     * spellings have to be handled or redaction covers half the occurrences
     * and looks like it worked.
     */
    const hideHome = cfg.redactHomePaths !== false;
    const home = homedir();

    sessions.push({
      agentId: a.agentId,
      lane: a.lane,
      worktree: redactHome(a.worktree, home, hideHome),
      git: g.ok
        ? {
            ...g,
            worktree: redactHome(g.worktree, home, hideHome),
            /*
             * The remote URL never leaves the machine.
             *
             * It published the account name and a PRIVATE REPOSITORY NAME --
             * somebody's inventory, not just their identity -- and it was found
             * by the payload guard's author, not by me, after I had already
             * fixed three leaks in this same payload and believed it clean.
             *
             * upstreamKind carries everything any rule needs: local, network,
             * unknown, or null. Set to undefined rather than null so the field
             * is ABSENT from the JSON: a null would still assert that the
             * concept exists and invite somebody to populate it again.
             */
            upstreamUrl: hideHome ? undefined : g.upstreamUrl,
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
