/**
 * FIND AN EXECUTABLE IN THE PARENT, SO THE CHILD DOES NOT HAVE TO.
 *
 * THE PROBLEM THIS SOLVES, and it is the reason Loop B had never launched.
 * `executorLocal` runs its child with an allow-list environment: PATH is an
 * empty string unless the spec named one, because an agent that inherits the
 * daemon's environment inherits its credentials. That control is correct and it
 * is not being relaxed here.
 *
 * But `agentLaunch` returns `file: binary ?? engine`, so a task that names an
 * engine without a configured binary produces a BARE executable name -- and a
 * bare name cannot resolve against an empty PATH. Every such attempt died as
 * `spawn claude ENOENT`, deterministically, and retried twice more for nothing.
 *
 * WHY RESOLVING HERE IS SAFE, stated plainly because this sits next to a
 * credential boundary. The lookup happens in the TRUSTED PARENT, against the
 * daemon's own PATH, and only the resulting ABSOLUTE path is put in the argv.
 * The child's environment is not touched: it still receives an empty PATH and
 * inherits nothing. The rejected alternative -- handing the child a PATH so it
 * could resolve the name itself -- would widen precisely what the allow-list
 * exists to narrow, and would do it for every command the agent later runs
 * rather than just the one being launched.
 *
 * It grants no new reach either. The daemon can already run anything on its own
 * PATH; this only names one of those things explicitly instead of hoping the
 * child finds it.
 *
 * ABSENT IS NULL, NEVER THE INPUT BACK. Returning the unresolved name would let
 * a caller carry on believing it had found something, and hand the executor an
 * argv guaranteed to fail. Null forces the caller to decide what an unfindable
 * engine means, which is a different question from a crash.
 */

import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/**
 * `exists` and `env` are injected so the Windows behaviour can be tested from
 * anywhere. PATHEXT is the half that is easy to miss: `claude` on Windows is
 * normally `claude.cmd`, so probing the bare name alone finds nothing and
 * reports it exactly as an uninstalled engine would.
 */
export function resolveBinary(name, { env = process.env, exists = existsSync } = {}) {
  if (typeof name !== 'string' || name === '') return null;

  // Always try the name as written first; a caller that already said `.cmd`
  // means it. Then the platform's executable suffixes, in the order the
  // platform itself would try them.
  const suffixes = String(env.PATHEXT ?? '')
    .split(delimiter)
    .filter((s) => s !== '');
  const candidates = (base) => [base, ...suffixes.map((s) => base + s)];

  const firstThatExists = (list) => list.find((c) => exists(c)) ?? null;

  /*
   * A name carrying any separator is a PATH, not something to search for.
   * Searching for it would be worse than failing: `./claude` found in
   * /usr/bin is not the file the caller asked for.
   */
  if (isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    return firstThatExists(candidates(name));
  }

  for (const dir of String(env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    const hit = firstThatExists(candidates(join(dir, name)));
    if (hit !== null) return hit;
  }
  return null;
}
