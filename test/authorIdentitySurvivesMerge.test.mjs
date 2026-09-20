/**
 * MY FIX FOR D4 ERASED THE FIELD IT ADDED, AND WIRED IT INTO ONE CALLER IN SIX.
 *
 * Second-lap blind audit, findings D-1 and D-2. Rule 20 says a fix is new
 * code and new code breaks what was previously fine; this is that, measured.
 *
 * ═══ D-1: THE PRODUCER IS ON THE ONE CALLER THAT DOES NOT MATTER MOST ═══
 *
 * `a6bfb4c` added `authorSessionFor` and wired it into `bin/agentbridge.mjs`
 * alone. There are six callers of `auditJobsFor`, and THREE OF THE OTHER FIVE
 * WRITE THE QUEUE STORE: claude-stop-gate.mjs, pre-push-audit.mjs and
 * enqueue-audit-job.mjs. They pass `{treeShaFor, now}`, so the resolver fell
 * to its `() => null` default.
 *
 * Measured in the live store: zero non-null `author_session` values across
 * 1413 rows, including a row written AFTER the fix landed, by post-fix code,
 * for a candidate whose commit message carries the trailer. The control was
 * still reading nothing. Rule 17 again, in the fix for a rule 17 defect.
 *
 * ═══ D-2: AND THE FIX MADE mergeQueue DESTROY THE VALUE ═══
 *
 * `mergeQueue` spreads `{...was, ...job}`, and the comment above it names
 * `author_session` and `author_source` among the fields that MUST survive
 * from `was`. Before the fix the computed packet had no such keys, so they
 * survived. The fix added both unconditionally -- as explicit `null` from any
 * resolver-less caller -- and `{...{a:'x'}, ...{a:null}}` is `{a:null}`.
 *
 * So the CLI wrote an author, and the very next Stop gate tick erased it.
 * Worse on a CLAIMED row: `independence` is not in the computed packet and
 * survives, while the two fields it was derived from are nulled -- leaving a
 * persisted record that contradicts itself.
 *
 * ═══ THE SHAPE OF THE FIX ═══
 *
 * "No resolver was supplied" and "the resolver looked and found nothing" are
 * different facts and must not be the same value. That is the primitive this
 * repository keeps rediscovering: could-not-measure is not measured-zero.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { auditJobsFor, mergeQueue } from '../src/auditJob.mjs';

const SHA = 'a'.repeat(40);
const TREE = '1'.repeat(40);
const AUTHOR = 'session_01AUTHOR';

const coverage = () => ({
  commits: [{ sha: SHA, subject: 's', touched: ['src/policy.mjs'], audited: false }],
  malformed: [],
  error: null,
});

const withResolver = () => auditJobsFor(coverage(), {
  treeShaFor: () => TREE, authorSessionFor: () => AUTHOR, now: 't',
}).jobs;

/** Exactly what the Stop gate, pre-push and post-commit hooks pass today. */
const withoutResolver = () => auditJobsFor(coverage(), {
  treeShaFor: () => TREE, now: 't',
}).jobs;

test('D-2: A LATER TICK WITH NO RESOLVER MUST NOT ERASE A KNOWN AUTHOR', () => {
  const stored = mergeQueue([], withResolver(), { now: 't' }).queue;
  assert.equal(stored[0].author_session, AUTHOR, 'the fixture never had an author to lose');

  const after = mergeQueue(stored, withoutResolver(), { now: 't' }).queue;
  assert.equal(after[0].author_session, AUTHOR,
    'a caller that cannot resolve the author ERASED one that was already known. '
    + 'The CLI writes it and the next Stop gate tick nulls it, so the field is '
    + 'empty in the store no matter how many callers get the resolver');
  assert.equal(after[0].author_source, 'trailer',
    'the source was erased alongside the value, leaving independence derived from nothing');
});

test('D-1: NO RESOLVER IS "UNAVAILABLE", NOT "NO AUTHOR"', () => {
  /*
   * The distinction that makes the merge above decidable. A caller with no
   * resolver has not looked; a caller whose resolver returned null has looked
   * and found nothing. Collapsing them into `null` is what let the erasure
   * happen silently, and it is the same could-not-measure-versus-measured-zero
   * confusion this repository has now hit at five separate sites.
   */
  const unasked = withoutResolver()[0];
  assert.equal(unasked.author_source, 'unavailable',
    'a caller that never asked reports the same thing as one that asked and found nothing');
  assert.equal(unasked.author_session, null);

  const asked = auditJobsFor(coverage(), {
    treeShaFor: () => TREE, authorSessionFor: () => null, now: 't',
  }).jobs[0];
  assert.equal(asked.author_source, null,
    'a resolver that looked and found no trailer must report absence, not unavailability');
  assert.equal(asked.author_session, null);
});

