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
/*
 * GIT_DIR BEATS -C, SO THE ENVIRONMENT COULD ANSWER FOR A DIFFERENT REPOSITORY.
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
 *
 * So the inherited environment is stripped of everything git-controlling before
 * the call. The test is the PREFIX, not a list of names: enumerating GIT_DIR,
 * GIT_COMMON_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY,
 * GIT_CEILING_DIRECTORIES, GIT_CONFIG_* and the rest is the enumeration mistake
 * this repository keeps losing to, and git adds new ones.
 *
 * AN EXPLICIT env FROM THE CALLER IS LEFT ALONE. src/candidateTree.mjs passes
 * GIT_INDEX_FILE deliberately, to point git at a temporary index it built; that
 * is a caller taking control on purpose, not an ambient value leaking in, and
 * silently dropping it would break the thing it was added for.
 */
/*
 * WHICH VARIABLES REDIRECT THE REPOSITORY. NOT "EVERYTHING NAMED GIT_".
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

export function redirectsRepository(key) {
  const k = String(key ?? '').toUpperCase();
  if (REDIRECTS_REPOSITORY.has(k)) return true;
  return REDIRECTS_PREFIXES.some((p) => k.startsWith(p));
}

function environmentWithoutGitRedirection() {
  const cleaned = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (redirectsRepository(key)) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

/*
 * THE STRIP APPLIES WHETHER OR NOT A CALLER PASSES env.
 *
 * The first version only sanitised when the caller passed NO env, on the
 * reasoning that an explicit env is a caller taking control on purpose. Every
 * caller that passes one spreads process.env into it:
 *
 *   src/candidateTree.mjs:54   runGit(args, { cwd, env: { ...process.env, ...env } })
 *   src/verifier.mjs:52, :61   env: { ...process.env, GIT_AUTHOR_NAME: ... }
 *
 * so the exemption swallowed the rule for exactly those modules. Measured by
 * audit at module level: with GIT_DIR pointed at another repository,
 * resolveBaseline(B) returned A's HEAD, and repoIdentity(B) changed value --
 * and repoIdentity is what the verifier compares to refuse a job whose
 * repository was swapped at the same path.
 *
 * So the BASE is always sanitised and the caller's keys are layered on top.
 * A caller that genuinely wants GIT_INDEX_FILE still gets it, because it named
 * it; what it no longer gets is whatever the environment happened to carry.
 */
export function runGit(args, options = {}) {
  const { env: callerEnv, ...rest } = options;
  return execFileSync('git', [...SAFE_GIT_CONFIG, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    ...rest,
    env: { ...environmentWithoutGitRedirection(), ...(callerEnv ?? {}) },
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
  /*
   * THE ASYNC TWIN STRIPPED NOTHING AT ALL, which made it the way around the
   * synchronous one. Same rule, same reason: git resolves GIT_DIR and
   * GIT_COMMON_DIR before -C, so an inherited variable answers for a different
   * repository. Used by bin/agentbridge-precommit.mjs.
   */
  const { env: callerEnv, ...rest } = options ?? {};
  return execFile('git', [...SAFE_GIT_CONFIG, ...args], {
    ...rest,
    env: { ...environmentWithoutGitRedirection(), ...(callerEnv ?? {}) },
  }, callback);
}
