/*
 * THE RESULT ENVELOPE. MACHINE EVIDENCE DECIDES; PROSE NEVER DOES.
 *
 * An executor finishes and wants to tell the system how it went. There are two
 * completely different things in that report and they must not share a channel:
 *
 *   EVIDENCE   exit code, test counts, the commit that exists, the files that
 *              changed, the path contract that held or did not. Every one of
 *              these is observable by something other than the agent.
 *   NOTES      the agent's account of itself. Useful to a human reading a
 *              failure. Worth nothing to a decision, because an agent that
 *              summarises its own work is the judge of its own work.
 *
 * So `notes` is carried, and `evidenceOf()` -- the only thing any decision
 * reads -- does not contain it. That is the whole mechanism. It is enforced by
 * construction rather than by asking callers to be careful, because "the
 * reviewer parsed the summary" is exactly the failure that makes the agent the
 * judge, and it looks like working software right up until it doesn't.
 *
 * THE SECOND RULE, which costs more bugs than the first: ABSENT EVIDENCE IS NOT
 * PASSING EVIDENCE. `tests: null` means nobody ran them, and that is not zero
 * failures. `exitCode: null` means nothing exited, and that is not exit 0. A
 * run whose summary says 0 total is a run that checked nothing and must not
 * report a pass. Every one of those is a reject reason below, with a code.
 */

export const ENVELOPE_VERSION = 1;

/*
 * How the attempt ended, as observed by the runner -- never as claimed by the
 * work. `exited` is the only outcome that can carry an exit code; everything
 * else means no process reached a normal end, so its exit code is null and the
 * verdict below refuses it.
 */
export const OUTCOMES = Object.freeze([
  'exited', // the process ran to completion; exitCode is meaningful
  'timeout', // the runner killed it; nothing about the work is known
  'crashed', // died on a signal
  'refused', // the far end answered and declined (401/409) -- not unreachable
  'unreachable', // no answer at all -- not exit 0, and not a refusal
  /*
   * The process stopped to ask a person. NOTHING ABOUT THE WORK IS KNOWN, even
   * though it may have exited zero: a tool that prompts, reaches end-of-file
   * and takes its default has made a choice nobody made, and the exit code
   * describes that default rather than the work. verdictFor refuses every
   * outcome but `exited`, so this rejects with no further wiring -- which is
   * the point of the outcome being a value rather than a flag somebody has to
   * remember to read.
   */
  'prompted',
]);

const ENVELOPE_KEYS = Object.freeze([
  'taskId',
  'attempt',
  'outcome',
  'exitCode',
  'tests',
  'commit',
  'filesChanged',
  'pathContract',
  'durationMs',
  'artifacts',
  'notes',
]);

const TEST_KEYS = Object.freeze(['passed', 'failed', 'skipped', 'total']);

function fail(message) {
  throw new TypeError(`result envelope: ${message}`);
}

function requireKnownKeys(object, allowed, what) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      /*
       * An unknown key is rejected rather than ignored. Ignoring it is how a
       * `summary` or a `confidence` field arrives from a well-meaning adapter,
       * gets carried in the envelope, and is eventually read by something that
       * decides. There is no quiet path for prose into evidence.
       */
      fail(`unknown ${what} field ${JSON.stringify(key)}`);
    }
  }
}

function normaliseTests(tests) {
  if (tests === null || tests === undefined) return null;
  if (typeof tests !== 'object') fail('tests must be an object or null');
  requireKnownKeys(tests, TEST_KEYS, 'tests');
  const out = {};
  for (const key of TEST_KEYS) {
    const value = tests[key];
    if (!Number.isInteger(value) || value < 0) {
      fail(`tests.${key} must be a non-negative integer, got ${JSON.stringify(value)}`);
    }
    out[key] = value;
  }
  const counted = out.passed + out.failed + out.skipped;
  if (counted !== out.total) {
    /*
     * A summary whose parts do not add up is a parse that went wrong, and a
     * wrong parse that is trusted reads as "0 failed". Refuse it here, where
     * the caller still knows which output produced it.
     */
    fail(`tests.total ${out.total} does not equal passed+failed+skipped ${counted}`);
  }
  return Object.freeze(out);
}

function normalisePathContract(contract) {
  if (contract === null || contract === undefined) return null;
  if (typeof contract !== 'object') fail('pathContract must be an object or null');
  requireKnownKeys(contract, ['allowed', 'forbidden', 'violations'], 'pathContract');
  const list = (value, name) => {
    if (!Array.isArray(value)) fail(`pathContract.${name} must be an array`);
    for (const entry of value) {
      if (typeof entry !== 'string') fail(`pathContract.${name} entries must be strings`);
    }
    return Object.freeze([...value]);
  };
  return Object.freeze({
    allowed: list(contract.allowed ?? [], 'allowed'),
    forbidden: list(contract.forbidden ?? [], 'forbidden'),
    violations: list(contract.violations ?? [], 'violations'),
  });
}

/*
 * Build an envelope. Every field is validated here and the result is frozen,
 * so an envelope that exists is an envelope that is well formed -- a consumer
 * never has to ask whether the counts add up or whether `exitCode` is a string.
 */
