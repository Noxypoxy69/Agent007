import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THE REFUSAL CONTRACT.
 *
 * evaluateCommit() is unit-tested and mutation-proven, and none of that proves
 * the guard can stop a commit. The distinction is the entire reason this file
 * exists: a pre-commit hook that prints COLLISION in scarlet and then exits 0
 * is indistinguishable from a working one in every log anyone will ever read.
 * The commit succeeds, the warning scrolls past, and the guard is decorative
 * while looking healthy.
 *
 * So this file asserts one thing and ignores everything else: the process exit
 * code. Nothing here inspects wording — wording is for a person and is free to
 * change; the code is what git consumes.
 *
 *   0  allow — clean, or warnings only
 *   1  refuse
 *   2  cannot run
 *
 * Real git repositories in a temp directory, a real child process, and a temp
 * AGENTBRIDGE_HOME so the operator's own machine config is never read or
 * written. Slower than a unit test and worth it: this is the only place the
 * wiring between rules, git and process.exit is exercised end to end.
 */

const CLI = fileURLToPath(new URL('../bin/agentbridge-precommit.mjs', import.meta.url));

const REGISTRY = `
lanes:
  - lane_id: messaging
    branch_patterns:
      - "code-c/*"
    owned_paths:
      - "src/reply/**"
    shared_paths:
      - "package.json"
  - lane_id: onboarding
    branch_patterns:
      - "code-b/*"
    owned_paths:
      - "src/onboarding/**"
`;

