import test from 'node:test';
import assert from 'node:assert/strict';
import {
  proposeWork, canConfirm, supervisoryReport, reconcileProposals, decideOpenReadTruncation, proposalsMatch,
  PROPOSAL_STALE_AFTER_MS, PROPOSAL_KINDS,
} from '../src/dispatch.mjs';

/**
 * SUPERVISED MEANS THE PROPOSAL IS NEVER A PERMISSION.
 *
 * The owner chose: the dispatcher prepares, the coordinator confirms. The way
 * that decision gets quietly reversed is not by someone changing their mind --
 * it is by confirmation trusting the verdict recorded at proposal time. Then
 * the dispatcher's judgment, formed against a world that has since moved,
 * becomes the authority, and "supervised" is "autonomous with an hour of lag".
 *
 * So canConfirm re-runs the guard against live rows and ignores the stored
 * verdict. These tests exist mainly to hold that line.
 */

const NOW = '2026-09-15T15:00:00.000Z';
const ago = (ms) => new Date(Date.parse(NOW) - ms).toISOString();

const alive = (s) => s?.capacity !== 'offline';

const task = (over = {}) => ({
  task_id: 't1', state: 'runnable', lane_id: 'agentbridge', repo_id: 'agentbridge',
  allowed_paths: [], depends_on: [], ...over,
});
const worker = (over = {}) => ({
  agent_id: 'code-b', session_id: 'danny-win-f1', lane_id: 'agentbridge',
  repo_id: 'agentbridge', capacity: 'idle', ...over,
});

const propose = (over = {}) => proposeWork({ now: NOW, isLive: alive, ...over });

// ── routing ────────────────────────────────────────────────────────────────
test('work is routed BY LANE, not by a fixed chain', () => {
  /*
   * A C -> B -> D -> A rotation was proposed. It describes today's roster
   * rather than a rule, and canAssign already refuses on lane mismatch, so most
   * hops in such a chain produce refusals instead of handoffs.
   */
  const { proposals } = propose({
    tasks: [task({ lane_id: 'review' })],
    sessions: [worker(), worker({ agent_id: 'code-d', session_id: 'd1', lane_id: 'review' })],
  });

  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].agent_id, 'code-d', 'the lane holder should have been chosen');
});

test('AMBIGUITY IS REPORTED, never broken by a tie-rule', () => {
  // Picking "the first" is a decision about who does the work, made by the
  // component explicitly told not to make those.
  const { proposals, blocked } = propose({
    tasks: [task()],
    sessions: [worker(), worker({ agent_id: 'code-c', session_id: 'danny-win-10' })],
  });

  assert.equal(proposals.length, 0);
  assert.equal(blocked.length, 1);
  assert.match(blocked[0].reason, /2 idle workers are eligible/);
  assert.deepEqual(blocked[0].candidates.sort(), ['code-b', 'code-c']);
});

test('a busy worker is not offered more work', () => {
  const { proposals, blocked } = propose({
    tasks: [task({ task_id: 'busy', state: 'assigned', assigned_session: 'danny-win-f1' }), task()],
    sessions: [worker()],
  });
  assert.equal(proposals.length, 0);
  assert.match(blocked[0].reason, /no idle live worker/);
});

test('an offline or stale worker is not a candidate', () => {
  assert.equal(propose({ tasks: [task()], sessions: [worker({ capacity: 'offline' })] }).proposals.length, 0);
  assert.equal(
    proposeWork({ tasks: [task()], sessions: [worker()], now: NOW, isLive: () => false }).proposals.length,
    0,
  );
});

test('liveness is INJECTED, never decided here', () => {
  // A dispatcher with its own opinion about who is alive is a second answer to
  // the question the registry exists to answer.
  assert.throws(() => proposeWork({ now: NOW }), /requires an isLive predicate/);
  assert.throws(() => proposeWork({ isLive: alive }), /requires a `now` timestamp/);
});

