import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAttempt, DISPOSAL } from '../src/attemptPipeline.mjs';
import { defineExecutor } from '../src/executorAdapter.mjs';
import { createLoopState } from '../src/loopDetector.mjs';
import { createLedger } from '../src/tokenTelemetry.mjs';
import { createFakeReviewer } from './fakeReviewer.mjs';

/**
 * THE CLOSED LOOP, PROVED IN BOTH DIRECTIONS.
 *
 * A pipeline that only ever rejects is an outage and a pipeline that only ever
 * accepts is decoration, so every test below has a twin. The fixtures differ by
 * one field at a time -- the test summary, the reviewer's answer, the agent's
 * prose -- because a fixture that changes three things proves which of them
 * mattered to nobody.
 */

const GREEN = '# tests 12\n# pass 12\n# fail 0\n# skipped 0\n';
const RED = '# tests 12\n# pass 9\n# fail 3\n# skipped 0\n';

function fakeWorkspaces() {
  const calls = { created: [], destroyed: [], quarantined: [] };
  return {
    calls,
    async create({ taskId, baseSha, attempt }) {
      const ws = { taskId, attempt, baseSha, path: `/w/${taskId}-a${attempt}` };
      calls.created.push(ws.path);
      return ws;
    },
    async destroy(ws) {
      calls.destroyed.push(ws.path);
      return { destroyed: true, reason: null };
    },
    async quarantine(ws, reason) {
      calls.quarantined.push({ path: ws.path, reason });
      return `/w/.quarantine/${ws.taskId}`;
    },
  };
}

const executorThat = (stdout, { exitCode = 0, notes = '' } = {}) =>
  defineExecutor({
    id: 'fake',
    capabilities: ['shell', 'write', 'commit'],
    run: async () => ({ outcome: 'exited', exitCode, stdout, notes, durationMs: 10 }),
  });

const io = (files = ['src/a.mjs']) => ({
  now: () => 1_000,
  git: { headSha: async () => 'abc1234', changedFiles: async () => files },
});

const task = {
  task_id: 't-1',
  attempt: 0,
  base_sha: 'deadbee',
  argv: ['npm', 'test'],
  timeout_ms: 1000,
};
const contract = { allowed: ['src/**'], forbidden: [] };

test('A GOOD ATTEMPT IS ACCEPTED AND ITS WORKSPACE IS DESTROYED', async () => {
  const workspaces = fakeWorkspaces();
  const out = await runAttempt({
    task,
    contract,
    workspaces,
    io: io(),
    executor: executorThat(GREEN),
    reviewer: createFakeReviewer(),
  });
  assert.equal(out.accepted, true);
  assert.equal(out.verdict.verdict, 'accept');
  assert.equal(out.review.decision, 'accept');
  assert.equal(out.disposal.outcome, DISPOSAL.DESTROYED);
  assert.deepEqual(
    workspaces.calls.quarantined,
    [],
    'a clean accepted attempt leaves nothing behind',
  );
});

test('A FAILING ATTEMPT IS QUARANTINED, NEVER DESTROYED', async () => {
  const workspaces = fakeWorkspaces();
  const out = await runAttempt({
    task,
    contract,
    workspaces,
    io: io(),
    executor: executorThat(RED, { exitCode: 1 }),
    reviewer: createFakeReviewer(),
  });
  assert.equal(out.accepted, false);
  assert.equal(out.disposal.outcome, DISPOSAL.QUARANTINED);
  assert.deepEqual(workspaces.calls.destroyed, [], 'a failed attempt is evidence');
  assert.match(workspaces.calls.quarantined[0].reason, /tests:failed:3/);
});

