/*
 * THE ATTEMPT RECORD, AND EVERY REFUSAL IT MAKES.
 *
 * A gate that only permits is decoration, so every assertion below that proves
 * a valid row is built has a partner proving an invalid one is refused. The
 * refusals are the reason the module exists: the row is written by a caller in
 * a hurry, at the end of a run that has already gone wrong, and the builder is
 * the only thing standing between that caller and a record nobody can attribute.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ATTEMPT_RECORD_VERSION,
  attemptStep,
  crashAttempt,
  finishAttempt,
  putRaw,
  startAttempt,
} from '../src/attemptRecord.mjs';
import { createCas, memoryStore } from '../src/cas.mjs';

const DIGEST = 'a'.repeat(64);
const T0 = '2026-09-16T08:00:00.000Z';
const T1 = '2026-09-16T08:05:00.000Z';

function started(overrides = {}) {
  return startAttempt({
    attemptId: 'att-1',
    taskId: 'task-1',
    attemptNo: 1,
    startedAt: T0,
    engine: 'claude-code',
    model: 'claude-opus-5',
    roleProfile: 'builder',
    workerSlotId: 'slot-3',
    sessionId: 'social-sparks-app-b6',
    leaseId: 'lease-9',
    fenceToken: '41',
    repo: 'agentbridge',
    baseSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    taskClass: 'code-edit',
    riskClass: 'routine',
    environmentDigest: DIGEST,
    workspaceId: 'ws-1',
    runtimeVersion: 'node-24.18.1',
    executorVersion: 'local-1',
    policyRevision: 'pol-7',
    toolSchemaRevision: 'tools-2',
    contextDigest: DIGEST,
    retryOfAttemptId: null,
    ...overrides,
  });
}

/* ── the row exists before anything is known ──────────────────────────── */

test('a started attempt is durable before the outcome is known', () => {
  const row = started();
  assert.equal(row.schemaVersion, ATTEMPT_RECORD_VERSION);
  assert.equal(row.state, 'running');
  assert.equal(row.finishedAt, null);
  assert.equal(row.engine, 'claude-code');
  assert.equal(row.fenceToken, '41');
});

test('ABSENT IS NULL, NOT PASSING, on a row that has not finished', () => {
  const row = started();
  for (const field of [
    'ending',
    'exitCode',
    'agentClaimedSuccess',
    'verificationVerdict',
    'reviewVerdict',
    'finalState',
  ]) {
    assert.equal(row[field], null, `${field} must start null`);
  }
});

test('routing identity that cannot be recovered later is REQUIRED', () => {
  for (const key of ['engine', 'model', 'workerSlotId', 'leaseId', 'fenceToken', 'riskClass']) {
    assert.throws(
      () => started({ [key]: undefined }),
      new RegExp(key),
      `${key} must be refused when missing — it cannot be reconstructed at the end`,
    );
  }
});

test('an unknown key is refused rather than dropped', () => {
  assert.throws(() => started({ confidence: 0.9 }), /unknown startAttempt key "confidence"/);
});

/* ── four verdicts, never collapsed ───────────────────────────────────── */

test('all four verdicts are stored separately and none is inferred', () => {
  const row = finishAttempt({
    record: started(),
    finishedAt: T1,
    ending: 'exited',
    exitCode: 0,
    agentClaimedSuccess: true,
    verificationVerdict: 'rejected',
    reviewVerdict: null,
    finalState: 'failed',
  });

  /*
   * THE FALSE-DONE CASE, WHICH IS THE WHOLE POINT. The agent said it worked and
   * the machine says it did not. Both survive in the row; nothing reconciles
   * them into a status, because the disagreement is the signal.
   */
  assert.equal(row.agentClaimedSuccess, true);
  assert.equal(row.verificationVerdict, 'rejected');
  assert.equal(row.reviewVerdict, null);
  assert.equal(row.finalState, 'failed');
  assert.equal(row.status, undefined, 'there must be no status column');
});

test('a verdict vocabulary is not interchangeable with another', () => {
  const base = { record: started(), finishedAt: T1, ending: 'exited', exitCode: 0 };
  assert.throws(
    () => finishAttempt({ ...base, verificationVerdict: 'accept' }),
    /verificationVerdict/,
    'a reviewer verdict must not pass as a machine verdict',
  );
  assert.throws(
    () => finishAttempt({ ...base, reviewVerdict: 'verified' }),
    /reviewVerdict/,
    'a machine verdict must not pass as a reviewer verdict',
  );
  assert.throws(() => finishAttempt({ ...base, finalState: 'accept' }), /finalState/);
});

