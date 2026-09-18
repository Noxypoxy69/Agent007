import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAFE_GIT_CONFIG, runGit, runGitAsync, redirectsRepository } from '../src/safeGit.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/*
 * THE REASON THE FLAGS EXIST, PROVEN BOTH WAYS.
 *
 * `.git/config` is executable configuration. `core.fsmonitor` names a command
 * git runs during ordinary read-only operations, so a plain `git status`
 * executes it. This is not theory: it was demonstrated in a scratch repository
 * before this module was written, and the assertion below is that demonstration.
 *
 * It matters because `.git/` is not in PROTECTED_PATHS and is never tracked, so
 * the file is invisible to `git status`, to protectedDrift and to the guard's
 * path rules -- and the Stop gate shells out to git to decide whether a baseline
 * may be minted.
 */
function repoWithHostileConfig() {
  const root = mkdtempSync(path.join(tmpdir(), 'safegit-'));
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: root, encoding: 'utf8', windowsHide: true });
  git('init', '-q', '-b', 'main', '.');
  git('commit', '-q', '--allow-empty', '-m', 'x');

  const marker = path.join(root, 'EXECUTED');
  const hook = path.join(root, 'hook.sh');
  writeFileSync(hook, `#!/bin/sh\ntouch "${marker.split(path.sep).join('/')}"\nexit 1\n`);
  try { chmodSync(hook, 0o755); } catch { /* not meaningful on Windows */ }
  git('config', 'core.fsmonitor', hook.split(path.sep).join('/'));
  return { root, marker };
}

