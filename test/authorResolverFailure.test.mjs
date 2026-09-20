/**
 * A FAILED LOOKUP IS NOT A MEASUREMENT, AND I MADE IT ONE INSIDE THE FIX.
 *
 * Third-lap blind audit, findings D-A (HIGH, fail-open), D-B and D-C.
 *
 * `674653a` introduced three author states precisely so that "nobody looked"
 * could not be confused with "looked and found nothing". Its commit message
 * calls that "the fifth site this session". The resolver it wired in the same
 * commit reads:
 *
 *     authorSessionFor: (c) => authorSessionFrom(git([...]) ?? '')
 *
 * `git()` returns null on ANY failure -- a 60s timeout, contention in this
 * shared clone, PATH, memory pressure. `?? ''` turns that into "I looked and
 * the message was empty", which resolves to `author_source: null` -- the
 * MEASURED-ABSENCE state. Same for a resolver that throws: `auditJobsFor`
 * catches it into `declaredAuthor = null`.
 *
 * So the sixth instance of the primitive is inside the fix for the fifth.
 *
 * ═══ WHY THIS IS FAIL-OPEN AND NOT MERELY UNTIDY ═══
 *
 *   src/auditDispatch.mjs:  if (!author) return true;   // every seat eligible
 *   src/auditJob.mjs:       if (author && author === who)  // cannot fire
 *
 * A null author makes EVERY seat eligible, including the author's own. One
 * transient git failure silently re-opens the author-can-audit-its-own-work
 * hole that both a6bfb4c and 674653a exist to close.
 *
 * D-B: `independenceOf` was never taught the third state. 'unavailable' is
 * not null, so it falls through to 'asserted' -- the same grade as a real
 * trailer-backed author, and STRONGER than the 'unverifiable' the identical
 * situation produced before 674653a. The fix made the grading weaker.
 *
 * D-C: the merge rule defers only for 'unavailable', so a trailer resolver
 * finding nothing overwrites a strictly stronger 'authoritative' record,
 * leaving independence and satisfies_gate surviving beside a nulled author --
 * a row contradicting itself, which is the state this file's sibling test
 * names as the bad one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  auditJobsFor, mergeQueue, independenceOf, AUTHOR_UNAVAILABLE,
} from '../src/auditJob.mjs';

const SHA = 'a'.repeat(40);
const TREE = '1'.repeat(40);
const AUTHOR = 'session_01AUTHOR';

const coverage = () => ({
  commits: [{ sha: SHA, subject: 's', touched: ['src/policy.mjs'], audited: false }],
  malformed: [],
  error: null,
});

const build = (authorSessionFor) => auditJobsFor(coverage(), {
  treeShaFor: () => TREE, authorSessionFor, now: 't',
}).jobs;

test('D-A: A THROWING RESOLVER IS UNAVAILABLE, NOT "no trailer"', () => {
  const job = build(() => { throw new Error('git exploded'); })[0];
  assert.equal(job.author_source, AUTHOR_UNAVAILABLE,
    'a git failure was recorded as a measured absence, which then licenses erasing a '
    + 'known author and makes every seat eligible including the author own');
  assert.equal(job.author_session, null);
});

test('D-A: A RESOLVER REPORTING FAILURE IS UNAVAILABLE TOO', () => {
  /*
   * The caller must be able to SAY it failed, not only throw. The post-commit
   * hook's git() returns null rather than throwing, and `?? ''` laundered
   * that into an empty message.
   */
  const job = build(() => AUTHOR_UNAVAILABLE)[0];
  assert.equal(job.author_source, AUTHOR_UNAVAILABLE);
  assert.equal(job.author_session, null,
    'the failure sentinel leaked into author_session, where it would be compared '
    + 'against a real session id');
});

