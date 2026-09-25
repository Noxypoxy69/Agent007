/**
 * THE AMBIENT ENVIRONMENT MUST NOT DECIDE WHICH REPOSITORY GIT IS TALKING ABOUT.
 *
 * THE DEFECT, MEASURED at this ref against two real repositories. GIT_DIR takes
 * precedence over discovery from `cwd`, and src/candidateTree.mjs's git() builds
 * its child environment as `{ ...process.env, ...env }`, so an inherited GIT_DIR
 * reached git and:
 *
 *     resolveBaseline(genuineRepo, 'HEAD')  returned the OTHER repository's HEAD
 *     repoIdentity(genuineRepo)             moved
 *     candidateIdentity(...).candidateId    moved
 *
 * repoIdentity exists so that "an approval issued for one repo cannot be replayed
 * against another that happens to share a baseline". It is the value a verifier
 * compares IN ORDER TO REFUSE A SWAP, so a control that can be made to certify the
 * swap it exists to detect is worse than no control.
 *
 * WHY EVERY CALLER-ENV ASSERTION BELOW SPREADS process.env, which is the part that
 * took two attempts to get right. A test that passes a CLEAN env
 * (`{ SOMETHING: '1' }`) PASSES AGAINST THE UNPATCHED CODE -- because node's
 * execFileSync REPLACES the environment when one is given, so passing any env at
 * all accidentally excludes GIT_DIR. Measured: two such assertions were green at
 * base. The dangerous caller is the one that SPREADS the ambient environment into
 * its own, which is exactly what candidateTree does, so that is the shape the
 * assertions use.
 *
 * AND WHY REPOSITORY-SELECTION VARIABLES ARE REFUSED FROM AN EXPLICIT CALLER TOO.
 * A layered merge -- strip the ambient, then apply the caller's -- does not work:
 * the ambient GIT_DIR arrives INSIDE the caller's object and is layered back on
 * top. Deliberate and spread are the same bytes and cannot be told apart, so the
 * selection variables are refused wherever they come from. GIT_INDEX_FILE is in a
 * second class: it chooses which INDEX, not which repository, a verifier passes it
 * on purpose, and an explicit one is therefore honoured.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { runGit, runGitAsync, environmentWithoutGitRedirection } =
  await import(new URL('../src/safeGit.mjs', import.meta.url));
const { resolveBaseline, repoIdentity, candidateIdentity, buildCandidateTree } =
  await import(new URL('../src/candidateTree.mjs', import.meta.url));

const WORK = mkdtempSync(path.join(tmpdir(), 'ab-gitredir-'));
process.on('exit', () => { try { rmSync(WORK, { recursive: true, force: true }); } catch { /* best effort */ } });

function makeRepo(name, content) {
  const dir = path.join(WORK, name);
  mkdirSync(dir, { recursive: true });
  const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  g(['init', '-q', '-b', 'main']);
  writeFileSync(path.join(dir, 'marker.txt'), content);
  g(['add', 'marker.txt']);
  g(['-c', `user.email=${name}@local`, '-c', `user.name=${name}`, 'commit', '-q', '-m', `for ${name}`]);
  return { dir, gitDir: path.join(dir, '.git'), head: g(['rev-parse', 'HEAD']).trim() };
}

/* Built before any GIT_DIR is set, so the fixtures cannot be affected by the
 * poisoning under test. */
const GENUINE = makeRepo('genuine', 'the real repository\n');
const SWAPPED = makeRepo('swapped', 'a DIFFERENT repository entirely\n');

function withGitDir(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'GIT_DIR');
  const prev = process.env.GIT_DIR;
  if (value === null) delete process.env.GIT_DIR; else process.env.GIT_DIR = value;
  try { return fn(); } finally {
    if (had) process.env.GIT_DIR = prev; else delete process.env.GIT_DIR;
  }
}

const head = (opts) => runGit(['rev-parse', 'HEAD'], { cwd: GENUINE.dir, ...opts }).trim();
/** candidateTree's own shape: the ambient environment spread into the caller's. */
const spreadEnv = (extra = {}) => ({ ...process.env, ...extra });

