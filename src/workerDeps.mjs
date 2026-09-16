/**
 * THE REAL WORLD, FOR src/worker.mjs.
 *
 * `workerLoop.mjs` decides, `worker.mjs` drives, and this supplies the effects
 * the driver takes as arguments: git, a child process, and the three hosted
 * routes. It is the thinnest layer in the runtime on purpose — every decision
 * it could make has already been made somewhere testable.
 *
 * ═══ WHY THIS FILE EXISTS AT ALL ═══
 *
 * Audited today at Danny's request: `worker.mjs` had ZERO production callers.
 * It was imported only by its own tests. That is precisely the "pure, tested,
 * called by nothing" defect I counted five of in somebody else's work this
 * morning and then produced two more of — while describing it as "the runtime
 * exists". The runtime did not run. This is the fix.
 */

import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { run } from './exec.mjs';
import {
  waitForEvents, fetchOwnTask, renewLease, returnWork, publishRegistration, HOSTED,
} from './hostedRegistry.mjs';

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * A FRESH WORKTREE PER TASK, AND FRESH MEANS FRESH.
 *
 * Every retry is a new attempt in a new workspace. Reusing a directory means
 * attempt two inherits attempt one's half-finished edits, and then the commit
 * that gets returned contains work nobody reviewed — which is the shared-clone
 * failure this project already documents between agents, with the added
 * unpleasantness that the second attempt looks like it succeeded.
 *
 * So the directory is REMOVED before it is created, not reused.
 */
export async function prepareWorktree({ dir, task }, { gitDir = process.cwd() } = {}) {
  if (!nonEmpty(dir)) return { ok: false, error: 'no worktree path' };

  await cleanupWorktree(dir, { gitDir });

  const base = nonEmpty(task?.base_sha) ? task.base_sha : 'HEAD';
  const branch = `work/${String(task?.task_id ?? 'task').replace(/[^A-Za-z0-9._-]/g, '-')}`;

  // Delete any branch left by a previous attempt, or `worktree add -b` refuses.
  await run('git', ['branch', '-D', branch], { cwd: gitDir, timeoutMs: 15000 });

  const added = await run('git', ['worktree', 'add', '-b', branch, dir, base],
    { cwd: gitDir, timeoutMs: 120000 });
  if (!added.ok) return { ok: false, error: (added.stderr || added.error || '').slice(0, 300) };

  return { ok: true, dir, branch, base };
}

export async function cleanupWorktree(dir, { gitDir = process.cwd() } = {}) {
  if (!nonEmpty(dir)) return;
  // --force because the agent may have left untracked files; this directory is
  // ours and disposable by construction.
  await run('git', ['worktree', 'remove', '--force', dir], { cwd: gitDir, timeoutMs: 60000 });
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  await run('git', ['worktree', 'prune'], { cwd: gitDir, timeoutMs: 15000 });
}