test('D-A: AND A FAILED LOOKUP MUST NOT ERASE A KNOWN AUTHOR', () => {
  const stored = mergeQueue([], build(() => AUTHOR), { now: 't' }).queue;
  assert.equal(stored[0].author_session, AUTHOR, 'the fixture had no author to lose');

  for (const failing of [() => { throw new Error('boom'); }, () => AUTHOR_UNAVAILABLE]) {
    const after = mergeQueue(stored, build(failing), { now: 't' }).queue;
    assert.equal(after[0].author_session, AUTHOR,
      'a failed git call erased a known author. That is the fail-open path: the next '
      + 'dispatch treats every seat as eligible, the author included');
  }
});

test('D-A: a resolver that LOOKED and found nothing records absence, not failure', () => {
  /*
   * THE POSITIVE BESIDE THE NEGATIVES (rule 5). If every unhappy path
   * collapsed to 'unavailable', the distinction the whole fix exists for
   * would be gone in the other direction -- a commit genuinely lacking a
   * trailer would be indistinguishable from one nobody could read.
   *
   * Only the RECORDED STATE is asserted here. What the merge then does with
   * it is a separate question, settled by strength ordering in
   * test/authorIdentitySurvivesMerge.test.mjs: a positive finding outranks a
   * later empty one, because the commit message is immutable and a false
   * negative is far likelier than a fabricated session id.
   */
  const job = build(() => null)[0];
  assert.equal(job.author_source, null, 'a real absence was upgraded to unavailable');
  assert.equal(job.author_session, null);

  /* and it still outranks "nobody looked", which is the point of the state. */
  const stored = mergeQueue([], build(() => AUTHOR_UNAVAILABLE), { now: 't' }).queue;
  const after = mergeQueue(stored, build(() => null), { now: 't' }).queue;
  assert.equal(after[0].author_source, null,
    'a measured absence failed to replace an unavailable one, so nobody-looked is '
    + 'being treated as at least as good as somebody-looked');
});

test('D-B: independenceOf KNOWS THE THIRD STATE, and grades it weakest', () => {
  /*
   * 'unavailable' is not null, so it fell through to 'asserted' -- the same
   * grade as a real trailer-backed author, and stronger than the
   * 'unverifiable' the identical situation produced BEFORE the fix. A fix
   * that weakens a grading is worse than the gap it closed.
   */
  assert.equal(independenceOf({ authorSource: AUTHOR_UNAVAILABLE, claimantSource: 'resolved' }),
    'unverifiable',
    'nobody looked, and it grades as strongly as a trailer-backed author');

  /* unchanged for the states that already existed */
  assert.equal(independenceOf({ authorSource: null, claimantSource: 'resolved' }), 'unverifiable');
  assert.equal(independenceOf({ authorSource: 'trailer', claimantSource: 'resolved' }), 'asserted');
  assert.equal(independenceOf({ authorSource: 'authoritative', claimantSource: 'resolved' }), 'enforced');
});

test('D-C: A TRAILER ABSENCE DOES NOT OVERWRITE AN AUTHORITATIVE RECORD', () => {
  /*
   * The merge deferred only for 'unavailable', so a trailer-only resolver
   * finding nothing overwrote a strictly STRONGER record. Meanwhile
   * `independence`, `satisfies_gate` and `author_principal` are not in the
   * computed packet and survive -- so the row ends up claiming enforced
   * independence beside a null author. Self-contradicting, and the strong
   * form is one candidates-store row away from live.
   */
  const strong = [{
    ...build(() => AUTHOR)[0],
    author_session: 'session_01REAL',
    author_source: 'authoritative',
    independence: 'enforced',
    satisfies_gate: true,
  }];
  const stored = mergeQueue([], strong, { now: 't' }).queue;
  assert.equal(stored[0].author_source, 'authoritative', 'the fixture is not the shape it claims');

  const after = mergeQueue(stored, build(() => null), { now: 't' }).queue;
  assert.equal(after[0].author_source, 'authoritative',
    'a trailer resolver finding nothing overwrote an AUTHORITATIVE author record');
  assert.equal(after[0].author_session, 'session_01REAL');
  assert.notEqual(
    `${after[0].independence}:${after[0].author_source}`, 'enforced:null',
    'the row now claims enforced independence with no author to have derived it from',
  );
});
