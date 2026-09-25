/**
 * A TEST MUST NOT DIRTY THE REPOSITORY IT IS RUNNING IN, AND NEITHER MUST THE
 * INSTRUMENT THAT CHECKS THAT.
 *
 * THE DEFECT THIS FILE GUARDS. test/checkFirstCli.test.mjs wrote
 * `<repoRoot>/zz-overlap-probe.tmp` -- a FIXED NAME in the REPO ROOT -- and removed
 * it in a finally. For that window the working tree was dirty for every process
 * that looked, and `node --test` runs files in parallel. MEASURED at caa8797 on a
 * CLEAN tree: running it alongside test/deployCheckTree.test.mjs makes that file's
 * "19:37" assertion fail, because its two internal runs disagree about whether the
 * tree was dirty. Either file alone fails 0/6.
 *
 * THE FIRST VERSION OF THIS FILE COMMITTED TWO SMALLER FORMS OF THE SAME SIN, both
 * found by code-c and both repaired here:
 *
 *   1. ITS CONTROL WROTE INTO THE REPO ROOT. `zz-sampler-control-*` is a unique
 *      name, and the unique name does not help: deployCheckTree disagreed about
 *      DIRTINESS, not about a name. It only shortened the window -- measured at
 *      25-50 ms, which is at or below the 40 ms polling period used elsewhere, so
 *      it is a writer a sweep of that period could miss. The control now runs in a
 *      THROWAWAY REPOSITORY and proves the sampler there.
 *
 *   2. THE SAMPLER REWROTE .git/index. Plain `git status --porcelain` takes
 *      OPTIONAL INDEX LOCKS and rewrites the index after a stat-only change.
 *      Polling a SHARED checkout every 25 ms during a parallel suite therefore
 *      MUTATES THE THING IT OBSERVES, under other tests, while other seats work in
 *      it. `--no-optional-locks` is the fix and there is an assertion below that
 *      the index is not rewritten.
 *
 * AN INSTRUMENT THAT MUTATES ITS SUBJECT IS THE DEFECT THIS FILE EXISTS TO CATCH,
 * arriving inside the repair for it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, rmSync, mkdtempSync, mkdirSync, utimesSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const PROBE = 'zz-overlap-probe';
const PROBE_TEST = 'an untracked file counts as a path you are touching';

const WORK = mkdtempSync(path.join(tmpdir(), 'ab-sampler-'));
process.on('exit', () => { try { rmSync(WORK, { recursive: true, force: true }); } catch { /* best effort */ } });

/**
 * READ-ONLY BY CONSTRUCTION. `--no-optional-locks` stops git taking the optional
 * index lock and rewriting .git/index, which a plain `status` does after a
 * stat-only change. A sampler polling a shared checkout every 25 ms without it
 * writes to the repository it is measuring.
 *
 * Returns null when git could not answer, NOT ''. An empty string means CLEAN and
 * a failure means UNKNOWN, and collapsing them is how the property below could
 * pass vacuously outside a repository.
 */
function statusIn(dir) {
  try {
    return execFileSync('git', ['--no-optional-locks', 'status', '--porcelain'],
      { cwd: dir, encoding: 'utf8' });
  } catch { return null; }
}

function childEnvWithoutTestRunner() {
  /* `node --test` exports NODE_TEST_CONTEXT; a child that inherits it emits the
   * subtest stream with no summary, so the precondition below could never pass. */
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^NODE_TEST/i.test(k)) delete env[k];
  return env;
}

