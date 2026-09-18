import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs';
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

/*
 * THIS SCAN NAMED FOUR SPELLINGS AND CALLED IT A PROPERTY.
 *
 * It matched /(execFileSync|spawnSync|execFile|spawn)\(\s*['"]git['"]/ and was
 * green across the whole tree. Two different accidents walked past it:
 *
 *   src/git.mjs      held `const GIT = 'git'` and passed the VARIABLE
 *   bin/agentbridge-attempt.mjs  passed the literal to run(), a WRAPPER
 *
 * Neither was deliberate. Both left a git invocation outside safeGit while a
 * test named "EVERY git invocation goes through safeGit" reported success --
 * rule 17, a control that is never consulted, except worse, because this one
 * answered and the answer was wrong.
 *
 * The property is not "which function was called". It is "this source hands the
 * NAME OF GIT to something that will spawn it". So the scan now matches any
 * call whose first argument is that literal, wrapper or not.
 *
 * WHAT A PATTERN OVER SOURCE STILL CANNOT SEE, said here rather than implied by
 * a confident test name: a variable. Put the name in a const, or compute it, and
 * no regex finds it. That is why the real enforcement is in the CODE --
 * src/exec.mjs throws when asked for git, inspecting the actual argument at
 * runtime, which is what caught bin/agentbridge-attempt.mjs. This scan is the
 * fast signal that fails at lint time instead of in somebody's worktree. It is a
 * second layer, not the boundary, and it is named for what it does.
 */
