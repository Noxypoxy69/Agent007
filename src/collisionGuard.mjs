/**
 * THE HALF THAT REACHES A PERSON BEFORE THE COMMIT LANDS.
 *
 * laneRegistry.mjs already refuses a registry in which two lanes claim one path
 * exclusively. That refusal protects the MAP. It does nothing about the commit
 * being written right now against a correct map by an agent working outside its
 * lane, which is the failure that actually happened here on 14 Sep: three
 * sessions, one worktree, one shared git identity, and four commits nobody
 * could attribute afterwards without comparing notes in prose. One session
 * amended another's commit believing it was its own.
 *
 * Nothing in git stopped any of it, and nothing could: the index is shared, the
 * identity is shared, and `git commit` has no opinion about who you are beyond
 * user.email. This module supplies the opinion.
 *
 * IT IS PURE ON PURPOSE. No git, no filesystem, no process, no clock. Everything
 * it decides on arrives as an argument, and it returns a verdict rather than
 * exiting. The CLI in bin/agentbridge-precommit.mjs does the I/O and turns the
 * verdict into an exit code. That split is what lets the refusal contract be
 * tested against real repositories through a real child process while the rules
 * stay testable in a millisecond.
 *
 * WHY A GUARD NEEDS A DIFFERENT PROOF FROM A GATE. For a gate, "it goes red" is
 * enough. For a guard it proves nothing. A pre-commit hook that prints COLLISION
 * in scarlet and exits 0 is indistinguishable, in every log anyone will ever
 * read, from one that works — the commit simply succeeds and the warning
 * scrolls away. So severity here is not decoration: it is the thing that becomes
 * the exit code, and the exit code is the only part of this a hook consumes.
 *
 * THE POLICY CHOICES, EACH OF WHICH IS A JUDGEMENT ABOUT BEING IGNORED:
 *
 *   A refusal names the owning lane. "src/lib/hunt/map.ts is owned by ar-hunt"
 *   tells you who to talk to. A refusal that does not say who to talk to gets
 *   overridden with --no-verify and the guard is dead.
 *
 *   SHARED warns, and only blocks under --strict-shared. Shared paths are
 *   precisely the ones two lanes reconcile independently — package.json,
 *   verify.mjs — so blocking them by default would fire on ordinary work
 *   constantly, and a hook that fires constantly gets uninstalled within a day.
 *
 *   UNCLAIMED is allowed. A partial lane map is the normal state of any real
 *   repository, and treating unowned files as foreign would block ordinary work
 *   everywhere the map has not reached yet.
 *
 *   Branch and worktree rules bind only when the lane declares them.
 *   laneMatchesBranch returns null for "this lane has no opinion", and null must
 *   never block — otherwise adding a lane with no branch_patterns silently
 *   freezes its holder out of every branch.
 */
import { classifyPath, ownersOfPath, laneMatchesBranch, SHARED, FOREIGN } from './laneRegistry.mjs';

/** Severities, in the order that decides the exit code. */
export const CANNOT_RUN = 'cannot-run';
export const BLOCK = 'block';
export const WARN = 'warn';

/** Exit codes. These ARE the contract; a hook consumes nothing else. */
export const EXIT_ALLOW = 0;
export const EXIT_REFUSE = 1;
export const EXIT_CANNOT_RUN = 2;

/**
 * Decide whether this commit may proceed.
 *
 * @param {object} input
 * @param {object|null} input.registry      parsed registry, or null if unusable
 * @param {string|null} input.registryError why it is unusable, if it is
 * @param {string|null} input.laneId        the acting lane, or null if unresolved
 * @param {string|null} input.branch        current branch name
 * @param {string|null} input.worktree      worktree directory name or path
 * @param {string[]}    input.stagedPaths   repo-relative staged paths
 * @param {boolean}     input.strictShared  make SHARED blocking
 * @returns {{exitCode:number, findings:Array, blocked:boolean}}
 */
