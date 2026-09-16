/*
 * WHAT A REVIEW DECIDES, AS A PURE FUNCTION.
 *
 * The runner next door does the effects -- lease, workspace, submit. Everything
 * that DECIDES lives here, because `supabase/functions/mcp/index.ts` is Deno-only
 * and cannot be imported by the suite, and a guard nobody can import is a guard
 * nobody has watched fail. Same reason `canAssign` and `canDecidePermission`
 * live in `src/`.
 *
 * IT IS NOT A SECOND IMPLEMENTATION OF THE REVIEW LEASE. Whether this session
 * may review this task is decided by `claim_review` in Postgres and by nothing
 * else -- the owner ruled on 2026-09-16 that SQL stays authority for leases, and
 * `src/runtime.mjs` is carried as a test oracle specifically so that it does NOT
 * acquire a caller. So there is no `canClaimReview` here. The runner asks the
 * database and honours the answer it gets.
 *
 * WHAT HAS NO SQL COUNTERPART, and therefore belongs here:
 *
 *   - three outcomes rather than two, and which evidence produces which
 *   - that a reviewer cannot accept what the machine rejected
 *   - that FIX_REQUIRED builds a SEPARATE task rather than another attempt
 *   - that a finding is closed by a review of the fix and never by its fixer
 */

/**
 * The three outcomes. A reviewer that can only accept is decoration and one
 * that can only refuse is an outage, so both refusals are real values here and
 * both are exercised in the tests.
 *
 * REJECT AND FIX_REQUIRED ARE NOT SEVERITY GRADES. They are different because
 * the work that follows them is different: a fix task starts FROM a commit, so
 * an attempt that produced no commit has nothing to hand a fixer. That is the
 * whole distinction and it is decided from evidence, not from how bad the
 * findings read.
 */
export const REVIEW_DECISION = Object.freeze({
  ACCEPT: 'accept',
  FIX_REQUIRED: 'fix_required',
  REJECT: 'reject',
});

function fail(message) {
  throw new Error(`review decision: ${message}`);
}

/**
 * Decide, from the packet and the reviewer's answer.
 *
 * `review` may be null: a review stage with no reviewer attached must not make
 * a rejected attempt look unjudged, so the machine verdict decides alone and
 * the absence is carried in the reasons rather than hidden.
 */
export function decideReview({ packet, review = null }) {
  if (!packet || typeof packet !== 'object') fail('a reviewer packet is required');
  const machine = packet.machineVerdict;
  if (!machine || !Array.isArray(machine.reasons)) fail('the packet carries no machine verdict');

  const reasons = [];
  for (const reason of machine.reasons) reasons.push(`machine:${reason}`);

  if (review !== null) {
    if (typeof review.decision !== 'string') fail('a review must carry a decision');
    if (!Array.isArray(review.findings)) fail('a review must carry findings, even an empty list');
    if (review.decision !== 'accept') {
      for (const finding of review.findings) reasons.push(`reviewer:${finding}`);
      /*
       * A reviewer that refuses and names nothing is refusing without evidence,
       * which is the mirror of accepting without it. Give the refusal a reason
       * so the fix task has something to act on.
       */
      if (review.findings.length === 0) reasons.push('reviewer:unexplained-refusal');
    }
  }

  if (reasons.length === 0) {
    return Object.freeze({ decision: REVIEW_DECISION.ACCEPT, reasons: Object.freeze([]) });
  }

  /*
   * NOTHING TO FIX MEANS NOTHING TO FIX.
   *
   * `evidence.commit` is the commit the work actually produced, read from git
   * by the evidence collector rather than claimed by the agent. Absent, there
   * is no tree for a fixer to start from, and a fix task pointing at the
   * original base is not a fix -- it is the same task again wearing a new id,
   * which is precisely the retry-in-disguise this stage exists to prevent.
   */
  const decision = packet.evidence?.commit
    ? REVIEW_DECISION.FIX_REQUIRED
    : REVIEW_DECISION.REJECT;

  return Object.freeze({ decision, reasons: Object.freeze(reasons) });
}

/**
 * THE SEPARATE TASK. Not a retry, not another attempt, not the same row.
 *
 * A retry inside the attempt would reuse the workspace and the lease that the
 * review has just finished judging, and the finding would be resolved by
 * whoever happened to still be holding them. A new task has its own lease, its
 * own workspace and -- the part that matters -- its own review, which is the
 * only thing that can close the finding.
 *
 * It bases on the REVIEWED COMMIT and not on the original base, so the fixer
 * starts from the work rather than from scratch. `decideReview` above has
 * already guaranteed that commit exists for this branch.
 */
