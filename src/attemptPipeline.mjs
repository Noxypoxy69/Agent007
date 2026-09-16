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
import { collectEvidence } from './evidenceCollector.mjs';
import { verdictFor } from './resultEnvelope.mjs';
import { fingerprintAttempt } from './fingerprint.mjs';
import { observe } from './loopDetector.mjs';
import { buildReviewerPacket } from './reviewerPacket.mjs';
import { compact } from './toolOutput.mjs';
import { record, totals } from './tokenTelemetry.mjs';

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
  const workspace = await workspaces.create({ taskId, baseSha: task.base_sha, attempt });

  const spec = {
    taskId,
    attempt,
    cwd: workspace.path,
    timeoutMs: task.timeout_ms ?? 30 * 60 * 1000,
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
