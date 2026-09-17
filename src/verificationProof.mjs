/**
 * OBSERVATION RECORDS. THERE IS NO PROMOTION VOCABULARY HERE, ON PURPOSE.
 *
 * Four reviews found the same defect in four places, and each repair moved it
 * rather than removing it:
 *
 *   1. the CANDIDATE controlled verification -- a commit set its own test script
 *   2. the CALLER controlled it -- three literals cleared every blocker
 *   3. the ARTIFACT carried no non-authority context -- a stored record read as
 *      a clean bill of health
 *   4. the ARTIFACT manufactured authority -- {promotable:true, standingBlockers:[]}
 *      with a recomputed digest returned {ok:true, promotable:true}
 *
 * The fourth is the one that settles the design. Every guard I added protected a
 * `promotable` field that had no business existing. A record that can say it was
 * promotable is a record somebody can forge into saying it, and an unkeyed
 * digest proves internal consistency, never authorship.
 *
 * SO THE FIELD IS GONE. An observation records EVIDENCE: what ran, on which
 * commit, with what result, and which blockers stood at the time. It has no
 * promotion field, no success-looking `ok`, and the reader always answers
 * `authorization: 'none'` -- not because today's configuration happens to
 * withhold it, but because this module cannot grant it at all.
 *
 * WHAT IS DELIBERATELY ABSENT AND MUST STAY ABSENT:
 *   a promotable field on the record;
 *   an `ok` that a caller can read as permission;
 *   any verifier-adapter registry -- the abstraction invited the forgery;
 *   an exported digest helper, which is authority-adjacent;
 *   any code path that yields exit 0.
 *
 * When real authority exists it belongs OUTSIDE this module and outside the
 * coding agent's writable checkout: a signed attestation from an approved
 * verifier identity, a suite policy loaded by id and digest from an authority
 * the candidate cannot reach, and an isolation attestation. None of those is a
 * boolean, a string, or a field on a record.
 *
 * PURE. No clone, no spawn, no clock.
 */

import { createHash } from 'node:crypto';

/** Each a distinct defect, never collapsed into one "invalid". */
export const REFUSALS = Object.freeze([
  'dirty-source',
  'source-mutated',
  'sha-mismatch',
  'not-a-sha',
  'deps-unavailable',
  'suite-not-run',
  'suite-failed',
  'suite-nonzero-exit',
  'suite-signalled',
  'suite-timed-out',
  'counts-do-not-reconcile',
  'tests-cancelled',
  'zero-tests',
  'ambiguous-summary',
  'integrity-broken',
  'version-mismatch',
  'promotion-claim-present',
]);

/**
 * Blockers that stand on every observation, unconditionally.
 *
 * There is no mechanism to clear one. The registry that used to hold "verifier
 * adapters" is deleted: it existed only to be empty, and the abstraction is what
 * made a cleared blocker representable in the first place.
 */
export const STANDING_BLOCKERS = Object.freeze([
  'unsigned-observation',
  'candidate-controlled-suite',
  'untrusted-execution-environment',
]);

const BLOCKER_DETAIL = Object.freeze({
  'unsigned-observation':
    'nothing signs an observation: an unkeyed digest cannot establish who observed, or that anyone did',
  'candidate-controlled-suite':
    'no trusted suite policy exists: the command came from the commit under test',
  'untrusted-execution-environment':
    'no isolation attestation exists: install and suite ran on the host with ambient credentials',
});

/** v4: the promotion vocabulary is removed from the record format entirely. */
export const RECORD_VERSION = 4;

const isSha = (v) => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);
const isNonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const isCount = (v) => Number.isInteger(v) && v >= 0;

/*
 * NOT EXPORTED. A digest helper beside an observation is authority-adjacent: it
 * is the tool a forger reaches for, and exporting it published the means to make
 * a tampered record self-consistent. Integrity is asked of the reader, which is
 * the only question a hash can answer.
 *
 * ARRAYS ARE JSON-ENCODED, NOT JOINED. `['a,b','c']` and `['a','b,c']` join to
 * the same string, so a comma-joined list is not a canonical encoding of a list.
 */
/**
 * Canonical encoding of a list, exported so the property can be TESTED.
 *
 * `['a,b','c']` and `['a','b,c']` join to the same comma string, so a joined
 * list is not a canonical encoding of a list. This is exported and the digest is
 * not: an encoder is not authority-adjacent, and leaving it unexported made the
 * canonicalisation test decorative -- both forged records were refused by the
 * digest path whatever the encoding, so a mutation reverting to join(',') stayed
 * green.
 */
