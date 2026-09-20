/**
 * ONE WORKTREE PER AGENT — the decision half, so it can be tested.
 *
 * ═══ WHAT THIS FIXES, MEASURED ═══
 *
 * `agent.cmd` starts every interactive session with `cd /d "%~dp0"`, so all of
 * them share ONE worktree. On 2026-09-20 that cost, in one hour:
 *
 *   - two agents editing src/shellAllowlist.mjs at the same time, with no
 *     claim, no lock and no message between them;
 *   - a verification that PASSED (2797 tests, 0 fail, 537s) against a tree
 *     that had ceased to exist before the run finished, because the other
 *     session committed twice underneath it;
 *   - four consecutive Stop gates blown, each burning ~400s of suite, because
 *     the identity key moved every time somebody saved a file.
 *
 * The verification machinery was not wrong. `treeDigest` hashes HEAD plus the
 * dirty files, so it correctly reported that the tree it measured was not the
 * tree that now exists. Nobody can verify a tree somebody else is rewriting.
 *
 * The autonomous path already knew this: `createWorkspaceManager` gives every
 * ATTEMPT its own worktree, and `bin/agentbridge-attempt.mjs` uses it. The
 * isolation was built, wired for the workers, and never applied to the
 * interactive sessions that do most of the work.
 *
 * ═══ WHY THE DECISION IS HERE AND NOT IN THE .cmd ═══
 *
 * Rule 10. A launcher cannot be tested by the suite -- running `agent.cmd`
 * starts a Claude session -- so anything it decides is untested by
 * construction, and this file is security-adjacent: the agent id becomes a
 * DIRECTORY NAME. `agent.cmd` already carries a blind-audit scar about
 * exactly that (an id containing shell metacharacters executed), and the fix
 * for it was quoting, which does nothing about `..`.
 *
 * So the .cmd asks this, and this is pure and tested.
 */

/**
 * WHAT AN AGENT ID MAY CONTAIN, given it becomes a path component.
 *
 * An allow-list, not a deny-list. The ids in use are `code-a`, `code-b`,
 * `code-c`, `code-d`, `fixer`, `main` -- letters, digits, dash, underscore,
 * dot. Everything else is refused rather than escaped, because escaping a
 * path is the thing this repository has a header about getting wrong.
 *
 * `.` is permitted for ordinary ids but `..` is not, and neither is a name
 * that is only dots: those traverse.
 */
const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateAgentId(id) {
  const s = typeof id === 'string' ? id.trim() : '';
  if (s === '') return { ok: false, why: 'an agent id is required; it names both the roster row and the worktree' };
  if (!ID_SHAPE.test(s)) {
    return {
      ok: false,
      why: `"${s}" is not a usable agent id. It becomes a DIRECTORY NAME, so it must start with a letter or `
        + 'digit and contain only letters, digits, dot, dash or underscore (max 64)',
    };
  }
  /*
   * THERE IS NO SEPARATE `..` CHECK, AND THAT IS DELIBERATE.
   *
   * I wrote one. My own test then proved it could never run: `..` fails the
   * shape above, because an id must START with a letter or digit. A guard
   * that cannot fire is not defence in depth, it is a line that makes the
   * next reader believe traversal is handled somewhere other than where it
   * actually is.
   *
   * Traversal is impossible here for two structural reasons, which is the
   * argument worth leaving behind: the shape admits no `/` or `\`, so no id
   * can be more than one path component; and it forbids a leading dot, so no
   * id can BE `..`. `a..b` is permitted and is simply a directory called
   * `wt-a..b`, which traverses nothing.
   */
  return { ok: true, id: s };
}

/**
 * Where an agent's worktree and branch live.
 *
 * A SIBLING OF THE REPOSITORY, NOT A CHILD. A worktree inside the repository
 * would be walked by every tool that scans the tree -- the dead-export
 * ratchet, the import-closure gates, `git status` -- and each agent would see
 * every other agent's copy of the source. It also puts the worktree inside
 * the path `destroy` containment checks are written against.
 *
 * THE BRANCH IS NAMESPACED so `git branch` stays readable once there are five
 * of them, and so a branch nobody meant to push is visibly an agent branch.
 */
export function agentWorkspacePlan(id, { repoRoot, parentDir } = {}) {
  const v = validateAgentId(id);
  if (!v.ok) return { ok: false, why: v.why };
  if (typeof repoRoot !== 'string' || repoRoot.trim() === '') {
    return { ok: false, why: 'repoRoot is required: the worktree is placed relative to the repository, never to cwd' };
  }

  const root = repoRoot.replace(/[\\/]+$/, '');
  const parent = typeof parentDir === 'string' && parentDir.trim() !== ''
    ? parentDir.replace(/[\\/]+$/, '')
    : root.slice(0, Math.max(0, root.lastIndexOf('/') === -1 ? root.lastIndexOf('\\') : root.lastIndexOf('/')));

  if (parent === '') {
    return { ok: false, why: `cannot place a worktree beside ${repoRoot}: it has no parent directory` };
  }

  const dir = `${parent}/wt-${v.id}`;

  /*
   * A WORKTREE MUST NOT LAND ON THE REPOSITORY ITSELF. With a crafted id and
   * an unlucky parent this would resolve onto the shared tree, and the
   * "isolation" would silently be the thing it was preventing.
   */
  const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (norm(dir) === norm(root)) {
    return { ok: false, why: `the computed worktree ${dir} IS the repository; that is the collision, not the fix` };
  }

  return { ok: true, id: v.id, dir, branch: `agent/${v.id}` };
}

/**
 * IF THE WORKTREE CANNOT BE MADE, DO NOT START.
 *
 * The tempting fallback is to carry on in the shared tree with a warning.
 * That is the shape this repository keeps shipping: a control that reports a
 * problem and then does the unsafe thing anyway, and whose absence is
 * invisible because everything still runs. `register-session` does exactly
 * that today -- it prints "local only" and exits 0, and an agent has been
 * invisible to the bridge for a day at a time as a result.
 *
 * So the launcher refuses. A session that cannot be isolated is a session
 * that will silently corrupt somebody else's verification.
 */
export function startupRefusal(plan) {
  return plan.ok ? null : `[agentbridge:no-workspace] ${plan.why}. REFUSING TO START in the shared worktree: `
    + 'two sessions in one tree is what makes every verification unreliable, and a warning nobody reads is '
    + 'not a control.';
}