export function evaluateCommit(input) {
  const {
    registry = null,
    registryError = null,
    laneId = null,
    branch = null,
    worktree = null,
    stagedPaths = [],
    strictShared = false,
  } = input ?? {};

  const findings = [];
  const add = (rule, severity, message, extra = {}) =>
    findings.push({ rule, severity, message, ...extra });

  /*
   * RULE 7, FIRST BECAUSE NOTHING BELOW MEANS ANYTHING WITHOUT IT. A guard that
   * cannot read its rules must refuse, not wave things through. This is the
   * same reasoning as the jobs-drain endpoint answering 503 when its secret is
   * unset: a security control that silently disables itself is worse than one
   * that loudly cannot run, because the first is invisible.
   */
  if (registryError || !registry) {
    add(
      'registry',
      CANNOT_RUN,
      registryError
        ? `the lane registry could not be used: ${registryError}`
        : 'no lane registry was found',
    );
    return verdict(findings);
  }

  /*
   * RULE 6. Committing with no declared lane is not a small omission — it is
   * exactly how 14 Sep's mixed-lane commits happened. Three sessions committed
   * under one git identity and the history cannot say which did what.
   */
  if (!laneId) {
    add(
      'identity',
      BLOCK,
      'no lane identity could be resolved for this commit — declare the acting lane ' +
        'before committing, or the history cannot say who did this',
    );
    return verdict(findings);
  }

  const lane = registry.lanes.find((l) => l.lane_id === laneId) ?? null;
  if (!lane) {
    add('identity', BLOCK, `lane "${laneId}" is not in the registry`);
    return verdict(findings);
  }

  /*
   * RULES 4 AND 5. Both bind ONLY when the lane declares them. `null` from
   * laneMatchesBranch means the lane has no opinion, and a lane with no
   * branch_patterns must not freeze its holder out of every branch.
   */
  const branchOk = laneMatchesBranch(lane, branch);
  if (branchOk === false) {
    add(
      'branch',
      BLOCK,
      `branch "${branch}" does not match lane "${laneId}" (${lane.branch_patterns.join(', ')})`,
      { branch },
    );
  }

  if (worktree && lane.worktrees.length && !worktreeMatches(lane.worktrees, worktree)) {
    add(
      'worktree',
      BLOCK,
      `worktree "${worktree}" is not one of lane "${laneId}"'s (${lane.worktrees.join(', ')})`,
      { worktree },
    );
  }

  /*
   * RULES 1-3, per staged path. Each path is reported separately: a commit that
   * touches four foreign files should say all four, because a person fixing one
   * at a time and re-running is the slowest possible way to learn this.
   */
  for (const p of stagedPaths) {
    const kind = classifyPath(registry, laneId, p);

    if (kind === FOREIGN) {
      const owners = ownersOfPath(registry, p);
      add(
        'foreign',
        BLOCK,
        owners.length
          ? `${p} is owned by ${owners.join(', ')}`
          : `${p} belongs to another lane`,
        { path: p, owners },
      );
      continue;
    }

    if (kind === SHARED) {
      add(
        'shared',
        strictShared ? BLOCK : WARN,
        `${p} is a shared path — reconcile it rather than overwriting it`,
        { path: p },
      );
      continue;
    }
    // OWNED and UNCLAIMED both pass without comment.
  }

  return verdict(findings);
}

/**
 * Worktree matching is by basename OR full path.
 *
 * A registry says `social-sparks-code-c`; the hook is handed
 * `C:\Users\...\Documents\social-sparks-code-c`. Comparing those as strings
 * fails, and the failure mode is a guard that blocks every commit in a
 * correctly-configured worktree — which gets it uninstalled the same hour.
 * Separators are normalised because this runs on Windows and in CI.
 */
function worktreeMatches(declared, actual) {
  const norm = (s) => String(s).replace(/\\/g, '/').replace(/\/+$/, '');
  const a = norm(actual);
  const base = a.slice(a.lastIndexOf('/') + 1);
  return declared.some((d) => {
    const n = norm(d);
    return n === a || n === base || a.endsWith(`/${n}`);
  });
}

/**
 * Highest severity present decides the code: cannot-run beats block beats warn.
 *
 * THE cannot-run/block ORDERING IS DEFENSIVE AND CURRENTLY UNREACHABLE, and it
 * is reported as unproven rather than quietly counted as covered. Every
 * cannot-run finding returns immediately above, so no verdict today holds both
 * a cannot-run and a block, and swapping these two branches changes nothing —
 * mutation confirmed it: the suite stayed green.
 *
 * It is kept because the ordering becomes load-bearing the moment any future
 * rule raises cannot-run without returning, and getting it backwards then would
 * report "refused" for a guard that could not actually evaluate the commit. It
 * is not deleted and it is not claimed as tested.
 */
function verdict(findings) {
  const has = (s) => findings.some((f) => f.severity === s);
  const exitCode = has(CANNOT_RUN) ? EXIT_CANNOT_RUN : has(BLOCK) ? EXIT_REFUSE : EXIT_ALLOW;
  return { exitCode, findings, blocked: exitCode !== EXIT_ALLOW };
}

/** Render a verdict for a terminal. Wording is never asserted on; the code is. */
export function formatFindings(findings, { laneId = null } = {}) {
  if (!findings.length) return '';
  const order = { [CANNOT_RUN]: 0, [BLOCK]: 1, [WARN]: 2 };
  const label = { [CANNOT_RUN]: 'CANNOT RUN', [BLOCK]: 'BLOCKED', [WARN]: 'warning' };
  const lines = [...findings]
    .sort((a, b) => order[a.severity] - order[b.severity])
    .map((f) => `  ${label[f.severity].padEnd(10)} ${f.message}`);
  const head = laneId ? `agentbridge: acting as lane "${laneId}"` : 'agentbridge:';
  return [head, ...lines].join('\n');
}
