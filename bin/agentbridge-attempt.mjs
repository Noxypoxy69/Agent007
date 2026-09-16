#!/usr/bin/env node
/**
 * RUN ONE ATTEMPT, BY HAND, AND PRINT THE EVIDENCE.
 *
 * The daemon will eventually do this on a lease. Until it does, this is how the
 * loop is exercised at all: a real worktree at a real base commit, a real
 * process, and an envelope built from git and the test output rather than from
 * anything the process claimed about itself.
 *
 * IT DOES NOT REVIEW, and that is deliberate rather than unfinished. Review is a
 * separate stage with its own lease and its own engine; a reviewer bolted into
 * the runner is the runner grading itself. The machine verdict is printed, and
 * it is the half that no reviewer is allowed to overturn anyway.
 *
 * IT CLAIMS NOTHING AND WRITES NOTHING TO THE BRIDGE. No lease, no return, no
 * coordination state. Those belong to the daemon and to whoever holds the token.
 *
 *   agentbridge-attempt --task ./task.json --root /tmp/work
 *
 * The task file is the contract: task_id, base_sha, argv, and optionally
 * timeout_ms, allowed_paths and forbidden_paths. Exit 0 only when the machine
 * evidence accepts.
 */

import { readFile } from 'node:fs/promises';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { run } from '../src/exec.mjs';
import { createLocalExecutor } from '../src/executorLocal.mjs';
import { createWorkspaceManager } from '../src/workspaceManager.mjs';
import { runAttempt } from '../src/attemptPipeline.mjs';
import { createLedger } from '../src/tokenTelemetry.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? null;
};

function die(message) {
  process.stderr.write(`agentbridge-attempt: ${message}\n`);
  process.exit(2);
}

const taskPath = flag('--task');
const root = flag('--root');
const repo = flag('--repo') ?? process.cwd();
if (!taskPath || !root) die('usage: --task <file.json> --root <workspace root> [--repo <path>]');

const task = JSON.parse(await readFile(taskPath, 'utf8'));
if (!task.task_id) die('the task file needs a task_id');
if (!task.base_sha) die('the task file needs a base_sha: a worktree is made at a commit, never a branch');
if (!Array.isArray(task.argv) || task.argv.length === 0) die('the task file needs an argv');

const git = {
  async addWorktree({ path, baseSha, detach }) {
    const r = await run('git', ['worktree', 'add', ...(detach ? ['--detach'] : []), path, baseSha], {
      cwd: repo,
      timeoutMs: 120_000,
    });
    if (!r.ok) die(`git worktree add failed: ${r.error ?? r.stderr}`);
  },
  async removeWorktree({ path, force }) {
    await run('git', ['worktree', 'remove', ...(force ? ['--force'] : []), path], {
      cwd: repo,
      timeoutMs: 60_000,
    });
  },
  async isDirty(path) {
    const r = await run('git', ['status', '--porcelain'], { cwd: path, timeoutMs: 60_000 });
    // A status we could not read is treated as dirty. Refusing to destroy is
    // recoverable; destroying on a failed check is not.
    return !r.ok || r.stdout.trim().length > 0;
  },
};

const fs = {
  exists: async (p) => stat(p).then(() => true).catch(() => false),
  mkdirp: (p) => mkdir(p, { recursive: true }),
  rename,
  writeFile: (p, body) => writeFile(p, body),
  rm: (p) => rm(p, { recursive: true, force: true }),
};

const workspaces = createWorkspaceManager({ root, git, fs });
const executor = createLocalExecutor();

const io = {
  now: () => Date.now(),
  git: {
    headSha: async () => {
      const r = await run('git', ['rev-parse', 'HEAD'], { cwd: workspacePath, timeoutMs: 30_000 });
      return r.ok ? r.stdout.trim() : null;
    },
    changedFiles: async () => {
      const r = await run('git', ['diff', '--name-only', task.base_sha], {
        cwd: workspacePath,
        timeoutMs: 60_000,
      });
      return r.ok ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
    },
  },
};

/*
 * The workspace path is needed by io.git before runAttempt returns, so the
 * manager is wrapped rather than the path being guessed at. Guessing it would
 * make this file a second implementation of the naming rule.
 */
let workspacePath = null;
const tracked = {
  ...workspaces,
  async create(spec) {
    const ws = await workspaces.create(spec);
    workspacePath = ws.path;
    return ws;
  },
};

const contract =
  task.allowed_paths || task.forbidden_paths
    ? { allowed: task.allowed_paths ?? null, forbidden: task.forbidden_paths ?? [] }
    : null;

const result = await runAttempt({
  task,
  contract,
  executor,
  reviewer: null,
  workspaces: tracked,
  ledger: createLedger(),
  io,
});

process.stdout.write(
  `${JSON.stringify(
    {
      task_id: result.taskId,
      attempt: result.attempt,
      accepted: result.accepted,
      verdict: result.verdict,
      evidence: {
        outcome: result.envelope.outcome,
        exit_code: result.envelope.exitCode,
        tests: result.envelope.tests,
        commit: result.envelope.commit,
        files_changed: result.envelope.filesChanged,
        duration_ms: result.envelope.durationMs,
      },
      fingerprint: result.fingerprint,
      disposal: result.disposal,
      stdout: { kind: result.stdout.kind, complete: result.stdout.complete, bytes: result.stdout.bytes },
      /*
       * STDERR TRAVELS WITH THE VERDICT, not just into the quarantine directory.
       * The first real run of this printed a clean rejection and nothing about
       * WHY, so diagnosing it meant finding the quarantined worktree and
       * reproducing by hand. The evidence that explains a refusal belongs next
       * to the refusal.
       */
      stderr: {
        kind: result.stderr.kind,
        complete: result.stderr.complete,
        bytes: result.stderr.bytes,
        head: result.stderr.kind === 'inline' ? result.stderr.text : result.stderr.head,
      },
    },
    null,
    2,
  )}\n`,
);

process.exit(result.accepted ? 0 : 1);
