/**
 * THE WORKER RUNTIME'S SHELL: config, the brief, and the driver.
 *
 * `src/workerLoop.mjs` decides WHAT to do. This supplies the world — which
 * command runs the work, where it runs, and what the agent is told. The driver
 * at the bottom takes every effect as an argument, so the whole cycle
 * (poll → hold → work → renew → return) can be walked end to end in a test
 * without a network, a git repository, or a coding agent.
 *
 * ═══ THE RUNTIME DOES NOT KNOW WHAT AN AGENT IS, AND MUST NOT ═══
 *
 * There is no default command and no vendor name anywhere in this file. A
 * worker that shells out to a hardcoded binary is a worker that silently does
 * nothing on a machine where that binary is absent, or — worse — runs whatever
 * happens to be on PATH under that name. The command is configuration, it is
 * validated up front, and a worker with none REFUSES TO START rather than
 * starting and finding out later.
 *
 * ═══ THE BRIEF CARRIES NO CREDENTIALS, EVER ═══
 *
 * The thing the agent reads is assembled by `taskBrief`, which is pure and
 * takes only a task row. The lease token is deliberately not a parameter: it
 * cannot leak into a prompt that was never handed it. The brief goes to the
 * child on STDIN rather than argv, because argv is readable by any process on
 * the machine — the rule src/argv.mjs exists to enforce.
 */

import { ACTION, nextAction, returnPayload, actionableEvent } from './workerLoop.mjs';
import { rotationHandover } from './builderHold.mjs';
import { nextCursor } from './events.mjs';

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const int = (v, fallback) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;   // 30 minutes
export const MIN_RUN_TIMEOUT_MS = 60_000;
export const MAX_RUN_TIMEOUT_MS = 4 * 60 * 60_000;   // 4 hours

/**
 * WHAT THIS WORKER NEEDS BEFORE IT MAY CALL ITSELF ONE.
 *
 * REFUSES rather than defaults, and names every missing piece at once. A
 * refusal that reports one problem produces an operator who fixes it, restarts,
 * and is refused again for the next one — four restarts to learn four facts
 * that were all knowable on the first.
 */
export function workerConfig(env = {}) {
  const errors = [];

  const cmd = env.AGENTBRIDGE_WORKER_CMD;
  if (!nonEmpty(cmd)) {
    errors.push('AGENTBRIDGE_WORKER_CMD is required: the command that performs a task. '
      + 'There is no default, because a worker that guesses runs whatever is on PATH under that name');
  }

  const root = env.AGENTBRIDGE_WORKTREE_ROOT;
  if (!nonEmpty(root)) {
    errors.push('AGENTBRIDGE_WORKTREE_ROOT is required: work runs in an isolated worktree, never in a shared checkout');
  }

  if (!nonEmpty(env.AGENTBRIDGE_WAIT_URL)) errors.push('AGENTBRIDGE_WAIT_URL is required');
  if (!nonEmpty(env.AGENTBRIDGE_RETURN_URL)) errors.push('AGENTBRIDGE_RETURN_URL is required');
  if (!nonEmpty(env.AGENTBRIDGE_REGISTRATION_TOKEN)) {
    errors.push('AGENTBRIDGE_REGISTRATION_TOKEN is required: a worker publishes its own liveness and returns its own work');
  }

  /*
   * THE TIMEOUT IS BOUNDED AT BOTH ENDS AND IS NOT A SUGGESTION. Unbounded, a
   * wedged agent holds a lease forever by renewing it — the reaper cannot help,
   * because from the outside a stuck worker and a busy one are identical. A
   * floor stops a mistyped value turning every task into an instant timeout.
   */
  const raw = env.AGENTBRIDGE_RUN_TIMEOUT_MS;
  const runTimeoutMs = int(raw, DEFAULT_RUN_TIMEOUT_MS);
  if (nonEmpty(raw) && (runTimeoutMs < MIN_RUN_TIMEOUT_MS || runTimeoutMs > MAX_RUN_TIMEOUT_MS)) {
    errors.push(`AGENTBRIDGE_RUN_TIMEOUT_MS must be between ${MIN_RUN_TIMEOUT_MS} and ${MAX_RUN_TIMEOUT_MS}`);
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    config: {
      cmd: cmd.trim(),
      args: parseArgs(env.AGENTBRIDGE_WORKER_ARGS),
      worktreeRoot: root.trim(),
      runTimeoutMs,
    },
  };
}

