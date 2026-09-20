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

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeAuthorResolver, AUTHOR_UNAVAILABLE, auditJobsFor } from '../src/auditJob.mjs';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

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

test('THE CALL SITES USE IT -- asserted on the SOURCE, because that is the half that drifts', () => {
  /*
   * Fifth-lap blind audit D6, and the regression it names has now recurred
   * on four consecutive laps: the library learns something and the callers
   * do not. Reverting any of the three call sites to `catch { return null }`
   * left the whole suite green, because every test here builds its own
   * resolver -- rule 4, the mechanism verified and the wiring not, which is
   * the exact criticism this file's header levels at the commit before it.
   *
   * The header's defence was "there is nothing left to hand-roll". That was
   * equally true of the library after the previous fix, and the callers
   * drifted anyway. A promise about future authors is not a control.
   *
   * COMMENT-BLANKED FIRST (rule 13). This file and the call sites both
   * DISCUSS `makeAuthorResolver` in prose, and three independent
   * rediscoveries in this repository came from a check matching its own
   * explanatory comment.
   */
  const blank = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));

  const SITES = [
    ['bin/agentbridge.mjs', 2],
    ['scripts/enqueue-audit-job.mjs', 1],
  ];

  for (const [rel, atLeast] of SITES) {
    const code = blank(readFileSync(path.join(REPO, rel), 'utf8'));
    const uses = [...code.matchAll(/makeAuthorResolver\s*\(/g)].length;
    assert.ok(uses >= atLeast,
      `${rel} calls makeAuthorResolver ${uses} time(s), expected at least ${atLeast}. `
      + 'A call site that hand-rolls its own resolver launders a failed lookup into a '
      + 'measured absence, which is the fail-open four audits have now found');
  }

  /*
   * AND NOBODY ELSE CALLS `authorSessionFrom`. The count above passes if
   * somebody adds a call and leaves the old resolver beside it, which is how
   * this drifted the first time.
   *
   * THE FIRST VERSION OF THIS ASSERTION BANNED `catch { return null }`
   * ANYWHERE IN THE FILE, and it went red on a 200k-character CLI full of
   * unrelated, perfectly correct instances. That is rule 19 -- an
   * over-block, refusing things that were never the problem -- and an
   * over-broad gate gets deleted by the next person it inconveniences,
   * which loses the real check with it.
   *
   * The precise invariant is narrower and stronger: `authorSessionFrom` is
   * the raw trailer parser, and the ONLY legitimate caller is
   * `makeAuthorResolver` inside src/auditJob.mjs. A call anywhere in bin/ or
   * scripts/ IS a hand-rolled resolver by definition, whatever its error
   * handling looks like.
   */
  for (const [rel] of SITES) {
    const code = blank(readFileSync(path.join(REPO, rel), 'utf8'));
    const calls = [...code.matchAll(/authorSessionFrom\s*\(/g)].length;
    assert.equal(calls, 0,
      `${rel} calls authorSessionFrom ${calls} time(s). That parser is raw -- it cannot `
      + 'tell a failed lookup from an absent trailer -- so any caller outside '
      + 'makeAuthorResolver is a hand-rolled resolver and reintroduces the fail-open');
  }
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
