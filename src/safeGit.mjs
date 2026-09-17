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
export function runGit(args, options = {}) {
  return execFileSync('git', [...SAFE_GIT_CONFIG, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    ...options,
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
  return execFile('git', [...SAFE_GIT_CONFIG, ...args], options, callback);
}
