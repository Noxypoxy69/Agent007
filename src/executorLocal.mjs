/**
 * THE LOCAL EXECUTOR: one real adapter, so the contract in executorAdapter.mjs
 * is something a thing satisfies rather than a description of nothing.
 *
 * IT DOES NOT RUN PROCESSES ITSELF. `src/exec.mjs` already does that, with the
 * shell disabled, secrets on stdin rather than argv, and the PowerShell module
 * path repair that took a day to find. A second child-process runner would be a
 * second set of those decisions, and the one that got them wrong would be the
 * one nobody was looking at. This file is the translation layer and nothing else.
 *
 * WHAT IT TRANSLATES, and why that is the whole job. The runner answers with
 * `ok`, `code`, `killed` and `signal`. The envelope needs an OUTCOME, and the
 * one mapping that must never happen is a process the runner shot being
 * reported as a clean exit. So a killed run becomes `timeout`, a signal death
 * becomes `crashed`, and neither carries an exit code -- null, not zero.
 *
 * THE ENVIRONMENT IS AN ALLOW-LIST HERE, unlike every other caller of the
 * runner. Those are git and PowerShell commands that need the ambient
 * environment. This one starts a coding agent in a disposable worktree, and an
 * agent that inherits the daemon's environment inherits its credentials.
 */

import { run as execRun } from './exec.mjs';

/**
 * `run` is injected so the mapping above can be tested against answers a real
 * runner produces only under conditions a test cannot arrange: a process killed
 * at its deadline, a signal death, a spawn that never started.
 */
export function createLocalExecutor({ run = execRun, maxOutputBytes = 256 * 1024 } = {}) {
  return {
    id: 'local',
    capabilities: ['shell', 'write', 'commit'],
    async run(spec, io = {}) {
      const now = io.now ?? (() => Date.now());
      const startedAt = now();

      const answer = await run(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        timeoutMs: spec.timeoutMs,
        maxBuffer: maxOutputBytes,
        // Nothing the spec did not name. PATH is the one thing a process needs
        // to find anything at all, and an absent one is an empty string rather
        // than the parent's.
        env: { PATH: spec.env?.PATH ?? '', ...(spec.env ?? {}) },
        ...(spec.prompt === undefined ? {} : { input: spec.prompt }),
      });

      const durationMs = now() - startedAt;
      const stdout = answer.stdout ?? '';
      const stderr = answer.stderr ?? '';

      /*
       * A PROMPT IS CHECKED BEFORE THE EXIT CODE, because the dangerous case is
       * the one that succeeded. An agent that asked, got end-of-file and took
       * its default exits zero, and reading the code first files that as a
       * clean run of work nobody authorised.
       */
      if (answer.interactivePrompt) {
        return {
          outcome: 'prompted',
          prompt: answer.interactivePrompt,
          stdout, stderr, durationMs,
        };
      }
      if (answer.killed) {
        /*
         * The runner enforced the deadline. Whatever the platform reported as an
         * exit code describes the kill, not the work, so none travels.
         */
        return { outcome: 'timeout', stdout, stderr, durationMs };
      }
      if (typeof answer.code !== 'number') {
        /*
         * Died without exiting, or NEVER STARTED. Either way there is no code --
         * but those two are not the same thing downstream, and the runner
         * already knows which. exec.mjs hands back `error` on a failed spawn,
         * and dropping it was how the most common permanent failure in this
         * system became indistinguishable from a transient one.
         *
         * This is the case that stops Loop B. The environment is an allow-list
         * here, so PATH is empty unless the spec named one, and agentLaunch
         * yields a BARE executable whenever a task names an engine with no
         * binary configured (`file: binary ?? engine`). It cannot resolve, and
         * a missing binary does not become present on the second attempt.
         *
         * Null when the runner gave no reason: unknown, not "no reason".
         */
        return {
          outcome: 'crashed',
          signal: answer.signal ?? null,
          ...(answer.error
            ? { failure: { kind: 'spawn-failed', message: String(answer.error) } }
            : {}),
          stdout, stderr, durationMs,
        };
      }
      return { outcome: 'exited', exitCode: answer.code, stdout, stderr, durationMs };
    },
  };
}
