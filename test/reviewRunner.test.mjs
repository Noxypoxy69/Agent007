import test from 'node:test';
import assert from 'node:assert/strict';
import { runReview, STAGE } from '../src/reviewRunner.mjs';
import {
  decideReview, fixTaskFor, resolveFindings, mutationBetween, REVIEW_DECISION,
} from '../src/reviewDecision.mjs';
import { createResultEnvelope } from '../src/resultEnvelope.mjs';
import { buildReviewerPacket } from '../src/reviewerPacket.mjs';
import { createFakeReviewer } from './fakeReviewer.mjs';
import { createFakeBridge } from './fakeBridge.mjs';

/**
 * THE REVIEWER RUNTIME. Item 4 of docs/ORDER.md: the review lease existed in SQL
 * and nothing had ever claimed it.
 *
 * WHAT THIS FILE IS EVIDENCE OF, and it is narrower than "the review loop
 * works": the runner, given a model of the database that refuses the way the
 * database refuses, claims a lease, reviews from machine evidence in a fresh
 * workspace, and records a decision under the token that authorised it. The
 * bridge is test/fakeBridge.mjs -- a MODEL of the SQL, not the SQL. It cannot
 * tell you a migration is applied and it will happily agree with a wrong one.
 *
 * WHAT IT IS EVIDENCE OF ANYWAY, and why the model earns its place: every
 * refusal path below is a refusal the runner did not predict and had to honour.
 * A stub that cannot say no cannot prove that.
 */

const SHA = 'a'.repeat(40);
const FIXED = 'b'.repeat(40);

/** The evidence a good attempt produces: exited 0, tests run, a commit, no path violation. */
const goodEnvelope = (over = {}) => createResultEnvelope({
  taskId: 't-review', attempt: 0, outcome: 'exited', exitCode: 0,
  tests: { passed: 2, failed: 0, skipped: 0, total: 2 },
  commit: SHA, filesChanged: ['src/thing.mjs'],
  pathContract: { allowed: ['src/thing.mjs'], forbidden: [], violations: [] },
  ...over,
});

/** A returned task, in the shape claim_review actually sees one. */
const returnedTask = (over = {}) => ({
  task_id: 't-review', state: 'returned', lane_id: 'agentbridge', repo_id: 'agentbridge',
  base_sha: '0'.repeat(40), returned_by: 'worker-session', returned_head_sha: SHA,
  returned_notes: 'I refactored the thing and I am confident it is correct.',
  attempt: 1, depends_on: [],
  ...over,
});

/** A workspace manager that records what it was asked to do. */
function fakeWorkspaces() {
  const log = [];
  let n = 0;
  return {
    log,
    async create(spec) {
      n += 1;
      log.push(['create', spec]);
      return { id: `ws-${n}`, path: `/tmp/review/ws-${n}` };
    },
    async destroy(ws) { log.push(['destroy', ws.id]); return { ok: true, reason: 'clean' }; },
    async quarantine(ws, reason) { log.push(['quarantine', ws.id, reason]); return `/q/${ws.id}`; },
  };
}

/** A git probe over a tree that does or does not move while the reviewer holds it. */
function probe({ head = FIXED, dirty = [], after = null } = {}) {
  let calls = 0;
  return {
    async headSha() { calls += 1; return calls > 1 && after?.head ? after.head : head; },
    async dirtyFiles() { return calls > 1 && after?.dirty ? after.dirty : dirty; },
  };
}

const harness = (over = {}) => {
  const task = over.task ?? returnedTask();
  const bridge = over.bridge ?? createFakeBridge({ tasks: [task] });
  const workspaces = over.workspaces ?? fakeWorkspaces();
  return {
    task, bridge, workspaces,
    args: {
      task,
      reviewerSession: 'reviewer-session',
      reviewer: over.reviewer ?? createFakeReviewer(),
      workspaces,
      bridge,
      envelopeFor: over.envelopeFor ?? (async () => goodEnvelope()),
      contract: { allowed: ['src/thing.mjs'], forbidden: [] },
      io: { workspaceGit: over.gitProbe ?? probe(), now: () => 1_700_000_000_000 },
    },
  };
};

/* ── both directions, because one direction proves nothing ───────────── */

