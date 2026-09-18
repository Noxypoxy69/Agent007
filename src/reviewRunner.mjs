/*
 * THE REVIEWER RUNTIME. The thing that claims the review lease nothing claimed.
 *
 * `claim_review`, `renew_review_lease` and `expire_dead_reviews` have been in
 * the database since 2026-09-15 with no caller anywhere -- the migration that
 * added them says so itself. This is the caller. One review, end to end: claim
 * the lease, build the packet, run a reviewer in a FRESH workspace, submit the
 * decision under the lease that authorised it.
 *
 * WHAT IT REFUSES TO DO, and each is structural rather than advisory:
 *
 *   IT NEVER DECIDES THE LEASE ITSELF. `claim_review` is asked and its answer is
 *   honoured, including its refusals -- self-review, wrong state, already under
 *   review. A JS copy of those rules would be a second implementation of the
 *   one property whose violation leaves no trace afterwards, and the owner
 *   ruled SQL is the authority. So there is no local pre-check to disagree.
 *
 *   IT NEVER LETS A REVIEWER EDIT. The workspace is photographed before and
 *   after; anything that moved VOIDS the review and nothing is submitted. Not
 *   "rejects" -- voids: a reviewer that edited the tree reviewed something other
 *   than what was handed in, and its verdict is about a different artefact.
 *
 *   IT NEVER RETRIES IN PLACE. FIX_REQUIRED produces a separate task with its
 *   own id, its own base and its own review. This function never calls back
 *   into the attempt pipeline, and it never touches the reviewed task's attempt
 *   counter.
 *
 *   IT NEVER READS THE WORKER'S PROSE. The packet is built by
 *   `buildReviewerPacket`, whose `assertNoProse` runs on every build. The notes
 *   are not passed to the reviewer, not summarised for it and not in the
 *   packet -- and the runner refuses to continue if they turn up in one.
 *
 * A CRASH IS RECOVERABLE AND THAT IS THE LEASE'S JOB, NOT THIS FUNCTION'S. If
 * this process dies mid-review the lease is simply never submitted; it expires
 * and `expire_dead_reviews` returns the work to the review pool. There is
 * deliberately no local "release" -- a released-on-exit lease is a lease that a
 * kill -9 does not release, so the only recovery path would be one that only
 * works when nothing went wrong.
 */

import { buildReviewerPacket } from './reviewerPacket.mjs';
import {
  decideReview, fixTaskFor, mutationBetween, resolveFindings, REVIEW_DECISION,
} from './reviewDecision.mjs';

/** Where a review stopped, so a caller branches on a value and not on prose. */
export const STAGE = Object.freeze({
  CLAIM: 'claim',
  EVIDENCE: 'evidence',
  REVIEW: 'review',
  SUBMIT: 'submit',
  DONE: 'done',
});

/*
 * Shorter than the 1800s review lease the SQL default mints, for the same
 * reason the attempt pipeline's run timeout is shorter than its work lease: a
 * deadline that outlives the authority granting it is a scheduled loss.
 *
 * THIS CONSTANT EXISTED FOR HOURS WITH THAT COMMENT AND NO CONSUMER. Nothing
 * read it, nothing bounded a reviewer, and the sentence above described an
 * intention as though it were a behaviour -- which is the defect the review
 * lease migration was written to fix ("a column with no writer is not a
 * feature") reappearing one layer up. Found by auditing my own module for
 * declarations nothing references.
 */
export const DEFAULT_REVIEW_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Stop waiting after `ms`. The promise is NOT cancelled -- it cannot be -- so
 * this bounds how long the runner waits, not how long the reviewer runs.
 *
 * THAT DISTINCTION IS THE POINT. A hung reviewer keeps running; what must not
 * happen is the runner sitting behind it until the lease expires and then
 * submitting a verdict against a credential that is no longer current. Timing
 * out means we do not have a verdict, so nothing is submitted.
 */