test("PROSE CHANGES NOTHING: two attempts differing only in the agent's account", async () => {
  const run = (notes) =>
    runAttempt({
      task,
      contract,
      workspaces: fakeWorkspaces(),
      io: io(),
      executor: executorThat(RED, { exitCode: 1, notes }),
      reviewer: createFakeReviewer(),
    });
  const boastful = await run('All green. The three failures are pre-existing and unrelated.');
  const honest = await run('I broke three tests.');

  assert.deepEqual(boastful.verdict, honest.verdict);
  assert.deepEqual(boastful.review, honest.review);
  assert.equal(
    boastful.fingerprint,
    honest.fingerprint,
    'prose must not even change the fingerprint',
  );
  assert.equal(JSON.stringify(boastful.packet).includes('pre-existing'), false);
});

test('A REVIEWER CANNOT RESCUE AN ATTEMPT THE EVIDENCE REJECTS', async () => {
  const yesMan = {
    id: 'yes',
    async review() {
      return { reviewer: 'yes', decision: 'accept', findings: [] };
    },
  };
  const out = await runAttempt({
    task,
    contract,
    workspaces: fakeWorkspaces(),
    io: io(),
    executor: executorThat(RED, { exitCode: 1 }),
    reviewer: yesMan,
  });
  assert.equal(out.review.decision, 'accept');
  assert.equal(out.accepted, false, 'machine evidence is the thing neither side can argue with');
});

test('and the positive: a reviewer CAN reject an attempt the evidence allows', async () => {
  const picky = {
    id: 'no',
    async review() {
      return { reviewer: 'no', decision: 'request-changes', findings: ['style'] };
    },
  };
  const out = await runAttempt({
    task,
    contract,
    workspaces: fakeWorkspaces(),
    io: io(),
    executor: executorThat(GREEN),
    reviewer: picky,
  });
  assert.equal(out.verdict.verdict, 'accept');
  assert.equal(out.accepted, false, 'review is a second opinion that counts');
});

test('NO REVIEWER IS NOT AN AUTOMATIC PASS FOR FAILING EVIDENCE', async () => {
  const out = await runAttempt({
    task,
    contract,
    workspaces: fakeWorkspaces(),
    io: io(),
    executor: executorThat(RED, { exitCode: 1 }),
    reviewer: null,
  });
  assert.equal(out.review, null);
  assert.equal(out.accepted, false);
});

test('a path outside the contract fails the attempt', async () => {
  const out = await runAttempt({
    task,
    contract,
    workspaces: fakeWorkspaces(),
    io: io(['src/a.mjs', 'supabase/migrations/001.sql']),
    executor: executorThat(GREEN),
    reviewer: createFakeReviewer(),
  });
  assert.equal(out.accepted, false);
  assert.ok(out.verdict.reasons.includes('path:supabase/migrations/001.sql'));
});

test('THREE IDENTICAL ATTEMPTS ARE REPORTED AS A LOOP, and the caller decides', async () => {
  let state = createLoopState();
  let last = null;
  for (let i = 0; i < 3; i += 1) {
    last = await runAttempt({
      task,
      contract,
      workspaces: fakeWorkspaces(),
      io: io(),
      executor: executorThat(RED, { exitCode: 1 }),
      reviewer: createFakeReviewer(),
      loopState: state,
    });
    state = last.loopState;
  }
  assert.equal(last.loop.kind, 'repeat');
  assert.equal(last.loop.count, 3);
  assert.equal(
    last.disposal.outcome,
    DISPOSAL.QUARANTINED,
    'the pipeline still finishes the attempt',
  );
  assert.match(last.disposal ? String(last.loop.kind) : '', /repeat/);
});

test('progress is not a loop', async () => {
  let state = createLoopState();
  let last = null;
  for (const files of [['src/a.mjs'], ['src/b.mjs'], ['src/c.mjs']]) {
    last = await runAttempt({
      task,
      contract,
      workspaces: fakeWorkspaces(),
      io: io(files),
      executor: executorThat(RED, { exitCode: 1 }),
      reviewer: createFakeReviewer(),
      loopState: state,
    });
    state = last.loopState;
  }
  assert.equal(last.loop, null);
});

