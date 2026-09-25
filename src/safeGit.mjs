/**
 * ONE WAY TO RUN GIT, BECAUSE A REPOSITORY'S CONFIG IS EXECUTABLE.
 *
 * WHAT THIS DEFENDS AGAINST, MEASURED RATHER THAN ASSUMED. `.git/config` can
 * name commands that git runs on ordinary read-only operations. Set
 * `core.fsmonitor` to a script and `git status` executes it. Demonstrated in a
 * scratch repository: an unhardened `git status` ran the command and created its
 * marker file; the same status with the flags below did not.
 *
 * THAT MATTERS MOST WHERE IT WAS MISSING. `.git/` is not in PROTECTED_PATHS and
 * is never tracked, so writing `.git/config` is invisible to `git status`, to
 * protectedDrift and to the guard's path rules. The Stop gate then shells out to
 * git to decide whether a baseline may be minted -- so the file the gate cannot
 * see could execute code inside the gate that is checking it.
 *
 * WHY A MODULE AND NOT A CONSTANT COPIED AROUND. The flags already existed
 * twice, byte-identical, as SAFE_GIT in verifier.mjs and SAFE_GIT_CONFIG in
 * candidateTree.mjs -- while seven other invocations had none. src/policy.mjs
 * was added to this repository with a header explaining that two lists of one
 * thing drift the moment somebody edits one, and that this project had already
 * lost days to exactly that. The hardening was that shape.
 *
 * So `runGit` exists as well as the list: a caller that imports the constant can
 * still forget to spread it, and `test/safeGit.test.mjs` asserts that nothing
 * under src/, bin/ or scripts/ invokes git any other way. The safe path is the
 * only path, and a new call site cannot quietly become the eighth.
 *
 * WHAT IT IS NOT. These three flags close the executable-config surface this
 * repository has actually met. They are not a sandbox: git run by a user can
 * still read and write everything that user can.
 */

import { execFile, execFileSync } from 'node:child_process';

/**
 * Refuses the repository's own executable configuration.
 *
 * hooksPath: no hook script from the repository under test.
 * fsmonitor: no "watch the filesystem with this command" -- the one proven to
 *   execute on a plain `git status`.
 * protocol.ext.allow: no `ext::` URL, which runs a shell command as a transport.
 */
export const SAFE_GIT_CONFIG = Object.freeze([
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'protocol.ext.allow=never',
]);

/*
 * ═══ MERGE 2026-09-25 (T-246): TWO LINES FIXED THE SAME HOLE WITH OPPOSITE POLICIES ═══
 *
 * design/action-authority (the trunk) and local master 637cdb9 each repaired
 * "an inherited GIT_DIR answers for a different repository". Their repairs were
 * NOT the same fix twice; they disagreed on two properties, and this file keeps
 * each property from the line that MEASURED it:
 *
 *   1. GIT_INDEX_FILE -- the TRUNK wins. It is NOT stripped from the ambient
 *      environment. Local stripped it; the trunk measured that doing so turned
 *      the pre-commit lane guard fail-open (an empty staged list for a partial
 *      commit, see the trunk's note below). Controller ruling, T-246.
 *   2. AN EXPLICIT CALLER env -- LOCAL wins for the repository-SELECTION set.
 *      The trunk layered the caller's env over the stripped ambient one; local
 *      measured that candidateTree builds `{ ...process.env, ...env }`, so an
 *      ambient GIT_DIR arrives INSIDE the caller's object and is layered back.
 *      REPOSITORY_SELECTION_VARS are therefore refused from every source.
 *
 * Both lines' exports are kept (redirectsRepository, REPOSITORY_SELECTION_VARS,
 * AMBIENT_ONLY_VARS, environmentWithoutGitRedirection) so both lines' tests
 * import and run against this one file.
 *
 * STATED RESIDUAL, not closed here: the config family (GIT_CONFIG*, GIT_CONFIG_
 * KEY_n/VALUE_n) is stripped from the AMBIENT environment but still honoured
 * from an explicit caller env -- the trunk's layering, kept as ruled. A caller
 * that spreads process.env therefore still carries an ambient GIT_CONFIG_COUNT
 * through. Closing that is a policy change, not a merge resolution.
 */

