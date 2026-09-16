/*
 * THE ATTEMPT RECORD. ONE ROW, FOUR VERDICTS, AND NEVER A `status` COLUMN.
 *
 * Nothing may advance authority along a "done" path before the attempt is
 * durable. That is the rule this exists to satisfy: if a task can close
 * unattended, the record of what was attempted has to outlive the process that
 * attempted it, or the first real run is unrecorded and unrecoverable.
 *
 * ONE RECORD, NOT TWO, AND THIS IS THE DECISION MOST LIKELY TO BE UNDONE LATER.
 * The loop needs a durable attempt row. Learning needs routing identity, the
 * execution fabric needs environment identity, the console needs an attempt
 * summary, the expert workforce needs a performance ledger, and false-done
 * needs the verdicts. Five specifications, one subject. Giving the loop a thin
 * row now and adding a trajectory table beside it later produces a second table
 * shadowing the first, which is the answer the project bar names as always
 * wrong. So every field those five need is here, even where the loop alone
 * would not have asked for it.
 *
 * ---------------------------------------------------------------------------
 * FOUR VERDICTS, STORED SEPARATELY, NEVER RECONCILED BY THIS MODULE.
 *
 *   agent_claimed_success   what the work said about itself
 *   verification_verdict    what the machine observed
 *   review_verdict          what an independent reviewer decided
 *   final_state             what the task became
 *
 * Collapsing these into one `status` throws away the only signal that matters
 * for false-done: the DISAGREEMENT. An agent claiming success while
 * verification rejects is the case the whole review runtime exists to catch,
 * and a schema keeping only the final answer has already discarded it before
 * anybody can count how often it happens.
 *
 * So `finishAttempt` takes all four and refuses to infer any of them from
 * another. Absent is `null` and null is not a pass -- the same rule the result
 * envelope enforces, for the same reason.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS CAPTURED AT THE START, BECAUSE IT CANNOT BE RECONSTRUCTED AT THE END.
 *
 * Engine, model, role profile, worker slot, lease and fence, repo, base sha,
 * task and risk class, and the environment digest. By the time an attempt
 * finishes, the worker slot may be reused, the lease expired, the model rolled
 * forward. Benchmark identity includes the hardware it ran on, and the
 * performance work is unbuildable without it.
 *
 * Everything else in the record can be recomputed from the record. These
 * cannot, so `startAttempt` demands them and refuses a row without them.
 *
 * ---------------------------------------------------------------------------
 * A ROW ON EVERY ENDING, ESPECIALLY A CRASH.
 *
 * A recorder written on the success path misses exactly the attempts that
 * teach. `crashAttempt()` exists so that a caller holding almost nothing -- no
 * envelope, no verdicts, possibly no commit -- can still close the row. It
 * fills the verdicts with null rather than with failure, because "the process
 * died" is not "the machine verified a failure", and a learning set that
 * cannot tell those apart will conclude the wrong thing about the engine.
 *
 * ---------------------------------------------------------------------------
 * RAW OUTPUT TRAVELS BY REFERENCE. THIS IS A REFUSAL, NOT A CONVENTION.
 *
 * An inlined tool dump is enormous and is the likeliest place in this system
 * for a credential to reach durable storage: stdout carries whatever the agent
 * printed, and the agent printed whatever its tools did. So the row holds a
 * content-store digest and `putRaw()` is the only way to produce one.
 * Attempting to hand a raw string to the row is a TypeError rather than a
 * silent truncation, because truncating it stores a credential AND loses the
 * output.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE IS NOT. It does not write. It builds and validates rows, the
 * way `leases.mjs` decides and lets its caller act. The CALL SITE belongs to
 * whoever owns lease and fence semantics: the write has to happen inside the
 * fenced return, under the same lease that authorised the work, or a record can
 * be written by a worker whose claim has already expired. Build the row here,
 * write it there.
 */

import { casRef } from './cas.mjs';

export const ATTEMPT_RECORD_VERSION = 1;

/*
 * The reader arrives months after the writer. Every row carries the version it
 * was written under, so a reader meeting an unfamiliar shape can say so instead
 * of quietly reading a field that has changed meaning.
 */

/** How an attempt ended, as observed. Mirrors the result envelope's OUTCOMES. */
export const ENDINGS = Object.freeze([
  'exited',
  'timeout',
  'crashed',
  'refused',
  'unreachable',
]);