test('UNHARDENED git executes the repository own config — this is the bug', () => {
  const { root, marker } = repoWithHostileConfig();
  try {
    try {
      execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', windowsHide: true });
    } catch { /* the hook exits 1 on purpose; the point is whether it RAN */ }

    // A control test: if this never fired, the negative below proves nothing.
    assert.equal(existsSync(marker), true,
      'the control failed: git did not run the fsmonitor command, so the hardening test below is vacuous');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runGit REFUSES to execute it — the same repository, the same command', () => {
  const { root, marker } = repoWithHostileConfig();
  try {
    try {
      runGit(['status', '--porcelain'], { cwd: root });
    } catch { /* ignore any git failure; the assertion is about execution */ }
    assert.equal(existsSync(marker), false, 'the hardened invocation must not run the repository command');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/*
 * AND NOBODY GETS TO BE THE EIGHTH CALL SITE.
 *
 * The flags previously existed twice, byte-identical, in verifier.mjs and
 * candidateTree.mjs, while SEVEN other invocations had none -- including the two
 * in guardSession.mjs that the Stop gate depends on. Consolidating them fixes
 * today; this test is what stops it recurring, because the next person adding a
 * git call will be told by a failing test rather than by a reviewer who happened
 * to look.
 */
function sourceFiles() {
  const out = [];
  const visit = (dir) => {
    for (const e of readdirSync(dir).sort()) {
      if (e === 'node_modules' || e === '.git') continue;
      const p = path.join(dir, e);
      if (statSync(p).isDirectory()) visit(p);
      else if (/\.(mjs|js)$/.test(e)) out.push(p);
    }
  };
  for (const d of ['src', 'bin', 'scripts']) {
    const full = path.join(REPO, d);
    if (existsSync(full)) visit(full);
  }
  return out;
}

test('EVERY git invocation under src, bin and scripts goes through safeGit', () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    const rel = path.relative(REPO, file).split(path.sep).join('/');
    if (rel === 'src/safeGit.mjs') continue; // the one place allowed to spawn git directly

    const text = execFileSync(process.execPath, ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(file)},'utf8'))`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    // Strip block and line comments so a comment mentioning the pattern is not a finding.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    for (const m of code.matchAll(/(execFileSync|spawnSync|execFile|spawn)\(\s*['"]git['"]/g)) {
      offenders.push(`${rel}: ${m[1]}('git', ...)`);
    }
  }
  assert.deepEqual(offenders, [],
    `these invoke git directly instead of importing runGit from src/safeGit.mjs:\n  ${offenders.join('\n  ')}`);
});

test('the hardening list itself is frozen and names all three surfaces', () => {
  assert.equal(Object.isFrozen(SAFE_GIT_CONFIG), true);
  const joined = SAFE_GIT_CONFIG.join(' ');
  for (const surface of ['core.hooksPath', 'core.fsmonitor', 'protocol.ext.allow']) {
    assert.ok(joined.includes(surface), `${surface} is not refused`);
  }
});

/*
 * WHICH GIT_ VARIABLES ARE STRIPPED, AND THE ONE THAT MUST NOT BE.
 *
 * The strip started as /^GIT_/i and that was too wide by exactly one variable
 * that matters. Git sets GIT_INDEX_FILE AS PROTOCOL when it invokes a hook for a
 * partial commit -- `git commit -- <paths>`, `git commit -p` -- pointing the
 * hook at a TEMPORARY index holding only what is being committed.
 *
 * bin/agentbridge-precommit.mjs passes no env of its own, so the blanket strip
 * removed the variable git had just handed it. Measured by audit: the lane
 * collision guard saw an EMPTY staged list and exited 0, waving through a commit
 * it had blocked one commit earlier. A control turned fail-open by a commit
 * whose subject was about closing a hole.
 */
test('the strip removes what redirects the REPOSITORY and keeps per-operation protocol', () => {
  for (const key of [
    'GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_PREFIX', 'GIT_NAMESPACE',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
    'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_17',
  ]) {
    assert.equal(redirectsRepository(key), true, `${key} changes which repository or config git uses`);
  }

  /*
   * THE COUNTEREXAMPLE THAT PROVED THE PREFIX RULE WRONG. These are
   * per-operation protocol -- which index this commit uses, whose name it is
   * made under -- not which repository git is looking at.
   */
  for (const key of [
    'GIT_INDEX_FILE', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE',
    'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_EDITOR', 'GIT_ASKPASS',
  ]) {
    assert.equal(redirectsRepository(key), false, `${key} is protocol and must survive`);
  }
});

test('a hook still reads the TEMPORARY INDEX git handed it, and still cannot be redirected', async (t) => {
  /*
   * The end-to-end shape of the regression, through runGitAsync, which is what
   * the pre-commit hook actually calls.
   */
  const dir = mkdtempSync(path.join(tmpdir(), 'safegit-index-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q');
  g('config', 'user.email', 't@example.invalid');
  g('config', 'user.name', 'T');
  writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  g('add', '-A');
  g('commit', '-qm', 'init');

  // Exactly what git builds for `git commit -- a.txt`: a temporary index in
  // which ONLY a.txt is staged, while both files differ in the worktree.
  const tmpIndex = path.join(dir, 'next-index.lock');
  writeFileSync(path.join(dir, 'a.txt'), 'a2\n');
  writeFileSync(path.join(dir, 'b.txt'), 'b2\n');
  const withIndex = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  execFileSync('git', ['read-tree', 'HEAD'], { cwd: dir, env: withIndex, stdio: 'ignore' });
  execFileSync('git', ['add', 'a.txt'], { cwd: dir, env: withIndex, stdio: 'ignore' });

  const prevIndex = process.env.GIT_INDEX_FILE;
  const prevDir = process.env.GIT_DIR;
  process.env.GIT_INDEX_FILE = tmpIndex;
  process.env.GIT_DIR = path.join(dir, 'NOT-A-REPO', '.git');   // must not take effect
  try {
    const staged = await new Promise((resolve) => {
      runGitAsync(['diff', '--cached', '--name-only'], { cwd: dir, encoding: 'utf8' }, (err, out) => {
        resolve(err ? `ERROR: ${err.message}` : String(out).trim().split('\n').filter(Boolean));
      });
    });
    assert.deepEqual(staged, ['a.txt'],
      'the hook must see the temporary index git handed it, not an empty one');
  } finally {
    if (prevIndex === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = prevIndex;
    if (prevDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prevDir;
  }
});
