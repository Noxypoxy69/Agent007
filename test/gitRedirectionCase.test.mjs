/**
 * A VARIABLE NAME IS NOT ONE SPELLING ON WINDOWS.
 *
 * THE DEFECT, measured by C against the T-063b tree under both launchers. The
 * strip compared names with an exact, case-sensitive Array.includes. On win32
 * Object.keys(process.env) keeps whatever casing a key was created with, and Git
 * for Windows reads its environment CASE-INSENSITIVELY. So GIT_DIR was stripped
 * while git_dir, Git_Dir and git_work_tree reached git and were honoured:
 * runGit, a spread env, runGitAsync and resolveBaseline all answered for the
 * swapped repository, and repoIdentity, candidateTree and candidateId moved.
 *
 * CLAUDE.md rule 19 -- a list of names fails in both directions -- and the same
 * shape as the guard's exact-match isProtectedRelPath on a case-insensitive
 * filesystem.
 *
 * THE FIXTURES ARE GENERATED FROM THE SHIPPED LISTS (rule 7). Every casing of
 * every name in REPOSITORY_SELECTION_VARS and AMBIENT_ONLY_VARS is exercised, so
 * adding a variable to either list extends this file without anybody remembering
 * to. BEHAVIOUR IS ASSERTED, NOT MEMBERSHIP, for the variables whose effect can
 * be observed directly: which HEAD, which toplevel, which index, and the identity
 * values an approval binds to.
 *
 * PLATFORM NOTE, stated so nobody overreads a green run elsewhere: on POSIX a
 * lower-case git_dir is a DIFFERENT variable that git never reads, so the
 * "variant does not redirect" assertions pass there without testing anything. The
 * red base for this file is win32, which is the platform this project runs on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import path from 'node:path';

const {
  runGit, runGitAsync, environmentWithoutGitRedirection, REPOSITORY_SELECTION_VARS, AMBIENT_ONLY_VARS,
} = await import(new URL('../src/safeGit.mjs', import.meta.url));
const { resolveBaseline, repoIdentity, candidateIdentity, buildCandidateTree } =
  await import(new URL('../src/candidateTree.mjs', import.meta.url));

const WIN = platform() === 'win32';
const WORK = mkdtempSync(path.join(tmpdir(), 'ab-gitcase-'));
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

/* Built before any variable is set, so the fixtures cannot be affected by the poisoning under test. */
const GENUINE = makeRepo('genuine', 'the real repository\n');
const SWAPPED = makeRepo('swapped', 'a DIFFERENT repository entirely\n');

/** Every spelling of a name worth trying: as listed, lower, Title_Case, and alternating. */
function casings(name) {
  const lower = name.toLowerCase();
  const title = lower.replace(/(^|_)([a-z])/g, (_, sep, c) => sep + c.toUpperCase());
  const alt = [...lower].map((c, i) => (i % 2 ? c.toUpperCase() : c)).join('');
  return [...new Set([name, lower, title, alt])];
}

/**
 * Set ONE spelling of a variable in the ambient environment, with every other
 * spelling of it removed first -- on win32 process.env is case-insensitive, so a
 * leftover GIT_DIR would otherwise be what the test measured.
 */
function withAmbient(spelling, value, fn) {
  const same = (k) => k.toUpperCase() === spelling.toUpperCase();
  const saved = {};
  for (const k of Object.keys(process.env)) if (same(k)) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env[spelling] = value;
  const clear = () => { for (const k of Object.keys(process.env)) if (same(k)) delete process.env[k]; };
  try {
    /* RULE 9: the fixture must be the real case. If this platform re-cased the key, the test is not testing it. */
    assert.ok(Object.keys(process.env).includes(spelling),
      `precondition: process.env did not keep the spelling ${spelling}, so this case cannot be constructed here`);
    return fn();
  } finally { clear(); Object.assign(process.env, saved); }
}

const norm = (p) => realpathSync.native(p.trim()).split('\\').join('/').toLowerCase();
const head = (opts = {}) => runGit(['rev-parse', 'HEAD'], { cwd: GENUINE.dir, ...opts }).trim();
const toplevel = (opts = {}) => norm(runGit(['rev-parse', '--show-toplevel'], { cwd: GENUINE.dir, ...opts }));
const indexPath = (opts = {}) => norm(path.resolve(GENUINE.dir,
  runGit(['rev-parse', '--git-path', 'index'], { cwd: GENUINE.dir, ...opts }).trim()));