/**
 * The machine's verdict and the reviewer's, as separate vocabularies on
 * purpose. A reviewer does not "pass"; it accepts, requires a fix, or rejects,
 * and FIX_REQUIRED creates a separate task rather than a retry inside this
 * attempt.
 */
export const VERIFICATION_VERDICTS = Object.freeze(['verified', 'rejected', 'inconclusive']);
export const REVIEW_VERDICTS = Object.freeze(['accept', 'fix_required', 'reject']);

/** What the task became. Distinct from every verdict above. */
export const FINAL_STATES = Object.freeze(['done', 'failed', 'abandoned', 'superseded']);

/** The durable steps. Recovery asks which one actually finished. */
export const STEP_KINDS = Object.freeze([
  'CLAIM',
  'PREPARE_WORKSPACE',
  'COMPILE_CONTEXT',
  'START_EXECUTOR',
  'AGENT_RUN',
  'COLLECT_RESULT',
  'VERIFY',
  'PUBLISH_ARTIFACTS',
  'REQUEST_REVIEW',
  'REVIEW',
  'ACCEPT_OR_REJECT',
  'CLEANUP',
]);

function fail(message) {
  throw new TypeError(`attempt record: ${message}`);
}

function requireKnownKeys(object, allowed, what) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      /*
       * Unknown keys are refused rather than dropped. A dropped key is how a
       * `summary` or a `confidence` arrives from a well-meaning adapter and is
       * eventually read by something that should only ever read evidence.
       */
      fail(`unknown ${what} key ${JSON.stringify(key)}`);
    }
  }
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${name} must be a non-empty string`);
  return value;
}

function optionalString(value, name) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${name} must be a non-empty string or null`);
  }
  return value;
}

function requireDigest(value, name) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    fail(`${name} must be a sha-256 hex digest`);
  }
  return value;
}

function optionalDigest(value, name) {
  return value === null || value === undefined ? null : requireDigest(value, name);
}

function requireIso(value, name) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    fail(`${name} must be an ISO timestamp`);
  }
  return value;
}

/*
 * IDENTITY THAT CANNOT BE RECOVERED LATER. Every one of these is required, and
 * the requirement is the point: a row missing its engine or its fence token is
 * a row that can never be attributed, and it will be written anyway by a
 * caller in a hurry unless the builder refuses it.
 */
const ROUTING_KEYS = [
  'engine',
  'model',
  'roleProfile',
  'workerSlotId',
  'sessionId',
  'leaseId',
  'fenceToken',
  'repo',
  'baseSha',
  'taskClass',
  'riskClass',
  'environmentDigest',
];

const START_KEYS = [
  'attemptId',
  'taskId',
  'attemptNo',
  'startedAt',
  'retryOfAttemptId',
  'runtimeVersion',
  'executorVersion',
  'policyRevision',
  'toolSchemaRevision',
  'contextDigest',
  'workspaceId',
  ...ROUTING_KEYS,
];

/**
 * The row as it exists the moment the work is claimed, before anything is
 * known about how it went. Written at CLAIM, not at the end.
 */
export function startAttempt(input) {
  if (input === null || typeof input !== 'object') fail('input must be an object');
  requireKnownKeys(input, START_KEYS, 'startAttempt');

  const attemptNo = input.attemptNo;
  if (!Number.isInteger(attemptNo) || attemptNo < 1) {
    fail('attemptNo must be a positive integer');
  }

  const routing = {};
  for (const key of ROUTING_KEYS) {
    routing[key] = requireString(input[key], key);
  }
  requireDigest(routing.environmentDigest, 'environmentDigest');

  return Object.freeze({
    schemaVersion: ATTEMPT_RECORD_VERSION,
    attemptId: requireString(input.attemptId, 'attemptId'),
    taskId: requireString(input.taskId, 'taskId'),
    attemptNo,
    state: 'running',
    startedAt: requireIso(input.startedAt, 'startedAt'),
    lastProgressAt: requireIso(input.startedAt, 'startedAt'),
    finishedAt: null,

    ...routing,

    workspaceId: requireString(input.workspaceId, 'workspaceId'),
    runtimeVersion: requireString(input.runtimeVersion, 'runtimeVersion'),
    executorVersion: requireString(input.executorVersion, 'executorVersion'),
    policyRevision: requireString(input.policyRevision, 'policyRevision'),
    toolSchemaRevision: requireString(input.toolSchemaRevision, 'toolSchemaRevision'),
    contextDigest: requireDigest(input.contextDigest, 'contextDigest'),
    retryOfAttemptId: optionalString(input.retryOfAttemptId, 'retryOfAttemptId'),

    /* Nothing is known about the outcome yet, and null is not a pass. */
    ending: null,
    exitCode: null,
    resultSha: null,
    resultEnvelopeDigest: null,
    rawOutputRef: null,
    agentClaimedSuccess: null,
    verificationVerdict: null,
    reviewVerdict: null,
    finalState: null,
    failureCode: null,
    failureFingerprint: null,
    loopVerdict: null,
    workspaceClean: null,
    pathViolations: null,
    tokensPrompt: null,
    tokensCompletion: null,
    filesChangedCount: null,
    testsPassed: null,
    testsFailed: null,
    durationMs: null,
  });
}