const GIT_CALL = /\b([A-Za-z_$][A-Za-z0-9_$.]*)\s*\(\s*['"](git(?:\.exe)?)['"]\s*,/gi;

/*
 * SIXTEEN CALL SITES THAT ARE NOT FIXED, LISTED RATHER THAN EXCLUDED.
 *
 * bin/agentbridge.mjs declares a local runner in three function scopes --
 * `const run = promisify(execFile)` -- which shadows the name and never reaches
 * src/exec.mjs. Measured, not assumed: a promisified execFile call to git from
 * this repo returns a branch name with no refusal. So these sixteen are outside
 * BOTH layers: invisible to the lint and invisible to refuseGit. No hooksPath,
 * fsmonitor or GIT_DIR hardening applies to them.
 *
 * They are not fixed here because routing them changes the behaviour of three
 * shipped commands, one of which clones a caller-supplied path. That is an
 * owner decision, and it is recorded as one rather than fixed quietly at the end
 * of a long night.
 *
 * THE COUNT IS ASSERTED EXACT, NOT AS A CEILING. Rule 19: enumeration fails in
 * both directions. A NEW unrouted call site in this file pushes the count above
 * the declared number and fails; a FIXED one pushes it below and fails too, so
 * the entry cannot rot into a permanent exemption nobody rereads.
 *
 * IT IS A COUNT AND NOT A LINE LIST ON PURPOSE. The first version of this
 * quarantine keyed on file:line, and the numbers were stale before it ever ran
 * -- every edit above a call site moves it, so the list would demand updating
 * for reasons that have nothing to do with git. A count is stable under edits
 * and still fails in both directions, which is the property that was wanted.
 */
const KNOWN_UNROUTED = Object.freeze({ 'bin/agentbridge.mjs': 18 });

function gitCallSites() {
  const found = [];
  for (const file of sourceFiles()) {
    const rel = path.relative(REPO, file).split(path.sep).join('/');
    if (rel === 'src/safeGit.mjs') continue; // the one place allowed to spawn git directly

    const raw = readFileSync(file, 'utf8');
    // Blank comments out IN PLACE, so a comment mentioning the pattern is not a
    // finding and every surviving line number still matches the real file.
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/^\s*\/\/.*$/gm, (m) => ' '.repeat(m.length));

    for (const m of code.matchAll(GIT_CALL)) {
      const line = code.slice(0, m.index).split('\n').length;
      found.push({ id: `${rel}:${line}`, rel, line, callee: m[1], spelling: m[2] });
    }
  }
  return found;
}

test('EVERY git invocation under src, bin and scripts goes through safeGit, wrapper or not', () => {
  const sites = gitCallSites();

  /*
   * RULE 5, and it is not decorative here: the previous scan's failure mode was
   * matching NOTHING and reporting success. A scan that silently stops finding
   * call sites is indistinguishable from a clean tree, so assert it still sees
   * the ones we know exist before trusting an empty offender list.
   */
  const declared = Object.values(KNOWN_UNROUTED).reduce((a, b) => a + b, 0);
  assert.ok(sites.length >= declared,
    `the scan found ${sites.length} git call sites, fewer than the ${declared} known to exist -- ` +
    'the pattern has stopped matching, and an empty result means nothing');

  const offenders = sites
    .filter((s) => !(s.rel in KNOWN_UNROUTED))
    .map((s) => `${s.id}: ${s.callee}('${s.spelling}', ...)`);

  assert.deepEqual(offenders, [],
    'these hand the name of git to something that spawns it, instead of importing runGit ' +
    `from src/safeGit.mjs:\n  ${offenders.join('\n  ')}`);
});

test('the unrouted count is exact in both directions', () => {
  /*
   * The other direction. Without this, the quarantine is a place to park a
   * finding forever: route the calls and the stale entry sits there implying
   * debt that no longer exists, which is how an exemption stops being read.
   */
  const actual = {};
  for (const s of gitCallSites()) actual[s.rel] = (actual[s.rel] ?? 0) + 1;

  const wrong = [];
  for (const [rel, expected] of Object.entries(KNOWN_UNROUTED)) {
    const got = actual[rel] ?? 0;
    if (got === expected) continue;
    wrong.push(got < expected
      ? `${rel}: ${got} unrouted git calls, quarantine still declares ${expected} -- if these were routed through safeGit, lower or remove the entry`
      : `${rel}: ${got} unrouted git calls, quarantine declares ${expected} -- ${got - expected} new one(s) went in outside safeGit`);
  }
  assert.deepEqual(wrong, [], wrong.join('\n  '));
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

/*
 * THE SCAN THAT SAID "EVERY git INVOCATION GOES THROUGH safeGit" WAS WRONG.
 *
 * It matches /(execFileSync|spawnSync|execFile|spawn)\(\s*['"]git['"]/ -- a
 * LITERAL. src/git.mjs held `const GIT = 'git'` and passed the variable, so the
 * scan never saw it. The test was green, with that name, while the file called
 * git.mjs was the one invocation that did not go through safeGit.
 *
 * Measured consequences, through the shipped CLI: a repository config saying
 * `fsmonitor = sh -c 'touch MARKER; exit 1'` EXECUTED, and GIT_DIR redirected
 * `agentbridge status --json` so it reported another repository's HEAD under
 * this worktree's name.
 *
 * A pattern over source can always be spelled around. So the property is
 * enforced IN THE CODE -- src/exec.mjs throws if asked for git -- and these
 * assert that refusal exists and covers the spellings, rather than asserting
 * that a particular string does not appear.
 */
test('exec.mjs REFUSES git, whatever it is called, so the lint cannot be spelled around', async () => {
  const { run } = await import('../src/exec.mjs');

  for (const spelling of ['git', 'git.exe', 'GIT', '/usr/bin/git', 'C:\\Program Files\\Git\\bin\\git.exe']) {
    await assert.rejects(
      () => run(spelling, ['--version'], { cwd: REPO }),
      /safeGit/,
      `${spelling} must be refused by exec.mjs and pointed at safeGit`,
    );
  }

  /*
   * RULE 5: the positive. exec.mjs must still run everything else, or this
   * "fix" is just a broken module and the assertions above mean nothing.
   */
  const ok = await run(process.execPath, ['-e', 'process.stdout.write("fine")'], { cwd: REPO });
  assert.equal(ok.ok, true, 'exec.mjs must still run ordinary commands');
  assert.match(ok.stdout, /fine/);
});

test('src/git.mjs goes through safeGit, not exec.mjs', async () => {
  // The structural half: the module that was exempt must not reach for the
  // unhardened runner at all.
  const src = readFileSync(path.join(REPO, 'src', 'git.mjs'), 'utf8');
  assert.ok(!/from '\.\/exec\.mjs'/.test(src),
    'src/git.mjs must not import the unhardened runner');
  assert.match(src, /from '\.\/safeGit\.mjs'/,
    'src/git.mjs must invoke git through safeGit');
});
