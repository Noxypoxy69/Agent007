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

test('A MEASURED ABSENCE DOES NOT RESURRECT A STALE AUTHOR', () => {
  /*
   * The other direction, and the one that would make this a laundering
   * mechanism if it were wrong: if a resolver LOOKS and finds no trailer, the
   * honest record is "no author", and a previously-stored value must not
   * silently persist as though it had been re-confirmed. Only `unavailable`
   * defers to what is already known.
   */
  const stored = mergeQueue([], withResolver(), { now: 't' }).queue;
  const measuredAbsent = auditJobsFor(coverage(), {
    treeShaFor: () => TREE, authorSessionFor: () => null, now: 't',
  }).jobs;

  const after = mergeQueue(stored, measuredAbsent, { now: 't' }).queue;
  assert.equal(after[0].author_session, null,
    'a resolver that positively found no trailer was overridden by a stale stored value');
  assert.equal(after[0].author_source, null);
});
