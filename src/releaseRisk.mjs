/**
 * Release-risk rules, as a PURE FUNCTION over the state gitState() already
 * collects.
 *
 * WHY THIS EXISTS, with the real case that produced it.
 *
 * On 2026-09-14 three agent sessions were working one repository. Section A
 * read the machine and reported:
 *
 *   code-a [integration]  release/integrate-2026-09-14  a53bcb0690e9
 *     unpushed 9 (no-upstream:vs-merge-base)  ahead 9 / behind 0   clean
 *
 * Nine commits of integration work, on a release branch, existing on exactly
 * one disk, with no remote to recover them from. Nobody had done anything
 * wrong -- it is what integrating locally looks like before the first push --
 * but it is also indistinguishable from the state where a machine dying loses
 * a day, and from the state where somebody deploys an artifact no one else can
 * reproduce. It was found by a human reading a text block. That is the thing
 * this file is meant to stop being true.
 *
 * PURE ON PURPOSE. Everything here takes a state object and returns findings.
 * No git, no filesystem, no process. Three reasons that matters:
 *
 *   1. Every rule can be tested by handing it a literal, so the tests can
 *      describe states this machine cannot currently be in.
 *   2. A rule cannot accidentally mutate the branch it is judging. This guard
 *      runs against other agents' worktrees; it must be incapable of writing.
 *   3. The negative proofs are cheap, and they are the point -- see
 *      test/releaseRisk.test.mjs. Two checks in the previous build passed
 *      while testing nothing, so no rule here is trusted until a test has
 *      watched it both fire and stay silent.
 *
 * SEVERITY IS A POLICY, NOT A FACT. A rule reports what is true; `block` vs
 * `warn` is how the caller is expected to react. Kept separate so a hook can
 * be strict on a release branch and advisory elsewhere without the rules
 * themselves changing meaning.
 */

/** Blocking findings stop the action. Warnings are reported and allow it. */
export const BLOCK = 'block';
export const WARN = 'warn';

/**
 * What counts as a release branch.
 *
 * Deliberately a pattern rather than a hardcoded name: this repository's
 * integration branch was `release/integrate-2026-09-14`, and the next one will
 * carry a different date. A branch that is NOT a release branch still gets the
 * universal rules below -- being local-only is not harmless on a feature
 * branch either, it is just less urgent.
 */
export const DEFAULT_RELEASE_PATTERN = /^(release|hotfix|integrate)[/-]/i;

/** Branch names that are the shared trunk rather than somebody's work. */
export const DEFAULT_TRUNK_PATTERN = /^(main|master|trunk)$/i;

function finding(code, severity, message, evidence) {
  return { code, severity, message, evidence };
}

/**
 * Evaluate one worktree's git state.
 *
 * @param {object} state  the object returned by gitState()
 * @param {object} [opts]
 * @param {RegExp} [opts.releasePattern]
 * @param {RegExp} [opts.trunkPattern]
 * @param {boolean} [opts.strictEverywhere]  apply release severities to any branch
 * @returns {{ok: boolean, blocking: number, warnings: number, findings: Array}}
 */