const spreadEnv = (extra = {}) => ({ ...process.env, ...extra });

const IDENTITY_ARGS = { repoRoot: GENUINE.dir, baselineRef: 'HEAD', candidateWorkspace: GENUINE.dir, policyVersion: 'v1' };
function identityReading() {
  return {
    baseline: resolveBaseline(GENUINE.dir, 'HEAD').commitSha,
    repo: repoIdentity(GENUINE.dir),
    tree: buildCandidateTree(GENUINE.dir),
    candidate: candidateIdentity(IDENTITY_ARGS).candidateId,
  };
}

/* ── preconditions (rule 5: the positive first) ─────────────────────────── */

test('precondition: the shipped lists loaded and contain the variables asserted by behaviour below', () => {
  assert.ok(Array.isArray(REPOSITORY_SELECTION_VARS) && REPOSITORY_SELECTION_VARS.length > 0,
    'REPOSITORY_SELECTION_VARS is not exported, so nothing below is generated from the real list');
  assert.ok(Array.isArray(AMBIENT_ONLY_VARS) && AMBIENT_ONLY_VARS.length > 0, 'AMBIENT_ONLY_VARS is not exported');
  for (const v of ['GIT_DIR', 'GIT_WORK_TREE']) assert.ok(REPOSITORY_SELECTION_VARS.includes(v), `${v} left the list`);
  /*
   * MERGE T-246: GIT_INDEX_FILE is no longer stripped at all, so it is not in the
   * ambient-only list. The trunk measured that stripping it made
   * bin/agentbridge-precommit.mjs see an EMPTY staged list for a partial commit
   * and wave the commit through (test/safeGit.test.mjs, "a hook still reads the
   * TEMPORARY INDEX git handed it"). Controller ruling: the trunk's semantics win.
   */
  assert.ok(!AMBIENT_ONLY_VARS.includes('GIT_INDEX_FILE'), 'GIT_INDEX_FILE is back in the ambient-only (stripped) list');
});

test('precondition: every name yields spellings that differ from it', () => {
  for (const name of [...REPOSITORY_SELECTION_VARS, ...AMBIENT_ONLY_VARS]) {
    const c = casings(name);
    assert.ok(c.length >= 3, `${name} produced only ${c.length} spellings`);
    assert.ok(c.slice(1).every((s) => s !== name && s.toUpperCase() === name.toUpperCase()));
  }
});

test('precondition: the fixtures are different repositories, and a clean reading answers for GENUINE', () => {
  assert.notEqual(GENUINE.head, SWAPPED.head);
  assert.equal(head(), GENUINE.head);
  assert.equal(toplevel(), norm(GENUINE.dir));
  assert.equal(indexPath(), norm(path.join(GENUINE.gitDir, 'index')));
});

/* ── the matcher, over every name and every spelling ────────────────────── */

test('the strip removes EVERY spelling of every listed variable, and nothing else', () => {
  for (const name of [...REPOSITORY_SELECTION_VARS, ...AMBIENT_ONLY_VARS]) {
    for (const spelling of casings(name)) {
      const out = environmentWithoutGitRedirection({ PATH: '/usr/bin', KEEP_ME: 'k', [spelling]: '/x' });
      assert.equal(out[spelling], undefined, `${spelling} survived the strip`);
      assert.equal(out.PATH, '/usr/bin');
      assert.equal(out.KEEP_ME, 'k');
    }
  }
});

/* ── behaviour: GIT_DIR, every spelling, every channel ───────────────────── */

