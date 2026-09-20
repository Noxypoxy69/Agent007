/**
 * IS THE VERDICT ABOUT THE THING THE CLAIM NAMED?
 *
 * ═══ WHY THIS IS A MODULE AND NOT TWENTY LINES IN THE DAEMON ═══
 *
 * It was twenty lines in the daemon, and the focused blind pass filed that
 * as D-3: `scripts/audit-daemon.mjs` cannot be imported, so nobody had
 * watched the fence fire, nobody had watched the dirty branch fire, and
 * nobody had watched the could-not-measure branch fire. Rule 10 verbatim --
 * "a guard that cannot be imported is a guard nobody has watched fail" --
 * and conspicuous, because the same stretch of work extracted
 * `src/auditWorkspace.mjs` into `src/` for exactly that reason and gave it
 * eight tests, while leaving the newest control in the script.
 *
 * The auditor checked the logic on its merits and found it correct. That is
 * not the same as tested, and "correct when I read it" is the assurance
 * this repository exists to distrust.
 *
 * ═══ WHAT IT IS FOR ═══
 *
 * `recordAudit` fences on `candidate_sha` and `candidate_tree_sha`. For
 * that fence to mean anything the values must be an INDEPENDENT READING,
 * not a copy of the row being checked -- passing the row's own fields back
 * to it compares a row with itself, which is what M7 shipped and what D4
 * caught. So the reading is taken from the worktree the reviewer actually
 * worked in, after it has exited.
 *
 * ═══ DIRTY IS MOVED ═══
 *
 * `HEAD^{tree}` is the tree of the COMMIT. A reviewer that edits files
 * without committing leaves it identical -- and the brief explicitly
 * instructs reviewers to mutate and restore. A half-restored worktree is
 * not the candidate, so the working tree's cleanliness is part of the
 * reading rather than a separate nicety.
 *
 * ═══ AND COULD-NOT-READ IS ITS OWN ANSWER ═══
 *
 * A verdict about a tree nobody can identify is exactly what a fence is
 * for. Every failure to read is a distinct code, never a silent match.
 */

export const ATTRIBUTION = Object.freeze({
  OK: 'OK',
  UNREADABLE: 'E_WORKTREE_UNREADABLE',
  DIRTY: 'E_WORKTREE_DIRTY',
  MOVED: 'E_CANDIDATE_MOVED',
});

/**
 * Read what was actually reviewed, from the worktree.
 *
 * @param {object}   o
 * @param {string}   o.dir     the workspace the reviewer ran in
 * @param {function} o.runGit  injected, so this is testable without a repo
 * @returns {{ok:true, sha:string, tree:string} | {ok:false, code:string, why:string}}
 */
export function measureReviewed({ dir, runGit } = {}) {
  if (typeof runGit !== 'function') {
    return { ok: false, code: ATTRIBUTION.UNREADABLE, why: 'measureReviewed needs a runGit' };
  }
  const g = (args) => String(runGit(args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })).trim();

  let sha;
  let tree;
  let dirt;
  try {
    sha = g(['rev-parse', 'HEAD']);
    tree = g(['rev-parse', 'HEAD^{tree}']);
    dirt = g(['status', '--porcelain']);
  } catch (e) {
    return {
      ok: false,
      code: ATTRIBUTION.UNREADABLE,
      why: `could not read what was reviewed from ${dir} `
        + `(${String(e?.stderr || e?.message || e).trim().split('\n')[0]}), so the verdict cannot be pinned`,
    };
  }

  if (dirt !== '') {
    return {
      ok: false,
      code: ATTRIBUTION.DIRTY,
      dirty: dirt.split('\n').length,
      why: `the reviewer left ${dirt.split('\n').length} uncommitted change(s) in the worktree, `
        + 'so what was reviewed is not the candidate the claim named',
    };
  }
  return { ok: true, sha, tree };
}

/**
 * Does an independent reading match the claim?
 *
 * PURE. Takes the measurement and the job; touches nothing. That is the
 * half worth testing exhaustively, and the half that used to be unreachable.
 */
export function attributionHolds(measured, job) {
  if (!measured || measured.ok !== true) {
    return { ok: false, code: measured?.code ?? ATTRIBUTION.UNREADABLE, why: measured?.why ?? 'no measurement' };
  }
  const wantSha = String(job?.candidate_sha ?? '');
  const wantTree = String(job?.candidate_tree_sha ?? '');

  /*
   * AN ABSENT CLAIM IS NOT A MATCH. A row missing either field would
   * otherwise compare '' against '' -- or against a real sha -- and the
   * empty case is the one that would pass silently.
   */
  if (!/^[0-9a-f]{40}$/.test(wantSha) || !/^[0-9a-f]{40}$/.test(wantTree)) {
    return {
      ok: false,
      code: ATTRIBUTION.MOVED,
      why: 'the claim does not carry a full candidate sha and tree, so there is nothing to compare against',
    };
  }

  if (measured.sha !== wantSha || measured.tree !== wantTree) {
    return {
      ok: false,
      code: ATTRIBUTION.MOVED,
      why: `the worktree was at ${measured.sha.slice(0, 8)}/${measured.tree.slice(0, 8)} but the claim `
        + `named ${wantSha.slice(0, 8)}/${wantTree.slice(0, 8)}; the candidate moved under the audit, `
        + 'so the verdict is about something else',
    };
  }
  return { ok: true, code: ATTRIBUTION.OK, sha: measured.sha, tree: measured.tree };
}
