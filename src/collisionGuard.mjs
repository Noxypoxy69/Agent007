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
import { leaseState } from './leases.mjs';

/** Severities, in the order that decides the exit code. */
export const CANNOT_RUN = 'cannot-run';
export const BLOCK = 'block';
export const WARN = 'warn';

/** A start-time revalidation outcome that is not a commit-exit severity. */
export const STALE = 'stale';

const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

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

/**
 * START-TIME REVALIDATION — because assignment-time checks cannot see a claim
 * that happened AFTER them.
 *
 * evaluateCommit above runs at commit, on PATHS. It has no notion of a lease,
 * an attempt, or a baseline, so it cannot catch the failure this exists for: a
 * worker that was validly assigned, then had its lease expire, its task
 * re-assigned or superseded, or its base commit move, and begins mutating
 * anyway. Measured twice in CLAUDE.md -- two agents answered the same question
 * 65 minutes apart and again 9 minutes apart, and the collision guard saw
 * nothing both times because a check that runs once at assignment cannot see a
 * claim made after it.
 *
 * SYMMETRIC WITH THE TERMINAL WRITE. Package 0 fenced the terminal write on the
 * tuple {task, attempt, lease token, assigned session, expected state}. This
 * revalidates the SAME tuple at the other boundary -- the moment before work
 * begins -- so a claim that will be refused at return is refused before the
 * tokens are spent, not after.
 *
 * LEASE SEMANTICS ARE NOT REIMPLEMENTED HERE. Whether a lease is live is
 * leaseState's decision, called rather than re-derived -- the attemptRecord
 * header's warning, that a second implementation of lease semantics is the one
 * nobody watches when they disagree, applies directly. This composes that
 * decision with the equality checks and the path-ownership check the guard
 * already owns.
 *
 * FAIL CLOSED. An unreadable task or a missing authorised tuple is STALE, not
 * OK: "cannot confirm the claim is current" must refuse to start, the same way
 * the Stop gate refuses on an unreadable snapshot. Unknown is not clean.
 *
 * PURE, like everything else here: the caller fetches the live task and passes
 * `now`; this returns a verdict and touches no clock, git or store.
 *
 * NOT WIRED YET. This is the decision; the CALL is a separate step. Nothing in a
 * mutation path invokes it today, so as of this commit the SYSTEM does not
 * revalidate -- a blind audit flagged that (rule 17). The intended call site is
 * the claim/attempt-start boundary in the worker path, immediately before the
 * executor runs, and wiring it there needs a worktree-capable session to prove
 * end to end. Until that lands this is a tested decision, not an enforced one.
 *
 * @param {object} input
 * @param {object|null} input.task          the LIVE task row now {lease_token, assigned_session, attempt, base_sha, state}
 * @param {object|null} input.expected      the tuple authorised at claim {leaseToken, session, attempt, baseSha, state} -- ALL required; an absent dimension is STALE, not skipped
 * @param {string[]}    input.reservedPaths paths this work will mutate; each must still be owned by laneId (CROSS-LANE only; intra-lane duplication needs a reservation store that does not exist yet)
 * @param {object|null} input.registry      parsed lane registry (for path ownership); required if reservedPaths is non-empty, else STALE
 * @param {string|null} input.laneId        the acting lane; required if reservedPaths is non-empty
 * @param {string|Date|null} input.now      the instant to judge lease liveness against. An ISO string or a Date; a NUMBER is rejected by leaseState's Date.parse and fails closed (STALE), so do not pass Date.now() -- pass new Date().toISOString()
 * @returns {{ok:boolean, stale:boolean, findings:Array}}
 */