// ── returned work ──────────────────────────────────────────────────────────
test('RETURNED WORK IS A REVIEW, never a reassignment', () => {
  /*
   * Proposing that somebody else pick up returned work would quietly discard a
   * worker's finished contract. What it needs is a coordinator to look at the
   * commit.
   */
  const t = task({ state: 'returned', returned_by: 'danny-win-f1', returned_head_sha: 'a'.repeat(40) });
  const { proposals } = propose({ tasks: [t], sessions: [worker({ agent_id: 'code-c', session_id: 'x' })] });

  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].kind, 'review');
  assert.equal(proposals[0].agent_id, undefined, 'a review proposal must not name a new assignee');
  assert.equal(proposals[0].head_sha, 'a'.repeat(40));
  assert.equal(proposals[0].would_be_accepted, true);
});

test('the dispatcher forms no opinion on whether work is GOOD', () => {
  // It cannot read a diff. It reports that a return exists and what to look at.
  const t = task({ state: 'returned', returned_by: 's1', returned_head_sha: 'b'.repeat(40), returned_notes: 'tests green' });
  const [p] = propose({ tasks: [t] }).proposals;
  assert.equal(p.notes, 'tests green');
  assert.equal(p.quality, undefined);
  assert.equal(p.approved, undefined);
});

// ── the line that must not move ────────────────────────────────────────────
test('CONFIRMATION RE-RUNS THE GUARD AND IGNORES THE RECORDED VERDICT', () => {
  /*
   * THE test. A proposal that said "ok" when the worker was idle must not
   * confirm once that worker has taken other work -- otherwise the dispatcher's
   * stale judgment is the authority and supervision is theatre.
   */
  const stale = {
    kind: 'assign', task_id: 't1', agent_id: 'code-b', session_id: 'danny-win-f1',
    would_be_accepted: true, reasons: [], prepared_at: ago(60_000),
  };

  const t = task();
  const otherWork = task({ task_id: 't2', state: 'assigned', assigned_session: 'danny-win-f1' });

  // The recorded verdict says yes. Live state says the task is no longer
  // runnable.
  const r = canConfirm(stale, {
    task: task({ state: 'cancelled' }),
    worker: worker(),
    tasks: [t, otherWork],
    now: NOW,
    isLive: alive,
  });

  assert.equal(r.ok, false, 'a stale "ok" was trusted');
  assert.match(r.errors.join(' '), /only runnable or returned work can be assigned/);
});

test('a proposal for a worker that has since gone offline cannot be confirmed', () => {
  const p = {
    kind: 'assign', task_id: 't1', agent_id: 'code-b', session_id: 'danny-win-f1',
    would_be_accepted: true, prepared_at: ago(60_000),
  };
  const r = canConfirm(p, { task: task(), worker: null, tasks: [], now: NOW, isLive: alive });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /no live session now/);
});

test('a worker that RESTARTED is a different session, and is refused', () => {
  /*
   * Confirming onto a new runtime would be assigning to something nobody
   * proposed. The session is part of the proposal for the same reason it is
   * part of a return.
   */
  const p = {
    kind: 'assign', task_id: 't1', agent_id: 'code-b', session_id: 'danny-win-f1',
    would_be_accepted: true, prepared_at: ago(60_000),
  };
  const r = canConfirm(p, {
    task: task(), worker: worker({ session_id: 'danny-win-f2' }), tasks: [], now: NOW, isLive: alive,
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /now "danny-win-f2"/);
});

test('A PROPOSAL GOES STALE and must be re-prepared', () => {
  // An hour-old suggestion confirmed without a fresh look is the dispatcher
  // deciding late rather than the supervisor deciding now.
  const old = {
    kind: 'assign', task_id: 't1', agent_id: 'code-b', session_id: 'danny-win-f1',
    would_be_accepted: true, prepared_at: ago(PROPOSAL_STALE_AFTER_MS + 60_000),
  };
  const r = canConfirm(old, { task: task(), worker: worker(), tasks: [], now: NOW, isLive: alive });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /stale; re-prepare it/);

  const fresh = { ...old, prepared_at: ago(PROPOSAL_STALE_AFTER_MS - 60_000) };
  assert.equal(canConfirm(fresh, { task: task(), worker: worker(), tasks: [], now: NOW, isLive: alive }).ok, true);
});