/* ── preconditions ───────────────────────────────────────────────────────── */

test('precondition: the two fixtures are genuinely different repositories', () => {
  assert.notEqual(GENUINE.head, SWAPPED.head,
    'both fixtures resolved to the same commit, so no swap could be detected either way');
  assert.ok(existsSync(SWAPPED.gitDir));
});

test('control: with no ambient GIT_DIR, runGit answers for the repo at cwd', () => {
  assert.equal(withGitDir(null, () => head()), GENUINE.head);
});

/* ── the property ────────────────────────────────────────────────────────── */

test('THE PROPERTY: an inherited GIT_DIR does not redirect runGit', () => {
  assert.equal(withGitDir(SWAPPED.gitDir, () => head()), GENUINE.head,
    'runGit answered for the repository named by GIT_DIR rather than the one at cwd');
});

test('THE PROPERTY: it is stripped even when the caller SPREADS the ambient env', () => {
  /*
   * The case a layered merge misses, and the case candidateTree actually
   * exercises. Asserting it with a clean caller env instead would pass against the
   * unpatched code and prove nothing.
   */
  assert.equal(withGitDir(SWAPPED.gitDir, () => head({ env: spreadEnv({ SOME_UNRELATED: '1' }) })), GENUINE.head,
    'the ambient GIT_DIR arrived inside the caller\'s own env and was layered back over the strip');
});