export function canonicalList(value) {
  return Array.isArray(value) ? JSON.stringify([...value].map(String).sort()) : 'unrecorded';
}

function recordDigest(record) {
  const arr = canonicalList;
  const parts = [
    `v:${record?.version ?? ''}`,
    `repo:${record?.repoId ?? ''}`,
    `sha:${record?.sha ?? ''}`,
    `headAt:${record?.checkoutHead ?? ''}`,
    `headAfter:${record?.headAfter ?? ''}`,
    `clean:${record?.sourceClean === true ? 'yes' : 'no'}`,
    `cleanAfter:${record?.treeCleanAfter === true ? 'yes' : 'no'}`,
    `deps:${record?.depsInstalled === true ? 'yes' : 'no'}`,
    `scripts:${record?.lifecycleScriptsRan === true ? 'yes' : 'no'}`,
    `exit:${record?.suiteExitCode}`,
    `signal:${record?.terminationSignal ?? 'none'}`,
    `timeout:${record?.timedOut === true ? 'yes' : 'no'}`,
    `tests:${record?.tests}`,
    `pass:${record?.pass}`,
    `fail:${record?.fail}`,
    `skip:${record?.skip}`,
    `cancelled:${record?.cancelled}`,
    `todo:${record?.todo}`,
    `suite:${record?.suiteCommand ?? ''}`,
    `suiteFrom:${record?.suiteSource ?? ''}`,
    `blockers:${arr(record?.blockersAtObservation)}`,
  ];
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/** Everything wrong with this run, all at once. One validator, both directions. */
function validate(o) {
  const refusals = [];
  const add = (code, detail) => refusals.push({ code, detail });

  if (!isSha(o.sha)) add('not-a-sha', `${o.sha ?? 'absent'} is not a full 40-character sha`);
  if (o.sourceClean !== true) {
    add('dirty-source', 'the checkout carried uncommitted changes before the run');
  }
  if (o.treeCleanAfter !== true) {
    add('source-mutated', 'tracked files changed during install or the suite; what ran is not the commit');
  }
  if (!isSha(o.checkoutHead)) {
    add('sha-mismatch', 'the checkout did not report a usable HEAD');
  } else if (isSha(o.sha) && o.checkoutHead !== o.sha) {
    add('sha-mismatch', `checked out ${o.checkoutHead}, asked for ${o.sha}`);
  }
  if (isSha(o.checkoutHead) && o.headAfter !== undefined && o.headAfter !== o.checkoutHead) {
    add('source-mutated', `HEAD moved during the run: ${o.checkoutHead} -> ${o.headAfter}`);
  }
  if (o.depsInstalled !== true) {
    add('deps-unavailable', 'dependencies were not installed; the run does not cover resolution');
  }
  if (!isNonEmpty(o.suiteCommand)) {
    add('suite-not-run', 'no suite command recorded; an observation must name what ran');
  }
  if (o.suiteExitCode !== 0) {
    add('suite-nonzero-exit', `the suite exited ${o.suiteExitCode === null || o.suiteExitCode === undefined ? 'with an unrecorded status' : o.suiteExitCode}`);
  }
  if (o.terminationSignal !== null && o.terminationSignal !== undefined) {
    add('suite-signalled', `the suite was killed by ${o.terminationSignal}`);
  }
  if (o.timedOut === true) add('suite-timed-out', 'the suite did not finish inside its limit');
  if (o.ambiguousSummary === true) {
    add('ambiguous-summary', 'more than one suite summary appeared in the output');
  }

  const counts = ['tests', 'pass', 'fail', 'skip', 'cancelled', 'todo'];
  const missing = counts.filter((k) => !isCount(o[k]));
  if (missing.length) {
    add('suite-not-run', `the suite produced no usable counts for: ${missing.join(', ')}`);
  } else {
    if (o.tests === 0) add('zero-tests', 'the suite ran 0 tests; that is not a pass');
    if (o.fail > 0) add('suite-failed', `${o.fail} failing test(s)`);
    if (o.cancelled > 0) add('tests-cancelled', `${o.cancelled} test(s) cancelled; the suite did not complete`);
    const accounted = o.pass + o.fail + o.skip + o.cancelled + o.todo;
    if (accounted !== o.tests) {
      add('counts-do-not-reconcile',
        `${o.pass}+${o.fail}+${o.skip}+${o.cancelled}+${o.todo} = ${accounted}, but the suite reported ${o.tests} tests`);
    }
  }
  return refusals;
}

/**
 * What this run observed. It never says what may be done about it.
 *
 * The blocker policy version is this module's and is NOT read from the input.
 * A previous version accepted an absent version and called that fail-closed; it
 * was not, it was fail-open with a comment. Observation data does not select
 * which policy judges it, and it does not get a say at all.
 */
export function assertObserved(observation = {}) {
  const o = { skip: 0, cancelled: 0, todo: 0, ...observation };
  const refusals = validate(o);
  const blockers = STANDING_BLOCKERS.map((code) => ({ code, detail: BLOCKER_DETAIL[code] }));

  if (refusals.length > 0) {
    return { refusals, authorization: 'none', blockers, record: null };
  }

  const record = {
    version: RECORD_VERSION,
    repoId: o.repoId ?? '',
    sha: o.sha,
    checkoutHead: o.checkoutHead,
    headAfter: o.headAfter ?? o.checkoutHead,
    sourceClean: true,
    treeCleanAfter: true,
    depsInstalled: true,
    lifecycleScriptsRan: o.lifecycleScriptsRan === true,
    suiteExitCode: 0,
    terminationSignal: null,
    timedOut: false,
    tests: o.tests,
    pass: o.pass,
    fail: o.fail,
    skip: o.skip,
    cancelled: o.cancelled,
    todo: o.todo,
    suiteCommand: o.suiteCommand,
    suiteSource: o.suiteSource ?? 'candidate',
    // FACTS about the run, not a verdict. There is no promotable field, so
    // there is nothing to forge into one.
    blockersAtObservation: STANDING_BLOCKERS.map((c) => c).sort(),
  };
  return {
    refusals: [],
    authorization: 'none',
    blockers,
    record: { ...record, digest: recordDigest(record) },
  };
}

/**
 * Is a record that arrived from elsewhere intact? That is the ONLY question.
 *
 * Named for what it does. `verifyProof` returning `ok` was two invitations in
 * one: "verify" and "proof" both suggest authority, and downstream code reads a
 * bare `ok:true` as permission. Integrity is a state, authorization is always
 * none, and neither is a boolean a caller can shortcut.
 */
export function inspectObservationRecord(record) {
  if (!record || typeof record !== 'object') {
    return {
      integrity: 'invalid',
      authorization: 'none',
      refusals: [{ code: 'integrity-broken', detail: 'not an observation record' }],
    };
  }

  const refusals = validate(record);

  if (record.version !== RECORD_VERSION) {
    refusals.push({
      code: 'version-mismatch',
      detail: `record version ${record.version}, this reader speaks ${RECORD_VERSION}`,
    });
  }

  /*
   * A LEGACY RECORD CARRYING A PROMOTION CLAIM IS REFUSED OUTRIGHT. v3 records
   * could say promotable:true with an empty blocker list and a recomputed
   * digest, and be read as authorised. Any record that still speaks that
   * vocabulary is rejected rather than reinterpreted.
   */
  if ('promotable' in record) {
    refusals.push({
      code: 'promotion-claim-present',
      detail: 'the record carries a promotion claim; that format could forge authority and is not readable',
    });
  }

  if (!Array.isArray(record.blockersAtObservation)) {
    refusals.push({
      code: 'integrity-broken',
      detail: 'the record does not say which blockers stood when it was made',
    });
  }

  if (!isNonEmpty(record.digest)) {
    refusals.push({ code: 'integrity-broken', detail: 'the record carries no digest' });
  } else if (recordDigest(record) !== record.digest) {
    refusals.push({
      code: 'integrity-broken',
      detail: 'the record does not hash to its own digest; a field changed after it was written',
    });
  }

  return {
    integrity: refusals.length === 0 ? 'valid' : 'invalid',
    // NOT COMPUTED. There is no input, no field and no configuration that makes
    // this anything else. Authority does not live in this module.
    authorization: 'none',
    blockersAtObservation: Array.isArray(record.blockersAtObservation)
      ? record.blockersAtObservation : ['unrecorded'],
    refusals,
  };
}