test('an undateable or future-dated proposal is refused', () => {
  const base = {
    kind: 'assign', task_id: 't1', agent_id: 'code-b', session_id: 'danny-win-f1', would_be_accepted: true,
  };
  for (const prepared_at of [null, '', 'whenever']) {
    const r = canConfirm({ ...base, prepared_at }, { task: task(), worker: worker(), now: NOW, isLive: alive });
    assert.equal(r.ok, false, String(prepared_at));
    assert.match(r.errors.join(' '), /cannot be dated/);
  }
  const future = canConfirm({ ...base, prepared_at: '2027-01-01T00:00:00.000Z' },
    { task: task(), worker: worker(), now: NOW, isLive: alive });
  assert.equal(future.ok, false);
  assert.match(future.errors.join(' '), /dated in the future/);
});

test('confirming a review re-checks that the task is still returned', () => {
  const p = { kind: 'review', task_id: 't1', prepared_at: ago(60_000) };
  const returned = task({ state: 'returned', returned_by: 's1', returned_head_sha: 'c'.repeat(40) });
  assert.equal(canConfirm(p, { task: returned, now: NOW, isLive: alive }).ok, true);

  // Somebody accepted it in the meantime.
  const r = canConfirm(p, { task: task({ state: 'accepted' }), now: NOW, isLive: alive });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /already "accepted"/);
});

test('an unknown proposal kind confirms nothing', () => {
  assert.equal(canConfirm({ kind: 'deploy', task_id: 't1' }, { now: NOW }).ok, false);
  assert.equal(canConfirm(null, { now: NOW }).ok, false);
  assert.deepEqual(PROPOSAL_KINDS, ['assign', 'review']);
});

// ── the report ─────────────────────────────────────────────────────────────
test('the report leads with counts, then only what needs a decision', () => {
  const { proposals, idle, blocked } = propose({
    tasks: [
      task(),
      task({ task_id: 't2', state: 'returned', returned_by: 's1', returned_head_sha: 'd'.repeat(40) }),
      task({ task_id: 't3', state: 'accepted' }),
    ],
    sessions: [worker()],
  });

  const r = supervisoryReport({ proposals, idle, blocked, tasks: [task(), task({ state: 'accepted' })], now: NOW });

  assert.equal(r.at, NOW);
  assert.equal(r.counts.tasks.runnable, 1);
  assert.equal(r.counts.tasks.accepted, 1);
  assert.equal(r.awaiting_review.length, 1);
  // Nothing in the actionable sections is a status update.
  for (const key of ['awaiting_review', 'ready_to_assign', 'would_refuse', 'blocked']) {
    assert.ok(Array.isArray(r[key]), key);
  }
});

test('a would-refuse proposal is surfaced separately, not silently dropped', () => {
  /*
   * A proposal the guard would reject is the most interesting row in the
   * report: it means the dispatcher found work and something is stopping it.
   * Hiding it would make a stuck production line look like an idle one.
   */
  const t = task({ depends_on: ['nope'] });
  const { proposals } = propose({ tasks: [t], sessions: [worker()] });
  assert.equal(proposals[0].would_be_accepted, false);
  assert.match(proposals[0].reasons.join(' '), /does not exist/);

  const r = supervisoryReport({ proposals, now: NOW });
  assert.equal(r.would_refuse.length, 1);
  assert.equal(r.ready_to_assign.length, 0);
});

test('a quiet hour reads as quiet', () => {
  const r = supervisoryReport({ now: NOW });
  // workers_went_stale joined this shape when a dead worker stopped being
  // indistinguishable from a lane nobody staffed. A quiet hour has none.
  assert.deepEqual(r.counts, {
    proposals: 0, awaiting_review: 0, idle_workers: 0, blocked: 0,
    workers_went_stale: 0, tasks: {},
  });
});

/* ── the churn ─────────────────────────────────────────────────────────────
 *
 * MEASURED BEFORE WRITING A LINE, because the contract's numbers were three
 * hours old and said the flood was live.
 *
 *   superseded review proposals on t-wire-gate-scripts    185 of a 200-row page
 *   one per minute, unbroken                              23:38Z -> 03:20Z
 *   prepared after the task was accepted at 03:20:37Z     0
 *   open proposals right now                              0
 *
 * So the flood has STOPPED, and not because anything was fixed: code-b accepted
 * the one returned task at 03:20:37Z and the dispatcher ran out of things to
 * re-propose. The writer is untouched. The next worker that returns work starts
 * it again at sixty rows an hour, and it never stops on its own because nothing
 * consumes a review proposal.
 *
 * WHAT THE WRITER ACTUALLY DOES, supabase/functions/mcp/index.ts around 1800:
 * every tick supersedes the whole open set and inserts a fresh row, whether or
 * not anything changed. Its comment defends replacing the set -- correctly, an
 * old proposal open beside a new one is stale authority -- but replacing a row
 * with a byte-identical row is not that. It is an audit trail of the dispatcher
 * having nothing to say.
 *
 * The decision of WHAT CHANGED is pure, so it lives here rather than in the
 * edge function, which the suite cannot import. See CLAUDE.md rule 10.
 */