test('A REVIEW ACCEPTS: the lease is claimed, the decision is recorded, the task is accepted', async () => {
  const h = harness();
  const r = await runReview(h.args);

  assert.equal(r.ok, true, `review did not complete: ${r.stage}/${r.reason}`);
  assert.equal(r.decision.decision, REVIEW_DECISION.ACCEPT, r.decision.reasons.join(', '));

  // the far end, not the return value: the row moved and names who moved it
  const row = h.bridge.rows.get('t-review');
  assert.equal(row.state, 'accepted');
  assert.equal(row.reviewed_by, 'reviewer-session');
  assert.equal(row.accepted_head_sha, SHA, 'accepted at a commit other than the reviewed one');
  assert.equal(row.review_lease_token, null, 'the review lease outlived the review');

  // and a lease really was taken -- an accept that never claimed is the hollow one
  assert.deepEqual(
    h.bridge.outbox.map((e) => e.kind),
    ['review_claimed', 'review_recorded'],
  );
});

test('A REVIEW REFUSES: findings become a SEPARATE task, never another attempt', async () => {
  // The machine is happy; only the reviewer objects. That is the case that
  // proves a reviewer can stop work rather than rubber-stamp what already passed.
  const h = harness({ reviewer: createFakeReviewer({ maxFilesChanged: 0 }) });
  const r = await runReview(h.args);

  assert.equal(r.ok, true, `${r.stage}/${r.reason}`);
  assert.equal(r.decision.decision, REVIEW_DECISION.FIX_REQUIRED);
  assert.ok(
    r.decision.reasons.some((x) => x.startsWith('reviewer:policy:too-many-files')),
    `the reviewer's finding did not reach the decision: ${r.decision.reasons.join(', ')}`,
  );

  // A SEPARATE TASK. Not the same id, not a bumped attempt counter.
  assert.notEqual(r.fixTask.task_id, 't-review');
  assert.equal(r.fixTask.attempt, 0, 'the fix task inherited an attempt count');
  assert.equal(r.fixTask.fix_of, 't-review');
  assert.equal(r.fixTask.base_sha, SHA, 'the fix starts from the reviewed commit');

  const original = h.bridge.rows.get('t-review');
  const fix = h.bridge.rows.get(r.fixTask.task_id);
  assert.ok(fix, 'fix_required recorded no task for the findings to go to');
  assert.equal(fix.state, 'runnable');
  assert.equal(original.state, 'blocked');
  assert.deepEqual(original.depends_on, [r.fixTask.task_id]);
  assert.equal(original.attempt, 1, 'the reviewed task was retried in place');
});

test('A REVIEW REJECTS when there is no commit to hand a fixer', async () => {
  /*
   * The distinction between the two refusals, tested on the evidence that makes
   * it: a killed run has no commit, so there is no tree a fix task could be
   * based on. A fix task pointing at the original base is the same task again
   * wearing a new id.
   */
  const h = harness({
    envelopeFor: async () => createResultEnvelope({
      taskId: 't-review', attempt: 0, outcome: 'timeout', exitCode: null,
      tests: null, commit: null, filesChanged: [],
    }),
  });
  const r = await runReview(h.args);

  assert.equal(r.ok, true, `${r.stage}/${r.reason}`);
  assert.equal(r.decision.decision, REVIEW_DECISION.REJECT);
  assert.equal(r.fixTask, null, 'a reject created work out of an attempt that produced none');
  assert.ok(r.decision.reasons.includes('machine:outcome:timeout'));

  const row = h.bridge.rows.get('t-review');
  assert.equal(row.state, 'runnable', 'rejected work did not go back into the pool');
  assert.equal(row.fix_task_id, null);
  assert.equal(h.bridge.rows.size, 1, 'a reject invented a task');
});

/* ── a reviewer may not mutate code ──────────────────────────────────── */

