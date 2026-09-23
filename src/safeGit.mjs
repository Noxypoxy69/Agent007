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

/**
 * Run git with the hardening applied. Throws on failure like execFileSync does;
 * a caller that wants a sentinel must write one deliberately, because a failure
 * that produces a usable value is a failure that produces an approval.
 */
/**
 * THE VARIABLES THAT DECIDE *WHICH REPOSITORY* GIT TALKS TO.
 *
 * GIT_DIR takes precedence over discovery from `cwd`, so an inherited one makes a
 * command answer for a different repository than the one whose path was passed in.
 * MEASURED at this ref against two real repositories: candidateTree's
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
 * NOT EVERY GIT_* VARIABLE. These select the repository; GIT_SSH_COMMAND or
 * GIT_CONFIG_GLOBAL change how git behaves, and stripping those is a larger change
 * with different consequences. CLAUDE.md rule 8: this does not claim to bound
 * every way an environment can influence git, only the set that decides which
 * repository is being described.
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

/**
 * Chooses which INDEX, not which repository. A verifier passes it deliberately to
 * keep its staging out of the repository under test, so an EXPLICIT one is
 * honoured while an INHERITED one is dropped.
 */
export const AMBIENT_ONLY_VARS = Object.freeze(['GIT_INDEX_FILE']);

/*
 * NAMES ARE MATCHED CASE-INSENSITIVELY, ON EVERY PLATFORM.
 *
 * This was `REPOSITORY_SELECTION_VARS.includes(k)`: exact and case-sensitive. On
 * win32 Object.keys(process.env) keeps whatever casing a key was created with, and
 * Git for Windows reads its environment CASE-INSENSITIVELY -- so GIT_DIR was
 * stripped while git_dir, Git_Dir and git_work_tree reached git and were honoured.
 * Measured by C against the T-063b tree: runGit, a spread env, runGitAsync and
 * resolveBaseline all answered for the swapped repository, and repoIdentity,
 * candidateTree and candidateId moved. One spelling was closed and every other
 * spelling of the same variable was open, on the platform this project runs on.
 *
 * Folding case on POSIX strips a lower-case git_dir that git would never have
 * read. That costs nothing -- no caller sets one -- and a single rule for every
 * platform is one fewer branch for the next reader to get wrong.
 *
 * toUpperCase rather than toLocaleUpperCase, so the answer cannot depend on the
 * machine's locale. It may fold a few exotic characters onto ASCII (dotless i,
 * long s) and so strip a name that merely resembles one of these; that errs
 * towards stripping, which is the safe direction.
 *
 * The two classes stay SEPARATE sets. GIT_INDEX_FILE is honoured from an explicit
 * caller and must not be folded into the selection set, or the verifier's private
 * index stops arriving and it stages into the repository under test.
 */
const SELECTION_NAMES = new Set(REPOSITORY_SELECTION_VARS.map((k) => k.toUpperCase()));
const AMBIENT_ONLY_NAMES = new Set(AMBIENT_ONLY_VARS.map((k) => k.toUpperCase()));
const selectsRepository = (k) => SELECTION_NAMES.has(String(k).toUpperCase());
const ambientOnly = (k) => AMBIENT_ONLY_NAMES.has(String(k).toUpperCase());

/** The ambient environment with every redirection variable removed. Exported so
 * the suite can assert the set directly rather than infer it (rule 10). */
export function environmentWithoutGitRedirection(base = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(base)) {
    if (selectsRepository(k) || ambientOnly(k)) continue;
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
 */
function hardenedEnv(callerEnv) {
  const out = environmentWithoutGitRedirection();
  for (const [k, v] of Object.entries(callerEnv ?? {})) {
    if (selectsRepository(k)) continue;
    out[k] = v;
  }
  return out;
}

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
 */
export function runGitAsync(args, options, callback) {
  const { env: callerEnv, ...rest } = options ?? {};
  return execFile('git', [...SAFE_GIT_CONFIG, ...args], { ...rest, env: hardenedEnv(callerEnv) }, callback);
}
