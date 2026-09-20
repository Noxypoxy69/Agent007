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
 *
 * ═══ WHAT THIS ENFORCES, STATED NARROWLY ═══
 *
 * Focused-pass finding D-6: the header used to say `releaseWorkspace`
 * "refuses an allocation it did not get", and that is more than the code
 * does. There is no registry of issued allocations; the check is INTERNAL
 * SELF-CONSISTENCY -- the directory's basename must be the one this
 * identity would produce. Every field is derivable from the path, so a
 * caller holding another run's path can construct an allocation that
 * passes.
 *
 * The property actually enforced is: A CALLER THAT RECOMPUTED THE PATH FROM
 * THE CANDIDATE IS REFUSED. That is the failure mode a per-run id creates
 * and it is worth closing. The unpredictability of the id is what stops an
 * unrelated process finding the path at all, and it is doing the real work
 * -- anyone already holding it could delete the directory directly.
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
   * CREATED ATOMICALLY, so "refuse rather than adopt" is enforced by the
   * filesystem instead of by a check racing it.
   *
   * Focused-pass finding D-7: this was `existsSync` then
   * `mkdirSync(recursive: true)`, and `recursive` SUCCEEDS SILENTLY on an
   * existing directory -- so the guard was a TOCTOU window, not a refusal,
   * and the comment claiming it refused was relying on the unguessability
   * it said it did not rely on. Without `recursive`, `mkdirSync` throws
   * EEXIST atomically and the claim is free.
   *
   * A collision on a CSPRNG id does not happen; if it somehow does, the
   * honest response is to stop rather than reuse. D9 was created by
   * adopting.
   */
  try {
    mkdirSync(dir);
  } catch (e) {
    if (e?.code === 'EEXIST') {
      return { ok: false, why: `${dir} already exists, which a per-run id makes impossible. Refusing to adopt it` };
    }
    return { ok: false, why: `could not create ${dir}: ${String(e?.message ?? e)}` };
  }

  try {
    /*
     * NO `--force`, AND I HAD ALREADY RECORDED WHY BEFORE WRITING IT AGAIN.
     *
     * Focused-pass finding D-5. The justification I carried into this
     * module -- "`--force` because mkdirSync just created the directory and
     * `worktree add` refuses a non-empty target" -- is false in both
     * halves: git dies only on a NON-EMPTY path, and that die is not gated
     * on `--force`. An empty directory needs no flag. What `--force`
     * actually buys is overriding a registered worktree's admin record at
     * that path, which is a safeguard removal, not a convenience.
     *
     * The galling part: lap 7 measured this as D8 and the ledger row I
     * wrote for `13b2d69` says "BOTH halves of my justifying comment were
     * false ... D8 REMAINS OPEN" -- and the very next commit copied the
     * disproven sentence into new source. Writing a finding down is not the
     * same as reading it.
     *
     * With per-run ids the one thing `--force` did do -- reclaiming a stale
     * `audit-<sha12>` record -- is unreachable, so it is purely inert. Gone.
     */
    runGit(['worktree', 'add', '--detach', dir, sha], { cwd: repoRoot });
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
export function releaseWorkspace(allocation, { runGit, repoRoot, rm = rmSync } = {}) {
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

  let gitRemoved = false;
  let gitWhy = null;
  try {
    if (typeof runGit === 'function') {
      runGit(['worktree', 'remove', '--force', dir], { cwd: repoRoot ?? allocation.repo_root });
      gitRemoved = true;
    }
  } catch (e) { gitWhy = String(e?.stderr || e?.message || e).trim().split('\n')[0]; }

  /*
   * THE DIRECTORY GOES EVEN IF GIT WOULD NOT REMOVE THE WORKTREE, because
   * on Windows a dying reviewer holds handles and `worktree remove` fails
   * routinely -- that is how thirteen of these accumulated before teardown
   * existed at all.
   */
  /*
   * `rm` IS INJECTABLE, AND ONLY SO THE FAILURE BRANCH CAN BE WATCHED.
   *
   * The `ok:false` path below is the entire reason this function was
   * changed, and it had no test -- because a removal that FAILS could not
   * be constructed from the suite. The obvious attempt does not work: a
   * held file handle does not block deletion on Windows, since libuv opens
   * with FILE_SHARE_DELETE. Measured, not assumed -- the first version of
   * the test tried exactly that and its precondition assertion fired.
   *
   * The remaining ways are all machine properties (a process whose cwd is
   * the directory, an ACL, a mount) and rule 21 says a test must not
   * encode one. So the seam moves into the code, the way `runGit` already
   * is: the test supplies a removal that fails the way Windows fails, and
   * the DECISION -- ask the filesystem, report what git said and what rm
   * said -- is then exercised for real. `existsSync` is still the far end
   * and is never injected, so `ok` cannot be talked into lying.
   */
  let fsWhy = null;
  try { rm(dir, { recursive: true, force: true }); } catch (e) { fsWhy = String(e?.message ?? e); }

  /*
   * ═══ NO REPO-GLOBAL PRUNE. THIS REPOSITORY ALREADY RULED ON IT. ═══
   *
   * I added `git worktree prune` here to reconcile admin records, and the
   * blind pass caught it as two separate mistakes.
   *
   * IT IS DANGEROUS. `test/startAgentLauncher.test.mjs` says, verbatim:
   * "NO REPO-GLOBAL PRUNE. That first version ended with an unconditional
   * `git worktree prune` against REPO, and the auditor showed it destroying
   * a PRUNABLE registration the run never created -- admin directory, HEAD
   * and any in-progress rebase state with it." That was written about a
   * checkout carrying 36 registrations; it carries 41 today, 28 of them
   * live agent worktrees and 5 belonging to another session. `prune` takes
   * no argument naming what to prune -- it removes everything prunable,
   * which is the opposite of the identity discipline this module is for.
   *
   * IT ALSO DID NOT WORK. The seven stale `audit-<sha12>` records I cited
   * as motivation are NOT prunable: their directories and `.git` link
   * files are all present, and `prune` only removes a registration whose
   * worktree is MISSING. So it was a no-op for its stated purpose and a
   * global hazard for everything else. Those seven accumulated because
   * teardown never deleted the DIRECTORIES -- a different defect, which
   * `releaseWorkspace` now fixes directly.
   *
   * `git worktree remove --force` already deregisters the one it removes.
   * When it fails, the honest outcome is the `ok:false` below, not a
   * repo-wide sweep to paper over it.
   */

  /*
   * ═══ ok MEANS THE WORKSPACE IS GONE, NOT "WE TRIED" ═══
   *
   * Focused-pass finding D-1. This returned a literal `ok: true` on every
   * path past the basename check, swallowing both failures, and the only
   * field carrying the truth -- `gitRemoved` -- was read by nobody. So the
   * daemon printed "removed <dir>" for a directory still sitting there.
   *
   * Worse than cosmetic, and the module's own comment says why: on Windows
   * a dying reviewer holds handles and the removal fails ROUTINELY. `rmSync`
   * fails on those same handles, so the documented-common case is exactly
   * the one that reported success -- and by the daemon's own note each
   * leftover worktree adds permanent Stop-gate drift. The operator lost the
   * only signal that a control was degrading, and the previous code (a bare
   * try/catch in the daemon) had reported it with git's reason.
   *
   * The far end is the filesystem, so that is what is asked (rule 4).
   */
  const gone = !existsSync(dir);
  if (gone) return { ok: true, gitRemoved };
  return {
    ok: false,
    gitRemoved,
    why: `${dir} is still present after teardown`
      + `${gitWhy ? `; git said: ${gitWhy}` : ''}${fsWhy ? `; rm said: ${fsWhy}` : ''}`,
  };
}