test('THE PROPERTY: runGitAsync strips it too, including a spread env', async () => {
  const out = await withGitDir(SWAPPED.gitDir, () => new Promise((resolve, reject) => {
    runGitAsync(['rev-parse', 'HEAD'], { cwd: GENUINE.dir, encoding: 'utf8', env: spreadEnv() },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  }));
  assert.equal(out.trim(), GENUINE.head, 'the async twin was left unhardened');
});

test('THE PROPERTY: candidateTree is protected WITHOUT BEING CHANGED', () => {
  /*
   * The reason the repair lives in safeGit. candidateTree's git() still builds
   * `{ ...process.env, ...env }` -- untouched by this patch -- so if these hold,
   * the strip is protecting a caller that is still spreading the ambient
   * environment. A fix at that call site would protect one of eight invocations.
   */
  const args = {
    repoRoot: GENUINE.dir, baselineRef: 'HEAD', candidateWorkspace: GENUINE.dir, policyVersion: 'v1',
  };
  const cleanBaseline = withGitDir(null, () => resolveBaseline(GENUINE.dir, 'HEAD').commitSha);
  const cleanIdentity = withGitDir(null, () => repoIdentity(GENUINE.dir));
  const cleanCandidate = withGitDir(null, () => candidateIdentity(args).candidateId);
  assert.notEqual(cleanBaseline, SWAPPED.head, 'precondition: the clean reading already matched the swapped repo');

  assert.equal(withGitDir(SWAPPED.gitDir, () => resolveBaseline(GENUINE.dir, 'HEAD').commitSha), cleanBaseline,
    'resolveBaseline was redirected to the repository named by GIT_DIR');
  assert.equal(withGitDir(SWAPPED.gitDir, () => repoIdentity(GENUINE.dir)), cleanIdentity,
    'repoIdentity moved, so the value that refuses a swapped repository is steerable from the environment');
  assert.equal(withGitDir(SWAPPED.gitDir, () => candidateIdentity(args).candidateId), cleanCandidate,
    'the identity an approval binds to was changed by an environment variable');
});

test('THE PROPERTY: an EXPLICIT caller GIT_DIR is refused as well', () => {
  /*
   * Not an oversight and not excessive caution. A GIT_DIR that arrived by
   * `{ ...process.env }` and one a caller typed are THE SAME BYTES -- there is no
   * way to honour the second without honouring the first, and honouring the first
   * is the defect. No caller in this repository sets it, so refusing it outright
   * costs nothing.
   */
  assert.equal(withGitDir(null, () => head({ env: { GIT_DIR: SWAPPED.gitDir } })), GENUINE.head,
    'a repository-selection variable was honoured from an explicit caller env, which re-opens the '
    + 'hole for every caller that builds its env by spreading process.env');
});

/* ── the outage half ─────────────────────────────────────────────────────── */

test('git still RUNS when the caller supplies an env', () => {
  /*
   * execFileSync REPLACES the environment when `env` is given, so a repair that
   * hands git only the caller's overrides can leave it with no PATH. Asserted
   * directly rather than inferred from the suite passing.
   */
  assert.match(runGit(['--version'], { env: { SOME_UNRELATED: '1' } }), /git version/,
    'git did not run at all once an env was supplied');
});

test('the caller\'s GIT_INDEX_FILE ARRIVES: the repository\'s own index is untouched', () => {
  /*
   * NOT CRASHING IS NOT THE SAME AS ARRIVING. Without GIT_INDEX_FILE git silently
   * falls back to the repository's own index -- nothing throws, `git add -A` just
   * stages into the repo under test, which is a verifier mutating the thing it is
   * measuring. Measured by consequence: with a private index the repo's own
   * staging area still knows nothing about a file created after the last commit.
   */
  const stray = path.join(GENUINE.dir, 'not-committed.txt');
  writeFileSync(stray, 'created after the commit\n');
  try {
    assert.equal(execFileSync('git', ['diff', '--cached', '--name-only'],
      { cwd: GENUINE.dir, encoding: 'utf8' }).trim(), '',
    'precondition: the fixture repo already had staged changes');

    withGitDir(null, () => buildCandidateTree(GENUINE.dir));

    assert.equal(execFileSync('git', ['diff', '--cached', '--name-only'],
      { cwd: GENUINE.dir, encoding: 'utf8' }).trim(), '',
    'files were staged into the repository\'s OWN index, so GIT_INDEX_FILE did not reach git');
  } finally { rmSync(stray, { force: true }); }
});

/* ── the matcher itself (rule 10) ────────────────────────────────────────── */

test('the strip removes the redirection set and leaves everything else alone', () => {
  const base = {
    PATH: '/usr/bin', SYSTEMROOT: 'C:\\Windows', SOME_UNRELATED: 'keep',
    GIT_DIR: '/x/.git', GIT_WORK_TREE: '/x', GIT_INDEX_FILE: '/x/index',
    GIT_OBJECT_DIRECTORY: '/x/objects', GIT_ALTERNATE_OBJECT_DIRECTORIES: '/y',
    GIT_COMMON_DIR: '/x/common', GIT_CEILING_DIRECTORIES: '/', GIT_NAMESPACE: 'ns',
    GIT_DISCOVERY_ACROSS_FILESYSTEM: '1', GIT_SSH_COMMAND: 'ssh -v',
  };
  const out = environmentWithoutGitRedirection(base);
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_CEILING_DIRECTORIES',
    'GIT_NAMESPACE', 'GIT_DISCOVERY_ACROSS_FILESYSTEM']) {
    assert.equal(out[k], undefined, `${k} survived the strip`);
  }
  /*
   * MERGE T-246: GIT_INDEX_FILE is KEPT. It chooses which index for THIS
   * operation, and git sets it for a pre-commit hook on a partial commit; the
   * trunk measured that stripping it made the lane guard see an empty staged list
   * and pass the commit (test/safeGit.test.mjs, "a hook still reads the TEMPORARY
   * INDEX git handed it"). Controller ruling: the trunk's semantics win.
   */
  assert.equal(out.GIT_INDEX_FILE, '/x/index',
    'GIT_INDEX_FILE was stripped, which blinds a pre-commit hook to the temporary index git handed it');
  assert.equal(out.PATH, '/usr/bin', 'PATH was stripped, which would stop git running');
  assert.equal(out.SYSTEMROOT, 'C:\\Windows');
  assert.equal(out.SOME_UNRELATED, 'keep');
  assert.equal(out.GIT_SSH_COMMAND, 'ssh -v',
    'GIT_SSH_COMMAND changes HOW git talks, not WHICH repository; stripping it is a larger change '
    + 'and is deliberately not attempted here');
});