const openRow = (over = {}) => ({
  proposal_id: 'p-1', kind: 'review', task_id: 't1',
  agent_id: null, session_id: null, lane_id: null,
  returned_by: 'danny-win-d1', head_sha: 'abc123', notes: 'did the thing',
  would_be_accepted: true, reasons: [], prepared_at: ago(60_000), ...over,
});
const freshRow = (over = {}) => ({
  kind: 'review', task_id: 't1',
  returned_by: 'danny-win-d1', head_sha: 'abc123', notes: 'did the thing',
  would_be_accepted: true, reasons: [], prepared_at: NOW, ...over,
});

test('AN UNCHANGED PROPOSAL IS REAFFIRMED, NOT SUPERSEDED AND REWRITTEN', () => {
  const plan = reconcileProposals({ open: [openRow()], fresh: [freshRow()], now: NOW });
  assert.deepEqual(plan.supersede, [], 'an unchanged proposal was superseded, which is the churn');
  assert.deepEqual(plan.insert, [], 'an unchanged proposal was written again as a new row');
  assert.deepEqual(plan.reaffirm, ['p-1'], 'the surviving row was not reaffirmed, so it will go stale and die');
});

test('A CHANGED VERDICT IS HISTORY AND IS RECORDED AS A NEW ROW', () => {
  /*
   * The point of the whole table. would_be_accepted flipping means the world
   * moved, and that IS worth a row -- collapsing it would trade a noisy log for
   * a lying one.
   */
  const plan = reconcileProposals({
    open: [openRow()],
    fresh: [freshRow({ would_be_accepted: false, reasons: ['the base moved'] })],
    now: NOW,
  });
  assert.deepEqual(plan.supersede, ['p-1']);
  assert.equal(plan.insert.length, 1);
  assert.deepEqual(plan.reaffirm, []);
});

test('A HEAD_SHA THAT MOVED IS A DIFFERENT PROPOSAL, NOT THE SAME ONE', () => {
  /*
   * The worker pushed again. Same task, same verdict, different commit to read.
   * Reaffirming here would leave a reviewer looking at the wrong sha, which is
   * worse than the churn this is fixing.
   */
  const plan = reconcileProposals({
    open: [openRow()],
    fresh: [freshRow({ head_sha: 'def456' })],
    now: NOW,
  });
  assert.deepEqual(plan.supersede, ['p-1']);
  assert.equal(plan.insert.length, 1);
});

test('AN OPEN PROPOSAL THE DISPATCHER NO LONGER MAKES IS SUPERSEDED', () => {
  /*
   * The task was accepted -- exactly what happened at 03:20:37Z. Nothing fresh
   * matches, so the row must close. Leaving it open is the stale-authority bug
   * the existing writer comment is about, and this fix must not reintroduce it.
   */
  const plan = reconcileProposals({ open: [openRow()], fresh: [], now: NOW });
  assert.deepEqual(plan.supersede, ['p-1']);
  assert.deepEqual(plan.insert, []);
  assert.deepEqual(plan.reaffirm, []);
});