for (const spelling of casings('GIT_DIR')) {
  test(`${spelling}: ambient does not redirect runGit`, () => {
    assert.equal(withAmbient(spelling, SWAPPED.gitDir, () => head()), GENUINE.head,
      `an ambient ${spelling} made runGit answer for the swapped repository`);
  });

  test(`${spelling}: ambient SPREAD into the caller env does not redirect runGit`, () => {
    assert.equal(withAmbient(spelling, SWAPPED.gitDir, () => {
      const env = spreadEnv({ SOME_UNRELATED: '1' });
      assert.ok(Object.keys(env).includes(spelling), `precondition: the spread env lost ${spelling}`);
      return head({ env });
    }), GENUINE.head, `${spelling} arrived inside the caller's own env and was honoured`);
  });

  test(`${spelling}: an EXPLICIT caller value is refused`, () => {
    assert.equal(head({ env: { [spelling]: SWAPPED.gitDir } }), GENUINE.head,
      `an explicit ${spelling} was honoured, which re-opens the hole for every caller that spreads process.env`);
  });

  test(`${spelling}: runGitAsync is not redirected by a spread env`, async () => {
    const out = await withAmbient(spelling, SWAPPED.gitDir, () => new Promise((resolve, reject) => {
      runGitAsync(['rev-parse', 'HEAD'], { cwd: GENUINE.dir, encoding: 'utf8', env: spreadEnv() },
        (err, stdout) => (err ? reject(err) : resolve(stdout)));
    }));
    assert.equal(out.trim(), GENUINE.head, `the async twin honoured ${spelling}`);
  });

  test(`${spelling}: the identity an approval binds to does not move`, () => {
    const clean = identityReading();
    const poisoned = withAmbient(spelling, SWAPPED.gitDir, () => identityReading());
    assert.deepEqual(poisoned, clean, `${spelling} moved resolveBaseline / repoIdentity / candidateTree / candidateId`);
  });
}

/* ── behaviour: GIT_WORK_TREE, at least as dangerous (C's N2) ────────────── */

for (const spelling of casings('GIT_WORK_TREE')) {
  test(`${spelling}: ambient does not move the toplevel`, () => {
    assert.equal(withAmbient(spelling, SWAPPED.dir, () => toplevel()), norm(GENUINE.dir),
      `an ambient ${spelling} made git describe the swapped work tree`);
  });

  test(`${spelling}: spread and explicit caller values are refused`, () => {
    assert.equal(withAmbient(spelling, SWAPPED.dir, () => toplevel({ env: spreadEnv() })), norm(GENUINE.dir),
      `a spread ${spelling} was honoured`);
    assert.equal(toplevel({ env: { [spelling]: SWAPPED.dir } }), norm(GENUINE.dir),
      `an explicit ${spelling} was honoured`);
  });

  test(`${spelling}: candidateTree and candidateId do not move`, () => {
    const clean = identityReading();
    const poisoned = withAmbient(spelling, SWAPPED.dir, () => identityReading());
    assert.deepEqual(poisoned, clean, `${spelling} moved the identity an approval binds to`);
  });
}

/* ── behaviour: GIT_INDEX_FILE, the second class ─────────────────────────── */

const BOGUS_INDEX = path.join(WORK, 'not-the-repo-index');

for (const spelling of casings('GIT_INDEX_FILE')) {
  /*
   * MERGE T-246: an AMBIENT index is now KEPT, not dropped. Git sets
   * GIT_INDEX_FILE as protocol when it runs a pre-commit hook for a partial
   * commit; the trunk measured that dropping it let the lane collision guard see
   * an empty staged list and pass a commit it had blocked one commit earlier
   * (test/safeGit.test.mjs, "a hook still reads the TEMPORARY INDEX git handed
   * it"). Only the canonical spelling on POSIX, where git never reads the others.
   */
  if (WIN || spelling === 'GIT_INDEX_FILE') {
    test(`${spelling}: an AMBIENT index is KEPT (the index git hands a hook)`, () => {
      writeFileSync(BOGUS_INDEX, '');
      assert.equal(withAmbient(spelling, BOGUS_INDEX, () => indexPath()), norm(BOGUS_INDEX),
        `an inherited ${spelling} was dropped, so a pre-commit hook would read the wrong (full) index`);
    });
  }

  /*
   * An EXPLICIT one must still ARRIVE: candidateTree passes it on purpose to keep a
   * verifier's staging out of the repository under test. Folding this list into
   * the selection list would break the verifier, not the security property.
   * Only the canonical spelling on POSIX, where git never reads the others.
   */
  if (WIN || spelling === 'GIT_INDEX_FILE') {
    test(`${spelling}: an EXPLICIT caller index is honoured`, () => {
      writeFileSync(BOGUS_INDEX, '');
      assert.equal(indexPath({ env: { [spelling]: BOGUS_INDEX } }), norm(BOGUS_INDEX),
        `an explicit ${spelling} did not reach git, so the verifier would stage into the repository under test`);
    });
  }
}