export function createResultEnvelope(input) {
  if (input === null || typeof input !== 'object') fail('input must be an object');
  requireKnownKeys(input, ENVELOPE_KEYS, 'envelope');

  const taskId = input.taskId;
  if (typeof taskId !== 'string' || taskId.trim() === '') fail('taskId must be a non-empty string');

  const attempt = input.attempt ?? 0;
  if (!Number.isInteger(attempt) || attempt < 0) fail('attempt must be a non-negative integer');

  const outcome = input.outcome;
  if (!OUTCOMES.includes(outcome)) {
    fail(`outcome must be one of ${OUTCOMES.join(', ')}, got ${JSON.stringify(outcome)}`);
  }

  const exitCode = input.exitCode ?? null;
  if (exitCode !== null && !Number.isInteger(exitCode)) fail('exitCode must be an integer or null');
  if (outcome !== 'exited' && exitCode !== null) {
    /*
     * A timeout with exitCode 0 is the shape of the bug this whole file exists
     * to prevent: a killed process reported as a clean finish. If the process
     * did not exit, it has no exit code.
     */
    fail(`outcome ${outcome} cannot carry an exit code`);
  }

  const commit = input.commit ?? null;
  if (commit !== null && !/^[0-9a-f]{7,64}$/.test(commit)) {
    fail('commit must be a lowercase hex sha or null');
  }

  const filesChanged = input.filesChanged ?? [];
  if (!Array.isArray(filesChanged)) fail('filesChanged must be an array');
  for (const file of filesChanged) {
    if (typeof file !== 'string' || file === '') fail('filesChanged entries must be non-empty');
  }

  const durationMs = input.durationMs ?? null;
  if (durationMs !== null && (!Number.isFinite(durationMs) || durationMs < 0)) {
    fail('durationMs must be a non-negative number or null');
  }

  const artifacts = input.artifacts ?? [];
  if (!Array.isArray(artifacts)) fail('artifacts must be an array');

  const notes = input.notes ?? '';
  if (typeof notes !== 'string') fail('notes must be a string');

  return Object.freeze({
    version: ENVELOPE_VERSION,
    taskId,
    attempt,
    outcome,
    exitCode,
    tests: normaliseTests(input.tests),
    commit,
    // sorted and deduped so two envelopes for the same change compare equal
    filesChanged: Object.freeze([...new Set(filesChanged)].sort()),
    pathContract: normalisePathContract(input.pathContract),
    durationMs,
    artifacts: Object.freeze([...artifacts]),
    notes,
  });
}

/*
 * The evidence projection. THIS IS THE ONLY THING A DECISION MAY READ.
 *
 * It is a fresh object rather than the envelope with a key deleted, because a
 * deleted key comes back the moment somebody adds a field upstream and forgets
 * to delete that one too. Here, a new prose field is invisible to decisions
 * until somebody deliberately adds it to this list -- which is a code review
 * they cannot miss.
 */
export function evidenceOf(envelope) {
  if (envelope === null || typeof envelope !== 'object') fail('evidenceOf needs an envelope');
  return Object.freeze({
    version: envelope.version,
    taskId: envelope.taskId,
    attempt: envelope.attempt,
    outcome: envelope.outcome,
    exitCode: envelope.exitCode ?? null,
    tests: envelope.tests ?? null,
    commit: envelope.commit ?? null,
    filesChanged: Object.freeze([...(envelope.filesChanged ?? [])]),
    pathContract: envelope.pathContract ?? null,
    durationMs: envelope.durationMs ?? null,
  });
}

/*
 * The verdict. Reasons are machine codes, not sentences -- a caller that wants
 * to branch on "why" can, and a caller that wants to show a human can format
 * them. A reason list is the proof; an empty one is the only accept.
 */
export function verdictFor(envelope) {
  const evidence = evidenceOf(envelope);
  const reasons = [];

  if (evidence.outcome !== 'exited') reasons.push(`outcome:${evidence.outcome}`);

  if (evidence.exitCode === null) reasons.push('exit-code:absent');
  else if (evidence.exitCode !== 0) reasons.push(`exit-code:${evidence.exitCode}`);

  if (evidence.tests === null) {
    reasons.push('tests:not-run');
  } else {
    if (evidence.tests.failed > 0) reasons.push(`tests:failed:${evidence.tests.failed}`);
    // A run that checked nothing must not print a pass.
    if (evidence.tests.total === 0) reasons.push('tests:empty-run');
    if (evidence.tests.passed === 0 && evidence.tests.total > 0) reasons.push('tests:none-passed');
  }

  if (evidence.commit === null) reasons.push('commit:absent');

  if (evidence.pathContract === null) reasons.push('path-contract:unchecked');
  else {
    for (const violation of evidence.pathContract.violations) {
      reasons.push(`path:${violation}`);
    }
  }

  return Object.freeze({
    verdict: reasons.length === 0 ? 'accept' : 'reject',
    reasons: Object.freeze(reasons),
  });
}
