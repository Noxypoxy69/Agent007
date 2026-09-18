import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceManager, isInside, resolvePath, isAbsolutePath } from '../src/workspaceManager.mjs';

/*
 * A real backslash, BUILT rather than typed, and `w` spells a Windows path from
 * a posix one. Both exist because a literal backslash does not survive every
 * way this file gets edited -- a heredoc silently collapses it, which turns a
 * test about backslashes into a test about nothing that passes.
 */
const B = String.fromCharCode(92);
const w = (posix) => posix.split('/').join(B);

test('resolvePath collapses . and ..', () => {
  assert.equal(resolvePath('/w/a/../b'), '/w/b');
  assert.equal(resolvePath('/w//a/./b/'), '/w/a/b');
  assert.equal(resolvePath('/w/a/../..'), '/');
});

test('CONTAINMENT IS NOT A PREFIX TEST', () => {
  // the sibling that starts with the same characters
  assert.equal(isInside('/work/ab', '/work/ab-evil'), false);
  assert.equal(isInside('/work/ab', '/work/ab/t1'), true);
  // a path is not inside itself -- destroying the root is the accident
  assert.equal(isInside('/work/ab', '/work/ab'), false);
  // traversal back out
  assert.equal(isInside('/work/ab', '/work/ab/../../etc'), false);
});

/*
 * A WINDOWS ABSOLUTE PATH IS ABSOLUTE, AND FOR A DAY THIS MODULE SAID IT WAS NOT.
 *
 * "absolute" was `startsWith('/')`, which is false for every real Windows path.
 * So createWorkspaceManager could not be CONSTRUCTED on Windows at all, and the
 * three unattended-loop tests that build a real worktree failed there while
 * passing everywhere else. The bug class is a platform assumption that is
 * invisible on the author's machine and total on the operator's -- and the
 * operator's machine was the only one still running agents.
 *
 * These are the cases that would have caught it. The containment guarantees are
 * asserted AGAIN in Windows spelling rather than trusted to carry over, because
 * the whole failure was a rule that held on one platform and not the other.
 */
test('A WINDOWS DRIVE PATH IS ABSOLUTE', () => {
  assert.equal(isAbsolutePath(w('C:/work')), true);
  assert.equal(isAbsolutePath('C:/work'), true, 'forward slashes are valid on Windows too');
  assert.equal(isAbsolutePath('/work'), true, 'posix unchanged');
  assert.equal(isAbsolutePath('work/ws'), false, 'relative is still relative');
  assert.equal(isAbsolutePath(''), false);
  assert.equal(isAbsolutePath(undefined), false, 'a non-string is not a path');
});

test('THE REGRESSION: the manager CONSTRUCTS with a Windows root', () => {
  /*
   * This is the assertion that actually fails against the bug, and the first
   * version of this file did not have it. Testing isAbsolutePath directly left
   * the gate GREEN when the constructor was mutated back to startsWith('/') --
   * a test that passes while proving nothing about the failure it was written
   * for. The failure was never "the predicate is wrong", it was "the manager
   * cannot be built on this machine", so that is what gets asserted.
   */
  const stub = {
    git: { addWorktree() {}, removeWorktree() {}, isDirty() {} },
    fs: { exists() {} },
  };
  assert.ok(createWorkspaceManager({ root: w('C:/Users/x/ws'), ...stub }), 'a Windows root was refused');
  assert.ok(createWorkspaceManager({ root: '/work', ...stub }), 'a posix root was refused');
  assert.throws(
    () => createWorkspaceManager({ root: 'relative/ws', ...stub }),
    /absolute/,
    'a RELATIVE root must still be refused -- the fix must not accept everything',
  );
});

test('resolvePath handles drive letters and backslashes, and normalises to one spelling', () => {
  assert.equal(resolvePath(w('C:/work/a/../b')), 'C:/work/b');
  assert.equal(resolvePath('C:/work//a/./b/'), 'C:/work/a/b');
  // the drive survives a traversal that would otherwise walk off the top
  assert.equal(resolvePath(w('C:/work/a/../..')), 'C:/');
});

test('CONTAINMENT IS NOT A PREFIX TEST -- IN WINDOWS SPELLING TOO', () => {
  assert.equal(isInside(w('C:/work/ab'), w('C:/work/ab-evil')), false);
  assert.equal(isInside(w('C:/work/ab'), w('C:/work/ab/t1')), true);
  assert.equal(isInside(w('C:/work/ab'), w('C:/work/ab')), false);
  assert.equal(isInside(w('C:/work/ab'), w('C:/work/ab/../../Windows')), false);
  // a different drive is not "inside" anything, however the strings compare
  assert.equal(isInside(w('C:/work'), w('D:/work/x')), false);
  // mixed spellings are the same place, which is what mkdtemp vs resolved paths hit
  assert.equal(isInside('C:/work/ab', w('C:/work/ab/t1')), true);
});