const FINISH_KEYS = [
  'record',
  'finishedAt',
  'ending',
  'exitCode',
  'resultSha',
  'resultEnvelopeDigest',
  'rawOutputRef',
  'agentClaimedSuccess',
  'verificationVerdict',
  'reviewVerdict',
  'finalState',
  'failureCode',
  'failureFingerprint',
  'loopVerdict',
  'workspaceClean',
  'pathViolations',
  'tokensPrompt',
  'tokensCompletion',
  'filesChangedCount',
  'testsPassed',
  'testsFailed',
  'durationMs',
];

function assertNotRawText(value, name) {
  /*
   * The refusal described in the header. A caller reaching for this field with
   * a tool dump gets a TypeError naming putRaw(), rather than a row that
   * quietly carries a credential into durable storage.
   */
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') fail(`${name} must be a cas ref string or null`);
  if (!value.startsWith('cas://')) {
    fail(
      `${name} must be a cas:// reference, not raw output. ` +
        'Raw output travels by reference: put it in the content store with putRaw() and store the ref. ' +
        'Inlining it is how a credential reaches durable storage.',
    );
  }
  return value;
}

/**
 * Close the row with everything observed. Takes all four verdicts and infers
 * none of them from another.
 */
export function finishAttempt(input) {
  if (input === null || typeof input !== 'object') fail('input must be an object');
  requireKnownKeys(input, FINISH_KEYS, 'finishAttempt');

  const record = input.record;
  if (record === null || typeof record !== 'object') fail('record must be a started attempt');
  if (record.schemaVersion !== ATTEMPT_RECORD_VERSION) {
    fail(`record schemaVersion ${record.schemaVersion} is not ${ATTEMPT_RECORD_VERSION}`);
  }

  const ending = input.ending;
  if (!ENDINGS.includes(ending)) fail(`ending must be one of ${ENDINGS.join(', ')}`);

  const exitCode = input.exitCode ?? null;
  if (exitCode !== null && !Number.isInteger(exitCode)) fail('exitCode must be an integer or null');
  if (ending !== 'exited' && exitCode !== null) {
    /*
     * The same refusal the result envelope makes, restated here because this
     * row outlives the envelope. A timeout carrying exit 0 is a killed run
     * wearing the shape of a clean finish, and in a LEARNING SET that is worse
     * than in a decision: it teaches that the engine succeeds when it did not.
     */
    fail(`ending ${ending} cannot carry an exit code`);
  }

  const agentClaimedSuccess = input.agentClaimedSuccess ?? null;
  if (agentClaimedSuccess !== null && typeof agentClaimedSuccess !== 'boolean') {
    fail('agentClaimedSuccess must be a boolean or null');
  }

  const verificationVerdict = input.verificationVerdict ?? null;
  if (verificationVerdict !== null && !VERIFICATION_VERDICTS.includes(verificationVerdict)) {
    fail(`verificationVerdict must be one of ${VERIFICATION_VERDICTS.join(', ')} or null`);
  }

  const reviewVerdict = input.reviewVerdict ?? null;
  if (reviewVerdict !== null && !REVIEW_VERDICTS.includes(reviewVerdict)) {
    fail(`reviewVerdict must be one of ${REVIEW_VERDICTS.join(', ')} or null`);
  }

  const finalState = input.finalState ?? null;
  if (finalState !== null && !FINAL_STATES.includes(finalState)) {
    fail(`finalState must be one of ${FINAL_STATES.join(', ')} or null`);
  }

  return Object.freeze({
    ...record,
    state: 'finished',
    finishedAt: requireIso(input.finishedAt, 'finishedAt'),
    lastProgressAt: requireIso(input.finishedAt, 'finishedAt'),

    ending,
    exitCode,
    resultSha: optionalString(input.resultSha, 'resultSha'),
    resultEnvelopeDigest: optionalDigest(input.resultEnvelopeDigest, 'resultEnvelopeDigest'),
    rawOutputRef: assertNotRawText(input.rawOutputRef, 'rawOutputRef'),

    /* Four columns. Never reconciled here. */
    agentClaimedSuccess,
    verificationVerdict,
    reviewVerdict,
    finalState,

    failureCode: optionalString(input.failureCode, 'failureCode'),
    failureFingerprint: optionalString(input.failureFingerprint, 'failureFingerprint'),
    loopVerdict: optionalString(input.loopVerdict, 'loopVerdict'),
    workspaceClean: input.workspaceClean ?? null,
    pathViolations: input.pathViolations ?? null,
    tokensPrompt: input.tokensPrompt ?? null,
    tokensCompletion: input.tokensCompletion ?? null,
    filesChangedCount: input.filesChangedCount ?? null,
    testsPassed: input.testsPassed ?? null,
    testsFailed: input.testsFailed ?? null,
    durationMs: input.durationMs ?? null,
  });
}