/* ── a killed run must not wear the shape of a clean finish ───────────── */

test('an ending that is not a normal exit cannot carry an exit code', () => {
  assert.throws(
    () =>
      finishAttempt({
        record: started(),
        finishedAt: T1,
        ending: 'timeout',
        exitCode: 0,
      }),
    /timeout cannot carry an exit code/,
    'a killed run reported as exit 0 teaches a learning set that the engine succeeded',
  );
});

/* ── a row on every ending, especially a crash ────────────────────────── */

test('a crash still produces a row, with verdicts NULL rather than failed', () => {
  const row = crashAttempt({ record: started(), finishedAt: T1, failureCode: 'SIGKILL' });

  assert.equal(row.state, 'finished');
  assert.equal(row.ending, 'crashed');
  assert.equal(row.failureCode, 'SIGKILL');
  assert.equal(row.finalState, 'failed');

  /*
   * "The process died" is not "the machine verified a failure". A learning set
   * that cannot tell those apart blames the engine for an infrastructure crash.
   */
  assert.equal(row.verificationVerdict, null);
  assert.equal(row.agentClaimedSuccess, null);
  assert.equal(row.reviewVerdict, null);
});

test('crashAttempt refuses to be used for a normal exit', () => {
  assert.throws(
    () => crashAttempt({ record: started(), finishedAt: T1, ending: 'exited' }),
    /not a normal exit/,
  );
});

/* ── raw output travels by reference ──────────────────────────────────── */

test('RAW OUTPUT IS REFUSED INLINE, because that is how a credential lands', () => {
  assert.throws(
    () =>
      finishAttempt({
        record: started(),
        finishedAt: T1,
        ending: 'exited',
        exitCode: 0,
        rawOutputRef: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG\nnpm ERR! failed',
      }),
    /must be a cas:\/\/ reference, not raw output/,
  );
});

test('putRaw is the only way to produce a ref the row accepts', async () => {
  const cas = createCas({ store: memoryStore(), namespace: 'attempt-raw' });
  const ref = await putRaw(cas, 'attempt-raw', 'npm ERR! code ELIFECYCLE\n');

  assert.match(ref, /^cas:\/\/attempt-raw\/[0-9a-f]{64}\/\d+$/);

  const row = finishAttempt({
    record: started(),
    finishedAt: T1,
    ending: 'exited',
    exitCode: 1,
    rawOutputRef: ref,
  });
  assert.equal(row.rawOutputRef, ref);
});

/* ── the step journal, which recovery reads instead of logs ───────────── */

test('a step records which durable stage actually finished', () => {
  const step = attemptStep({
    attemptId: 'att-1',
    kind: 'VERIFY',
    status: 'finished',
    startedAt: T0,
    finishedAt: T1,
    outputDigest: DIGEST,
    retryable: false,
  });
  assert.equal(step.kind, 'VERIFY');
  assert.equal(step.schemaVersion, ATTEMPT_RECORD_VERSION);
});

test('a finished step without a finishing time is refused', () => {
  assert.throws(
    () =>
      attemptStep({
        attemptId: 'att-1',
        kind: 'VERIFY',
        status: 'finished',
        startedAt: T0,
      }),
    /must carry finishedAt/,
    'it would look complete and could not be ordered against the next step',
  );
});

test('a started step must not claim a finishing time', () => {
  assert.throws(
    () =>
      attemptStep({
        attemptId: 'att-1',
        kind: 'AGENT_RUN',
        status: 'started',
        startedAt: T0,
        finishedAt: T1,
      }),
    /has not finished/,
  );
});

test('an invented step kind is refused', () => {
  assert.throws(
    () => attemptStep({ attemptId: 'att-1', kind: 'ALMOST_DONE', status: 'started', startedAt: T0 }),
    /kind must be one of/,
  );
});

/* ── the version travels with the row ─────────────────────────────────── */

test('a row from another schema version is refused rather than read', () => {
  const stale = { ...started(), schemaVersion: 99 };
  assert.throws(
    () => finishAttempt({ record: stale, finishedAt: T1, ending: 'exited', exitCode: 0 }),
    /schemaVersion 99 is not 1/,
    'the reader arrives months after the writer',
  );
});