test('AN UNAVAILABLE READING NEVER OVERWRITES A MEASURED ONE, in either order', () => {
  /*
   * Rule 5 and the symmetric case together: the merge must prefer the known
   * author regardless of which side carries it, or the repair only works for
   * the ordering I happened to test.
   */
  const known = mergeQueue([], withResolver(), { now: 't' }).queue;
  const unknown = mergeQueue([], withoutResolver(), { now: 't' }).queue;

  assert.equal(mergeQueue(known, withoutResolver(), { now: 't' }).queue[0].author_session, AUTHOR,
    'stored known + computed unavailable lost the author');
  assert.equal(mergeQueue(unknown, withResolver(), { now: 't' }).queue[0].author_session, AUTHOR,
    'stored unavailable + computed known did not adopt the author');
});

test('D14: A LEGACY ROW WITH AN AUTHOR IS NOT OVERWRITTEN BY A FAILED LOOKUP', () => {
  /*
   * Fifth-lap blind audit D14. `authorStrength(undefined)` returned -1,
   * BELOW `unavailable`'s 0 -- so a computed unavailable packet outranked a
   * row written before `author_source` existed, and `{...was, ...job}`
   * destroyed a real `author_session` in favour of a reading that measured
   * nothing.
   *
   * Rows with no `author_source` are the pre-fix shape, so this is the
   * migration case: it must not cost an author that was genuinely recorded.
   */
  /*
   * DERIVED FROM THE REAL PRODUCER, NOT TYPED. My first version of this
   * fixture used `audit_id: 'audit-1'`, which never matches the computed
   * packet's hashed id -- so the rows never merged at all, the legacy row
   * was simply dropped as resolved, and the test failed for a reason that
   * had nothing to do with the defect. Hollow gate 9, in a test I wrote to
   * catch a merge bug: a fixture the system cannot produce.
   *
   * So: take a real job and strip `author_source`, which is exactly what a
   * row written before that field existed looks like.
   */
  const legacy = withResolver().map((j) => {
    const { author_source, ...rest } = j;
    return { ...rest, author_session: 'session_01LEGACY' };
  });
  const stored = mergeQueue([], legacy, { now: 't' }).queue;
  assert.equal(stored[0].author_session, 'session_01LEGACY');
  assert.equal(stored[0].author_source, undefined, 'the fixture is not the legacy shape');

  const after = mergeQueue(stored, withoutResolver(), { now: 't' }).queue;
  assert.equal(after[0].author_session, 'session_01LEGACY',
    'a caller that could not look destroyed an author a legacy row had recorded');
});

test('A POSITIVE FINDING OUTRANKS A LATER EMPTY ONE, because the commit is immutable', () => {
  /*
   * ═══ I ASSERTED THE OPPOSITE HERE FIRST, AND IT WAS WRONG ═══
   *
   * The original version of this test demanded that a resolver finding no
   * trailer must OVERWRITE a stored author, on the reasoning that otherwise a
   * stale value persists and the mechanism launders rather than repairs.
   *
   * That reasoning does not survive the fact it ignored: A COMMIT MESSAGE IS
   * IMMUTABLE. For one sha, `trailer` and `null` are two readings of the same
   * unchanging input, so they cannot both be right -- and there is no "later,
   * truer" reading to prefer. The question is only which is more likely to be
   * the error.
   *
   * A false NEGATIVE is easy: git returns a partial body under memory
   * pressure, the call is truncated, the message is re-read through a
   * different path. A false POSITIVE requires the regex to invent a string
   * matching `session_[A-Za-z0-9]+` out of a message that has none. The
   * positive finding is the more trustworthy of the two, so it wins.
   *
   * "Stale" was never a real hazard for immutable input, and the laundering
   * risk I wrote this test to prevent cannot occur: the only way the author of
   * sha X legitimately changes is a rewrite, which produces a different sha
   * and therefore a different audit_id and a different job.
   *
   * The genuine hazard is the opposite one, which the strength ordering now
   * covers: a WEAKER reader overwriting a STRONGER record. See the
   * authoritative case in test/authorResolverFailure.test.mjs.
   */
  const stored = mergeQueue([], withResolver(), { now: 't' }).queue;
  const measuredAbsent = auditJobsFor(coverage(), {
    treeShaFor: () => TREE, authorSessionFor: () => null, now: 't',
  }).jobs;

  const after = mergeQueue(stored, measuredAbsent, { now: 't' }).queue;
  assert.equal(after[0].author_session, AUTHOR,
    'an empty re-read discarded a trailer that was positively found earlier, for a '
    + 'commit whose message cannot have changed');
  assert.equal(after[0].author_source, 'trailer');
});

test('BUT AN EQUAL-STRENGTH RE-READ DOES WIN, so a real correction can land', () => {
  /*
   * The ordering must not freeze the first answer for ever. Two readings at
   * the SAME strength are both measurements, and the fresher one is the
   * queue's current view -- otherwise a corrected resolver could never
   * replace a wrong value and this becomes a different kind of trap.
   */
  const stored = mergeQueue([], withResolver(), { now: 't' }).queue;
  const corrected = auditJobsFor(coverage(), {
    treeShaFor: () => TREE, authorSessionFor: () => 'session_01CORRECTED', now: 't',
  }).jobs;

  const after = mergeQueue(stored, corrected, { now: 't' }).queue;
  assert.equal(after[0].author_session, 'session_01CORRECTED',
    'a same-strength re-read could not correct an earlier value, so the first answer '
    + 'is frozen permanently');
});