/** The commit that actually holds the work. Derived, never supplied. */
export async function headSha(dir) {
  const out = await run('git', ['rev-parse', 'HEAD'], { cwd: dir, timeoutMs: 15000 });
  const sha = (out.stdout ?? '').trim();
  return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

/**
 * START THE AGENT, AND DO NOT WAIT FOR IT.
 *
 * The driver polls, because it must stay free to renew the lease while the
 * work runs. A blocking call here would hold the loop for the whole run and the
 * lease would lapse underneath it — the failure the whole renewal path exists
 * to prevent.
 *
 * THE BRIEF GOES ON STDIN. argv is readable by any process on the machine,
 * which is the rule src/argv.mjs exists to enforce, and a task brief can carry
 * repository detail worth not broadcasting.
 *
 * NO SHELL. `shell: false` means a brief or an argument containing `;` or `&&`
 * is text, not a second command.
 */
export function startRun({ cmd, args = [], cwd, brief, timeoutMs }) {
  const child = spawn(cmd, args, {
    cwd,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const state = {
    done: false, ok: false, timedOut: false, error: null, notes: '',
    headSha: null, _out: [], _err: [],
  };

  const cap = (arr, chunk) => {
    arr.push(String(chunk));
    // Bounded in memory. The full log belongs in an artifact, not in a field
    // that rides back to the coordinator.
    if (arr.length > 400) arr.splice(0, arr.length - 400);
  };

  child.stdout?.on('data', (c) => cap(state._out, c));
  child.stderr?.on('data', (c) => cap(state._err, c));

  const killer = setTimeout(() => {
    state.timedOut = true;
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }, timeoutMs);

  child.on('error', (e) => {
    clearTimeout(killer);
    state.done = true; state.ok = false;
    state.error = `could not start "${cmd}": ${e.message}`;
  });

  child.on('close', (code) => {
    clearTimeout(killer);
    state.done = true;
    state.ok = code === 0 && !state.timedOut;
    if (state.timedOut) state.error = `killed after ${Math.round(timeoutMs / 1000)}s`;
    else if (code !== 0) state.error = `exit ${code}`;
    state.notes = [state._out.join(''), state._err.join('')].join('\n').trim();
  });

  try { child.stdin?.end(brief ?? ''); } catch { /* the error handler has it */ }

  return state;
}

/** The driver polls this; the object mutates in place as the child runs. */
export const pollRun = async (state) => state ?? { done: false };

/**
 * THE VERIFICATION GATE, AND ITS EXIT CODE IS THE TRUTH.
 *
 * Run by the DAEMON, in the worktree, after the agent says it is finished —
 * never by the agent and never reported by it. An agent that grades its own
 * work is the confused deputy in a different costume, and prose saying "all
 * tests pass" is not evidence that any ran.
 */
export async function verify({ dir, cmd, timeoutMs = 10 * 60_000 }) {
  if (!nonEmpty(cmd)) return { ran: false, ok: null, detail: 'no verify command configured' };
  const parts = cmd.trim().split(/\s+/);
  const out = await run(parts[0], parts.slice(1), { cwd: dir, timeoutMs });
  return {
    ran: true,
    ok: out.ok,
    exit_code: out.code ?? (out.ok ? 0 : 1),
    detail: (out.stderr || out.stdout || '').slice(-2000),
  };
}

/** Bind the hosted routes to this session. */
export function hostedDeps(env, { session_id }) {
  return {
    waitForEvents: async ({ since } = {}) => {
      const res = await waitForEvents(env, { session_id, since, timeout_ms: 25000 },
        { timeoutMs: 40000 });
      return res.state === HOSTED.OK ? (res.events ?? []) : [];
    },

    readTask: async (task_id) => {
      const res = await fetchOwnTask(env, { session_id, task_id });
      return res.state === HOSTED.OK ? (res.task ?? null) : null;
    },

    renewLease: async ({ task_id, lease_token }) => {
      const res = await renewLease(env, { task_id, lease_token });
      /*
       * ONLY HOSTED.OK IS A RENEWAL. A refusal means this process is no longer
       * the holder and the driver must abandon; an UNREACHABLE is a transport
       * failure and is also not a renewal. Reporting either as success keeps
       * the worker running on a lease it has lost.
       */
      return res.state === HOSTED.OK
        ? { ok: true, lease_expires_at: res.lease_expires_at }
        : { ok: false, detail: res.detail ?? res.state };
    },

    returnWork: async (body) => returnWork(env, body),
  };
}

/**
 * HEARTBEAT WHILE WORKING, AND NOTICE WHEN IT STOPS.
 *
 * ═══ THE BUG THIS FIXES, WHICH WAS AN HOUR OLD ═══
 *
 * `agentbridge work` claimed a task, worked for up to THIRTY MINUTES, renewed
 * its LEASE faithfully -- and never beat its SESSION. Sessions go stale after
 * ten minutes. So a worker doing a perfectly normal task disappeared from the
 * roster a third of the way through, `wentStale` raised an alert about a worker
 * that was fine, and any coordinator reading the roster saw a dead agent
 * holding live work.
 *
 * The lease and the session are different clocks and I had wired only one.
 *
 * ═══ AND THE OTHER HALF, WHICH b6 FOUND THE HARD WAY ═══
 *
 * b6's watcher died silently: the background process was still nominally
 * running, produced no output, and stopped beating. The roster was right to
 * call it offline; b6 did not know. A worker that cannot tell whether its own
 * heartbeat is landing will keep working while the system has written it off --
 * and its task is reaped out from under it the moment the lease lapses.
 *
 * So this returns the outcome rather than swallowing it, and the driver logs a
 * failure. A heartbeat that fails silently is worse than none: none is at least
 * consistent with what the roster says.
 */
export function heartbeatDeps(env, { session_id, agent_id }) {
  let consecutiveFailures = 0;

  return {
    // `opts` carries an injectable fetch. Without it this client could only be
    // tested through the driver's fake, which is how the NOT_CONFIGURED branch
    // went uncovered: a fake dep proves the driver calls something, never that
    // the something is right.
    async heartbeat({ capacity = 'busy', task_id = null, head_sha = null } = {}, opts = {}) {
      const res = await publishRegistration(env, {
        session_id,
        agent_id,
        capacity,
        task_id,
        head_sha,
        heartbeat_at: new Date().toISOString(),
      }, opts);

      if (res.state === HOSTED.OK) {
        consecutiveFailures = 0;
        return { ok: true };
      }

      consecutiveFailures += 1;
      /*
       * NOT_CONFIGURED is not a failure -- a local-only worker is a legitimate
       * setup and counting it would raise a false alarm forever. Everything
       * else is: REFUSED and REJECTED mean the Bridge answered and said no,
       * UNREACHABLE means nobody answered. All three leave this worker
       * invisible, which is the thing that matters.
       */
      if (res.state === HOSTED.NOT_CONFIGURED) {
        consecutiveFailures = 0;
        return { ok: true, note: 'not configured; local-only' };
      }

      return {
        ok: false,
        consecutiveFailures,
        detail: res.detail ?? res.state,
        /*
         * THE THRESHOLD IS THE STALENESS WINDOW, NOT A ROUND NUMBER. Sessions
         * go stale at ten minutes and the driver cycles far faster than that,
         * so three consecutive failures means the roster is about to be right
         * about us and we should say so loudly rather than discover it when a
         * return is refused.
         */
        goingDark: consecutiveFailures >= 3,
      };
    },
  };
}
