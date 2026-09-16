import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAttempt } from '../src/attemptPipeline.mjs';
import { createLocalExecutor } from '../src/executorLocal.mjs';
import { run as execRun } from '../src/exec.mjs';

/**
 * THE ACCEPTANCE TEST FOR "ZERO INTERACTIVE PROMPTS", RUN FOR REAL.
 *
 * Every other test in this repository injects the runner, the git layer or the
 * workspace. This one does not: a real repository on disk, a real child
 * process, real git, real commits. It is slower and it is the only test here
 * that can fail for a reason the mocks agree is impossible.
 *
 * WHAT IT ASSERTS IS NOT "THE AGENT WORKED". It is that a task which reads
 * files, edits files, runs a test, stages and commits, with nobody at a
 * keyboard, produces a commit and reaches a verdict WITHOUT ANY PROCESS EVER
 * WAITING FOR INPUT. The failure it exists to catch is the one from the
 * screenshot: a worker sitting on "Do you want to proceed?" until its lease
 * expires, on a machine nobody is watching.
 *
 * AND IT ASSERTS THE OPPOSITE DIRECTION IN THE SAME FILE. A gate that only ever
 * sees the good case cannot distinguish "no prompt happened" from "prompts are
 * invisible to me", so the second scenario runs an agent that DOES prompt and
 * requires the attempt to fail with the prompt named. A negative needs the
 * positive first, and this is the positive.
 */

const git = async (cwd, ...args) => {
  const r = await execRun('git', args, { cwd, timeoutMs: 20000 });
  if (!r.ok) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.error}`);
  return r.stdout.trim();
};

/** A repository with one commit, and the identity git needs to make another. */
async function scratchRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'unattended-'));
  await git(dir, 'init', '--quiet', '-b', 'work/t1');
  await git(dir, 'config', 'user.email', 'harness@example.invalid');
  await git(dir, 'config', 'user.name', 'harness');
  await git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'value.txt'), '1\n');
  writeFileSync(path.join(dir, 'check.mjs'),
    "import {readFileSync} from 'node:fs';\n" +
    "const v = Number(readFileSync(new URL('./value.txt', import.meta.url), 'utf8').trim());\n" +
    // a real node --test summary shape: parseTestSummary requires `# tests` too,
    // and returns null without it, which is correct -- absent is not zero
    "console.log(v === 2 ? '# tests 1\\n# pass 1\\n# fail 0' : '# tests 1\\n# pass 0\\n# fail 1');\n" +
    'process.exit(v === 2 ? 0 : 1);\n');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '--quiet', '-m', 'base');
  return { dir, sha: await git(dir, 'rev-parse', 'HEAD') };
}

/**
 * The workspace manager, wired to the real repository rather than mocked.
 * runAttempt only needs create/destroy/quarantine, and using the task's own
 * directory keeps this about the loop rather than about worktree plumbing.
 */
const workspacesFor = (dir) => ({
  create: async () => ({ path: dir, id: 'ws' }),
  destroy: async () => ({ ok: true, reason: 'kept by the harness' }),
  quarantine: async () => dir,
});