/**
 * Close the row when the process died and almost nothing is known.
 *
 * Deliberately fills the verdicts with NULL rather than with failure. "The
 * process died" is not "the machine verified a failure", and a learning set
 * that cannot tell those apart will attribute an infrastructure crash to the
 * engine's competence.
 */
export function crashAttempt({ record, finishedAt, ending = 'crashed', failureCode = null }) {
  if (!ENDINGS.includes(ending)) fail(`ending must be one of ${ENDINGS.join(', ')}`);
  if (ending === 'exited') fail('crashAttempt is for endings that are not a normal exit');
  return finishAttempt({
    record,
    finishedAt,
    ending,
    failureCode,
    agentClaimedSuccess: null,
    verificationVerdict: null,
    reviewVerdict: null,
    finalState: 'failed',
  });
}

const STEP_KEYS = [
  'attemptId',
  'kind',
  'startedAt',
  'finishedAt',
  'status',
  'inputDigest',
  'outputDigest',
  'errorCode',
  'retryable',
  'executorVersion',
  'runtimeVersion',
  'policyRevision',
];

/**
 * One durable step. Recovery asks which step actually finished, and never
 * infers the recovery point from logs.
 */
export function attemptStep(input) {
  if (input === null || typeof input !== 'object') fail('input must be an object');
  requireKnownKeys(input, STEP_KEYS, 'attemptStep');

  const kind = input.kind;
  if (!STEP_KINDS.includes(kind)) fail(`kind must be one of ${STEP_KINDS.join(', ')}`);

  const status = input.status;
  if (!['started', 'finished', 'failed'].includes(status)) {
    fail('status must be started, finished or failed');
  }
  if (status === 'started' && (input.finishedAt ?? null) !== null) {
    fail('a started step has not finished');
  }
  if (status !== 'started' && (input.finishedAt ?? null) === null) {
    /*
     * A step that claims to have finished without a finishing time is exactly
     * what breaks recovery: it looks complete and cannot be ordered against
     * the step after it.
     */
    fail(`a ${status} step must carry finishedAt`);
  }

  return Object.freeze({
    schemaVersion: ATTEMPT_RECORD_VERSION,
    attemptId: requireString(input.attemptId, 'attemptId'),
    kind,
    status,
    startedAt: requireIso(input.startedAt, 'startedAt'),
    finishedAt: input.finishedAt == null ? null : requireIso(input.finishedAt, 'finishedAt'),
    inputDigest: optionalDigest(input.inputDigest, 'inputDigest'),
    outputDigest: optionalDigest(input.outputDigest, 'outputDigest'),
    errorCode: optionalString(input.errorCode, 'errorCode'),
    retryable: input.retryable ?? null,
    executorVersion: optionalString(input.executorVersion, 'executorVersion'),
    runtimeVersion: optionalString(input.runtimeVersion, 'runtimeVersion'),
    policyRevision: optionalString(input.policyRevision, 'policyRevision'),
  });
}

/**
 * Put raw output in the content store and return the ref the row may carry.
 * The ONLY way to produce a value `rawOutputRef` accepts.
 *
 * The reference is built by `casRef` rather than assembled here. That format is
 * a contract and every call site that builds the string by hand is a place it
 * can be misread, so this module does not own a second opinion about it.
 */
export async function putRaw(cas, namespace, text) {
  if (typeof text !== 'string') fail('raw output must be a string');
  requireString(namespace, 'namespace');
  const digest = await cas.put(text);
  return casRef(namespace, digest);
}