function fakeWorld() {
  const files = new Map();
  const dirs = new Set(['/work']);
  const log = [];
  return {
    log,
    files,
    dirs,
    fs: {
      exists: async (p) => dirs.has(p) || files.has(p),
      mkdirp: async (p) => {
        dirs.add(p);
      },
      rename: async (from, to) => {
        log.push(`rename ${from} ${to}`);
        dirs.delete(from);
        dirs.add(to);
        for (const [k, v] of [...files]) {
          if (k.startsWith(from + '/')) {
            files.delete(k);
            files.set(to + k.slice(from.length), v);
          }
        }
      },
      writeFile: async (p, body) => {
        files.set(p, body);
      },
      rm: async (p) => {
        log.push(`rm ${p}`);
        dirs.delete(p);
      },
    },
    git: {
      dirty: new Set(),
      addWorktree: async ({ path }) => {
        log.push(`addWorktree ${path}`);
        dirs.add(path);
      },
      removeWorktree: async ({ path }) => log.push(`removeWorktree ${path}`),
      isDirty: async function (path) {
        return this.dirty.has(path);
      },
    },
  };
}

function manager(world, extra = {}) {
  let n = 0;
  return createWorkspaceManager({
    root: '/work',
    fs: world.fs,
    git: world.git,
    now: () => 1000,
    randomId: () => `id${(n += 1)}`,
    ...extra,
  });
}

test('create makes a detached worktree at an explicit sha', async () => {
  const world = fakeWorld();
  const ws = await manager(world).create({ taskId: 't-1', baseSha: 'abc1234' });
  assert.equal(ws.path, '/work/t-1-a0-id1');
  assert.ok(world.log.includes('addWorktree /work/t-1-a0-id1'));
});

test('A BRANCH NAME IS NOT A BASE', async () => {
  const world = fakeWorld();
  await assert.rejects(
    manager(world).create({ taskId: 't-1', baseSha: 'master' }),
    /base commit sha, not a branch name/,
  );
});

test('a task id that would escape the root is sanitised', async () => {
  const world = fakeWorld();
  const ws = await manager(world).create({ taskId: '../../etc/passwd', baseSha: 'abc1234' });
  assert.equal(isInside('/work', ws.path), true);
  assert.equal(ws.path.includes('..'), false);
});

test('create refuses to reuse an existing path', async () => {
  const world = fakeWorld();
  world.dirs.add('/work/t-1-a0-id1');
  await assert.rejects(
    manager(world).create({ taskId: 't-1', baseSha: 'abc1234' }),
    /refusing to reuse/,
  );
});

test('DESTROY REFUSES ANYTHING OUTSIDE THE ROOT', async () => {
  const world = fakeWorld();
  const m = manager(world);
  await assert.rejects(m.destroy({ path: '/etc' }), /outside/);
  await assert.rejects(m.destroy({ path: '/work-evil/x' }), /outside/);
  await assert.rejects(m.destroy({ path: '/work' }), /outside/);
  assert.equal(
    world.log.some((line) => line.startsWith('rm')),
    false,
    'nothing was removed',
  );
});

test('NEVER DESTROY EVIDENCE: a dirty workspace is refused', async () => {
  const world = fakeWorld();
  const m = manager(world);
  const ws = await m.create({ taskId: 't-1', baseSha: 'abc1234' });
  world.git.dirty.add(ws.path);
  await assert.rejects(m.destroy(ws), /refusing to destroy dirty workspace/);
  assert.equal(world.dirs.has(ws.path), true);
});

test('force destroys a dirty workspace when the caller says so', async () => {
  const world = fakeWorld();
  const m = manager(world);
  const ws = await m.create({ taskId: 't-1', baseSha: 'abc1234' });
  world.git.dirty.add(ws.path);
  assert.deepEqual(await m.destroy(ws, { force: true }), { destroyed: true, reason: null });
  assert.equal(world.dirs.has(ws.path), false);
});

test('destroy is idempotent', async () => {
  const world = fakeWorld();
  const m = manager(world);
  const ws = await m.create({ taskId: 't-1', baseSha: 'abc1234' });
  assert.deepEqual(await m.destroy(ws), { destroyed: true, reason: null });
  assert.deepEqual(await m.destroy(ws), { destroyed: false, reason: 'alreadyGone' });
});

test('quarantine moves and preserves, and records why', async () => {
  const world = fakeWorld();
  const m = manager(world);
  const ws = await m.create({ taskId: 't-1', baseSha: 'abc1234' });
  world.files.set(`${ws.path}/evidence.txt`, 'the failure');
  const target = await m.quarantine(ws, 'three identical attempts');

  assert.equal(world.dirs.has(ws.path), false, 'moved out of the way');
  assert.equal(world.dirs.has(target), true);
  assert.equal(world.files.get(`${target}/evidence.txt`), 'the failure', 'nothing was lost');
  assert.match(world.files.get(`${target}/.quarantine-reason`), /three identical attempts/);
  assert.equal(
    world.log.some((line) => line.startsWith('rm')),
    false,
    'quarantine never deletes',
  );
});

test('an unexplained quarantine is refused', async () => {
  const world = fakeWorld();
  const m = manager(world);
  const ws = await m.create({ taskId: 't-1', baseSha: 'abc1234' });
  await assert.rejects(m.quarantine(ws, '   '), /needs a reason/);
});

test('quarantine also refuses a path outside the root', async () => {
  const world = fakeWorld();
  await assert.rejects(manager(world).quarantine({ path: '/etc', taskId: 'x' }, 'why'), /outside/);
});