/**
 * Extra arguments for the runner, whitespace-separated.
 *
 * NO SHELL, ANYWHERE. src/exec.mjs runs with `shell: false`, so these are argv
 * entries and never a command line — a value containing `;` or `&&` is one
 * argument with punctuation in it, not two commands.
 */
export function parseArgs(raw) {
  if (!nonEmpty(raw)) return [];
  return raw.trim().split(/\s+/).filter(Boolean);
}

/**
 * WHERE THE WORK HAPPENS: one worktree per task, named after the task.
 *
 * Per TASK rather than per session, because a session that handles two tasks in
 * a row must not inherit the first one's working tree — an uncommitted file
 * from a previous task would ride along into the next task's commit, which is
 * the shared-clone failure this project already documents between agents.
 */
export function worktreePath(root, task_id) {
  if (!nonEmpty(root)) throw new TypeError('worktreePath requires a root');
  if (!nonEmpty(task_id)) throw new TypeError('worktreePath requires a task_id');
  /*
   * DOTS ARE NEUTRALISED, NOT JUST SLASHES. The first version replaced every
   * character outside [A-Za-z0-9._-] and KEPT dots, so "../../etc/passwd"
   * became "..-..-etc-passwd" -- one segment, so not a traversal, but a
   * directory name carrying ".." that the next person to join a path onto it
   * would have to notice. Caught by the test, not by reading.
   */
  const safe = task_id.trim()
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/\.\.+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 64) || 'task';
  return `${root.replace(/[\\/]+$/, '')}/${safe}`;
}

/**
 * WHAT THE AGENT IS TOLD.
 *
 * PURE, AND IT TAKES NO CREDENTIAL. The lease token is not a parameter here, so
 * it cannot reach a prompt, a log, or a transcript by accident. That is a
 * structural guarantee rather than a careful habit.
 *
 * The brief states the CONTRACT and not the method: which paths may change, the
 * base commit, and that the work must be committed — because a return carries
 * the commit that holds the work and there is nothing to return otherwise.
 */
export function taskBrief(task = {}) {
  if (!nonEmpty(task.task_id)) throw new TypeError('taskBrief requires a task_id');

  const lines = [
    `TASK ${task.task_id}`,
    task.title ? `\n${task.title}` : '',
    task.notes ? `\n${task.notes}` : '',
    '',
    'CONTRACT',
  ];

  const paths = Array.isArray(task.allowed_paths) ? task.allowed_paths.filter(nonEmpty) : [];
  lines.push(paths.length
    ? `  Files you may change: ${paths.join(', ')}. Changing anything else fails this task.`
    : '  No path contract was given. Change only what the task names, and nothing else.');

  if (nonEmpty(task.base_sha)) lines.push(`  Base commit: ${task.base_sha}`);
  if (nonEmpty(task.repo_id)) lines.push(`  Repository: ${task.repo_id}`);

  lines.push(
    '  COMMIT YOUR WORK. The commit is what gets handed back; uncommitted changes are not returned.',
    '  Commit by exact pathspec. The index is shared with other agents.',
    '  If you cannot complete this, say so plainly and stop. A partial change presented as',
    '  finished is worse than a refusal, because it is accepted.',
  );

  return lines.filter((l) => l !== '').join('\n');
}

/**
 * THE DRIVER. Every effect is injected, so the whole cycle can be walked in a
 * test without a network, a git repo, or an agent.
 *
 * @param deps {
 *   now, waitForEvents, readTask, startRun, pollRun, renewLease, returnWork,
 *   prepareWorktree, cleanupWorktree, headSha, pausedTaskIds, log
 * }
 */