export function revalidateStart(input) {
  const {
    task = null,
    expected = null,
    reservedPaths = [],
    registry = null,
    laneId = null,
    now = null,
  } = input ?? {};

  const findings = [];
  const stale = (rule, message, extra = {}) => findings.push({ rule, severity: STALE, message, ...extra });

  if (!task || typeof task !== 'object') {
    stale('task', 'the live task could not be read; refusing to start work on a claim that cannot be confirmed current');
    return startVerdict(findings);
  }
  if (!expected || typeof expected !== 'object') {
    stale('expected', 'no authorised claim tuple was supplied to revalidate against; unknown is not current');
    return startVerdict(findings);
  }

  /*
   * Lease liveness: leaseState decides, this composes. leaseState THROWS on a
   * missing or unparseable `now` -- caught and treated as not-live, because a
   * lease whose liveness cannot be judged must fail closed, not throw past the
   * caller or read as live.
   */
  let ls;
  try { ls = leaseState(task, { now }); } catch { ls = 'unknowable'; }
  if (ls !== 'live') {
    stale('lease', `the lease is not live (state ${ls}); the claim that authorised this work has lapsed or cannot be judged`);
  }
  /*
   * EACH AUTHORISED DIMENSION IS REQUIRED, AND ABSENT IS STALE, NOT SKIPPED.
   *
   * An earlier version guarded each comparison with nonEmpty(expected.X), which
   * SKIPPED the check when the authorised field was empty -- the maker-rule
   * short-circuit, fail-OPEN: a tuple with an empty expected.session let a task
   * reassigned to another session pass as current, and a blind audit traced the
   * exact all-empty-tuple input that returned ok:true for a fully re-assigned
   * terminal task. The contract is fail-closed, so a dimension with no
   * authorised value to compare against cannot be confirmed current -- STALE.
   */
  if (!nonEmpty(expected.leaseToken)) stale('lease-token', 'no authorised lease token to revalidate against; the claim cannot be confirmed current');
  else if (task.lease_token !== expected.leaseToken) stale('lease-token', 'this claim has been superseded; the work was re-assigned under a new lease token');

  if (!nonEmpty(expected.session)) stale('session', 'no authorised session to revalidate against');
  else if (task.assigned_session !== expected.session) stale('session', `the task is assigned to ${task.assigned_session ?? '(none)'}, not the authorised session`);

  if (expected.attempt === null || expected.attempt === undefined) stale('attempt', 'no authorised attempt number to revalidate against');
  else if (Number(task.attempt) !== Number(expected.attempt)) stale('attempt', `the current attempt is ${task.attempt}, not the authorised ${expected.attempt}`);

  if (!nonEmpty(expected.baseSha)) stale('baseline', 'no authorised base sha to revalidate against');
  else if (task.base_sha !== expected.baseSha) stale('baseline', `the task base moved from ${expected.baseSha} to ${task.base_sha ?? '(none)'}; the workspace would sit on a different commit`);

  if (!nonEmpty(expected.state)) stale('state', 'no authorised state to revalidate against');
  else if (task.state !== expected.state) stale('state', `the task state is "${task.state}", not the authorised "${expected.state}"; it may be superseded or terminal`);

  /*
   * Path reservation reuses lane ownership -- there is no separate reservation
   * store, and inventing one would be a second source of truth. TWO LIMITS,
   * stated rather than hidden:
   *   (1) reserved paths declared with no registry or lane cannot be confirmed,
   *       which is STALE, not skipped -- an earlier version skipped it, fail-open.
   *   (2) lane ownership catches a path taken by ANOTHER lane. It does NOT catch
   *       two sessions in the SAME lane both starting the same work -- the
   *       intra-lane duplication this package's own motivating incident was.
   *       Detecting that needs a session-level reservation store, which does not
   *       exist yet; until it does, this dimension is a CROSS-LANE check only and
   *       must not be read as covering intra-lane collision.
   */
  if (reservedPaths.length > 0) {
    if (!registry || !nonEmpty(laneId)) {
      stale('reservation', 'reserved paths were declared but no registry or lane was supplied to confirm they still hold; unverifiable is not current');
    } else {
      for (const p of reservedPaths) {
        if (classifyPath(registry, laneId, p) === FOREIGN) {
          const owners = ownersOfPath(registry, p);
          stale(
            'reservation',
            owners.length
              ? `${p} is now owned by ${owners.join(', ')}; the reservation this work relied on is gone`
              : `${p} is no longer this lane's to mutate`,
            { path: p, owners },
          );
        }
      }
    }
  }

  return startVerdict(findings);
}

function startVerdict(findings) {
  return Object.freeze({ ok: findings.length === 0, stale: findings.length > 0, findings });
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
