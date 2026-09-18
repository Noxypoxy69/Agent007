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
import { mkdir, readFile as readBytes, rename, rm, stat, writeFile } from 'node:fs/promises';
import { runGit } from '../src/safeGit.mjs';
import { createLocalExecutor } from '../src/executorLocal.mjs';
import { createWorkspaceManager } from '../src/workspaceManager.mjs';
import { openVerificationJob } from '../src/verificationControl.mjs';
import { runAttempt } from '../src/attemptPipeline.mjs';
import { ENVELOPE_VERSION } from '../src/resultEnvelope.mjs';
import { createLedger } from '../src/tokenTelemetry.mjs';
import { createCas, digestOf } from '../src/cas.mjs';

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

/*
 * GIT GOES THROUGH safeGit, NOT exec. Every call here used run() from
 * src/exec.mjs, which 560ba4d taught to THROW for git -- exec applies no
 * SAFE_GIT_CONFIG and strips no repository-redirecting environment, so a
 * repository config could execute and GIT_DIR could redirect the answer. That
 * throw correctly caught this file: the shipped controller could not open a
 * worktree at all (step4aWiring "G" failed at refuseGit). runGit is the hardened
 * path. It THROWS on failure and RETURNS stdout, where run returned
 * { ok, stdout, stderr }, so each site adapts: a throw is the failed case.
 */
const git = {
  async addWorktree({ path, baseSha, detach }) {
    try {
      runGit(['worktree', 'add', ...(detach ? ['--detach'] : []), path, baseSha], {
        cwd: repo,
        timeout: 120_000,
      });
    } catch (e) {
      die(`git worktree add failed: ${e?.stderr ?? e?.message ?? e}`);
    }
  },
  async removeWorktree({ path, force }) {
    // Cleanup: the original ignored the result, so a failure here is tolerated
    // rather than fatal.
    try {
      runGit(['worktree', 'remove', ...(force ? ['--force'] : []), path], {
        cwd: repo,
        timeout: 60_000,
      });
    } catch { /* best-effort cleanup */ }
  },
  async isDirty(path) {
    // A status we could not read is treated as dirty. Refusing to destroy is
    // recoverable; destroying on a failed check is not -- so a throw means dirty.
    try {
      return runGit(['status', '--porcelain'], { cwd: path, timeout: 60_000 }).trim().length > 0;
    } catch {
      return true;
    }
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

/*
 * A CONTENT-ADDRESSED STORE UNDER THE ROOT, so a spilled log is retrievable
 * rather than merely truncated. Without a sink the compact form is honest but
 * useless -- it says "incomplete" and the bytes are gone. With one, the whole
 * output survives the workspace it came from, which matters most in exactly the
 * case where the workspace is about to be quarantined or destroyed.
 *
 * Keyed by content, so two attempts producing the same log store it once. The
 * namespace is the repository, because cross-project reuse should be impossible
 * by construction rather than by a check somebody has to remember to write.
 */
const casDir = `${root}/.cas`;

/*
 * THE FILENAME IS A HASH OF THE KEY, NOT A SCRUBBED VERSION OF IT.
 *
 * The first version of this replaced unsafe characters with underscores, which
 * quietly undid the isolation the store above enforces: a key under the
 * namespace "project:a" and one under a namespace literally called "project_a"
 * collapse to the same filename. Content verification does not catch that,
 * because the bytes hash correctly -- so the second namespace could confirm the
 * first one's content exists, which is the existence leak namespacing is for.
 *
 * Hashing the whole key is injective enough to make that impossible and needs no
 * rules about which characters a namespace may contain.
 */
const pathFor = (key) => `${casDir}/${digestOf(key).hash}`;
const cas = createCas({
  namespace: task.namespace ?? 'default',
  store: {
    // A read that fails for any reason is a MISS. That is safe for a cache: the
    // caller recomputes. It must never be an error that stops an attempt.
    get: async (key) => readBytes(pathFor(key)).catch(() => null),
    set: async (key, bytes) => {
      await mkdir(casDir, { recursive: true });
      await writeFile(pathFor(key), bytes);
    },
  },
});

const io = {
  now: () => Date.now(),
  sink: cas.sink,
  git: {
    headSha: async () => {
      try {
        return runGit(['rev-parse', 'HEAD'], { cwd: workspacePath, timeout: 30_000 }).trim();
      } catch {
        return null;
      }
    },
    changedFiles: async () => {
      try {
        return runGit(['diff', '--name-only', task.base_sha], { cwd: workspacePath, timeout: 60_000 })
          .split('\n').map((s) => s.trim()).filter(Boolean);
      } catch {
        return [];
      }
    },
  },
};

/*
 * The workspace path is needed by io.git before runAttempt returns, so the
 * manager is wrapped rather than the path being guessed at. Guessing it would
 * make this file a second implementation of the naming rule.
 */
let workspacePath = null;
let verificationJobId = null;
let verificationError = null;
const tracked = {
  ...workspaces,
  async create(spec) {
    const ws = await workspaces.create(spec);
    workspacePath = ws.path;
    return ws;
  },

  /*
   * THE CONTROLLER OPENS THE VERIFICATION JOB HERE, AND THE PLACEMENT IS THE
   * WHOLE POINT.
   *
   * It was originally opened after runAttempt returned, which read correctly
   * and was dead: the pipeline destroys an accepted workspace BEFORE it
   * returns, so every job named a directory that no longer existed and
   * verification would have refused all of them with "no such workspace". No
   * test that built its own workspace could see that; running this binary
   * end-to-end did, immediately.
   *
   * runAttempt disposes of an accepted attempt with destroy() and of every
   * other one with quarantine(), so this is both the last moment the candidate
   * exists and the first moment acceptance is known. That coupling is load
   * bearing, so it is stated here rather than left to be rediscovered.
   *
   * A failure to open a job does NOT rewrite the attempt's verdict, and does
   * not block disposal. An attempt that ran is reported as it ran; a
   * verification that could not be opened is reported as absent rather than as
   * refused, because those are different facts.
   */
  async destroy(ws) {
    try {
      verificationJobId = openVerificationJob({
        repoRoot: repo,
        baselineRef: 'HEAD',
        candidateWorkspace: ws?.path ?? workspacePath,
        sessionId: task?.sessionId ?? null,
        workerId: task?.workerId ?? null,
      });
    } catch (e) {
      verificationError = String(e?.message ?? e);
    }
    return workspaces.destroy(ws);
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
      /*
       * The schema version travels with the record, because the reader arrives
       * months after the writer and will meet rows from earlier versions of it.
       * One field now, unrecoverable later.
       */
      envelope_version: ENVELOPE_VERSION,
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
      stdout: {
        kind: result.stdout.kind,
        complete: result.stdout.complete,
        bytes: result.stdout.bytes,
        ref: result.stdout.ref ?? null,
      },
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

process.stdout.write(`${JSON.stringify({ verification: { jobId: verificationJobId, error: verificationError } }, null, 2)}\n`);

process.exit(result.accepted ? 0 : 1);