test('AN UNATTENDED TASK READS, EDITS, TESTS AND COMMITS WITH NO PROMPT', async (t) => {
  const { dir, sha } = await scratchRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  /*
   * A real agent: reads a file, edits it, runs the check, stages and commits.
   * Everything a coding task does and nothing that needs a person.
   *
   * IT LIVES OUTSIDE THE WORKSPACE, and the first run of this test is why. With
   * the script inside the repository the agent committed itself, the path
   * contract reported a violation for `agent.mjs`, and the attempt was
   * correctly refused. The contract was right and the harness was wrong -- an
   * executor's own binary is not part of the tree it is working on.
   */
  const agentDir = mkdtempSync(path.join(tmpdir(), 'agent-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const agent = path.join(agentDir, 'agent.mjs');
  writeFileSync(agent, `
import {readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const cwd = process.cwd();
const v = Number(readFileSync(cwd + '/value.txt', 'utf8').trim());
writeFileSync(cwd + '/value.txt', String(v + 1) + '\\n');
const out = execFileSync(process.execPath, [cwd + '/check.mjs'], {cwd, encoding: 'utf8'});
process.stdout.write(out);
execFileSync('git', ['add', '-A'], {cwd});
execFileSync('git', ['commit', '--quiet', '-m', 'raise the value'], {cwd});
`);

  const result = await runAttempt({
    task: {
      task_id: 't1-unattended', base_sha: sha, branch: 'work/t1',
      lease_ms: 120000, timeout_ms: 60000,
      // THE EXECUTOR HANDS THE CHILD ONLY WHAT THE SPEC NAMES, on purpose: an
      // agent that inherits the daemon's environment inherits its credentials.
      // So a task that shells out to git has to say so. The first run of this
      // test failed with exit 1 for exactly that reason, which is the design
      // working rather than a defect.
      env: { PATH: process.env.PATH ?? '' },
      argv: [process.execPath, agent],
      commands: [{ file: 'git', args: ['add', '-A'] }, { file: 'git', args: ['commit', '-m', 'x'] }],
    },
    contract: { allowed: ['value.txt'], forbidden: [] },
    executor: createLocalExecutor(),
    workspaces: workspacesFor(dir),
    io: {
      now: () => Date.now(),
      git: {
        headSha: async () => git(dir, 'rev-parse', 'HEAD'),
        changedFiles: async () => (await git(dir, 'diff', '--name-only', `${sha}..HEAD`)).split('\n').filter(Boolean),
      },
    },
  });

  assert.notEqual(result.verdict, undefined, `blocked before running: ${JSON.stringify(result.blocked ?? null)}`);
  assert.equal(result.envelope.outcome, 'exited', `outcome was ${result.envelope.outcome}`);
  assert.equal(result.envelope.exitCode, 0);

  // the work actually happened, in git rather than in a report
  assert.notEqual(result.envelope.commit, sha, 'no new commit was produced');
  assert.equal(readFileSync(path.join(dir, 'value.txt'), 'utf8').trim(), '2');
  assert.deepEqual(result.envelope.filesChanged, ['value.txt']);
  assert.deepEqual(result.envelope.tests, { passed: 1, failed: 0, skipped: 0, total: 1 });

  // and the whole point: nobody was asked anything
  assert.equal(result.verdict.verdict, 'accept', `rejected: ${result.verdict.reasons.join(', ')}`);
});

test('AND AN AGENT THAT ASKS FAILS THE ATTEMPT INSTEAD OF WAITING', async (t) => {
  /*
   * The negative, and it needs the positive above to mean anything: a harness
   * that cannot see a prompt would pass the first test for the wrong reason.
   * This agent prints a prompt and would, with an open standard input, sit
   * there until the lease expired.
   */
  const { dir, sha } = await scratchRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const agentDir = mkdtempSync(path.join(tmpdir(), 'agent-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const agent = path.join(agentDir, 'asks.mjs');
  writeFileSync(agent, `
process.stdout.write('Do you want to proceed? [y/n] ');
let answer = '';
process.stdin.on('data', (d) => { answer += d; });
process.stdin.on('end', () => { process.exit(0); });
`);

  const started = Date.now();
  const result = await runAttempt({
    task: {
      task_id: 't1-asks', base_sha: sha, branch: 'work/t1',
      lease_ms: 120000, timeout_ms: 30000,
      argv: [process.execPath, agent],
    },
    executor: createLocalExecutor(),
    workspaces: workspacesFor(dir),
    io: { now: () => Date.now(), git: { headSha: async () => git(dir, 'rev-parse', 'HEAD') } },
  });
  const elapsed = Date.now() - started;

  assert.equal(result.envelope.outcome, 'prompted', 'a prompt was reported as an ordinary run');
  assert.equal(result.verdict.verdict, 'reject');
  assert.ok(result.verdict.reasons.includes('outcome:prompted'));
  assert.equal(result.accepted, false);
  assert.ok(elapsed < 15000, `waited ${elapsed}ms: the run hung instead of failing`);
  assert.equal(result.disposal.outcome, 'quarantined', 'a refused attempt must not destroy its evidence');
});
