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
import { decideReview, fixTaskFor, mutationBetween, REVIEW_DECISION } from './reviewDecision.mjs';

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
 */
export const DEFAULT_REVIEW_TIMEOUT_MS = 10 * 60 * 1000;

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
      : await reviewer.review(packet, { path: workspace.path, readOnly: true });
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
  let disposal;
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
    disposal,
    submitted,
  });
}