test('REAFFIRMING RESETS THE STALENESS CLOCK, OR THE FIX CREATES AN OUTAGE', () => {
  /*
   * canConfirm refuses a proposal older than PROPOSAL_STALE_AFTER_MS. Keep a row
   * for an hour without touching its clock and it becomes unconfirmable while
   * still being the dispatcher's current opinion -- a proposal nobody may act on
   * and nothing replaces. That turns sixty harmless rows an hour into a dead
   * queue, which is a worse bug than the one being fixed.
   */
  const stale = openRow({ prepared_at: ago(PROPOSAL_STALE_AFTER_MS + 60_000) });
  const before = canConfirm(
    { ...stale, kind: 'review' },
    { task: task({ state: 'returned' }), tasks: [], now: NOW, isLive: alive },
  );
  assert.equal(before.ok, false, 'precondition: that row was supposed to be too old to confirm');

  const plan = reconcileProposals({ open: [stale], fresh: [freshRow()], now: NOW });
  assert.deepEqual(plan.reaffirm, ['p-1'], 'a stale-but-still-current proposal was not reaffirmed');
  assert.equal(plan.reaffirmed_at, NOW, 'reaffirm carries no new timestamp, so the clock never resets');
});

test('FRESHNESS READS reaffirmed_at; prepared_at STAYS THE WAITING-SINCE CLOCK', () => {
  /*
   * THE OBVIOUS FIX IS THE WRONG ONE AND IT IS WORTH SAYING WHY.
   *
   * Reaffirming by bumping prepared_at keeps the row confirmable and needs no
   * new column -- and it makes every review proposal read sixty seconds old
   * forever. The 676 rows about one task were a symptom SHOUTING that nothing
   * consumes a review proposal; silencing the churn by rewriting the clock
   * would have removed the shout and left the stuck queue, which is trading a
   * noisy bug for a quiet one.
   *
   * So the two dates mean different things: prepared_at is how long this has
   * been waiting for a human, reaffirmed_at is whether the dispatcher still
   * means it.
   */
  const heldOpenForHours = {
    ...openRow(),
    prepared_at: ago(4 * 60 * 60 * 1000),   // waiting since 4 hours ago
    reaffirmed_at: ago(30_000),             // and still current 30s ago
  };
  const verdict = canConfirm(heldOpenForHours, {
    task: task({ state: 'returned' }), tasks: [], now: NOW, isLive: alive,
  });
  assert.ok(
    !verdict.errors.some((e) => /stale/.test(e)),
    `a reaffirmed proposal was called stale: ${verdict.errors.join('; ')}`,
  );
  assert.equal(
    heldOpenForHours.prepared_at, ago(4 * 60 * 60 * 1000),
    'prepared_at was mutated, so nothing can report how long this waited',
  );
});

test('A ROW PREDATING reaffirmed_at STILL AGES, RATHER THAN BECOMING IMMORTAL', () => {
  /*
   * The fallback is the dangerous half of `??`. Rows written before the column
   * existed carry reaffirmed_at undefined, and a fallback that resolved those
   * to "now" would make every historical proposal permanently confirmable --
   * a staleness check that stops refusing is not a check.
   */
  const old = { ...openRow(), prepared_at: ago(PROPOSAL_STALE_AFTER_MS + 60_000) };
  delete old.reaffirmed_at;
  const verdict = canConfirm(old, {
    task: task({ state: 'returned' }), tasks: [], now: NOW, isLive: alive,
  });
  assert.ok(
    verdict.errors.some((e) => /stale/.test(e)),
    'a pre-column row an hour old was not called stale, so the fallback swallowed the check',
  );
});

test('A TRUNCATED OPEN READ FALLS BACK TO REPLACING THE SET, NOT TO A PARTIAL ONE', () => {
  /*
   * FOUND BY AUDITING THE DIFF AFTER 1611 TESTS WENT GREEN OVER IT. The caller
   * reads the open set with a PostgREST `limit`, in a file the suite cannot
   * import, so nothing here could have seen it.
   *
   * A row past the limit is invisible: never matched, so never superseded, and
   * the fresh proposal that would have matched it is inserted beside it. Two
   * open proposals for one task, one unreachable -- the stale-authority bug the
   * original writer existed to prevent, reintroduced by the fix for its other
   * half.
   */
  const plan = reconcileProposals({
    open: [openRow()], fresh: [freshRow()], now: NOW, openTruncated: true,
  });
  assert.equal(plan.replaceAll, true, 'a partial read was reconciled as though it were complete');
  assert.deepEqual(plan.reaffirm, [], 'a row was reaffirmed on the strength of a set that may be incomplete');
  assert.equal(plan.insert.length, 1, 'the fallback must still write what the dispatcher derived');
  assert.match(String(plan.reason), /incomplete|limit/i, 'the fallback does not say why it happened');
});