export async function runWorker({ config, session_id, agent_id }, deps, { maxCycles = Infinity } = {}) {
  if (!config) throw new TypeError('runWorker requires a validated config');
  if (!nonEmpty(session_id)) throw new TypeError('runWorker requires a session_id');

  const log = deps.log ?? (() => {});
  const w = {
    session_id, agent_id, task: null, lease: null, run: null,
    stopping: false, renewalFailed: false, pausedTaskIds: [],
  };
  const done = [];
  let cycles = 0;
  /*
   * THE CURSOR, WITHOUT WHICH THE SAME EVENT IS HANDLED FOREVER.
   *
   * /wait filters on `since`. A worker that never advances it is re-told about
   * every assignment it has already finished, picks the task up again, and runs
   * it again -- which the end-to-end test caught immediately by returning the
   * same task three times. nextCursor deliberately HOLDS on an empty poll
   * rather than advancing to now, so an event landing in the gap is not
   * stepped over.
   */
  let cursor = null;

  while (cycles < maxCycles && !(w.stopping && !w.task)) {
    cycles += 1;
    const now = deps.now();
    w.pausedTaskIds = (await deps.pausedTaskIds?.(w)) ?? [];

    /*
     * BEAT EVERY CYCLE, AND SAY SO WHEN IT STOPS LANDING.
     *
     * The LEASE and the SESSION are different clocks. Renewing the lease keeps
     * the TASK; beating the session keeps the WORKER visible. This loop renewed
     * one and not the other, so a worker on a normal thirty-minute task
     * vanished from the roster after ten -- reported stale by wentStale, shown
     * offline to every reader, while working perfectly.
     *
     * GOING DARK IS LOGGED, NOT SWALLOWED. b6 lost a watcher this way: the
     * process was nominally alive, produced nothing, and stopped beating, and
     * it did not know. A worker that cannot tell whether its heartbeat is
     * landing keeps working while the system has written it off.
     */
    if (deps.heartbeat) {
      const hb = await deps.heartbeat({
        capacity: w.task ? 'busy' : 'idle',
        task_id: w.task?.task_id ?? null,
      });
      if (hb && hb.ok === false) {
        log('heartbeat', `FAILED x${hb.consecutiveFailures}: ${hb.detail}`
          + (hb.goingDark ? ' — THIS WORKER IS GOING DARK; the roster will call it offline' : ''));
      }
    }

    /*
     * MEASURE THE BUILDER, SO THE HOLD BAR HAS SOMETHING TO JUDGE.
     *
     * A bar wired into `nextAction` that is never handed an observation
     * returns `continue` on every cycle and never fires once -- rule 17, a
     * control that is consulted and concludes nothing. So this counts what it
     * can actually see and NOTHING ELSE.
     *
     * WHAT IT HONESTLY KNOWS: cycles spent on this attempt, and how long the
     * attempt has been held. Both are reset per task, because a step count
     * that accumulates across tasks would hold the bar against a successor for
     * its predecessor's work.
     *
     * WHAT IT DOES NOT: context consumption and files touched live inside the
     * agent process, not here. They arrive from `deps.observe` when a runtime
     * can supply them and stay absent when it cannot -- an invented number is
     * worse than a missing one, because the bar would then fire on fiction.
     *
     * `checkpointable` IS ASKED OF GIT, not assumed. It is the difference
     * between rotating and destroying an attempt's work, so it is the one
     * field that must never be a guess.
     */
    if (w.task) {
      /*
       * THE COUNTER RESETS PER ATTEMPT, AND THE KEY CARRIES THE ATTEMPT NUMBER
       * RATHER THAN JUST THE TASK ID.
       *
       * Keying on the task alone looks right until a ROTATED task comes back
       * to the same worker, which is the ordinary case: the id matches, the
       * counter is not reset, the successor inherits its predecessor's step
       * count and re-rotates within a few cycles -- spending the rotation
       * budget on a task nobody has actually spent any effort on yet.
       *
       * This is the sole owner of the reset. It used to be cleared in the
       * task-less branch below as well, and that redundancy made a mutation of
       * this line a no-op: every gap between two tasks happens to pass through
       * an idle cycle today. Rule 11 -- a protection that is only untested
       * because it is currently redundant is how a protection quietly stops
       * being one.
       */
      const attemptKey = `${w.task.task_id}#${Number.isInteger(w.task.attempt) ? w.task.attempt : 0}`;
      if (w.attemptOf !== attemptKey) {
        w.attemptOf = attemptKey;
        w.attemptCycle0 = cycles;
        w.attemptStartedAt = Date.parse(now);
      }
      const sha = nonEmpty(w.dir) ? await deps.headSha(w.dir) : null;
      const startedAt = Number.isFinite(w.attemptStartedAt) ? w.attemptStartedAt : null;
      const at = Date.parse(now);

      /*
       * BREADTH IS ASKED OF GIT, NOT OF THE BUILDER. The agent in the worktree
       * is not ours -- it is whatever the platform dispatched -- so it cannot
       * be asked to report on itself and does not need to be. `changedPaths`
       * returns null when it could not look, and null stays null: an empty
       * set would read as "well inside the limit" on exactly the runs where
       * the lookup broke.
       */
      const touched = nonEmpty(w.dir) && deps.changedPaths
        ? await deps.changedPaths(w.dir, w.task.base_sha)
        : null;

      const base = {
        steps: cycles - w.attemptCycle0,
        elapsedMs: startedAt !== null && Number.isFinite(at) ? at - startedAt : null,
        filesTouched: Array.isArray(touched) ? touched.length : null,
        rotations: Number.isInteger(w.task.attempt) ? w.task.attempt : 0,
        /* A commit that is not the base is work this worker actually produced. */
        checkpointable: Boolean(sha) && sha !== w.task.base_sha,
      };
      /*
       * `observe` IS HANDED WHAT THE LOOP ALREADY MEASURED, so a supplier can
       * see the loop's own numbers rather than re-deriving them from `w` and
       * drifting. It overrides them because a runtime with a real step counter
       * inside the agent process knows better than a cycle count does.
       */
      w.observed = { ...base, ...((await deps.observe?.(w, base)) ?? {}) };
    } else {
      /* `attemptOf` is deliberately NOT cleared here; see the reset above. */
      w.observed = null;
    }

    const decision = nextAction(w, { now });
    log(decision.action, decision.reason);

    /*
     * THE HOLD VERDICT TRAVELS WITH THE WORKER, because `returnPayload` has to
     * know an attempt was stopped by the bar rather than finishing. Without it
     * a held return is refused for having no finished run, and the decision
     * the machine just made cannot be carried out.
     */
    w.hold = decision.hold ?? null;

    switch (decision.action) {
      case ACTION.POLL: {
        const events = (await deps.waitForEvents({ ...w, since: cursor })) ?? [];
        cursor = nextCursor(events, cursor);
        for (const ev of events) {
          const take = actionableEvent(ev, w);
          if (!take.act) continue;
          const task = await deps.readTask(take.task_id);
          if (!task) { log('skip', `${take.task_id} vanished between event and read`); continue; }
          /*
           * THE AUTHORITY IS THE TASK ROW; THE EVENT IS A DOORBELL. The only
           * thing taken from the event is the token, because it is the only
           * thing the row cannot tell this process.
           */
          w.task = task;
          w.lease = { lease_token: take.lease_token ?? task.lease_token ?? null,
            lease_expires_at: task.lease_expires_at ?? null, leased_at: task.leased_at ?? null };
          break;
        }
        break;
      }

      case ACTION.START: {
        const dir = worktreePath(config.worktreeRoot, w.task.task_id);
        const prepared = await deps.prepareWorktree({ dir, task: w.task });
        if (!prepared?.ok) {
          // Cannot even set up: return it as a failure rather than sit on it.
          w.run = { done: true, ok: false, headSha: w.task.base_sha ?? null,
            error: `worktree setup failed: ${prepared?.error ?? 'unknown'}` };
          break;
        }
        w.dir = dir;
        w.run = await deps.startRun({
          cmd: config.cmd, args: config.args, cwd: dir,
          brief: taskBrief(w.task), timeoutMs: config.runTimeoutMs,
        });
        break;
      }

      case ACTION.WAIT: {
        w.run = await deps.pollRun(w.run);
        break;
      }

      case ACTION.PAUSE: {
        await deps.pollRun?.(w.run);
        break;
      }

      case ACTION.RENEW: {
        const r = await deps.renewLease({ task_id: w.task.task_id, lease_token: w.lease.lease_token });
        if (r?.ok) {
          w.lease = { ...w.lease, lease_expires_at: r.lease_expires_at };
          w.renewalFailed = false;
        } else {
          /*
           * NOT A RETRY. A refused renewal means somebody else holds this now;
           * retrying would at best succeed against a lease we no longer own.
           */
          w.renewalFailed = true;
          log('renew-failed', r?.detail ?? 'refused');
        }
        break;
      }

      case ACTION.RETURN: {
        if (nonEmpty(w.dir)) {
          const sha = await deps.headSha(w.dir);
          w.run = { ...w.run, headSha: sha ?? w.run.headSha ?? null };
        }
        const payload = returnPayload(w, { now: deps.now() });
        if (!payload.ok) {
          log('return-refused', payload.errors.join('; '));
          done.push({ task_id: w.task.task_id, outcome: 'not-returned', errors: payload.errors });
        } else {
          const res = await deps.returnWork(payload.body);
          log('returned', `${w.task.task_id} ${res?.state ?? ''}`);
          done.push({ task_id: w.task.task_id, outcome: payload.body.outcome, state: res?.state });
        }
        // Only when there IS one. Abandoning before the run started leaves w.dir
        // unset, and handing undefined to a real cleanup is how the wrong
        // directory gets removed.
        if (nonEmpty(w.dir)) await deps.cleanupWorktree?.(w.dir);
        w.task = null; w.lease = null; w.run = null; w.dir = null; w.renewalFailed = false;
        break;
      }

      case ACTION.ROTATE: {
        /*
         * HAND THE WORK OVER INTACT. A rotation is not a failure and not a
         * completion: the task goes back to the pool with its checkpoint
         * committed, and `claim_task` admits `returned`, so the next builder
         * picks it up at a fresh attempt.
         *
         * THE CHECKPOINT IS DERIVED FROM GIT, NEVER ASSUMED. `checkpointable`
         * is the runtime's claim that the work COULD be handed over; this is
         * where that claim is checked against the repository. If it turns out
         * there is no commit, rotating would discard the work -- so this falls
         * back to abandoning loudly rather than quietly losing an attempt.
         */
        const sha = nonEmpty(w.dir) ? await deps.headSha(w.dir) : null;
        const handover = rotationHandover({
          task_id: w.task.task_id,
          attempt: Number.isInteger(w.task.attempt) ? w.task.attempt : 0,
          checkpoint_sha: sha ?? null,
          findings: w.findings ?? [],
          required_regressions: w.requiredRegressions ?? [],
        });

        if (!handover.ok) {
          log('rotate-refused', handover.errors.join('; '));
          done.push({ task_id: w.task.task_id, outcome: 'rotate-refused', errors: handover.errors });
        } else {
          const res = await deps.returnWork({
            task_id: w.task.task_id,
            session_id: w.session_id,
            lease_token: w.lease.lease_token,
            head_sha: handover.handover.checkpoint_sha,
            outcome: 'rotated',
            notes: `ROTATED: ${decision.reason}\nhandover: ${JSON.stringify(handover.handover)}`,
          });
          log('rotated', `${w.task.task_id} -> attempt ${handover.handover.attempt} ${res?.state ?? ''}`);
          done.push({ task_id: w.task.task_id, outcome: 'rotated', handover: handover.handover, state: res?.state });
        }

        if (nonEmpty(w.dir)) await deps.cleanupWorktree?.(w.dir);
        w.task = null; w.lease = null; w.run = null; w.dir = null; w.renewalFailed = false; w.hold = null;
        break;
      }

      case ACTION.ABANDON: {
        /*
         * DISCARD, AND SAY SO. Nothing is submitted: the lease is gone, so the
         * task may be somebody else's now and our result is the output of a run
         * nobody is waiting for. The worktree still gets cleaned up — it is
         * ours regardless of who owns the task.
         */
        log('abandon', decision.reason);
        done.push({ task_id: w.task?.task_id ?? null, outcome: 'abandoned', reason: decision.reason });
        // Only when there IS one. Abandoning before the run started leaves w.dir
        // unset, and handing undefined to a real cleanup is how the wrong
        // directory gets removed.
        if (nonEmpty(w.dir)) await deps.cleanupWorktree?.(w.dir);
        w.task = null; w.lease = null; w.run = null; w.dir = null; w.renewalFailed = false;
        break;
      }

      case ACTION.STOP:
      default:
        w.stopping = true;
        break;
    }

    if (w.stopping && !w.task) break;
  }

  return { cycles, done };
}