/** A throwaway repository with one commit. Nothing here touches REPO. */
function sandbox(name) {
  const dir = path.join(WORK, name);
  mkdirSync(dir, { recursive: true });
  const g = (a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  g(['init', '-q', '-b', 'main']);
  writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  g(['add', 'seed.txt']);
  g(['-c', 'user.email=s@l', '-c', 'user.name=s', 'commit', '-q', '-m', 'seed']);
  return dir;
}

/* ── preconditions: the property below is only meaningful inside a repository ── */

test('precondition: this file is running inside a readable git repository', () => {
  /*
   * Without this the property is vacuous: statusIn() returning null outside a
   * repository would mean the probe "never appears" for the wrong reason. Asserted
   * in-test rather than left to a sibling, so the property still means something
   * when run alone under --test-name-pattern.
   */
  assert.doesNotThrow(
    () => execFileSync('git', ['rev-parse', '--git-dir'], { cwd: REPO, stdio: 'pipe' }),
    'the tests are not running inside a git repository, so nothing below can observe dirtiness',
  );
  assert.notEqual(statusIn(REPO), null, 'git could not report status for this repository');
});

/* ── the property ────────────────────────────────────────────────────────── */

test('THE PROPERTY: the overlap probe never appears in the repository working tree', async () => {
  /*
   * THE PRECONDITION LIVES HERE, NOT IN A SIBLING TEST.
   *
   * A sibling is skipped by `--test-name-pattern`, so this property could be run
   * alone, outside a repository, and PASS VACUOUSLY: 1 test, 1 pass, exit 0.
   * MEASURED that way by code-c against the previous version. A property that
   * depends on a precondition it does not itself assert is not self-sufficient,
   * whatever the comment above it claims.
   */
  execFileSync('git', ['rev-parse', '--git-dir'], { cwd: REPO, stdio: 'pipe' });

  const seen = new Set();
  /*
   * VALID AND UNREADABLE ARE COUNTED SEPARATELY, AND THAT IS THE REPAIR.
   *
   * This was one counter incremented BEFORE the null check, so a sample that saw
   * NOTHING still counted as a sample and `samples > 0` was satisfied entirely by
   * samples that observed nothing at all. Returning null rather than '' did not
   * help: the null was coerced to a SKIP instead of to an empty string, which is
   * the same vacuous pass with a different value in it.
   */
  let valid = 0;
  let unreadable = 0;
  const timer = setInterval(() => {
    const s = statusIn(REPO);
    if (s === null) { unreadable += 1; return; }
    valid += 1;
    for (const line of s.split('\n')) {
      const p = line.slice(3).trim();
      if (p.includes(PROBE)) seen.add(p);
    }
  }, 25);

  const child = await new Promise((resolve) => {
    execFile(process.execPath,
      ['--test', '--test-reporter=tap', '--test-name-pattern', PROBE_TEST, 'test/checkFirstCli.test.mjs'],
      { cwd: REPO, env: childEnvWithoutTestRunner(), encoding: 'utf8', timeout: 600_000, maxBuffer: 64e6 },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr: stderr ?? '' }));
  });
  clearInterval(timer);

  /*
   * PRECONDITIONS, NOT GUARDS. The message says "did not PASS" rather than "did not
   * run", because it also fires when the probe test ran and FAILED -- and a message
   * that names the wrong cause is the conclusion-with-the-evidence-stripped shape.
   */
  assert.equal(unreadable, 0,
    `${unreadable} of ${unreadable + valid} samples could not read the repository at all. An `
    + 'unreadable sample observes nothing, so counting it makes the assertion below vacuous.');
  assert.ok(valid > 0,
    'no sample successfully read the repository, so nothing was observed and the assertion '
    + 'below would pass for the wrong reason');
  assert.match(child.stdout, /# pass 1\b/,
    `the probe test did not PASS, so nothing was observed. It may have failed rather than not run. `
    + `stdout tail: ${child.stdout.slice(-400)}`);

  assert.deepEqual([...seen], [],
    'the probe appeared in the repository working tree while the test ran, so every other test '
    + 'in a parallel suite could see a dirty tree caused by this one');
});

/* ── the instrument's own controls, both OUTSIDE the repository ───────────── */

test('control: the sampler detects a file written into a repository', () => {
  /*
   * The negative above is worth nothing unless this sampler can see what it claims
   * is absent. Run in a THROWAWAY repository: the first version of this control
   * wrote into the REPO ROOT, which is the same class of write this candidate
   * exists to remove -- shorter window, same defect.
   */
  const dir = sandbox('control');
  const marker = path.join(dir, 'zz-control-marker.tmp');
  assert.equal(statusIn(dir), '', 'precondition: the throwaway repository was not clean');
  writeFileSync(marker, 'x\n');
  try {
    assert.match(String(statusIn(dir)), /zz-control-marker\.tmp/,
      'the sampler cannot see a file written into a repository, so the property assertion proves nothing');

    /*
     * AND THE CONTROL MUST NOT HAVE WRITTEN INTO *THIS* REPOSITORY.
     *
     * N1 -- the earlier version of this control created its marker in the REPO
     * ROOT -- was proven repaired by an EXTERNAL sampler, mine and code-c's, and
     * was not guarded by anything in the suite. C noted that a variant writing the
     * marker straight into REPO would have passed all four tests. This closes that:
     * whatever the control creates, it must be invisible to the repository under
     * test.
     */
    assert.doesNotMatch(String(statusIn(REPO) ?? ''), /zz-control-marker/,
      'the control wrote its marker into the repository under test, which is the same class of '
      + 'shared-resource write this whole file exists to remove');
  } finally { rmSync(marker, { force: true }); }
});

test('control: the sampler does not REWRITE the index of the repository it observes', () => {
  /*
   * MEASURED, and this is why `--no-optional-locks` is not decoration. A plain
   * `git status --porcelain` takes the optional index lock and rewrites .git/index
   * after a stat-only change. This file polls every 25 ms; against a SHARED
   * checkout during a parallel suite that is an instrument mutating its own
   * subject, under other tests, while other seats are working in it.
   *
   * Constructed as a stat-only change -- same content, newer mtime -- because that
   * is exactly the case that makes git want to refresh the index.
   */
  const dir = sandbox('index');
  const seed = path.join(dir, 'seed.txt');
  const future = new Date(Date.now() + 10_000);
  utimesSync(seed, future, future);

  const indexPath = path.join(dir, '.git', 'index');
  const before = createHash('sha256').update(readFileSync(indexPath)).digest('hex');
  for (let i = 0; i < 5; i += 1) statusIn(dir);
  const after = createHash('sha256').update(readFileSync(indexPath)).digest('hex');

  assert.equal(after, before,
    'sampling rewrote .git/index. An instrument that mutates the repository it observes is the '
    + 'defect this file exists to catch, and against a shared checkout it corrupts other tests '
    + 'rather than merely this one');
});
