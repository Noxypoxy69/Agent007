import { classifyRequest, DECIDER, RISK } from './permissionRequest.mjs';

/**
 * THE MISSING HALF-INCH BETWEEN AN ARGV AND A POLICY THAT ALREADY DECIDED IT.
 *
 * A screenshot on 2026-09-16 showed a coding agent stopped on "Do you want to
 * proceed?" for `git commit`. The reflex reading is that the policy is too
 * strict. It is not: permissionRequest.mjs has classified `commit` as ROUTINE
 * since it was written, on the explicit reasoning that a local commit is
 * reversible by the actor alone and nobody outside the machine sees it. That
 * file even opens by quoting the diagnosis that interactive prompts are a
 * blocking defect rather than an owner workflow.
 *
 * SO THE POLICY WAS NEVER CONSULTED. Nothing in this repository turns
 * ['git', 'commit', '-m', ...] into the string 'commit', so classifyRequest was
 * never asked, and the decision fell through to the executor's own permission
 * system -- which knows nothing about leases, worktrees or the ledger, and
 * whose only vocabulary is a prompt. The gap was one translation wide.
 *
 * THAT IS WHY THIS FILE NORMALISES AND COMPOSES RATHER THAN DECIDING. Adding a
 * second policy engine beside a correct one is how the booking sheet and the
 * phone agent disagreed for a fortnight. Risk classes, the deny-lists and the
 * owner ledger stay where they are; this file answers the question they cannot,
 * which is what action a given command line IS.
 *
 * PLACEMENT IS CHECKED SEPARATELY FROM ACTION CLASS, AND BOTH MUST PASS.
 * `git commit` is routine in a disposable task worktree holding the lease. The
 * same argv on main, or with no lease, or with a fence the coordinator has
 * moved past, is not the same act at all. Composing them as one score would let
 * a generous action class pay for a bad placement; keeping them independent
 * means a bug in either one cannot waive the other.
 *
 * FAILING CLOSED HERE MEANS WAITING_APPROVAL, NOT A PROMPT. A gate that stops
 * on a keypress has moved the blocker from a queue, where it is visible and
 * survives a restart, onto a laptop nobody is looking at.
 *
 * PURE. The command, the placement and the ledger arrive as arguments.
 */

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const arr = (v) => (Array.isArray(v) ? v : []);
const basename = (p) => String(p).split(/[\\/]/).pop() || String(p);

export const OUTCOME = Object.freeze({
  ALLOW: 'ALLOW',
  OWNER_GATE: 'OWNER_GATE',
  DENY: 'DENY',
});

/** Why a command was refused. These are the codes the attempt record stores. */
export const REFUSAL = Object.freeze({
  UNCLASSIFIED_COMMAND: 'UNCLASSIFIED_COMMAND',
  PROTECTED_BRANCH: 'PROTECTED_BRANCH',
  OUTSIDE_WORKSPACE: 'OUTSIDE_WORKSPACE',
  STALE_AUTHORITY: 'STALE_AUTHORITY',
  POLICY_DENIAL: 'POLICY_DENIAL',
  OWNER_REQUIRED: 'OWNER_REQUIRED',
  /*
   * A COORDINATOR GATE IS NOT AN OWNER GATE AND MUST NOT BE FILED AS ONE.
   * Collapsing them sends every elevated action to Danny's desk, which is how
   * an approval queue becomes noise and the one that mattered gets waved
   * through. `git push` lands here: elevated, delegated, and not his.
   */
  COORDINATOR_REQUIRED: 'COORDINATOR_REQUIRED',
});

/**
 * Branches a worker may never write to from inside an attempt.
 *
 * The integration branch is not here because it is precious; it is here because
 * a worker that can write it can make its own work look accepted without a
 * reviewer, which is the one thing the whole review layer exists to prevent.
 */
export const PROTECTED_BRANCHES = Object.freeze(['main', 'master', 'production', 'release']);

/**
 * git subcommands, mapped to the action vocabulary permissionRequest speaks.
 *
 * WRITTEN OUT RATHER THAN DERIVED, because a rule like "read verbs are safe"
 * has to be right about every verb git will ever have, and `git gc --prune` is
 * a read verb by that reasoning. An unlisted subcommand is unclassified, which
 * lands on the owner by the classifier's own default.
 */
const GIT_ACTIONS = Object.freeze({
  status: 'git.status',
  diff: 'git.diff',
  log: 'git.log',
  show: 'git.log',
  'rev-parse': 'git.status',
  'ls-files': 'git.status',
  add: 'commit',
  commit: 'commit',
  restore: 'commit',
  checkout: 'commit',
  switch: 'commit',
  branch: 'commit',
  stash: 'commit',
  /*
   * PUSH IS DELIBERATELY NOT ROUTINE and this is the line people will want to
   * change. Publishing is the step that stops being local and reversible by the
   * actor alone. It falls through the routine allow-list to ELEVATED, which
   * costs one coordinator approval rather than an owner's.
   */
  push: 'git.push',
  merge: 'merge',
  rebase: 'merge',
  reset: 'git.reset',
  clean: 'delete.worktree',
});

/**
 * Turn a command into an action string, or null when nothing here recognises it.
 *
 * NULL IS A REAL ANSWER AND IS NOT A FAILURE TO TRY HARDER. An unrecognised
 * command must not be guessed into a class; the classifier sends an unnamed
 * action to the owner on purpose, and returning a plausible-looking string
 * would route it somewhere cheaper on the strength of a guess.
 */