export function fixTaskFor({ task, packet, decision, raisedBy, now = null }) {
  if (!task?.task_id) fail('fixTaskFor needs the reviewed task');
  if (decision?.decision !== REVIEW_DECISION.FIX_REQUIRED) {
    fail(`fixTaskFor called for a ${JSON.stringify(decision?.decision ?? null)} decision`);
  }
  const base = packet?.evidence?.commit;
  if (!base) fail('a fix task needs the reviewed commit as its base');

  /*
   * A FULL SHA, REFUSED HERE RATHER THAN BY THE DATABASE.
   *
   * agentbridge.tasks constrains base_sha to exactly 40 hex characters, and
   * submit_review refuses a shorter one with `fix-task-base`. But the result
   * envelope this value comes from permits SEVEN to sixty-four -- deliberately,
   * for abbreviated shas elsewhere -- so an executor reporting a short commit
   * is a shape the caller can legitimately hold.
   *
   * Left to the far end, that refusal arrives AFTER the review has been done
   * and the lease spent, and the reviewer has nothing to show for it. Failing
   * at decision time costs the caller nothing and loses no work.
   *
   * FOUND BY AUDITING THE FAKE BRIDGE AGAINST THE APPLIED SQL rather than by a
   * test: I added the far-end refusal while auditing the migration and never
   * propagated it back here, so every test used a 40-character sha and this
   * path had never run. That is the source-against-production drift this
   * repository is scarred by, committed inside the hour I wrote a commit
   * message about it.
   */
  if (!/^[0-9a-f]{40}$/.test(base)) {
    fail(
      `a fix task needs a full 40-character commit to start from, got ${JSON.stringify(base)}; `
      + 'the task table refuses anything else and the review lease would be spent discovering it',
    );
  }
  if (typeof raisedBy !== 'string' || raisedBy.trim() === '') fail('a finding needs a reviewer');

  /*
   * A DISTINCT ID, DERIVED FROM THE COMMIT UNDER REVIEW.
   *
   * Derived rather than random so that re-running a review of the same commit
   * produces the same fix task id instead of a second one -- a duplicate
   * delivery after a crash is the ordinary case here, not the exotic one.
   * Distinct from the original because a fix that reuses the task id IS the
   * retry this function exists to refuse.
   */
  const fixId = `${task.task_id}+fix@${String(base).slice(0, 12)}`;
  if (fixId === task.task_id) fail('the fix task id collided with the task it fixes');

  /*
   * THE FIX INHERITS THE REVIEWED TASK'S PATH CONTRACT, AND IT IS NOT A
   * CONVENIENCE. An EMPTY ALLOW-LIST MEANS NOTHING IS ALLOWED -- pathViolations
   * in evidenceCollector.mjs is explicit about it, because a contract that
   * failed to load must not read as permission. So a fix task that does not
   * carry one is a task on which every file the fixer touches is a violation:
   * the machine verdict rejects every attempt, forever, and the loop looks busy
   * while nothing can ever pass. A fix to the same work has the same scope.
   */
  return Object.freeze({
    task_id: fixId,
    state: 'runnable',
    // a new task counts its own attempts; it never inherits the reviewed one's
    attempt: 0,
    base_sha: base,
    lane_id: task.lane_id ?? null,
    repo_id: task.repo_id ?? null,
    allowed_paths: Object.freeze([...(task.allowed_paths ?? [])]),
    forbidden_paths: Object.freeze([...(task.forbidden_paths ?? [])]),
    shared_paths: Object.freeze([...(task.shared_paths ?? [])]),
    title: `Fix findings raised on ${task.task_id}`,
    fix_of: task.task_id,
    fix_of_attempt: packet.attempt ?? null,
    raised_by: raisedBy,
    findings: Object.freeze([...decision.reasons]),
    /*
     * The fixer is not permitted to declare the finding closed. This flag is
     * the statement of that; `resolveFindings` below is the only thing in this
     * module that produces a resolved finding, and it refuses the fixer.
     */
    requires_review: true,
    created_at: now,
  });
}

/**
 * CLOSE A FINDING, AND THE ONLY WAY TO.
 *
 * A fixer may not resolve its own finding. The comparison is one line; the
 * property is that there is no OTHER line anywhere that turns a finding into a
 * resolved one, so a fixer cannot reach the outcome by another route.
 *
 * `fixedBy` is the session that returned the fix. It comes from the task row,
 * which the fixer does not write -- a fixer that could name its own reviewer
 * would be back where it started.
 */
export function resolveFindings({ fixTask, review }) {
  if (!fixTask?.fix_of) fail('resolveFindings needs a fix task');
  if (!review || typeof review.decision !== 'string') fail('resolveFindings needs a review');
  const reviewer = review.reviewer;
  if (typeof reviewer !== 'string' || reviewer.trim() === '') {
    fail('a review that closes a finding must name its reviewer');
  }
  const fixedBy = fixTask.fixed_by ?? null;
  if (fixedBy !== null && fixedBy === reviewer) {
    fail(`${reviewer} fixed this and cannot also decide that the finding is closed`);
  }
  if (review.decision !== REVIEW_DECISION.ACCEPT) {
    return Object.freeze({ resolved: Object.freeze([]), open: Object.freeze([...fixTask.findings]) });
  }
  return Object.freeze({
    resolved: Object.freeze([...fixTask.findings]),
    open: Object.freeze([]),
  });
}

/**
 * DID THE REVIEWER TOUCH THE CODE?
 *
 * A reviewer may not mutate code, and the enforcement cannot be a rule in a
 * prompt. The runner photographs the workspace before and after; anything that
 * moved voids the review, because a reviewer that edited the tree has reviewed
 * something other than what was submitted -- and a reviewer that can edit can
 * fix a finding and then not raise it.
 *
 * ABSENT IS NOT UNCHANGED. A fingerprint that could not be taken returns a
 * mutation of kind `unknown`, not a pass: "I could not look" and "nothing
 * moved" are the two readings of a missing answer and only one of them is safe.
 */
export function mutationBetween(before, after) {
  if (!before || !after) {
    return Object.freeze({
      kind: 'unknown',
      detail: 'the workspace could not be fingerprinted on both sides of the review',
    });
  }
  if (before.head !== after.head) {
    return Object.freeze({ kind: 'head', detail: `${before.head} -> ${after.head}` });
  }
  const b = [...(before.dirty ?? [])].sort();
  const a = [...(after.dirty ?? [])].sort();
  if (b.length !== a.length || b.some((p, i) => p !== a[i])) {
    return Object.freeze({ kind: 'tree', detail: `dirty ${JSON.stringify(b)} -> ${JSON.stringify(a)}` });
  }
  return null;
}