test('A REVIEWER THAT EDITS ITS WORKSPACE VOIDS THE REVIEW AND SUBMITS NOTHING', async () => {
  /*
   * Not "rejects" -- voids. A reviewer that edited the tree reviewed something
   * other than what was handed in, so its verdict is about a different artefact
   * and recording it would file a judgement of the reviewer's own edit as a
   * judgement of the worker's commit.
   */
  const h = harness({
    reviewer: {
      id: 'meddler',
      async review() { return { reviewer: 'meddler', decision: 'accept', findings: [] }; },
    },
    gitProbe: probe({ head: FIXED, dirty: [], after: { head: 'c'.repeat(40), dirty: [] } }),
  });
  const r = await runReview(h.args);

  assert.equal(r.ok, false);
  assert.equal(r.stage, STAGE.REVIEW);
  assert.equal(r.reason, 'reviewer:mutated-workspace');
  assert.equal(r.mutation.kind, 'head');
  assert.equal(r.submitted, null, 'a voided review was submitted anyway');

  // the far end is untouched and the work is still reviewable by somebody else
  const row = h.bridge.rows.get('t-review');
  assert.equal(row.state, 'returned');
  assert.equal(row.review_decision, undefined);
  assert.deepEqual(h.bridge.outbox.map((e) => e.kind), ['review_claimed']);

  // and the evidence of the meddling is kept, not tidied away
  assert.ok(h.workspaces.log.some(([verb]) => verb === 'quarantine'));
  assert.ok(!h.workspaces.log.some(([verb]) => verb === 'destroy'));
});

