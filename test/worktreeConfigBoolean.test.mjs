/**
 * GIT PARSES ITS OWN BOOLEANS. WE DO NOT.
 *
 * Seventh-lap blind audit D3. `hooksPathOverride` decided whether to query
 * the `--worktree` config scope with `String(git config --get ...) === 'true'`
 * -- and `--get` returns THE RAW STRING FROM THE FILE, while git parses
 * `extensions.worktreeConfig` with `git_config_bool`.
 *
 * So `1`, `yes`, `on`, `TRUE` and a VALUELESS key all enable per-worktree
 * config in git's eyes while that check concluded "off" and skipped the
 * scope. `--worktree` OVERRIDES local, global and system, so a hooks
 * redirect hidden there was invisible to the attestation -- and the
 * attacker picks the spelling.
 *
 * A regression on a guard surface introduced by my own fix, and the same
 * class as the locale bet it replaced: a string equality standing in for a
 * semantic question.
 *
 * ═══ WHY THIS DRIVES REAL GIT ═══
 *
 * The claim is "git and this function agree". Asserting it against a
 * fixture would be me writing down what I believe git's grammar is, which
 * is the belief that produced the defect. So each form is written into a
 * scratch repository's own config and the real binary is asked. The scratch
 * repo is a temp directory; the operator's config is never touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { worktreeConfigEnabled } from '../scripts/verify-hook-integrity.mjs';

let repo;

const git = (args, opts = {}) => execFileSync('git', args, {
  cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts,
});

test.beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'wtcfg-'));
  git(['init', '--quiet']);
});
test.afterEach(() => { try { rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ } });

/**
 * Every spelling git accepts as TRUE, and every one it accepts as FALSE.
 *
 * Generated as a table rather than asserted one by one, so adding a form
 * extends the coverage without anybody remembering this file (rule 7).
 */
const TRUTHY = ['true', '1', 'yes', 'on', 'TRUE', 'Yes', 'On'];
const FALSY = ['false', '0', 'no', 'off', 'FALSE', 'Off'];

test('EVERY FORM GIT CALLS TRUE, THIS FUNCTION CALLS TRUE', () => {
  for (const form of TRUTHY) {
    git(['config', 'extensions.worktreeConfig', form]);

    /*
     * ASSERT THE PRECONDITION (rule 6): confirm git itself reads this form
     * as true before asserting that we agree. Otherwise a git that stopped
     * accepting `on` would make this test pass for the wrong reason.
     */
    const asGit = String(git(['config', '--bool', '--get', 'extensions.worktreeConfig'])).trim();
    assert.equal(asGit, 'true', `git does not read ${JSON.stringify(form)} as true on this build`);

    assert.equal(worktreeConfigEnabled({ cwd: repo }), true,
      `git enables per-worktree config for ${JSON.stringify(form)} and the guard does not, `
      + 'so a hooks redirect in --worktree scope would be invisible');
  }
});

test('EVERY FORM GIT CALLS FALSE, THIS FUNCTION CALLS FALSE', () => {
  for (const form of FALSY) {
    git(['config', 'extensions.worktreeConfig', form]);
    const asGit = String(git(['config', '--bool', '--get', 'extensions.worktreeConfig'])).trim();
    assert.equal(asGit, 'false', `git does not read ${JSON.stringify(form)} as false on this build`);

    assert.equal(worktreeConfigEnabled({ cwd: repo }), false,
      `${JSON.stringify(form)} was treated as enabling per-worktree config`);
  }
});

test('A VALUELESS KEY IS TRUE TO GIT, AND MUST BE TRUE HERE', async () => {
  /*
   * The form the old string check could never have caught: `--get` prints
   * an EMPTY LINE for a valueless boolean, so `=== 'true'` was false while
   * git treated the extension as enabled.
   */
  git(['config', '--bool', 'extensions.worktreeConfig', 'true']);
  /* Rewrite the file so the key carries no value at all. */
  const cfg = path.join(repo, '.git', 'config');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/worktreeConfig = true/, 'worktreeConfig'));

  const asGit = String(git(['config', '--bool', '--get', 'extensions.worktreeConfig'])).trim();
  assert.equal(asGit, 'true', 'git does not read a valueless boolean as true on this build');

  assert.equal(worktreeConfigEnabled({ cwd: repo }), true,
    'a valueless extensions.worktreeConfig enabled per-worktree config in git and '
    + 'was read as disabled here -- the exact form a raw --get cannot see');
});

test('UNSET IS FALSE, and so is an unreadable repository', () => {
  assert.equal(worktreeConfigEnabled({ cwd: repo }), false, 'an unset key read as enabled');

  /*
   * A directory that is not a repository: git exits non-zero. The contract
   * is "not in play", which is safe -- the remaining scopes are queried
   * regardless, and git documents --worktree as an alias for --local when
   * the extension is off, so nothing is lost by skipping it.
   */
  const notARepo = mkdtempSync(path.join(tmpdir(), 'notrepo-'));
  try {
    assert.equal(worktreeConfigEnabled({ cwd: notARepo }), false);
  } finally {
    try { rmSync(notARepo, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test('THE GUARD IS NOT VACUOUSLY FALSE -- it can return true (rule 5)', () => {
  /*
   * Every assertion above except the truthy loop is a `false`. A function
   * that returned false unconditionally would satisfy most of this file, so
   * the distinction is asserted directly.
   */
  assert.equal(worktreeConfigEnabled({ cwd: repo }), false);
  git(['config', 'extensions.worktreeConfig', 'true']);
  assert.equal(worktreeConfigEnabled({ cwd: repo }), true);
});
