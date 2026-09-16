/*
 * WORKSPACE MANAGER. Fresh worktree, quarantine, destroy.
 *
 * Every worker gets its own worktree off a named base commit, does its work
 * there, and the workspace is then either destroyed or set aside. The whole
 * value is that a bad attempt leaves nothing behind -- and the whole risk is
 * that "leaves nothing behind" is implemented by deleting a directory computed
 * from a string somebody else supplied.
 *
 * SO THE CONTAINMENT CHECK IS THE POINT OF THIS FILE. `destroy` will not touch
 * a path that is not under the root it was given, and the check is done on
 * resolved paths with a separator appended, because `/work/agentbridge-evil`
 * starts with `/work/agentbridge` and a naive prefix test says that is inside.
 *
 * NEVER DESTROY EVIDENCE. A workspace with uncommitted changes is refused
 * unless quarantined first: the times it matters are the times something went
 * wrong, which are exactly the times somebody will want to look. Quarantine
 * moves and records a reason; it never deletes.
 *
 * All git and fs effects are injected. A fake filesystem in the tests is how
 * "destroy refused to leave the root" is a test rather than a near-miss.
 */

const SEP = '/';

/*
 * THE ROOT OF A PATH, WHICH IS THE ONLY PART THAT IS PLATFORM-SPECIFIC.
 *
 * Returns the absolute prefix ('/' or 'C:/') and the rest, backslashes already
 * folded to SEP. An empty prefix means the path is relative.
 *
 * This exists because "absolute" was `startsWith('/')`, which is FALSE for
 * every real Windows path. `C:\work` is absolute and was rejected as though it
 * were not, so createWorkspaceManager could not be constructed at all on
 * Windows -- which is why three unattended-loop tests failed on the only
 * machine still running agents, while passing everywhere else.
 *
 * WHY NOT node:path. The header's reason still holds: no import means the tests
 * run this exact code against posix-looking fake paths on any platform, and the
 * containment check is the point of this file. `node:path.isAbsolute` answers
 * differently depending on the host, so the fake `/work/ab-evil` case would
 * stop being checkable on Windows. The drive letter is handled here instead and
 * the posix behaviour is unchanged.
 */
function splitRoot(path) {
  const s = String(path).replace(/\\/g, SEP);
  const drive = /^([A-Za-z]:)\//.exec(s);
  if (drive) return { prefix: `${drive[1]}${SEP}`, rest: s.slice(drive[0].length) };
  if (s.startsWith(SEP)) return { prefix: SEP, rest: s.slice(1) };
  return { prefix: '', rest: s };
}

/** Absolute on EITHER platform: a leading separator, or a drive root. */
export function isAbsolutePath(path) {
  return typeof path === 'string' && splitRoot(path).prefix !== '';
}

/*
 * Resolve without node:path so the module has no import at all and the tests
 * can run the same code against posix-looking fake paths on any platform.
 * Handles `.`, `..`, repeated separators, backslashes and Windows drive
 * letters. Output always uses SEP, which node's fs accepts on Windows too, so a
 * resolved path stays a usable filesystem path rather than becoming only a key.
 */
export function resolvePath(path) {
  const { prefix, rest } = splitRoot(path);
  const absolute = prefix !== '';
  const out = [];
  for (const part of rest.split(SEP)) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(part);
  }
  return prefix + out.join(SEP);
}

/*
 * Is `child` inside `parent`? A path is NOT inside itself -- destroying the
 * root because the workspace path collapsed to it is the accident this returns
 * false for.
 */
export function isInside(parent, child) {
  const p = resolvePath(parent);
  const c = resolvePath(child);
  if (c === p) return false;
  return c.startsWith(p.endsWith(SEP) ? p : p + SEP);
}

function fail(message) {
  throw new Error(`workspace: ${message}`);
}

