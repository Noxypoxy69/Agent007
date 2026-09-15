import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermeticEnv } from './helpers/hermeticEnv.mjs';

/**
 * THE REFUSAL CONTRACT.
 *
 * evaluateReleaseRisk() is unit-tested and mutation-proven, but a rule engine
 * that cannot stop anything is not a guard. The distinction matters because a
 * hook that prints "RELEASE RISK" in red and then exits 0 is indistinguishable
 * from a working one in every log anyone will ever read -- the push simply
 * succeeds, and the warning scrolls away.
 *
 * So this file asserts the thing a pre-push hook actually consumes: the exit
 * code. Nothing here inspects wording.
 *
 *   0  clean, or warnings only
 *   1  at least one blocking finding
 *   2  cannot run
 *
 * Real git repositories in a temp dir, a real CLI process, a temp
 * AGENTBRIDGE_HOME so the operator's own machine config is never touched or
 * read. Slower than a unit test and worth it: this is the only place the
 * wiring between rules, collector and process exit is exercised end to end.
 */

const CLI = fileURLToPath(new URL('../bin/agentbridge.mjs', import.meta.url));

function run(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], {
      env: hermeticEnv(env), windowsHide: true, timeout: 120000,
    }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 60000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function makeRepo(root, name) {
  const dir = path.join(root, name);
  await git(root, ['init', '-q', name]);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await writeFile(path.join(dir, 'f.txt'), 'one\n');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'first']);
  return dir;
}

test('release-risk CLI: exits 1 on a local-only branch and 0 once it has an upstream', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'ab-rr-'));
  const home = path.join(root, 'home');
  const env = { AGENTBRIDGE_HOME: home };
  t.after(() => rm(root, { recursive: true, force: true }));

  const init = await run(['init', '--label', 'test-machine'], env);
  if (init.code !== 0) return t.skip(`init unavailable here: ${init.stderr.trim().slice(0, 120)}`);

  // A repo with a commit and no remote at all: the Code A shape.
  const solo = await makeRepo(root, 'solo');
  await run(['register', '--agent', 'solo', '--lane', 'release', '--worktree', solo], env);

  const before = await run(['release-risk'], env);
  assert.equal(before.code, 1,
    `a branch with commits and no upstream did not block (exit ${before.code})\n${before.stdout}`);

  // Give it a real upstream and push. Same commits, same tree -- the ONLY
  // change is that the work now exists somewhere other than this disk, which
  // is precisely the condition the guard is about.
  const bare = path.join(root, 'origin.git');
  await git(root, ['init', '-q', '--bare', 'origin.git']);
  await git(solo, ['remote', 'add', 'origin', bare]);
  const head = (await git(solo, ['branch', '--show-current'])).stdout.trim();
  const pushed = await git(solo, ['push', '-q', '-u', 'origin', head]);
  assert.equal(pushed.ok, true, `push into the temp bare repo failed: ${pushed.stderr}`);

  // A temp bare repo IS a local-path remote, and LOCAL_ONLY_REMOTE correctly
  // fires on it -- pushing here moves the work nowhere. So the intermediate
  // state is still blocked, and that is the rule working rather than a defect.
  const local = await run(['release-risk'], env);
  assert.equal(local.code, 1, 'a filesystem-path remote was accepted as off-machine');
  assert.match(local.stdout, /LOCAL_ONLY_REMOTE/);
  assert.equal(local.stdout.includes('NO_UPSTREAM'), false, 'NO_UPSTREAM should be satisfied by the push');
  assert.equal(local.stdout.includes('LOCAL_ONLY_COMMITS'), false, 'commits are no longer unpushed');

  // Now make the remote genuinely off-machine. The commits and tree are
  // untouched; only where the upstream lives changes, which is precisely the
  // fact the guard is about. Never fetched, so an unreachable host is fine.
  await git(solo, ['remote', 'set-url', 'origin', 'https://example.invalid/solo.git']);

  const after = await run(['release-risk'], env);
  assert.equal(after.code, 0,
    `a pushed branch with a network remote was still blocked (exit ${after.code})\n${after.stdout}`);
});

test('release-risk CLI: a dirty tree blocks a release branch', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'ab-rr2-'));
  const home = path.join(root, 'home');
  const env = { AGENTBRIDGE_HOME: home };
  t.after(() => rm(root, { recursive: true, force: true }));

  const init = await run(['init', '--label', 'test-machine'], env);
  if (init.code !== 0) return t.skip(`init unavailable here: ${init.stderr.trim().slice(0, 120)}`);

  const repo = await makeRepo(root, 'rel');
  const bare = path.join(root, 'origin.git');
  await git(root, ['init', '-q', '--bare', 'origin.git']);
  await git(repo, ['remote', 'add', 'origin', bare]);
  await git(repo, ['checkout', '-q', '-b', 'release/x']);
  await git(repo, ['push', '-q', '-u', 'origin', 'release/x']);
  // Point the remote somewhere off-machine after pushing, so this test isolates
  // the dirty-tree rule instead of also tripping LOCAL_ONLY_REMOTE.
  await git(repo, ['remote', 'set-url', 'origin', 'https://example.invalid/rel.git']);
  await run(['register', '--agent', 'rel', '--lane', 'release', '--worktree', repo], env);

  // Clean and pushed: must pass. Establishes the positive before the negative,
  // so a block below cannot be some unrelated pre-existing failure.
  const clean = await run(['release-risk'], env);
  assert.equal(clean.code, 0, `clean pushed release branch blocked: ${clean.stdout}`);

  // Now modify a tracked file without committing. Same HEAD, different bytes
  // on disk -- a build from here is not the commit it claims to be.
  await writeFile(path.join(repo, 'f.txt'), 'two\n');
  const dirty = await run(['release-risk'], env);
  assert.equal(dirty.code, 1, `dirty release tree did not block (exit ${dirty.code})\n${dirty.stdout}`);
});

test('release-risk CLI: refuses to run uninitialised rather than reporting clean', async (t) => {
  // Exit 2, not 0. "I could not run" must never be mistaken for "nothing is
  // wrong" by a hook that only checks for zero.
  const root = await mkdtemp(path.join(tmpdir(), 'ab-rr3-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const r = await run(['release-risk'], { AGENTBRIDGE_HOME: path.join(root, 'empty') });
  assert.equal(r.code, 2, `uninitialised run exited ${r.code}, which a hook would read as success`);
});