/*
 * GIT_DIR BEATS -C, SO THE ENVIRONMENT COULD ANSWER FOR A DIFFERENT REPOSITORY.
 * (trunk)
 *
 * Every question this module is asked is about a DIRECTORY -- what does this
 * pathspec cover, which repository is this, is this file inherited. The answers
 * are asked with -C. But git resolves GIT_DIR and GIT_COMMON_DIR BEFORE -C, so
 * an inherited variable silently redirects the answer:
 *
 *   GIT_DIR=<A>/.git git -C <B> rev-parse --git-common-dir   ->  <A>/.git
 *
 * Measured 2026-09-18 by blind audit, through the shipped hook binary: with
 * GIT_DIR set, three unrelated repositories produced ONE grant key, and a grant
 * written for repository A ALLOWED a protected write in repository B. Without
 * it, the same write was denied. Git exports GIT_DIR into every hook process it
 * spawns, so any session started from a git hook, a rebase --exec or a filter
 * carries it -- this needs no attacker, only an ordinary launch path.
 */
/*
 * WHICH VARIABLES REDIRECT THE REPOSITORY. NOT "EVERYTHING NAMED GIT_". (trunk)
 *
 * The first version stripped /^GIT_/i, and that was too wide by exactly one
 * variable that matters: GIT_INDEX_FILE. Git sets it AS PROTOCOL when it invokes
 * a hook for a partial commit -- `git commit -- <paths>`, `git commit -p` -- to
 * point the hook at a TEMPORARY index holding only what is being committed.
 *
 * bin/agentbridge-precommit.mjs passes no env of its own, so the blanket strip
 * removed the variable git had just handed it. Measured by audit: the lane
 * collision guard saw an EMPTY staged list and exited 0, waving through a commit
 * that the same hook had blocked one commit earlier. That file's own header says
 * "Unreadable git is 'cannot run', not 'nothing staged'. The difference matters:
 * the second would wave every commit through." I created the second reading by
 * another route, in a commit whose subject was about closing a hole.
 *
 * So the rule is the PROPERTY, and the property is narrower than the prefix:
 * strip what changes WHICH REPOSITORY OR CONFIG git operates on. Leave what is
 * per-operation protocol -- the index for this commit, the identity a commit is
 * made under, the editor. GIT_INDEX_FILE is the counterexample that proves the
 * prefix rule wrong, and it was in the tree the whole time.
 *
 * The prefixed families are matched as prefixes because git numbers them
 * (GIT_CONFIG_KEY_0, GIT_CONFIG_VALUE_0, ...) and a numbered list cannot be
 * enumerated.
 */
const REDIRECTS_REPOSITORY = new Set([
  'GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_PREFIX', 'GIT_NAMESPACE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_COUNT',
]);
const REDIRECTS_PREFIXES = ['GIT_CONFIG_KEY_', 'GIT_CONFIG_VALUE_'];

/**
 * THE VARIABLES THAT DECIDE *WHICH REPOSITORY* GIT TALKS TO. (local 637cdb9)
 *
 * GIT_DIR takes precedence over discovery from `cwd`, so an inherited one makes a
 * command answer for a different repository than the one whose path was passed in.
 * MEASURED at 637cdb9 against two real repositories: candidateTree's
 * resolveBaseline(genuineRepo,'HEAD') returned the OTHER repo's HEAD, and both
 * repoIdentity and candidateId moved. repoIdentity is the value a verifier
 * compares IN ORDER TO REFUSE a replayed approval, so the control that exists to
 * detect a swapped repository could be made to certify one.
 *
 * REFUSED FROM EVERY SOURCE, INCLUDING AN EXPLICIT CALLER env, and that is the
 * correction that matters. Stripping only the ambient environment and then
 * layering the caller's on top does NOT work here: src/candidateTree.mjs builds
 * its env as `{ ...process.env, ...env }`, so the ambient GIT_DIR arrives inside
 * the caller's own object and is layered straight back over the strip. That
 * version was built and measured and it left candidateTree poisonable.
 *
 * No caller in this repository sets these deliberately, so refusing them outright
 * costs nothing and removes the question of telling a deliberate one from a
 * spread one -- which cannot be done, because they are the same bytes.
 *
 * Every member is also in REDIRECTS_REPOSITORY above, so the ambient strip covers
 * it; this list is the SUBSET additionally refused from an explicit caller.
 */
export const REPOSITORY_SELECTION_VARS = Object.freeze([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_NAMESPACE',
]);