test('A WORKSPACE THAT COULD NOT BE FINGERPRINTED IS A MUTATION, NOT A PASS', async () => {
  // Absent is not unchanged. "I could not look" and "nothing moved" are the two
  // readings of a missing answer, and only one of them is safe.
  const h = harness({ gitProbe: null });
  const r = await runReview({ ...h.args, io: { now: () => 1 } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'reviewer:mutated-workspace');
  assert.equal(r.mutation.kind, 'unknown');
  assert.equal(r.submitted, null);
});

/* ── the reviewer reads machine evidence, never the agent's prose ─────── */

test('THE WORKER\'S NOTES DO NOT REACH THE REVIEWER, BY ANY ROUTE', async () => {
  const notes = 'I refactored the thing and I am confident it is correct, tests all pass.';
  let seen = null;
  const h = harness({
    envelopeFor: async () => goodEnvelope({ notes }),
    reviewer: {
      id: 'recorder',
      async review(packet) {
        seen = packet;
        return { reviewer: 'recorder', decision: 'accept', findings: [] };
      },
    },
  });
  const r = await runReview(h.args);
  assert.equal(r.ok, true, `${r.stage}/${r.reason}`);

  // THE POSITIVE FIRST: the reviewer really did receive a packet with the
  // evidence in it. "No prose reached it" passes trivially against a reviewer
  // that received nothing at all.
  assert.notEqual(seen, null, 'the reviewer was never called');
  assert.equal(seen.evidence.commit, SHA);
  assert.deepEqual(seen.evidence.tests, { passed: 2, failed: 0, skipped: 0, total: 2 });

  const serialised = JSON.stringify(seen);
  for (let i = 0; i + 24 <= notes.length; i += 8) {
    assert.ok(
      !serialised.includes(notes.slice(i, i + 24)),
      `the worker's prose reached the reviewer: ${notes.slice(i, i + 24)}`,
    );
  }
  assert.equal(Object.prototype.hasOwnProperty.call(seen, 'notes'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(seen.evidence, 'notes'), false);
});

/* ── refusals the runner did not predict, and had to honour ──────────── */

test('THE RUNNER DOES NOT SECOND-GUESS THE DATABASE: a self-review is refused there', async () => {
  /*
   * The runner has no local copy of claim_review's rules -- the owner ruled SQL
   * is the authority for leases, and src/runtime.mjs is carried as a test oracle
   * precisely so it does not acquire a caller. So the refusal has to arrive from
   * the far end and be honoured, and NOTHING may be created before it does.
   */
  const h = harness();
  const r = await runReview({ ...h.args, reviewerSession: 'worker-session' });

  assert.equal(r.ok, false);
  assert.equal(r.stage, STAGE.CLAIM);
  assert.equal(r.reason, 'self-review');
  assert.deepEqual(h.workspaces.log, [], 'a workspace was created before the claim was answered');
});

test('WORK THAT IS NOT RETURNED IS NOT REVIEWABLE, and the runner does not decide that either', async () => {
  const h = harness({ task: returnedTask({ state: 'assigned' }) });
  const r = await runReview(h.args);
  assert.equal(r.ok, false);
  assert.equal(r.stage, STAGE.CLAIM);
  assert.equal(r.reason, 'state');
  assert.deepEqual(h.workspaces.log, []);
});

test('A SECOND REVIEWER IS REFUSED WHILE THE FIRST LEASE IS LIVE', async () => {
  const h = harness();
  const first = await h.bridge.claimReview({ task_id: 't-review', reviewer_session: 'reviewer-one' });
  assert.equal(first.ok, true);

  const r = await runReview(h.args);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'under-review');
  assert.deepEqual(h.workspaces.log, []);
});

/* ── a crash is recoverable: expiry, then reclaim ─────────────────────── */

test('A REVIEWER CRASH SUBMITS NOTHING, AND THE WORK IS RECLAIMABLE AFTER THE REAPER', async (t) => {
  /*
   * THE RECOVERY PATH IS THE LEASE'S, NOT THE RUNNER'S. There is deliberately
   * no local release: a lease released on exit is a lease that a kill -9 does
   * not release, so the only recovery would be the one that works when nothing
   * went wrong.
   *
   * THE STATES BELOW ARE THE ONES THE SYSTEM REALLY PRODUCES, in order: a live
   * lease on returned work, the same row with the lease expired and not yet
   * swept, and the row after expire_dead_reviews nulled the columns. The middle
   * one is the shape a reclaim actually meets, because the reaper runs on a
   * schedule and a reviewer does not wait for it.
   */
  let clock = 1_000_000;
  const task = returnedTask();
  const bridge = createFakeBridge({ tasks: [task], now: () => clock });
  const workspaces = fakeWorkspaces();

  const crashed = await runReview({
    task, reviewerSession: 'reviewer-one',
    reviewer: { id: 'dies', async review() { throw new Error('reviewer died mid-read'); } },
    workspaces, bridge,
    envelopeFor: async () => goodEnvelope(),
    io: { workspaceGit: probe(), now: () => clock },
  });

  assert.equal(crashed.ok, false);
  assert.equal(crashed.reason, 'reviewer:crashed');
  assert.equal(crashed.submitted, null, 'a crashed review recorded a decision');

  // STATE ONE: the lease is still held by the dead reviewer, so nobody else can
  // take it yet. That is the outage this test has to prove recovery FROM.
  const blocked = await runReview({
    task, reviewerSession: 'reviewer-two',
    reviewer: createFakeReviewer(), workspaces, bridge,
    envelopeFor: async () => goodEnvelope(),
    io: { workspaceGit: probe(), now: () => clock },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'under-review', 'a dead reviewer did not hold the lease at all');

  // STATE TWO: the lease has expired and nothing has swept it yet. claim_review
  // admits this, which is the same rule the work lease follows.
  clock += 1801 * 1000;
  const row = bridge.rows.get('t-review');
  assert.notEqual(row.review_lease_token, null, 'the fixture reaped it early; this is the wrong state');
  assert.ok(row.review_lease_expires_at <= clock);

  const reclaimed = await runReview({
    task, reviewerSession: 'reviewer-two',
    reviewer: createFakeReviewer(), workspaces, bridge,
    envelopeFor: async () => goodEnvelope(),
    io: { workspaceGit: probe(), now: () => clock },
  });
  assert.equal(reclaimed.ok, true, `reclaim failed: ${reclaimed.stage}/${reclaimed.reason}`);
  assert.equal(reclaimed.decision.decision, REVIEW_DECISION.ACCEPT);
  assert.equal(bridge.rows.get('t-review').state, 'accepted');
  assert.equal(bridge.rows.get('t-review').reviewed_by, 'reviewer-two');
});

test('AND STATE THREE: after the reaper nulls the columns, the work is still reclaimable', async () => {
  let clock = 1_000_000;
  const task = returnedTask();
  const bridge = createFakeBridge({ tasks: [task], now: () => clock });

  await bridge.claimReview({ task_id: 't-review', reviewer_session: 'reviewer-one' });
  clock += 1801 * 1000;
  assert.equal(await bridge.expireDeadReviews(), 1, 'the reaper swept nothing');
  const row = bridge.rows.get('t-review');
  assert.equal(row.review_lease_token, null, 'the premise: the columns really were nulled');
  assert.equal(row.state, 'returned', 'the reaper moved the row as well as the lease');

  const r = await runReview({
    task, reviewerSession: 'reviewer-two',
    reviewer: createFakeReviewer(), workspaces: fakeWorkspaces(), bridge,
    envelopeFor: async () => goodEnvelope(),
    io: { workspaceGit: probe(), now: () => clock },
  });
  assert.equal(r.ok, true, `${r.stage}/${r.reason}`);
});

/* ── a lost race is not a success ────────────────────────────────────── */

test('A SUPERSEDED REVIEW TOKEN IS A REFUSAL, NOT A QUIET PASS', async () => {
  /*
   * The zombie catch for the review half. The reviewer reads for half an hour,
   * its lease expires, somebody else reclaims and decides -- and this one's
   * verdict must not land on top.
   */
  let clock = 1_000_000;
  const task = returnedTask();
  const bridge = createFakeBridge({ tasks: [task], now: () => clock });
  const workspaces = fakeWorkspaces();

  const r = await runReview({
    task, reviewerSession: 'reviewer-slow',
    reviewer: {
      id: 'slow',
      async review() {
        // the lease expires while the reviewer is reading, then somebody else
        // takes it -- which is the state that makes the token stale
        clock += 1801 * 1000;
        await bridge.claimReview({ task_id: 't-review', reviewer_session: 'reviewer-fast' });
        return { reviewer: 'slow', decision: 'accept', findings: [] };
      },
    },
    workspaces, bridge,
    envelopeFor: async () => goodEnvelope(),
    io: { workspaceGit: probe(), now: () => clock },
  });

  assert.equal(r.ok, false, 'a submit against a superseded token was reported as a success');
  assert.equal(r.stage, STAGE.SUBMIT);
  assert.equal(r.reason, 'review-lease-not-current');
  assert.equal(bridge.rows.get('t-review').state, 'returned', 'the stale verdict landed');
  assert.ok(workspaces.log.some(([verb]) => verb === 'quarantine'));
});

test('A REVIEW OF A COMMIT THE TASK DID NOT RETURN IS REFUSED', async () => {
  const h = harness({ envelopeFor: async () => goodEnvelope({ commit: 'd'.repeat(40) }) });
  const r = await runReview(h.args);
  assert.equal(r.ok, false);
  assert.equal(r.stage, STAGE.SUBMIT);
  assert.equal(r.reason, 'head-moved');
});

/* ── absent evidence is not clean evidence ───────────────────────────── */

test('NO ENVELOPE MEANS NO REVIEW: the agent\'s word is not a fallback', async () => {
  const h = harness({ envelopeFor: async () => null });
  const r = await runReview(h.args);
  assert.equal(r.ok, false);
  assert.equal(r.stage, STAGE.EVIDENCE);
  assert.equal(r.reason, 'evidence:absent');
  assert.equal(h.bridge.rows.get('t-review').state, 'returned');
  // the lease is held and will be reaped; nothing was decided on no evidence
  assert.deepEqual(h.bridge.outbox.map((e) => e.kind), ['review_claimed']);
});

/* ── the pure decisions, at their boundaries ─────────────────────────── */

const packetOf = (env, review) => buildReviewerPacket({ envelope: env, diffRef: 'diff://x', contract: null });

test('A REVIEWER CANNOT ACCEPT WHAT THE MACHINE REJECTED', async () => {
  const env = createResultEnvelope({
    taskId: 't', outcome: 'exited', exitCode: 1,
    tests: { passed: 0, failed: 1, skipped: 0, total: 1 }, commit: SHA,
    pathContract: { allowed: [], forbidden: [], violations: [] },
  });
  const d = decideReview({ packet: packetOf(env), review: { reviewer: 'x', decision: 'accept', findings: [] } });
  assert.notEqual(d.decision, REVIEW_DECISION.ACCEPT);
  assert.ok(d.reasons.includes('machine:exit-code:1'));
  assert.ok(d.reasons.includes('machine:tests:failed:1'));
});

test('A REVIEWER THAT REFUSES WITHOUT NAMING ANYTHING STILL PRODUCES A REASON', async () => {
  const d = decideReview({
    packet: packetOf(goodEnvelope()),
    review: { reviewer: 'x', decision: 'request-changes', findings: [] },
  });
  assert.equal(d.decision, REVIEW_DECISION.FIX_REQUIRED);
  assert.deepEqual(d.reasons, ['reviewer:unexplained-refusal']);
});

test('NO REVIEWER IS NOT AN ACCEPT OF BAD EVIDENCE', async () => {
  const env = createResultEnvelope({ taskId: 't', outcome: 'crashed', tests: null, commit: null });
  const d = decideReview({ packet: packetOf(env), review: null });
  assert.equal(d.decision, REVIEW_DECISION.REJECT);
  // and a clean attempt with no reviewer is still an accept: the stage is a
  // second opinion, not the only one
  assert.equal(decideReview({ packet: packetOf(goodEnvelope()), review: null }).decision,
    REVIEW_DECISION.ACCEPT);
});

test('fixTaskFor REFUSES ANY DECISION BUT fix_required, and never reuses the task id', async () => {
  const packet = packetOf(goodEnvelope());
  const decision = { decision: REVIEW_DECISION.FIX_REQUIRED, reasons: ['reviewer:x'] };
  const fix = fixTaskFor({ task: returnedTask(), packet, decision, raisedBy: 'r' });
  assert.notEqual(fix.task_id, 't-review');
  assert.equal(fix.requires_review, true);
  assert.equal(fix.raised_by, 'r');

  // derived, so a duplicate delivery finds the same row rather than a second fix
  const again = fixTaskFor({ task: returnedTask(), packet, decision, raisedBy: 'r' });
  assert.equal(again.task_id, fix.task_id);

  assert.throws(
    () => fixTaskFor({
      task: returnedTask(), packet, raisedBy: 'r',
      decision: { decision: REVIEW_DECISION.ACCEPT, reasons: [] },
    }),
    /accept/,
  );
});

test('A FIXER MAY NOT DECIDE THAT ITS OWN FIX CLOSED THE FINDING', async () => {
  const fixTask = {
    fix_of: 't-review', findings: ['reviewer:policy:no-change'], fixed_by: 'fixer-session',
  };
  assert.throws(
    () => resolveFindings({ fixTask, review: { reviewer: 'fixer-session', decision: 'accept' } }),
    /cannot also decide/,
  );

  // THE POSITIVE FIRST: somebody else's accept does close it, or the refusal
  // above would pass against a function that closes nothing for anyone.
  const closed = resolveFindings({ fixTask, review: { reviewer: 'other-session', decision: 'accept' } });
  assert.deepEqual(closed.resolved, ['reviewer:policy:no-change']);
  assert.deepEqual(closed.open, []);

  // and a refusal leaves it open rather than half-closing it
  const still = resolveFindings({ fixTask, review: { reviewer: 'other-session', decision: 'fix_required' } });
  assert.deepEqual(still.resolved, []);
  assert.deepEqual(still.open, ['reviewer:policy:no-change']);
});

test('mutationBetween reads a missing fingerprint as a mutation and an equal one as none', async () => {
  assert.equal(mutationBetween({ head: 'a', dirty: [] }, { head: 'a', dirty: [] }), null);
  assert.equal(mutationBetween({ head: 'a', dirty: [] }, { head: 'b', dirty: [] }).kind, 'head');
  assert.equal(mutationBetween({ head: 'a', dirty: [] }, { head: 'a', dirty: ['x'] }).kind, 'tree');
  assert.equal(mutationBetween(null, { head: 'a', dirty: [] }).kind, 'unknown');
  assert.equal(mutationBetween({ head: 'a', dirty: [] }, null).kind, 'unknown');
  // order is not a mutation: git may list the same two files either way round
  assert.equal(mutationBetween({ head: 'a', dirty: ['x', 'y'] }, { head: 'a', dirty: ['y', 'x'] }), null);
});

/* ── the eviction this change makes reachable, in the model ──────────── */

test('A WORKER CLAIMING RETURNED WORK IS REFUSED WHILE A REVIEW LEASE IS LIVE', async () => {
  /*
   * claim_task admits 'returned' and release_review_lease nulls the reviewer
   * columns on the way out of it, so before this change a worker claiming work
   * under review destroyed the reviewer's lease and nothing was addressed to the
   * reviewer. 20260916181000 implements Danny's ruling; this is the model of it.
   *
   * THE POSITIVE CONTROL IS THE SECOND HALF: the same claim succeeds once the
   * review lease has expired. A refusal that fired unconditionally would pass
   * the first assertion and break every claim in the system.
   */
  let clock = 1_000_000;
  const task = returnedTask();
  const bridge = createFakeBridge({ tasks: [task], now: () => clock });
  await bridge.claimReview({ task_id: 't-review', reviewer_session: 'reviewer-one' });

  const evicting = await bridge.claimTask({
    task_id: 't-review', agent_id: 'code-x', session_id: 'worker-two',
  });
  assert.equal(evicting.ok, false, 'a worker evicted a live reviewer');
  assert.equal(evicting.reason, 'under-review');
  assert.notEqual(bridge.rows.get('t-review').review_lease_token, null, 'the lease was destroyed anyway');

  clock += 1801 * 1000;
  const after = await bridge.claimTask({
    task_id: 't-review', agent_id: 'code-x', session_id: 'worker-two',
  });
  assert.equal(after.ok, true, 'an expired review lease blocked a claim forever');
});

/* ── the edge routes, which the suite cannot import and must read ─────── */

/*
 * supabase/functions/mcp/index.ts is a Deno entrypoint. It cannot be imported
 * here, which is exactly why anything left in it is untested by construction --
 * so the decisions live in src/ and these two assertions check the one thing
 * that has to be true of the forwarder: the fencing token reaches the RPC.
 *
 * THEY BLANK COMMENTS AND THEY SLICE TO THE CALL. Both traps are live here.
 * The route explains `review_lease_token` in a 400 body and again in a comment,
 * so a file-wide match for that identifier would be satisfied by prose about
 * the field while the field itself was deleted -- which is exactly how a gate
 * asserting the client sends `lease_token` passed against the CLI's own error
 * message.
 */

test('THE SUBMIT ROUTE SENDS THE REVIEW TOKEN TO submit_review, not a comment about it', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { codeOnly } = await import('./helpers/codeOnly.mjs');

  const index = fileURLToPath(new URL('../supabase/functions/mcp/index.ts', import.meta.url));
  const code = codeOnly(await readFile(index, 'utf8'));

  // POSITIVE CONTROL FOR THE READ ITSELF. A non-match is not evidence the
  // search ran: if this file moves or the path breaks, everything below is
  // vacuously true against an empty string.
  assert.ok(code.length > 10000, `read ${code.length} bytes; that is not the entrypoint`);
  assert.match(code, /Deno\.serve/, 'the file read is not the edge entrypoint');

  const at = code.indexOf("rpc('submit_review'");
  assert.notEqual(at, -1, 'the submit route does not call submit_review at all');
  const call = code.slice(at, code.indexOf('});', at));

  assert.match(
    call,
    /p_review_token:\s*reviewToken/,
    'submit_review is called without the token from the request. Unfenced, a reviewer whose '
      + 'lease expired half an hour ago can still land its verdict on work somebody else holds.',
  );
  assert.match(
    call,
    /p_reviewer_session:\s*row\.session_id/,
    'the reviewer session is taken from the body rather than resolved from the registry. '
      + "claim_review's self-review refusal compares that string to returned_by, so a caller "
      + 'that chooses it can review its own work by typing a different name.',
  );
});

test('THE CLAIM ROUTE RESOLVES THE REVIEWER FROM THE REGISTRY, NOT FROM THE BODY', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { codeOnly } = await import('./helpers/codeOnly.mjs');

  const index = fileURLToPath(new URL('../supabase/functions/mcp/index.ts', import.meta.url));
  const code = codeOnly(await readFile(index, 'utf8'));

  const at = code.indexOf("rpc('claim_review'");
  assert.notEqual(at, -1, 'nothing calls claim_review; the review lease still has no claimant');
  const call = code.slice(at, code.indexOf('});', at));
  assert.match(call, /p_reviewer_session:\s*row\.session_id/);
  assert.doesNotMatch(
    call,
    /p_reviewer_session:\s*(body|claimed)/,
    'the reviewer session comes straight from the request body',
  );
});
