import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermeticEnv } from './helpers/hermeticEnv.mjs';

/**
 * A DELEGATION MAY NOT NAME A COMMIT THAT DOES NOT EXIST.
 *
 * Written from a real incident, 2026-09-15. A contract was recorded against
 * "e38ebd9d0e7a4cf7cc0e3c46c43e7ac8be9d9b0e" -- an agent knew the short SHA
 * and padded it to forty characters. validateDelegation accepted it because
 * its SHA rule is a SHAPE check, and a fabricated string is the right shape.
 * The contract stored cleanly and pointed nowhere.
 *
 * The rule now: a SHA is machine-verifiable, so the Bridge resolves it and an
 * agent never types one from memory. These tests assert the refusal, because a
 * validator that cannot stop a bad contract is decoration.
 *
 * Real git repos in a temp dir, a real CLI process, a temp AGENTBRIDGE_HOME.
 */

const CLI = fileURLToPath(new URL('../bin/agentbridge.mjs', import.meta.url));

function run(args, env, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], {
      env: hermeticEnv(env), cwd, windowsHide: true, timeout: 120000,
    }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 60000 }, (err, stdout) => {
      resolve({ ok: !err, stdout: String(stdout).trim() });
    });
  });
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'ab-base-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await git(root, ['init', '-q', 'repo']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test']);
  await writeFile(path.join(repo, 'f.txt'), 'one\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'first']);
  const head = (await git(repo, ['rev-parse', 'HEAD'])).stdout;
  const home = path.join(root, 'home');
  return { root, repo, head, env: { AGENTBRIDGE_HOME: home } };
}

const argsFor = (id, extra = []) => [
  'delegate', '--id', id, '--from', 'lead', '--to', 'worker',
  '--task', 'a bounded task', ...extra,
];

async function storedRows(env) {
  try {
    return JSON.parse(await readFile(path.join(env.AGENTBRIDGE_HOME, 'delegations.json'), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

test('delegate: a fabricated 40-char SHA is REFUSED and nothing is stored', async (t) => {
  const { repo, env } = await fixture(t);
  // The exact string from the incident. Correct shape, no such object.
  const fake = 'e38ebd9d0e7a4cf7cc0e3c46c43e7ac8be9d9b0e';
  const r = await run(argsFor('d-fake', ['--base', fake]), env, repo);
  assert.equal(r.code, 2, `expected refusal, got ${r.code}: ${r.stdout}${r.stderr}`);
  assert.deepEqual(await storedRows(env), [], 'a contract naming a nonexistent commit was stored');
});

test('delegate: a real base IS accepted — the guard is not simply refusing everything', async (t) => {
  // The loud half. A guard that only refuses is an outage.
  const { repo, head, env } = await fixture(t);
  const r = await run(argsFor('d-real', ['--base', head]), env, repo);
  assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
  const rows = await storedRows(env);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].base_sha, head);
});

test('delegate: --base omitted is filled from the machine, not left blank', async (t) => {
  const { repo, head, env } = await fixture(t);
  const r = await run(argsFor('d-head'), env, repo);
  assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
  const rows = await storedRows(env);
  assert.equal(rows[0].base_sha, head, 'HEAD was not resolved into the contract');
});

test('delegate: a short SHA is canonicalised to the full object id', async (t) => {
  // What is stored must be unambiguous forever, not only until another object
  // shares the prefix.
  const { repo, head, env } = await fixture(t);
  const r = await run(argsFor('d-short', ['--base', head.slice(0, 8)]), env, repo);
  assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
  const rows = await storedRows(env);
  assert.equal(rows[0].base_sha, head);
  assert.equal(rows[0].base_sha.length, 40);
});

test('delegate: a branch name resolves to its commit', async (t) => {
  const { repo, head, env } = await fixture(t);
  await git(repo, ['branch', 'b/work']);
  const r = await run(argsFor('d-branch', ['--base', 'b/work']), env, repo);
  assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
  assert.equal((await storedRows(env))[0].base_sha, head);
});

test('delegate: a valid hex that names a TREE, not a commit, is refused', async (t) => {
  // Perfectly real object, correct shape, cannot be checked out as a base.
  // This is what `^{commit}` is for.
  const { repo, env } = await fixture(t);
  const tree = (await git(repo, ['rev-parse', 'HEAD^{tree}'])).stdout;
  assert.match(tree, /^[0-9a-f]{40}$/);
  const r = await run(argsFor('d-tree', ['--base', tree]), env, repo);
  assert.equal(r.code, 2, `a tree sha was accepted as a base: ${r.stdout}`);
  assert.deepEqual(await storedRows(env), []);
});

test('delegate: outside a git worktree it refuses rather than inventing a base', async (t) => {
  const { root, env } = await fixture(t);
  const notRepo = path.join(root, 'home');   // exists, not a worktree
  await rm(notRepo, { recursive: true, force: true });
  const r = await run(argsFor('d-norepo'), env, root);
  assert.equal(r.code, 2, `expected refusal outside a worktree, got ${r.code}`);
  assert.deepEqual(await storedRows(env), []);
});

test('delegate: --base with no value is refused, not read as the boolean true', async (t) => {
  const { repo, env } = await fixture(t);
  const r = await run(argsFor('d-bare', ['--base']), env, repo);
  assert.equal(r.code, 2, `expected refusal, got ${r.code}: ${r.stdout}`);
  assert.deepEqual(await storedRows(env), []);
});

test('delegate: --repo lets the base be resolved in another worktree', async (t) => {
  const { root, repo, head, env } = await fixture(t);
  const r = await run(argsFor('d-elsewhere', ['--repo', repo]), env, root);
  assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
  assert.equal((await storedRows(env))[0].base_sha, head);
});
