/**
 * THE RESOLVER THE CALL SITES ACTUALLY USE, NOT A SYNTHETIC ONE.
 *
 * Fourth-lap blind audit H1, and it is the fourth consecutive lap to find the
 * same shape one layer further out.
 *
 * `98db963` taught `auditJobsFor` to map a throw, and a returned sentinel, to
 * `AUTHOR_UNAVAILABLE`. It changed no caller. All three shipped resolvers went
 * on laundering a failed lookup into a measured absence, each hand-rolled:
 *
 *   scripts/enqueue-audit-job.mjs   authorSessionFrom(git(...) ?? '')
 *   bin/agentbridge.mjs (jobs)      try { ... } catch { return null }
 *   bin/agentbridge.mjs (claim)     try { ... } catch { authorSession = null }
 *
 * The library learned the distinction and the callers never did. The two tests
 * that shipped with that commit each built their OWN resolver and asserted
 * against it -- rule 4, the mechanism verified and the wiring not, which is
 * exactly what let the fix look complete.
 *
 * So the resolver is one shared function now, and this exercises THAT
 * function with the failure modes the real git wrappers actually produce.
 * A hand-rolled resolver at a call site would no longer be covered here --
 * which is the point: there is nothing left to hand-roll.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeAuthorResolver, AUTHOR_UNAVAILABLE, auditJobsFor } from '../src/auditJob.mjs';

const SHA = 'a'.repeat(40);
const BODY_WITH = 'subject\n\nClaude-Session: https://claude.ai/code/session_01ABC\n';

test('A READER RETURNING null IS UNAVAILABLE -- the enqueue-audit-job shape', () => {
  /*
   * `git()` in the post-commit hook returns null on ANY failure: a 60s
   * timeout, contention in this shared clone, PATH. The old line applied
   * `?? ''` to that, which is the launder.
   */
  const r = makeAuthorResolver(() => null);
  assert.equal(r(SHA), AUTHOR_UNAVAILABLE,
    'a git call that failed was reported as a commit with no trailer, which is the '
    + 'measured-absence state and licenses erasing a known author');
});

test('A READER THAT THROWS IS UNAVAILABLE -- the bin/agentbridge shape', () => {
  const r = makeAuthorResolver(() => { throw new Error('execFileSync exploded'); });
  assert.equal(r(SHA), AUTHOR_UNAVAILABLE);
});

test('BUT AN EMPTY MESSAGE IS A MEASUREMENT, not a failure', () => {
  /*
   * THE POSITIVE BESIDE THE NEGATIVES (rule 5). git answered; this commit
   * genuinely has no trailer. If every unhappy path became `unavailable` the
   * distinction would be destroyed in the other direction, and a commit with
   * no trailer would defer to a stale author for ever.
   */
  assert.equal(makeAuthorResolver(() => '')(SHA), null,
    'an answered-but-empty message was treated as a failed lookup');
  assert.equal(makeAuthorResolver(() => 'subject with no trailer\n')(SHA), null);
});

test('AND A REAL TRAILER STILL RESOLVES, or the refusals above prove nothing', () => {
  assert.equal(makeAuthorResolver(() => BODY_WITH)(SHA), 'session_01ABC');
});

test('undefined IS UNAVAILABLE TOO, because a wrapper may return it', () => {
  assert.equal(makeAuthorResolver(() => undefined)(SHA), AUTHOR_UNAVAILABLE);
});

test('END TO END: a failed reader produces a job marked unavailable, not absent', () => {
  /*
   * The far end (rule 4). The states above matter only if they survive into
   * the job the queue stores, because that is what `mergeQueue`'s strength
   * ordering and the dispatcher's author exclusion both read.
   */
  const coverage = {
    commits: [{ sha: SHA, subject: 's', touched: ['src/policy.mjs'], audited: false }],
    malformed: [],
    error: null,
  };
  const build = (reader) => auditJobsFor(coverage, {
    treeShaFor: () => '1'.repeat(40),
    authorSessionFor: makeAuthorResolver(reader),
    now: 't',
  }).jobs[0];

  assert.equal(build(() => null).author_source, AUTHOR_UNAVAILABLE);
  assert.equal(build(() => { throw new Error('x'); }).author_source, AUTHOR_UNAVAILABLE);
  assert.equal(build(() => '').author_source, null, 'a real absence became unavailable');
  assert.equal(build(() => BODY_WITH).author_source, 'trailer');
  assert.equal(build(() => BODY_WITH).author_session, 'session_01ABC');
});