test('large output spills by reference and the record says it is complete', async () => {
  const store = new Map();
  const sink = {
    put: async ({ sha256, text }) => {
      store.set(sha256, text);
      return `artifact://${sha256}`;
    },
  };
  const big = `${'x'.repeat(40_000)}\n${GREEN}`;
  const out = await runAttempt({
    task,
    contract,
    workspaces: fakeWorkspaces(),
    io: { ...io(), sink, outputLimit: 1024 },
    executor: executorThat(big),
    reviewer: createFakeReviewer(),
  });
  assert.equal(out.stdout.kind, 'spilled');
  assert.equal(out.stdout.complete, true);
  assert.equal(store.get(out.stdout.sha256), big);
  assert.equal(out.packet.logRef, out.stdout.ref, 'the reviewer is told where the whole log is');
});

test('without a sink the log is marked incomplete rather than quietly shortened', async () => {
  const out = await runAttempt({
    task,
    contract,
    workspaces: fakeWorkspaces(),
    io: { ...io(), outputLimit: 1024 },
    executor: executorThat(`${'x'.repeat(40_000)}\n${GREEN}`),
    reviewer: createFakeReviewer(),
  });
  assert.equal(out.stdout.kind, 'truncated');
  assert.equal(out.stdout.complete, false);
});

test('A TIMEOUT PRODUCES NO COMMIT AND IS NOT ACCEPTED', async () => {
  const timingOut = defineExecutor({
    id: 'slow',
    capabilities: ['shell'],
    run: async () => ({ outcome: 'timeout', stdout: GREEN, durationMs: 1000 }),
  });
  const out = await runAttempt({
    task,
    contract,
    workspaces: fakeWorkspaces(),
    io: io(),
    executor: timingOut,
    reviewer: createFakeReviewer(),
  });
  assert.equal(out.envelope.commit, null, 'a half-written worktree supplies no commit');
  assert.equal(out.envelope.exitCode, null);
  assert.equal(out.accepted, false);
  assert.equal(out.disposal.outcome, DISPOSAL.QUARANTINED);
});

test('telemetry records the attempt once, and a repeat report does not double it', async () => {
  let ledger = createLedger({ budget: 10_000 });
  const run = () =>
    runAttempt({
      task,
      contract,
      workspaces: fakeWorkspaces(),
      io: { ...io(), usage: { input: 100, output: 20, cacheRead: 900, cacheCreation: 40 } },
      executor: executorThat(GREEN),
      reviewer: createFakeReviewer(),
      ledger,
    });
  const first = await run();
  assert.equal(first.spent.billed, 120);
  assert.equal(first.spent.input, 100, 'cached input is not input');
  assert.equal(first.spent.cacheRead, 900, 'cache read is preserved as its own dimension');
  assert.equal(first.spent.cacheCreation, 40, 'cache creation is preserved, separate from read');
});

/*
 * THE HEADLINE PATH: the aggregate must be BOUND INTO THE DURABLE ROW, not just
 * returned. A blind clone audit found the binding block never ran under test --
 * every telemetry test omitted io.records/routing, so `attemptRow` stayed null
 * and the finishAttempt binding was skipped; a mutation nulling it passed the
 * whole suite. These drive the true path: ledger + io.usage + io.records +
 * task.routing together, and assert the FINISHED row.
 */
const DIGEST = 'a'.repeat(64);
const ROUTING = Object.freeze({
  engine: 'claude-code', model: 'claude-opus-5', roleProfile: 'builder',
  workerSlotId: 'slot-3', sessionId: 'sess-1', leaseId: 'lease-9', fenceToken: '41',
  repo: 'agentbridge', baseSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  taskClass: 'code-edit', riskClass: 'routine', environmentDigest: DIGEST,
});
const recordingTask = { ...task, routing: ROUTING, context_digest: DIGEST };

