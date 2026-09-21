/**
 * AM I THE SCRIPT THE USER RAN, OR AM I BEING IMPORTED?
 *
 * ═══ WHY THIS IS A MODULE AND NOT FIVE ONE-LINERS ═══
 *
 * It was five one-liners, in five spellings, and four of them silently
 * turn their script into a no-op under a path spelling that is the NORM
 * in this repository's own audit tooling.
 *
 *   scripts/check-edge-deploy.mjs      new URL(`file://${argv[1]}`).href
 *   bridge/server.mjs                  pathToFileURL(argv[1]).href
 *   scripts/verify-hook-integrity.mjs  path.resolve both sides
 *   scripts/bridge-session-poll.mjs    path.resolve(argv[1]) === SELF
 *   scripts/check-deployed-instructions.mjs   endsWith(basename)
 *
 * ═══ THE FAILURE, MEASURED ═══
 *
 * `npm run audit:workspace` clones into `os.tmpdir()`. On a Windows
 * profile whose directory name contains a space or exceeds eight
 * characters, that path arrives as an NTFS 8.3 SHORT NAME: the profile
 * segment becomes a six-character stem plus a `~1` suffix. (The literal
 * is deliberately not written here -- it is an identity segment, and a
 * leak-regression gate refuses it. That gate caught this very file.)
 * A child process is spawned with that
 * path in `argv[1]`, but node resolves the entry point through realpath
 * before setting `import.meta.url`, so the two sides are the SAME FILE
 * spelled two ways. Every comparison above except the last then says
 * "I am being imported", and the script exits 0 having done nothing.
 *
 * What that looked like from the outside: twelve deploy-gate tests
 * failing in every audit clone and passing in the shared tree, with
 * messages reading "a deploy that reverts a line was allowed", "the gate
 * passed having compared no files at all" and "missing arguments exit 2".
 * A DEPLOY GATE THAT SILENTLY PASSES EVERYTHING. Two auditors recorded
 * those twelve as the pre-existing baseline; one stated in writing that
 * there was no environment finding.
 *
 * It is not only a test artefact. Any invocation whose `argv[1]` spelling
 * differs from node's resolved one -- a short name, a symlinked checkout,
 * a junction, a differently-cased drive letter -- gets a gate that prints
 * nothing and exits 0. That is the worst failure a gate has.
 *
 * ═══ ASK WHATEVER OWNS THE MAPPING ═══
 *
 * CLAUDE.md rule 21's answer to 8.3, and the same instinct that put
 * `realpathSync.native` in the path resolver: do not compare spellings,
 * resolve both sides through the thing that owns the truth and compare
 * the results. `realpathSync.native` collapses 8.3, symlinks and
 * junctions in one call.
 *
 * ON CASE: Windows paths are case-insensitive, so the comparison folds
 * case on win32 only. Folding everywhere would make two genuinely
 * different files compare equal on Linux, which is the over-block
 * direction and worse than the bug.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Resolve a path to its canonical spelling, or fall back honestly.
 *
 * `realpathSync.native` throws if the file is gone. A missing file cannot
 * be the running module, so the fallback only has to be good enough to
 * say "no" -- but it must not throw, because a main-module check that
 * throws takes the whole script down at load.
 */
function canonical(p, realpath) {
  const abs = path.resolve(p);
  try {
    return realpath(abs);
  } catch {
    return abs;
  }
}

/**
 * Was this module run as the entry point?
 *
 * @param argv1      process.argv[1] as the runtime gave it
 * @param moduleUrl  the caller's import.meta.url
 * @returns boolean -- false when either side is unusable, never a throw
 */
export function invokedDirectly(argv1, moduleUrl, { realpath = realpathSync.native } = {}) {
  if (typeof argv1 !== 'string' || argv1.trim() === '') return false;
  if (typeof moduleUrl !== 'string' || !moduleUrl.startsWith('file:')) return false;

  let self;
  try {
    self = fileURLToPath(moduleUrl);
  } catch {
    return false;
  }

  const a = canonical(argv1, realpath);
  const b = canonical(self, realpath);
  if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}