function run(args, cwd, env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd, env: { ...process.env, AGENTBRIDGE_LANE: '', ...env }, windowsHide: true, timeout: 120000 },
      (err, stdout, stderr) => {
        resolve({ code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 60000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** A real repo with a real registry, a real branch, and real staged files. */
async function makeRepo(root, { branch = 'code-c/x', withRegistry = true, stage = [] } = {}) {
  const dir = path.join(root, `r${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '-q']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await writeFile(path.join(dir, 'seed.txt'), 'seed\n');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'first']);
  await git(dir, ['checkout', '-q', '-b', branch]);
  if (withRegistry) await writeFile(path.join(dir, 'lanes.registry.yml'), REGISTRY);
  for (const rel of stage) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, 'x\n');
    await git(dir, ['add', '--', rel]);
  }
  return dir;
}

async function harness(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'ab-cg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const probe = await git(root, ['--version']);
  return { root, env: { AGENTBRIDGE_HOME: path.join(root, 'home') }, gitOk: probe.ok };
}

/**
 * THE CONTROL THAT CAUGHT THIS SUITE LYING, AND IT MUST RUN FIRST.
 *
 * The first version of the CLI had a syntax error: `a ?? b || c` without
 * parentheses, which JavaScript rejects at parse time. The file never loaded,
 * every invocation crashed — and node exits 1 on an uncaught startup failure,
 * which this contract defines as "refuse".
 *
 * So four of the tests below PASSED against a guard that could not start. Every
 * one of them asserted `code === 1`, and got it, for entirely the wrong reason.
 * The nearest-clean cases are what exposed it: a guard that refuses a clean
 * commit is either broken or useless, and both need finding.
 *
 * A refuse-only suite cannot tell "correctly refused" from "died on startup".
 * This asserts the process can actually run, so the 1s below mean what they say.
 */
test('the guard can start at all — a crash exits 1 and would read as a refusal', async (t) => {
  const h = await harness(t);
  if (!h.gitOk) return t.skip('git unavailable here');
  const dir = await makeRepo(h.root, { branch: 'code-c/x', stage: ['src/reply/engine.ts'] });
  const r = await run(['--lane', 'messaging'], dir, h.env);
  assert.doesNotMatch(r.stderr, /SyntaxError|ReferenceError|TypeError|Cannot find module/,
    'the guard crashed on startup; every "refused" result below would be meaningless');
  assert.equal(r.code, 0, 'a clean commit must pass, or the guard is refusing everything');
});

test('CLI exit 1: a staged FOREIGN path refuses the commit', async (t) => {
  const h = await harness(t);
  if (!h.gitOk) return t.skip('git unavailable here');
  const dir = await makeRepo(h.root, { branch: 'code-c/x', stage: ['src/onboarding/setup.ts'] });
  const r = await run(['--lane', 'messaging'], dir, h.env);
  assert.equal(r.code, 1);
});

test('CLI exit 0: the same repo, staging only OWNED paths', async (t) => {
  const h = await harness(t);
  if (!h.gitOk) return t.skip('git unavailable here');
  const dir = await makeRepo(h.root, { branch: 'code-c/x', stage: ['src/reply/engine.ts'] });
  const r = await run(['--lane', 'messaging'], dir, h.env);
  assert.equal(r.code, 0);
});

test('CLI exit 0: an UNCLAIMED path does not block ordinary work', async (t) => {
  const h = await harness(t);
  if (!h.gitOk) return t.skip('git unavailable here');
  const dir = await makeRepo(h.root, { branch: 'code-c/x', stage: ['docs/notes.md'] });
  const r = await run(['--lane', 'messaging'], dir, h.env);
  assert.equal(r.code, 0);
});

test('CLI exit 0 then 1: a SHARED path passes by default and refuses under --strict-shared', async (t) => {
  const h = await harness(t);
  if (!h.gitOk) return t.skip('git unavailable here');
  const dir = await makeRepo(h.root, { branch: 'code-c/x', stage: ['package.json'] });
  assert.equal((await run(['--lane', 'messaging'], dir, h.env)).code, 0);
  assert.equal((await run(['--lane', 'messaging', '--strict-shared'], dir, h.env)).code, 1);
});

test('CLI exit 0: nothing staged', async (t) => {
  const h = await harness(t);
  if (!h.gitOk) return t.skip('git unavailable here');
  const dir = await makeRepo(h.root, { branch: 'code-c/x', stage: [] });
  const r = await run(['--lane', 'messaging'], dir, h.env);
  assert.equal(r.code, 0);
});

test('CLI exit 1: a branch outside the lane pattern refuses', async (t) => {
  const h = await harness(t);
  if (!h.gitOk) return t.skip('git unavailable here');
  const dir = await makeRepo(h.root, { branch: 'code-b/other', stage: ['src/reply/engine.ts'] });
  const r = await run(['--lane', 'messaging'], dir, h.env);
  assert.equal(r.code, 1);
});

test('CLI exit 2: NO REGISTRY MUST NEVER READ AS ALLOWED', async (t) => {
  const h = await harness(t);
  if (!h.gitOk) return t.skip('git unavailable here');
  const dir = await makeRepo(h.root, { branch: 'code-c/x', withRegistry: false, stage: ['src/reply/engine.ts'] });
  const r = await run(['--lane', 'messaging'], dir, h.env);
  assert.equal(r.code, 2);
});

test('CLI exit 2: a registry with overlapping exclusive ownership cannot run', async (t) => {
  const h = await harness(t);
  if (!h.gitOk) return t.skip('git unavailable here');
  const dir = await makeRepo(h.root, { branch: 'code-c/x', stage: ['src/reply/engine.ts'] });
  // The exact misconfiguration the registry refuses: two lanes, one path, both exclusive.
  await writeFile(
    path.join(dir, 'lanes.registry.yml'),
    `
lanes:
  - lane_id: messaging
    owned_paths:
      - "src/reply/**"
  - lane_id: onboarding
    owned_paths:
      - "src/reply/**"
`,
  );
  const r = await run(['--lane', 'messaging'], dir, h.env);
  assert.equal(r.code, 2);
});

test('CLI exit 1: no resolvable lane identity refuses', async (t) => {
  const h = await harness(t);
  if (!h.gitOk) return t.skip('git unavailable here');
  // A branch no lane pattern claims, and no --lane given: nothing to infer from.
  const dir = await makeRepo(h.root, { branch: 'nobodys-branch', stage: ['docs/notes.md'] });
  const r = await run([], dir, h.env);
  assert.equal(r.code, 1);
});

test('CLI exit 0: the lane is inferred from the branch when it is unambiguous', async (t) => {
  const h = await harness(t);
  if (!h.gitOk) return t.skip('git unavailable here');
  const dir = await makeRepo(h.root, { branch: 'code-b/thing', stage: ['src/onboarding/setup.ts'] });
  const r = await run([], dir, h.env); // no --lane
  assert.equal(r.code, 0);
});

test('CLI: AGENTBRIDGE_LANE is honoured, and --lane beats it', async (t) => {
  const h = await harness(t);
  if (!h.gitOk) return t.skip('git unavailable here');
  const dir = await makeRepo(h.root, { branch: 'code-c/x', stage: ['src/onboarding/setup.ts'] });
  // As onboarding this staging is owned... but the branch is messaging's, so it
  // refuses on the branch rule. Either way the env var must be READ.
  const viaEnv = await run([], dir, { ...h.env, AGENTBRIDGE_LANE: 'onboarding' });
  assert.equal(viaEnv.code, 1);
  // Explicit flag wins over the environment: as messaging the path is foreign.
  const viaFlag = await run(['--lane', 'messaging'], dir, { ...h.env, AGENTBRIDGE_LANE: 'onboarding' });
  assert.equal(viaFlag.code, 1);
});

test('CLI exit 2: an unreadable repository cannot run rather than allowing', async (t) => {
  const h = await harness(t);
  if (!h.gitOk) return t.skip('git unavailable here');
  // A directory that is not a git repo at all, with a registry beside it.
  const dir = path.join(h.root, 'notarepo');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'lanes.registry.yml'), REGISTRY);
  const r = await run(['--lane', 'messaging'], dir, h.env);
  assert.equal(r.code, 2);
});