test('the aggregate is BOUND INTO the durable row on the true path, not merely returned', async () => {
  let finished = null;
  const records = { start: async () => {}, finish: async (row) => { finished = row; } };
  const out = await runAttempt({
    task: recordingTask,
    contract,
    workspaces: fakeWorkspaces(),
    io: { ...io(), usage: { input: 100, output: 20, cacheRead: 900, cacheCreation: 40, source: 'test-provider' }, records },
    executor: executorThat(GREEN),
    reviewer: createFakeReviewer(),
    ledger: createLedger({ budget: 10_000 }),
  });
  assert.equal(out.accepted, true, `precondition: the attempt is accepted (${out.verdict?.reasons?.join(',') ?? ''})`);
  assert.ok(finished, 'the durable finish write must have happened (io.records.finish called)');
  assert.equal(finished.tokensPrompt, 100, 'input bound into the durable row, not dropped');
  assert.equal(finished.tokensCompletion, 20, 'output bound, not swapped with input');
  assert.equal(finished.tokensCacheRead, 900);
  assert.equal(finished.tokensCacheCreation, 40);
  assert.equal(finished.usageObserved, true);
  assert.equal(finished.usageSource, 'test-provider');
});

test('with NO usage observed, the durable row records null tokens, never 0', async () => {
  let finished = null;
  const records = { start: async () => {}, finish: async (row) => { finished = row; } };
  await runAttempt({
    task: recordingTask,
    contract,
    workspaces: fakeWorkspaces(),
    io: { ...io(), records }, // ledger present, but no io.usage
    executor: executorThat(GREEN),
    reviewer: createFakeReviewer(),
    ledger: createLedger({ budget: 10_000 }),
  });
  assert.ok(finished, 'the durable finish write must have happened');
  assert.equal(finished.usageObserved, false, 'no provider usage means observed is false');
  for (const f of ['tokensPrompt', 'tokensCompletion', 'tokensCacheRead', 'tokensCacheCreation', 'usageSource']) {
    assert.equal(finished[f], null, `${f} must be null when usage was not observed, not 0`);
  }
});

test('A RUN MAY NOT OUTLIVE THE LEASE THAT AUTHORISES IT', async () => {
  /*
   * Reported from the live system by code-c: the default lease is 900s and the
   * default run timeout was 1800s, so a normal-length task lost its lease
   * partway through and the finished work was correctly discarded. Silent,
   * expensive, and indistinguishable from flakiness.
   */
  await assert.rejects(
    runAttempt({
      task: { ...task, lease_ms: 900_000, timeout_ms: 1_800_000 },
      contract, workspaces: fakeWorkspaces(), io: io(),
      executor: executorThat(GREEN), reviewer: createFakeReviewer(),
    }),
    /not shorter than the lease/,
  );
});

test('the default deadline fits inside the default lease', async () => {
  // the positive: no explicit timeout, and it is still accepted against a 900s lease
  const out = await runAttempt({
    task: { ...task, lease_ms: 900_000, timeout_ms: undefined },
    contract, workspaces: fakeWorkspaces(), io: io(),
    executor: executorThat(GREEN), reviewer: createFakeReviewer(),
  });
  assert.equal(out.accepted, true);
});

test('a deadline equal to the lease is refused, not merely one that exceeds it', async () => {
  await assert.rejects(
    runAttempt({
      task: { ...task, lease_ms: 900_000, timeout_ms: 900_000 },
      contract, workspaces: fakeWorkspaces(), io: io(),
      executor: executorThat(GREEN), reviewer: createFakeReviewer(),
    }),
    /not shorter than the lease/,
  );
});

test('without a stated lease the pipeline does not invent one', async () => {
  const out = await runAttempt({
    task: { ...task, timeout_ms: 1_800_000 },
    contract, workspaces: fakeWorkspaces(), io: io(),
    executor: executorThat(GREEN), reviewer: createFakeReviewer(),
  });
  assert.equal(out.accepted, true, 'a caller that has not said what the lease is gets no guess');
});
