import { gitState } from './git.mjs';
import { discoverLocks } from './locks.mjs';
import { probeProcesses } from './processes.mjs';
import { redactPaths, portableWorktree } from './redact.mjs';
import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';

/**
 * The canonical long form of a path, or null if it cannot be resolved.
 *
 * On Windows this is what turns an 8.3 alias (`C:\Users\JANEDO~1\...`) back
 * into the spelling home is compared against. `.native` is the part that does
 * it -- the JS implementation of realpath does not expand short names.
 *
 * Never throws: a path that has since been deleted, or one on a volume that
 * refuses the call, must degrade to "use what we were given" rather than take
 * the whole heartbeat down. portableWorktree still refuses to emit an absolute
 * path in that case, so the fallback is safe rather than merely quiet.
 */
function longPath(p) {
  if (typeof p !== 'string' || !p) return null;
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}
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

    /*
     * BOTH SPELLINGS OF HOME, because Windows has two and hands out the short
     * one constantly. `C:\Users\JANEDO~1\...` is the same directory as
     * `C:\Users\JANE DOE\...` -- every temp path on this machine uses the
     * 8.3 form -- and a prefix match against the long form alone never fires
     * on it. The path shipped absolute with the operator's name still in it,
     * merely abbreviated.
     *
     * realpathSync.native is what resolves the alias, and it needs the path to
     * exist. A worktree does. It is called once per collect, not per path, and
     * falls back to the original spelling rather than throwing: a home we could
     * not canonicalise must not take the heartbeat down, and portableWorktree
     * still refuses to emit an absolute path either way.
     */
    const homes = [...new Set([home, longPath(home)].filter(Boolean))];

    sessions.push({
      agentId: a.agentId,
      lane: a.lane,
      worktree: portableWorktree(longPath(a.worktree) ?? a.worktree, homes, hideHome),
      git: g.ok
        ? {
            ...g,
            worktree: portableWorktree(longPath(g.worktree) ?? g.worktree, homes, hideHome),
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
        /*
         * THE FAILURE BRANCH LEAKED, AND ONLY THE FAILURE BRANCH.
         *
         * gitState's early return is `{ ok:false, reason, worktree: cwd }` --
         * the raw path. Spreading `g` here shipped it untouched, so a worktree
         * that was merely NOT A GIT REPO disclosed its absolute path while
         * every healthy one was redacted. Caught by the end-to-end test rather
         * than by reading this, because the happy path looked correct and is
         * the only one anybody inspects.
         *
         * Same treatment as above: there is no version of this where an
         * absolute path is acceptable on the wire, including when the probe
         * failed.
         */
        : { ...g, worktree: portableWorktree(longPath(g.worktree) ?? g.worktree, homes, hideHome) },
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
