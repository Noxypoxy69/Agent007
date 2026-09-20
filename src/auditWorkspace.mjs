/**
 * WHERE A REVIEWER WORKS, AND WHO IS ALLOWED TO DELETE IT.
 *
 * ═══ THE DEFECT FAMILY THIS CLOSES ═══
 *
 * The daemon allocated `%TEMP%/audit-<sha12>` -- a name DERIVED ENTIRELY
 * FROM THE CANDIDATE, so any local process could compute it before the audit
 * started. Three findings from one blind audit all followed from that:
 *
 *   D9  a pre-existing directory was adopted as the candidate checkout.
 *       Verifying it needed three checks -- registered worktree, at the
 *       candidate, clean -- of which one was ever written, so a separate
 *       `git clone` at the right commit passed the check that existed and
 *       defeated the two that did not.
 *   D10 `mkdir` of the head-of-queue candidate's path WEDGED THE DAEMON.
 *       Allocation refused, the job stayed PENDING, and it is re-selected
 *       first on every tick -- permanently, with no fallback and no alarm.
 *   D11 teardown `--force`-removed a directory the daemon may not have
 *       created, destroying a review in progress.
 *
 * ═══ AN ALLOCATION IS AN IDENTITY, NOT A NAME YOU CAN RECOMPUTE ═══
 *
 * Danny's correction, and it is the half a random suffix alone would have
 * left open: unpredictability stops somebody else occupying the path, and
 * does nothing about cleanup deriving a path from the sha again later. If
 * teardown recomputes, it is guessing which of several workspaces for the
 * same candidate it owns -- and with a random suffix there can now be
 * several.
 *
 * So `allocate` MINTS an identity and returns it, and `release` CONSUMES
 * that identity. Nothing downstream is given the sha and asked to work the
 * path out. `releaseWorkspace` refuses an allocation it did not get.
 *
 * ═══ crypto, NOT Math.random, AND NOT mkdtemp's SUFFIX EITHER ═══
 *
 * `mkdtempSync` appends six implementation-defined characters. That is
 * enough to avoid a collision and it is not a documented security property
 * -- the threat here is a local process PREDICTING the path, which makes
 * this a guessability question rather than a uniqueness one. `randomUUID`
 * is a CSPRNG and says so.
 */
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

/** A per-run identifier no other process can predict. */
export function newRunId() {
  return randomUUID().replace(/-/g, '');
}

/**
 * The workspace path for one run.
 *
 * The sha prefix is for a HUMAN reading `ls %TEMP%` -- it says which
 * candidate a leftover belongs to. The run id is what makes the path
 * unguessable. Twelve characters of sha, because that is what the rest of
 * this system prints and a shorter prefix reads as a different thing.
 */
export function workspaceName(candidateSha, runId) {
  const sha = String(candidateSha ?? '').slice(0, 12);
  return `audit-${sha}-${runId}`;
}

/**
 * Create a detached worktree at the candidate, and return its identity.
 *
 * @returns {{ok:true, allocation:object} | {ok:false, why:string}}
 */
export function allocateWorkspace({
  candidateSha, runGit, repoRoot, tmpRoot = os.tmpdir(), runId = newRunId(),
} = {}) {
  const sha = String(candidateSha ?? '').trim();
  if (!/^[0-9a-f]{7,40}$/.test(sha)) {
    return { ok: false, why: `not a candidate sha: ${JSON.stringify(candidateSha)}` };
  }
  if (typeof runGit !== 'function') return { ok: false, why: 'allocateWorkspace needs a runGit' };

  const dir = path.join(tmpRoot, workspaceName(sha, runId));

  /*
   * IF THIS EXISTS, SOMETHING IS VERY WRONG -- and it is still refused
   * rather than adopted. A collision on a CSPRNG id is not a thing that
   * happens; if it does, the honest response is to stop, not to reuse.
   * D9 was created by adopting.
   */
  if (existsSync(dir)) {
    return { ok: false, why: `${dir} already exists, which a per-run id makes impossible. Refusing to adopt it` };
  }

  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, why: `could not create ${dir}: ${String(e?.message ?? e)}` };
  }

  try {
    /*
     * `--force` because mkdirSync just created the directory and `worktree
     * add` refuses a non-empty target. It is ours, brand new and empty, so
     * there is nothing here for --force to destroy -- which was NOT true of
     * the old adopt-an-existing-directory path, and is the difference
     * between this flag being safe and being D11.
     */
    runGit(['worktree', 'add', '--detach', '--force', dir, sha], { cwd: repoRoot });
  } catch (e) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, why: String(e?.stderr || e?.message || e).trim() };
  }

  return {
    ok: true,
    allocation: {
      workspace_id: runId, dir, candidate_sha: sha, repo_root: repoRoot,
    },
  };
}

/**
 * Remove exactly the workspace an allocation names.
 *
 * REFUSES ANYTHING IT WAS NOT HANDED. Teardown that recomputes a path from
 * the candidate can delete a sibling run's workspace for the same
 * candidate -- which a per-run id makes possible for the first time, so
 * unpredictability without this would trade one defect for another.
 *
 * @returns {{ok:boolean, why?:string}}
 */
export function releaseWorkspace(allocation, { runGit, repoRoot } = {}) {
  const dir = allocation && typeof allocation.dir === 'string' ? allocation.dir : null;
  const id = allocation && typeof allocation.workspace_id === 'string' ? allocation.workspace_id : null;
  if (!dir || !id) return { ok: false, why: 'releaseWorkspace needs the allocation it is removing, not a sha' };

  /*
   * THE PATH MUST STILL BE THE ONE THIS ID NAMES. Cheap, and it catches a
   * caller that mutated `dir` or assembled an allocation by hand -- the
   * shape that would quietly re-open D11.
   */
  if (path.basename(dir) !== workspaceName(allocation.candidate_sha, id)) {
    return { ok: false, why: `${dir} does not match the identity ${id} it claims; refusing to remove it` };
  }

  let removed = false;
  try {
    if (typeof runGit === 'function') {
      runGit(['worktree', 'remove', '--force', dir], { cwd: repoRoot ?? allocation.repo_root });
      removed = true;
    }
  } catch { /* fall through to the directory removal and report below */ }

  /*
   * THE DIRECTORY GOES EVEN IF GIT WOULD NOT REMOVE THE WORKTREE, because
   * on Windows a dying reviewer holds handles and `worktree remove` fails
   * routinely -- that is how thirteen of these accumulated before teardown
   * existed at all. `git worktree prune` reconciles the admin records
   * afterwards; a directory nobody deletes is the thing that actually
   * accumulates.
   */
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  return { ok: true, gitRemoved: removed };
}
