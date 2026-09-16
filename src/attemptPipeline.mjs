/**
 * ONE ATTEMPT, END TO END, WITH EVERY EFFECT INJECTED.
 *
 * This is the seam the worker needs and the only module here that expects a
 * caller. Everything else in this lane is reached through it, which is
 * deliberate: twelve modules each waiting for a call site is twelve entries in
 * an allowlist, and an allowlist that long stops being read.
 *
 * WHAT IT REFUSES TO DO, because each is a failure this project has already had:
 *
 *   It never asks the work whether the work succeeded. The executor reports how
 *   the process ENDED; the commit comes from git and the test counts come from
 *   the output. An agent's prose travels in `notes` and no branch below reads it.
 *
 *   It never disposes of a workspace it cannot account for. Accepted and clean
 *   is destroyed; anything else is quarantined with a reason. A failed attempt
 *   is evidence, and the cheapest way to lose an incident is to tidy up after it.
 *
 *   It never retries in place. A repeat is a new attempt with a new workspace,
 *   because a retry inside a dirty tree is how "it passes on the second run"
 *   becomes a property of the system rather than a question about it.
 *
 * THE LOOP DETECTOR IS CONSULTED, NOT OBEYED. It returns what it saw and the
 * caller decides, because only the caller knows whether a repeat is a worker
 * stuck or a scheduler legitimately re-running the same base after a revert.
 */

import { execute } from './executorAdapter.mjs';
import { guardExecution, OUTCOME } from './preExecutionGuard.mjs';
import { permissionScope, agentLaunch } from './agentPermissions.mjs';
import { collectEvidence } from './evidenceCollector.mjs';
import { verdictFor } from './resultEnvelope.mjs';
import { fingerprintAttempt } from './fingerprint.mjs';
import { observe } from './loopDetector.mjs';
import { buildReviewerPacket } from './reviewerPacket.mjs';
import { compact } from './toolOutput.mjs';
import { record, totals } from './tokenTelemetry.mjs';

/*
 * Shorter than the 900s default lease on purpose. A default that outlives the
 * authority granting it is not a default, it is a scheduled loss.
 */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Disposal outcomes, so a caller can branch on them rather than on prose. */
export const DISPOSAL = Object.freeze({
  DESTROYED: 'destroyed',
  QUARANTINED: 'quarantined',
  KEPT: 'kept',
});

/**
 * Run one attempt.
 *
 * `reviewer` is optional. Without one the attempt still produces an envelope and
 * a machine verdict -- review is a second opinion, not the only opinion, and a
 * missing reviewer must not make a failing attempt look unjudged.
 */
/**
 * `io.now` IS A CLOCK FUNCTION EVERYWHERE ELSE IN THIS FILE, and both places
 * below want an ISO timestamp instead.
 *
 * I passed the function straight through and the policy classifier, which
 * parses its `now`, got NaN and refused every request as unclassifiable. It
 * surfaced as "now is not a function" one layer further on, from a caller that
 * did supply the clock -- so the guard wiring committed earlier today would
 * have thrown for every real caller and passed every test, because the tests
 * supplied no clock at all and the `?? new Date()` fallback covered it.
 *
 * One name, two types, and the default hid the collision. Converted in one
 * place so the two callers cannot drift.
 */
function isoNow(io) {
  const t = typeof io?.now === 'function' ? io.now() : io?.now;
  if (typeof t === 'string') return t;
  return new Date(typeof t === 'number' ? t : Date.now()).toISOString();
}