/*
 * NAMES ARE MATCHED CASE-INSENSITIVELY, ON EVERY PLATFORM. (local 637cdb9)
 *
 * This was `REPOSITORY_SELECTION_VARS.includes(k)`: exact and case-sensitive. On
 * win32 Object.keys(process.env) keeps whatever casing a key was created with, and
 * Git for Windows reads its environment CASE-INSENSITIVELY -- so GIT_DIR was
 * stripped while git_dir, Git_Dir and git_work_tree reached git and were honoured.
 * Measured by C against the T-063b tree: runGit, a spread env, runGitAsync and
 * resolveBaseline all answered for the swapped repository, and repoIdentity,
 * candidateTree and candidateId moved.
 *
 * toUpperCase rather than toLocaleUpperCase, so the answer cannot depend on the
 * machine's locale. It may fold a few exotic characters onto ASCII (dotless i,
 * long s) and so strip a name that merely resembles one of these; that errs
 * towards stripping, which is the safe direction.
 */
const SELECTION_NAMES = new Set(REPOSITORY_SELECTION_VARS.map((k) => k.toUpperCase()));
const selectsRepository = (k) => SELECTION_NAMES.has(String(k ?? '').toUpperCase());

export function redirectsRepository(key) {
  const k = String(key ?? '').toUpperCase();
  if (REDIRECTS_REPOSITORY.has(k) || SELECTION_NAMES.has(k)) return true;
  return REDIRECTS_PREFIXES.some((p) => k.startsWith(p));
}

/**
 * The NAMED variables stripped from the AMBIENT environment but honoured from an
 * explicit caller: the ambient set minus the selection set. GENERATED from the
 * two lists above rather than kept by hand. The numbered GIT_CONFIG_KEY_n /
 * GIT_CONFIG_VALUE_n families behave the same way and cannot be listed.
 *
 * On 637cdb9 this list was ['GIT_INDEX_FILE']. Since the merge GIT_INDEX_FILE is
 * not stripped at all (the trunk's measured precommit failure), so it is not here.
 */
export const AMBIENT_ONLY_VARS = Object.freeze(
  [...REDIRECTS_REPOSITORY].filter((k) => !SELECTION_NAMES.has(k)),
);

/** The ambient environment with every redirection variable removed. Exported so
 * the suite can assert the set directly rather than infer it (rule 10). */
export function environmentWithoutGitRedirection(base = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(base)) {
    if (redirectsRepository(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * The environment a git child actually gets.
 *
 * Ambient first with the redirection stripped, then the caller's values -- EXCEPT
 * the repository-selection ones, which are refused wherever they came from.
 *
 * THE FULL AMBIENT ENVIRONMENT IS KEPT OTHERWISE, deliberately: node's
 * execFileSync REPLACES the environment when `env` is given, so handing git only
 * a caller's overrides can leave it with no PATH. That is the outage this repair
 * must not cause, and it is asserted rather than assumed.
 *
 * A caller that genuinely wants GIT_INDEX_FILE still gets it (candidateTree's
 * private index); and since the merge an AMBIENT GIT_INDEX_FILE -- the temporary
 * index git hands a pre-commit hook -- arrives too.
 */
function hardenedEnv(callerEnv) {
  const out = environmentWithoutGitRedirection();
  for (const [k, v] of Object.entries(callerEnv ?? {})) {
    if (selectsRepository(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Run git with the hardening applied. Throws on failure like execFileSync does;
 * a caller that wants a sentinel must write one deliberately, because a failure
 * that produces a usable value is a failure that produces an approval.
 */
export function runGit(args, options = {}) {
  const { env: callerEnv, ...rest } = options;
  return execFileSync('git', [...SAFE_GIT_CONFIG, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    ...rest,
    /* After ...rest so no other key can reintroduce the ambient environment. */
    env: hardenedEnv(callerEnv),
  });
}

/**
 * The asynchronous twin. Same flags, same reasoning.
 *
 * It exists because one caller was already callback-based, and the alternative
 * was letting that one site keep spreading the list by hand -- which is how the
 * list came to exist in two places to begin with.
 *
 * THE ASYNC TWIN ONCE STRIPPED NOTHING AT ALL, which made it the way around the
 * synchronous one. Used by bin/agentbridge-precommit.mjs.
 */
export function runGitAsync(args, options, callback) {
  const { env: callerEnv, ...rest } = options ?? {};
  return execFile('git', [...SAFE_GIT_CONFIG, ...args], { ...rest, env: hardenedEnv(callerEnv) }, callback);
}