export function evaluateReleaseRisk(state, opts = {}) {
  const releasePattern = opts.releasePattern ?? DEFAULT_RELEASE_PATTERN;
  const trunkPattern = opts.trunkPattern ?? DEFAULT_TRUNK_PATTERN;
  const findings = [];

  // A state we could not read is not a state we may approve. Fail closed:
  // "I could not tell" and "it is fine" must never produce the same answer.
  if (!state || state.ok !== true) {
    findings.push(finding('UNREADABLE_WORKTREE', BLOCK,
      'cannot read git state, so no release claim can be made about it',
      { reason: state?.reason ?? 'no-state', worktree: state?.worktree ?? null }));
    return summarise(findings);
  }

  const branch = state.branch ?? null;
  const isRelease = branch != null && releasePattern.test(branch);
  const isTrunk = branch != null && trunkPattern.test(branch);
  // Severity for "this work exists only here" findings.
  const sev = (isRelease || isTrunk || opts.strictEverywhere) ? BLOCK : WARN;

  /*
   * DETACHED HEAD. There is no branch to push, so whatever is here is
   * unreachable the moment anyone checks out anything else. wt-release-verify
   * was detached at 481f812 for the first half of the afternoon.
   */
  if (state.detached) {
    findings.push(finding('DETACHED_HEAD', sev,
      'HEAD is detached, so commits here belong to no branch and are not pushable',
      { head: state.head }));
  }

  /*
   * NO UPSTREAM. The branch has never been pushed, or its remote was deleted.
   * Reported separately from unpushed-commit count because a branch with no
   * upstream and no commits yet is still a branch nobody else can see.
   */
  if (!state.detached && !state.upstream) {
    findings.push(finding('NO_UPSTREAM', sev,
      'branch has no remote upstream, so nothing here is recoverable off this machine',
      { branch }));
  }

  /*
   * LOCAL-ONLY COMMITS. The headline case. Counted against the upstream when
   * there is one, against the merge-base when there is not -- gitState says
   * which via unpushedReason, and that distinction is carried into the
   * evidence because "9 unpushed" means something different in each case.
   */
  if (typeof state.unpushed === 'number' && state.unpushed > 0) {
    const localOnly = !state.upstream;
    findings.push(finding(
      localOnly ? 'LOCAL_ONLY_COMMITS' : 'UNPUSHED_COMMITS',
      sev,
      localOnly
        ? `${state.unpushed} commit(s) exist only on this machine and have no remote upstream`
        : `${state.unpushed} commit(s) are ahead of ${state.upstream} and not pushed`,
      { count: state.unpushed, basis: state.unpushedReason, upstream: state.upstream ?? null, head: state.head },
    ));
  }

  /*
   * TRUNK AHEAD OF ITS REMOTE. Distinct from the above: commits sitting on a
   * local main are the ones most likely to be assumed shared, and most
   * damaging when a second integrator pushes over them.
   */
  if (isTrunk && typeof state.aheadOfMain === 'number' && state.aheadOfMain > 0) {
    findings.push(finding('TRUNK_AHEAD_OF_REMOTE', BLOCK,
      `local ${branch} is ${state.aheadOfMain} commit(s) ahead of ${state.mainRef}`,
      { ahead: state.aheadOfMain, mainRef: state.mainRef }));
  }

  /*
   * DIRTY TREE. A release built from a dirty tree is not the commit it claims
   * to be: wrangler ships the working tree, not HEAD. Untracked files are a
   * warning rather than a block -- they are usually scratch, and blocking on
   * them is how a guard gets switched off.
   */
  const modified = (state.staged?.length ?? 0) + (state.dirty?.length ?? 0);
  if (modified > 0) {
    findings.push(finding('DIRTY_TREE', sev,
      `${modified} uncommitted change(s), so a build from this tree is not ${String(state.head).slice(0, 12)}`,
      { staged: state.staged?.length ?? 0, dirty: state.dirty?.length ?? 0 }));
  }
  if ((state.untracked?.length ?? 0) > 0) {
    findings.push(finding('UNTRACKED_FILES', WARN,
      `${state.untracked.length} untracked file(s) present`,
      { untracked: state.untracked.length }));
  }

  /*
   * STALE BASE. Being behind the trunk is not itself an error, but a release
   * branch that has not seen the trunk's latest is one whose green CI describes
   * a merge nobody has performed.
   */
  if (isRelease && typeof state.behindMain === 'number' && state.behindMain > 0) {
    findings.push(finding('BEHIND_TRUNK', WARN,
      `release branch is ${state.behindMain} commit(s) behind ${state.mainRef}`,
      { behind: state.behindMain, mainRef: state.mainRef }));
  }

  return summarise(findings);
}

function summarise(findings) {
  const blocking = findings.filter((f) => f.severity === BLOCK).length;
  return {
    ok: blocking === 0,
    blocking,
    warnings: findings.filter((f) => f.severity === WARN).length,
    findings,
  };
}

/** Human-readable report. One line per finding, severity first so it greps. */
export function formatReleaseRisk(label, result) {
  if (!result.findings.length) return `  ${label}: no release risk`;
  const lines = [];
  for (const f of result.findings) {
    const tag = f.severity === BLOCK ? 'RELEASE RISK' : 'release warning';
    lines.push(`  ${tag} — ${f.message}`);
    lines.push(`      ${label}  [${f.code}]  ${JSON.stringify(f.evidence)}`);
  }
  return lines.join('\n');
}