export async function runAttempt({
  task,
  contract = null,
  executor,
  reviewer = null,
  workspaces,
  loopState = null,
  ledger = null,
  io = {},
}) {
  if (!task?.task_id) throw new TypeError('runAttempt: task.task_id required');
  if (!executor) throw new TypeError('runAttempt: an executor is required');
  if (!workspaces) throw new TypeError('runAttempt: a workspace manager is required');

  const taskId = task.task_id;
  const attempt = task.attempt ?? 0;

  /*
   * A RUN MAY NOT OUTLIVE THE LEASE THAT AUTHORISES IT.
   *
   * Reported by code-c from the live system: the default lease is 900 seconds
   * and the default run timeout was 1800, so a worker doing a normal-length task
   * loses its lease partway through and correctly discards finished work. The
   * failure is silent, expensive and looks like flakiness -- the task ran, the
   * tests passed, and the result was thrown away because the token had expired.
   *
   * So the deadline is checked against the lease rather than assumed to fit
   * inside it. Refusing before the work starts costs nothing; discovering it
   * after costs the whole attempt.
   */
  if (task.lease_ms !== undefined && task.lease_ms !== null) {
    const deadline = task.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    if (deadline >= task.lease_ms) {
      throw new RangeError(
        `runAttempt: timeout ${deadline}ms is not shorter than the lease ${task.lease_ms}ms; ` +
          'the lease would expire mid-run and the finished work would be discarded',
      );
    }
  }
  /*
   * THE PERMISSION DECISION HAPPENS HERE, BEFORE ANYTHING IS LAUNCHED.
   *
   * A screenshot on 2026-09-16 showed a coding agent sitting on "Do you want to
   * proceed?" for a local commit, on a machine nobody was watching. An agent
   * that asks at the moment it acts has put the blocker on somebody's laptop
   * instead of in a queue, where it would be visible and would survive a
   * restart. So a command class is decided BEFORE the executor starts and the
   * executor is launched already knowing the answer.
   *
   * Only commands the task declares up front can be pre-decided. That is a real
   * limit and it is stated rather than hidden: an agent choosing commands as it
   * goes needs the guard at its own tool boundary, which is the executor
   * adapter's job and not this function's. What this closes is the case where
   * the task already knew what it was going to run.
   */
  if (Array.isArray(task.commands) && task.commands.length) {
    const placement = {
      isDisposable: true,
      branch: task.branch ?? null,
      leaseValid: task.lease_valid !== false,
      fenceCurrent: task.fence_current !== false,
      task_id: taskId,
      project: task.project, repo: task.repo, lane: task.lane,
    };
    for (const c of task.commands) {
      const verdict = guardExecution(c, placement, ledger ?? [], { now: isoNow(io) });
      if (verdict.outcome !== OUTCOME.ALLOW) {
        /*
         * WAITING_APPROVAL, not a prompt and not a silent skip. The attempt
         * stops before it creates a workspace it would have to clean up, and
         * the reason travels as machine evidence rather than as prose.
         */
        return {
          taskId,
          attempt,
          verdict: 'blocked',
          blocked: {
            state: 'WAITING_APPROVAL',
            action: verdict.action,
            code: verdict.code,
            decider: verdict.decider ?? null,
            command: { file: c.file, args: c.args ?? [] },
            reason: verdict.reason,
          },
        };
      }
    }
  }

  const workspace = await workspaces.create({ taskId, baseSha: task.base_sha, attempt });

  /*
   * AN AGENT IS LAUNCHED ALREADY KNOWING WHAT IT MAY DO.
   *
   * The guard above covers commands the task named. An agent choosing commands
   * as it goes never reaches that check -- it asks its OWN permission system,
   * whose only answer is a prompt on a machine nobody is watching. So when the
   * task names an engine rather than an argv, the argv is BUILT here from the
   * same guard: the scope is derived, never transcribed, so a policy change
   * moves both halves together instead of leaving two lists to disagree.
   */
  const launched = (!task.argv && task.engine)
    ? agentLaunch(task.engine, {
        binary: task.binary ?? null,
        scope: permissionScope(
          {
            isDisposable: true,
            branch: task.branch ?? null,
            leaseValid: task.lease_valid !== false,
            fenceCurrent: task.fence_current !== false,
            task_id: taskId,
            project: task.project, repo: task.repo, lane: task.lane,
          },
          ledger ?? [],
          { now: isoNow(io) },
        ),
        extraArgs: task.engine_args ?? [],
      })
    : null;

  const spec = {
    taskId,
    attempt,
    cwd: workspace.path,
    ...(launched ? { argv: [launched.file, ...launched.args] } : {}),
    timeoutMs: task.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    ...(task.argv ? { argv: task.argv } : {}),
    ...(task.prompt ? { prompt: task.prompt } : {}),
    ...(task.env ? { env: task.env } : {}),
  };

  const execution = await execute(executor, spec, io);

  /*
   * Output is compacted before anything else touches it. A spill keeps the whole
   * log retrievable and hands on a reference; without a sink it is marked
   * incomplete rather than quietly shortened, because a truncated log that reads
   * as a finished one is indistinguishable from a finished one to the next
   * reader.
   */
  const limit = io.outputLimit ?? 8 * 1024;
  const stdout = await compact(execution.stdout ?? '', {
    limit,
    sink: io.sink ?? null,
    label: 'stdout',
  });
  const stderr = await compact(execution.stderr ?? '', {
    limit,
    sink: io.sink ?? null,
    label: 'stderr',
  });

  const envelope = await collectEvidence({ taskId, attempt, execution, contract, io });
  const verdict = verdictFor(envelope);

  const fingerprint = fingerprintAttempt({
    taskId,
    baseSha: task.base_sha ?? null,
    filesChanged: envelope.filesChanged,
    outcome: envelope.outcome,
    exitCode: envelope.exitCode,
    failureText: stderr.kind === 'inline' ? stderr.text : `${stderr.head}\n${stderr.tail}`,
    testSummary: envelope.tests,
  });
  const looped = loopState === null ? null : observe(loopState, fingerprint);

  const packet = buildReviewerPacket({
    envelope,
    diffRef: envelope.commit === null ? null : `diff://${taskId}@${envelope.commit}`,
    logRef: stdout.kind === 'spilled' ? stdout.ref : null,
    contract,
  });
  const review = reviewer === null ? null : await reviewer.review(packet);

  /*
   * ACCEPTED MEANS BOTH AGREED. A reviewer cannot rescue an attempt the machine
   * evidence rejects: the evidence is the thing neither side can argue with, and
   * a reviewer that can overrule it is a reviewer that can be talked round.
   */
  const accepted =
    verdict.verdict === 'accept' && (review === null || review.decision === 'accept');

  let disposal;
  if (accepted) {
    const result = await workspaces.destroy(workspace);
    disposal = { outcome: DISPOSAL.DESTROYED, path: null, detail: result.reason };
  } else {
    const reason = [
      `attempt ${attempt} of ${taskId} was not accepted`,
      `machine: ${verdict.reasons.join(', ') || 'accept'}`,
      review === null
        ? 'reviewer: none'
        : `reviewer: ${review.decision} ${review.findings.join(', ')}`,
      looped?.loop ? `loop: ${looped.loop.kind}` : 'loop: none',
    ].join('\n');
    const path = await workspaces.quarantine(workspace, reason);
    disposal = { outcome: DISPOSAL.QUARANTINED, path, detail: null };
  }

  const spent =
    ledger === null
      ? null
      : totals(
          record(ledger, {
            id: `${taskId}:${attempt}`,
            phase: 'execute',
            attempt,
            input: io.usage?.input ?? 0,
            output: io.usage?.output ?? 0,
            cachedInput: io.usage?.cachedInput ?? 0,
          }),
        );

  return Object.freeze({
    taskId,
    attempt,
    accepted,
    envelope,
    verdict,
    review,
    packet,
    fingerprint,
    loop: looped?.loop ?? null,
    loopState: looped?.state ?? loopState,
    disposal,
    stdout,
    stderr,
    spent,
  });
}