test('THE COMPLETE-READ PLAN SAYS SO, SO THE CALLER CANNOT CONFUSE THE TWO', () => {
  /*
   * The positive half. A flag that is only ever read when true is one typo away
   * from being read the wrong way round, and `undefined` is falsy, so a plan
   * that simply omitted the field would silently take the reconcile path.
   */
  const plan = reconcileProposals({ open: [openRow()], fresh: [freshRow()], now: NOW });
  assert.equal(plan.replaceAll, false, 'a complete read did not state that it was complete');
  assert.deepEqual(plan.reaffirm, ['p-1']);
});

/* ============================================================================
 * TRUNCATION IS DECIDED FROM A COUNT THE SERVER REPORTS, NOT FROM ROW COUNT.
 *
 * reconcileProposals correctly refuses to reconcile a partial set. It was fed by
 * a guess made in supabase/functions/mcp/index.ts -- `rows.length >= limit` --
 * in a file the suite cannot import, so the one line deciding whether the guard
 * ever engages had no coverage at all. These tests give it some.
 *
 * db-max-rows measured on this project 2026-09-18: absent from every role
 * config and from pg_settings, so the platform default applies.
 * ==========================================================================*/

test('THE BUG: a server capping below the requested limit reads as complete under row-count', () => {
  /*
   * PostgREST returns min(limit, db-max-rows). Cap of 200, limit of 1000: 200
   * rows come back out of 5000. The old test, `returned >= limit`, is 200 >= 1000
   * -- false -- so a partial set reconciles believing itself whole, which is the
   * precise bug reconcileProposals exists to prevent.
   */
  assert.equal(200 >= 1000, false, 'the old heuristic calls this complete');
  const d = decideOpenReadTruncation({ returned: 200, total: 5000, limit: 1000 });
  assert.equal(d.truncated, true, 'and the count says otherwise');
  assert.match(d.reason, /5000 rows and the read returned 200/);
});

test('THE OBVIOUS REPAIR IS ALSO WRONG, at exactly the default configuration', () => {
  /*
   * "Ask for limit+1 and treat length > limit as truncated" fails when the cap
   * equals the limit: asking 1001 against a cap of 1000 returns 1000, and
   * 1000 > 1000 is false. A 1000-row slice of a 5000-row set reads as complete.
   * Recorded as a test so nobody re-proposes it.
   */
  assert.equal(1000 > 1000, false, 'the limit+1 repair calls this complete');
  assert.equal(
    decideOpenReadTruncation({ returned: 1000, total: 5000, limit: 1000 }).truncated,
    true,
    'reading the count is not fooled by the cap coinciding with the limit',
  );
});

test('a full page that is genuinely the whole set is NOT truncated', () => {
  /*
   * The old heuristic said truncated here and degraded to replacing the set --
   * a false positive that brought back the churn this branch removes, every
   * time the open set happened to be exactly the limit.
   */
  assert.equal(1000 >= 1000, true, 'the old heuristic calls this truncated');
  assert.equal(decideOpenReadTruncation({ returned: 1000, total: 1000, limit: 1000 }).truncated, false);
});

test('an unknown count is UNSAFE, not assumed complete', () => {
  /*
   * With no count there is no way to tell a whole set from one the server
   * capped. Fail closed: degrade to replacing the set, which is noisy, visible,
   * and was the behaviour before this branch.
   */
  const d = decideOpenReadTruncation({ returned: 200, total: null, limit: 1000 });
  assert.equal(d.truncated, true);
  assert.match(d.reason, /no row count/);
});

test('an empty open set is complete, not truncated', () => {
  assert.equal(decideOpenReadTruncation({ returned: 0, total: 0, limit: 1000 }).truncated, false);
});

test('unusable inputs throw rather than defaulting to a verdict', () => {
  assert.throws(() => decideOpenReadTruncation({ returned: -1, total: 0, limit: 10 }), TypeError);
  assert.throws(() => decideOpenReadTruncation({ returned: 1, total: 0, limit: 0 }), TypeError);
  assert.throws(() => decideOpenReadTruncation({ returned: 1, total: 'lots', limit: 10 }), TypeError);
});