function withDeadline(promise, ms) {
  let timer = null;
  /*
   * THE TIMER IS NOT UNREF'D, AND THE FIRST VERSION OF THIS WAS.
   *
   * unref() looks like tidiness -- do not hold the process open for a timer --
   * and it removes the deadline entirely: with nothing else pending, the event
   * loop drains, the process tears down before the timer fires, and the race
   * never settles. The test for a hung reviewer caught it at once with "promise
   * resolution is still pending but the event loop has already resolved". A
   * deadline that only fires when something else happens to be keeping the
   * loop alive is not a deadline. clearTimeout in the finally below is what
   * stops it outliving the race.
   */
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`reviewer exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

function fail(message) {
  throw new TypeError(`review runner: ${message}`);
}

/**
 * Photograph a workspace. `head` is the commit and `dirty` the porcelain list;
 * either failing yields null, which `mutationBetween` reads as a mutation of
 * unknown kind rather than as "nothing moved".
 */
async function fingerprint(workspace, io) {
  const probe = io.workspaceGit;
  if (!probe) return null;
  try {
    const head = await probe.headSha(workspace.path);
    const dirty = await probe.dirtyFiles(workspace.path);
    if (typeof head !== 'string' || !Array.isArray(dirty)) return null;
    return { head, dirty };
  } catch {
    return null;
  }
}

/**
 * Run one review.
 *
 * `bridge` is the transport: `claimReview` and `submitReview`, both of which
 * answer `{ ok, ... }` rather than throwing on a refusal, because a refusal is
 * an ordinary outcome here and an exception is not a thing a caller branches on
 * carefully.
 *
 * `envelopeFor` hands back the result envelope the worker's attempt produced.
 * It is the MACHINE EVIDENCE and it is the only account of the work anything
 * below reads.
 */
export async function runReview({
  task,
  reviewerSession,
  reviewer,
  workspaces,
  bridge,
  envelopeFor,
  contract = null,
  leaseSeconds = 1800,
  timeoutMs = DEFAULT_REVIEW_TIMEOUT_MS,
  io = {},
}) {
  if (!task?.task_id) fail('runReview: task.task_id required');
  if (typeof reviewerSession !== 'string' || reviewerSession.trim() === '') {
    fail('runReview: a reviewer session id is required');
  }
  if (!bridge?.claimReview || !bridge?.submitReview) {
    fail('runReview: a bridge with claimReview and submitReview is required');
  }
  if (!workspaces) fail('runReview: a workspace manager is required');
  if (typeof envelopeFor !== 'function') fail('runReview: envelopeFor is required');

  const taskId = task.task_id;

  /*
   * A REVIEW MAY NOT OUTLIVE THE LEASE THAT AUTHORISES IT, checked before the
   * lease is taken rather than discovered at the submit.
   *
   * Exactly the guard runAttempt carries for the work lease, and it was missing
   * here. Without it a reviewer reads for longer than 1800 seconds, does the
   * whole job, and the fenced submit refuses a token that expired mid-read --
   * the work is lost and the failure reads as a race rather than as a deadline
   * nobody set. Refusing before the claim costs nothing.
   */
  if (timeoutMs >= leaseSeconds * 1000) {
    throw new RangeError(
      `runReview: timeout ${timeoutMs}ms is not shorter than the review lease `
      + `${leaseSeconds * 1000}ms; the lease would expire mid-review and the decision `
      + 'would be refused by the fence after the work was done',
    );
  }

  /*
   * THE LEASE FIRST, BEFORE A WORKSPACE EXISTS.
   *
   * A workspace created before the claim is a workspace to clean up after a
   * refusal, and the refusals here are the common case: another reviewer holds
   * it, the work is not returned, the caller wrote it. Nothing is created until
   * the database says this session may review.
   */
  const claim = await bridge.claimReview({
    task_id: taskId,
    reviewer_session: reviewerSession,
    lease_seconds: leaseSeconds,
  });
  if (!claim?.ok) {
    return Object.freeze({
      ok: false,
      stage: STAGE.CLAIM,
      taskId,
      reason: claim?.reason ?? 'claim-refused',
      detail: claim?.detail ?? null,
      submitted: null,
    });
  }
  const reviewToken = claim.review_lease_token;

  /*
   * EVIDENCE OR NOTHING. An absent envelope is not an empty one: it means
   * nobody collected the machine's account of the attempt, and a review with no
   * evidence would have only the agent's word left to read, which is the exact
   * failure the packet exists to prevent.
   *
   * The lease is NOT released here. There is no release verb, deliberately (see
   * the header), so this stops and lets the reaper return the work.
   */
  const envelope = await envelopeFor(task);
  if (!envelope) {
    return Object.freeze({
      ok: false,
      stage: STAGE.EVIDENCE,
      taskId,
      reviewToken,
      reason: 'evidence:absent',
      detail: 'no result envelope for the returned attempt; there is nothing machine-checkable '
        + 'to review, and the agent\'s notes are not a substitute',
      submitted: null,
    });
  }

  /*
   * A FRESH WORKSPACE, AT THE COMMIT UNDER REVIEW.
   *
   * Fresh because a reviewer inheriting the worker's tree inherits its
   * untracked files, its node_modules and its half-applied edits, and would be
   * reading a state no reviewer of the submitted commit should see. At the
   * REVIEWED commit rather than the task's base, because the reviewed commit is
   * what was handed in.
   */
  const baseSha = envelope.commit ?? task.returned_head_sha ?? task.base_sha;
  const workspace = await workspaces.create({
    taskId,
    baseSha,
    attempt: envelope.attempt ?? task.attempt ?? 0,
  });

  const before = await fingerprint(workspace, io);

  const packet = buildReviewerPacket({
    envelope,
    diffRef: envelope.commit === null ? null : `diff://${taskId}@${envelope.commit}`,
    logRef: io.logRef ?? null,
    contract,
  });

  /*
   * THE REVIEWER SEES THE PACKET AND A PATH. It does not see the task row, the
   * notes, the returning session or who assigned the work -- all of which are
   * the author's account or a route to it.
   */
  let review = null;
  let crashed = null;
  try {
    review = reviewer === null || reviewer === undefined
      ? null
      : await withDeadline(
          reviewer.review(packet, { path: workspace.path, readOnly: true }),
          timeoutMs,
        );
  } catch (error) {
    crashed = error;
  }

  const after = await fingerprint(workspace, io);
  const mutation = mutationBetween(before, after);

  /*
   * A REVIEWER THAT EDITED IS VOID, AND VOID BEFORE ANYTHING IS SUBMITTED.
   *
   * Checked ahead of the crash below on purpose: a reviewer that edits and then
   * throws must not be filed as a crash, because the tree it left behind is the
   * more serious of the two findings and the one somebody has to look at.
   */
  if (mutation !== null) {
    const kept = await workspaces.quarantine(
      workspace,
      `review of ${taskId} voided: the reviewer mutated its workspace (${mutation.kind}: ${mutation.detail})`,
    );
    return Object.freeze({
      ok: false,
      stage: STAGE.REVIEW,
      taskId,
      reviewToken,
      reason: 'reviewer:mutated-workspace',
      detail: `${mutation.kind}: ${mutation.detail}`,
      mutation,
      quarantined: kept,
      submitted: null,
    });
  }

  if (crashed !== null) {
    const kept = await workspaces.quarantine(
      workspace,
      `review of ${taskId} crashed: ${crashed?.message ?? crashed}`,
    );
    return Object.freeze({
      ok: false,
      stage: STAGE.REVIEW,
      taskId,
      reviewToken,
      reason: 'reviewer:crashed',
      detail: crashed?.message ?? String(crashed),
      quarantined: kept,
      submitted: null,
    });
  }

  const decision = decideReview({ packet, review });

  /*
   * REVIEWING A FIX TASK CLOSES THE FINDINGS IT CARRIED, AND ONLY THIS CLOSES
   * THEM.
   *
   * resolveFindings existed with tests and NO CALLER for the whole of its first
   * day -- an orphan export inside a module that is otherwise reachable, so the
   * module graph could not see it. Its own docstring claimed to be "the only
   * way" a finding is closed, which was true and worthless: nothing closed one
   * at all. A pure function's tests pass whether or not anything calls it.
   *
   * It belongs here. A task carrying `fix_of` is a fix, and accepting it is the
   * moment its findings stop being open. resolveFindings refuses when the
   * reviewer is the session that returned the fix, which is the fixer -- so the
   * rule "a fixer may not resolve its own finding" is enforced on a real path
   * rather than asserted in a comment.
   */
  let resolved = null;
  if (task.fix_of) {
    resolved = resolveFindings({
      fixTask: { ...task, fixed_by: task.returned_by ?? null, findings: task.findings ?? [] },
      review: { decision: decision.decision, reviewer: reviewerSession },
    });
  }

  const fixTask = decision.decision === REVIEW_DECISION.FIX_REQUIRED
    ? fixTaskFor({
        task,
        packet,
        decision,
        raisedBy: reviewerSession,
        now: typeof io.now === 'function' ? new Date(io.now()).toISOString() : null,
      })
    : null;

  /*
   * THE FENCED SUBMIT. The token minted by the claim travels with the decision,
   * and the far end compares it. A review whose lease expired mid-read is
   * refused HERE rather than silently overwriting a decision somebody else has
   * since made -- the review half of the zombie catch the work lease already
   * has.
   *
   * A LOST RACE IS NOT A SUCCESS. `ok:false` from the far end is returned as a
   * refusal with its reason, never smoothed into a pass, and never retried:
   * retrying a superseded token cannot succeed and a retry loop here is how a
   * stale decision eventually lands.
   */
  const submitted = await bridge.submitReview({
    task_id: taskId,
    review_lease_token: reviewToken,
    decision: decision.decision,
    reasons: [...decision.reasons],
    reviewer_session: reviewerSession,
    resolves: resolved?.resolved ? [...resolved.resolved] : [],
    head_sha: envelope.commit ?? null,
    fix_task: fixTask,
  });

  /*
   * The workspace goes either way, and it is not evidence: it is a checkout of
   * a commit that already exists, containing nothing the reviewer made -- the
   * check above is what guarantees that. The attempt's own workspace, which
   * does hold evidence, is the attempt pipeline's to quarantine and this never
   * touches it.
   */
  /*
   * DISPOSAL MAY NOT TURN A LANDED REVIEW INTO A REPORTED FAILURE.
   *
   * The submit above is durable, fenced and one-shot. Everything after it is
   * tidying, and tidying that throws would propagate out of this function and
   * tell the caller the review failed -- for a decision the database has
   * already recorded. CLAUDE.md names this exactly: "Reporting failure for
   * completed work is worse than failing outright, because the retry is what
   * corrupts the picture." The retry here cannot even succeed: the task has
   * left `returned`, so claim_review answers `state` and a human goes looking
   * for a race that never happened.
   *
   * A workspace that could not be disposed of is KEPT and said so. A directory
   * left behind is a cheaper problem than a lost verdict.
   */
  let disposal;
  try {
    if (submitted?.ok) {
      const result = await workspaces.destroy(workspace);
      disposal = { outcome: 'destroyed', detail: result?.reason ?? null };
    } else {
      const kept = await workspaces.quarantine(
        workspace,
        `review of ${taskId} was not recorded: ${submitted?.reason ?? 'submit-refused'}`,
      );
      disposal = { outcome: 'quarantined', detail: kept };
    }
  } catch (error) {
    disposal = {
      outcome: 'kept',
      detail: `disposal failed and was not allowed to mask the outcome: ${error?.message ?? error}`,
      path: workspace.path,
    };
  }

  if (!submitted?.ok) {
    return Object.freeze({
      ok: false,
      stage: STAGE.SUBMIT,
      taskId,
      reviewToken,
      reason: submitted?.reason ?? 'submit-refused',
      detail: submitted?.detail ?? null,
      decision,
      review,
      packet,
      fixTask,
      disposal,
      submitted,
    });
  }

  return Object.freeze({
    ok: true,
    stage: STAGE.DONE,
    taskId,
    reviewToken,
    decision,
    review,
    packet,
    fixTask,
    resolved,
    disposal,
    submitted,
  });
}