export function createWorkspaceManager({ root, git, fs, now, randomId } = {}) {
  if (!isAbsolutePath(root)) fail('root must be an absolute path');
  if (!git || typeof git.addWorktree !== 'function') fail('git.addWorktree required');
  if (!fs || typeof fs.exists !== 'function') fail('fs.exists required');
  const clock = now ?? (() => Date.now());
  const nextId = randomId ?? (() => Math.random().toString(36).slice(2, 10));
  const resolvedRoot = resolvePath(root);

  async function create({ taskId, baseSha, attempt = 0 }) {
    if (typeof taskId !== 'string' || taskId === '') fail('create needs a taskId');
    if (typeof baseSha !== 'string' || !/^[0-9a-f]{7,64}$/.test(baseSha)) {
      /*
       * A worktree is created at an explicit commit, never at a branch name.
       * A branch moves -- if two attempts at "master" run an hour apart they
       * get different trees, and the base_sha in the task contract becomes a
       * claim about something that already changed underneath it.
       */
      fail('create needs a base commit sha, not a branch name');
    }
    /*
     * The task id reaches the filesystem, so it is sanitised rather than
     * trusted. Separators go first, then any run of dots: `../../etc` survives
     * the character filter as `..-..-etc`, which happens to be harmless because
     * nothing resolves it -- and depending on that is depending on a resolver
     * detail two files away. A slug with no `..` in it needs no such argument.
     */
    const slug = taskId
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .replace(/\.{2,}/g, '-')
      .slice(0, 60);
    const path = `${resolvedRoot}/${slug}-a${attempt}-${nextId()}`;
    if (await fs.exists(path)) fail(`refusing to reuse an existing path ${path}`);
    await git.addWorktree({ path, baseSha, detach: true });
    return Object.freeze({ taskId, attempt, path, baseSha, createdAt: clock() });
  }

  /*
   * Move a workspace aside with a reason. Returns the quarantine path. This is
   * the only disposal that is safe to call when something went wrong, and it is
   * why `destroy` is allowed to be strict.
   */
  async function quarantine(workspace, reason) {
    if (!workspace || typeof workspace.path !== 'string') fail('quarantine needs a workspace');
    if (typeof reason !== 'string' || reason.trim() === '') {
      // An unexplained quarantine directory is indistinguishable from litter,
      // and litter gets deleted by whoever is next short of disk.
      fail('quarantine needs a reason');
    }
    if (!isInside(resolvedRoot, workspace.path)) {
      fail(`refusing to quarantine ${workspace.path}: outside ${resolvedRoot}`);
    }
    const name = resolvePath(workspace.path).split(SEP).pop();
    const target = `${resolvedRoot}/.quarantine/${clock()}-${name}`;
    await fs.mkdirp(`${resolvedRoot}/.quarantine`);
    await fs.rename(workspace.path, target);
    await fs.writeFile(
      `${target}/.quarantine-reason`,
      `${new Date(clock()).toISOString()} ${workspace.taskId} attempt ${workspace.attempt}\n${reason}\n`,
    );
    return target;
  }

  /*
   * Destroy. Idempotent: destroying something already gone reports
   * `alreadyGone` rather than throwing, because a retry after a partial failure
   * is the normal case and a throw there turns a cleanup into an incident.
   */
  async function destroy(workspace, { force = false } = {}) {
    if (!workspace || typeof workspace.path !== 'string') fail('destroy needs a workspace');
    if (!isInside(resolvedRoot, workspace.path)) {
      fail(`refusing to destroy ${workspace.path}: outside ${resolvedRoot}`);
    }
    if (!(await fs.exists(workspace.path)))
      return Object.freeze({ destroyed: false, reason: 'alreadyGone' });

    if (!force && typeof git.isDirty === 'function' && (await git.isDirty(workspace.path))) {
      fail(`refusing to destroy dirty workspace ${workspace.path}: quarantine it or pass force`);
    }
    if (typeof git.removeWorktree === 'function') {
      await git.removeWorktree({ path: workspace.path, force });
    }
    await fs.rm(workspace.path);
    return Object.freeze({ destroyed: true, reason: null });
  }

  return Object.freeze({ root: resolvedRoot, create, quarantine, destroy });
}