export function normalizeCommand(file, args = []) {
  if (!nonEmpty(file)) return null;
  const exe = basename(file).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  const rest = arr(args).filter((a) => typeof a === 'string');

  if (exe === 'git') {
    /*
     * -C <path> and other global options sit before the subcommand, so the
     * subcommand is the first token that is not an option or an option's value.
     * Getting this wrong reads `git -C /repo push` as a bare `-C`, which is
     * unclassified -- safe, but it would send every routine command to the
     * owner and teach everyone to widen the list.
     */
    const takesValue = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '-c']);
    let i = 0;
    while (i < rest.length) {
      const tok = rest[i];
      if (takesValue.has(tok)) { i += 2; continue; }
      if (tok.startsWith('-')) { i += 1; continue; }
      break;
    }
    const sub = rest[i];
    if (!sub) return null;
    return GIT_ACTIONS[sub.toLowerCase()] ?? null;
  }

  if (exe === 'npm' || exe === 'pnpm' || exe === 'yarn' || exe === 'bun') {
    const sub = rest.find((a) => !a.startsWith('-'));
    if (!sub) return null;
    const s = sub.toLowerCase();
    if (s === 'test') return 'run.tests';
    if (s === 'run') {
      const script = rest[rest.indexOf(sub) + 1];
      if (!nonEmpty(script)) return null;
      // A check script is a test; everything else a package can run is not
      // knowable from here, and `npm run deploy` is the reason that matters.
      return /^(test|check:|verify|lint|typecheck)/i.test(script) ? 'run.tests' : null;
    }
    return null;
  }

  if (exe === 'node' || exe === 'npx') return null;
  return null;
}

/**
 * Decide whether a command may run now, in this workspace, under this lease.
 *
 * @param command   { file, args }
 * @param placement { workspace, isDisposable, branch, leaseValid, fenceCurrent }
 * @param decisions the owner decision ledger, as rows
 */
export function guardExecution(command = {}, placement = {}, decisions = [], { now } = {}) {
  const action = normalizeCommand(command.file, command.args);

  /*
   * AUTHORITY IS CHECKED BEFORE THE ACTION CLASS, and the order is the point.
   * A stale worker asking to do something routine is still a stale worker, and
   * answering "that action is fine" first is how an expired lease commits.
   */
  if (placement.leaseValid === false || placement.fenceCurrent === false) {
    return {
      outcome: OUTCOME.DENY,
      action,
      code: REFUSAL.STALE_AUTHORITY,
      reason: placement.leaseValid === false
        ? 'the lease is not valid, so this worker no longer holds the task'
        : 'the fence token is behind, so this worker has been superseded',
    };
  }

  if (action === null) {
    return {
      outcome: OUTCOME.OWNER_GATE,
      action: null,
      code: REFUSAL.UNCLASSIFIED_COMMAND,
      reason: 'nothing here recognises this command, and an unclassified command '
        + 'is the owner\'s by default rather than the coordinator\'s',
    };
  }

  const writes = !/^(git\.(status|diff|log)|read\.|list\.|get\.|search\.|inspect\.|run\.tests)/.test(action);

  if (writes && placement.isDisposable === false) {
    return {
      outcome: OUTCOME.OWNER_GATE,
      action,
      code: REFUSAL.OUTSIDE_WORKSPACE,
      reason: 'a write outside a disposable task worktree is not a worker action',
    };
  }

  if (writes && nonEmpty(placement.branch)
      && PROTECTED_BRANCHES.includes(placement.branch.trim().toLowerCase())) {
    return {
      outcome: OUTCOME.OWNER_GATE,
      action,
      code: REFUSAL.PROTECTED_BRANCH,
      reason: `writing to ${placement.branch} from inside an attempt would let a worker `
        + 'make its own work look accepted without a reviewer',
    };
  }

  const verdict = classifyRequest(
    { action, task_id: placement.task_id ?? null, project: placement.project,
      repo: placement.repo, lane: placement.lane },
    decisions,
    { now },
  );

  if (verdict.decider === DECIDER.POLICY && verdict.allowed) {
    return { outcome: OUTCOME.ALLOW, action, decider: verdict.decider, risk: verdict.risk,
      decision_id: verdict.decision_id, reason: verdict.reason };
  }
  if (verdict.decider === DECIDER.POLICY && verdict.allowed === false) {
    return { outcome: OUTCOME.DENY, action, code: REFUSAL.POLICY_DENIAL, risk: verdict.risk,
      decision_id: verdict.decision_id, reason: verdict.reason };
  }
  if (verdict.decider === DECIDER.COORDINATOR && verdict.risk === RISK.ROUTINE) {
    /*
     * THE ONE THAT ENDS THE SCREENSHOT. Routine and delegated is exactly what
     * the owner delegated in d-owner-chatgpt-operational-approvals-20260915,
     * and asking again for something already decided is what trains an owner to
     * click through the approval that matters.
     */
    return { outcome: OUTCOME.ALLOW, action, decider: verdict.decider, risk: verdict.risk,
      reason: verdict.reason };
  }

  return {
    outcome: OUTCOME.OWNER_GATE,
    action,
    decider: verdict.decider,
    code: verdict.decider === DECIDER.OWNER
      ? REFUSAL.OWNER_REQUIRED
      : REFUSAL.COORDINATOR_REQUIRED,
    risk: verdict.risk,
    reason: verdict.reason,
  };
}
