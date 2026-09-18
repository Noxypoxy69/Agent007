import test from 'node:test';
import assert from 'node:assert/strict';
import { rank, priorWork } from '../src/priorWork.mjs';

const BRANCHES = [
  { name: 'code-b/liveness-from-activity', subject: 'The roster described daemons, not agents', at: '2026-09-17T00:15:09Z', merged: false },
  { name: 'code-b/artifact-loads', subject: 'A digest cannot tell you the artifact loads', at: '2026-09-16T02:08:00Z', merged: false },
  { name: 'work/support-modules', subject: 'the attempt-record writer', at: '2026-09-16T17:59:00Z', merged: true },
];
const COMMITS = [
  { sha: '5083feb', subject: 'The CI failure: a username is a word, and on a runner that word is "runner"', at: '2026-09-16T19:59:23Z' },
  { sha: 'abc1234', subject: 'Reconcile the ledger to version 26', at: '2026-09-17T00:44:00Z' },
];

test('THE 65-MINUTE DUPLICATION: the CI fix was findable on master the whole time', () => {
  const r = priorWork({ branches: BRANCHES, commits: COMMITS, query: 'CI failure runner username' });
  assert.equal(r.verdict, 'prior-work-found');
  assert.equal(r.matches[0].name, '5083feb', 'the commit that already fixed it must rank first');
});

test('THE 9-MINUTE DUPLICATION: the roster branch was on the server before I started', () => {
  const r = priorWork({ branches: BRANCHES, commits: COMMITS, query: 'roster liveness' });
  assert.equal(r.matches[0].name, 'code-b/liveness-from-activity');
  assert.equal(r.matches[0].kind, 'branch');
});

test('ordering is score first, then newest — and this test was hollow once', () => {
  /*
   * `b.score - a.score || cond ? 1 : -1` parses as `(x || cond) ? 1 : -1`, so
   * the score difference is swallowed and the comparator is inconsistent.
   *
   * THE FIRST VERSION OF THIS TEST USED THREE ENTRIES AND PASSED AGAINST THE
   * BUG. V8 insertion-sorts a small array, and an inconsistent comparator can
   * still land on the expected order by luck of the input. The mutation was run
   * and came back green, which is the only reason it was caught.
   *
   * Nine entries, three score bands. The bug interleaves them -- 3,2,1,3,2,1,
   * 3,2,1 -- so asserting the PROPERTY (scores never increase) catches it where
   * asserting one expected list did not.
   */
  const c = Array.from({ length: 9 }, (_, i) => ({
    kind: 'branch',
    name: `n${i}`,
    subject: i % 3 === 0 ? 'roster liveness heartbeat' : i % 3 === 1 ? 'roster liveness' : 'roster',
    at: `2026-09-${String(10 + (i % 9)).padStart(2, '0')}T00:00:00Z`,
  }));
  const out = rank(c, 'roster liveness heartbeat');
  assert.equal(out.length, 9);
  for (let i = 1; i < out.length; i += 1) {
    assert.ok(out[i - 1].score >= out[i].score,
      `score must never increase down the list, got ${out.map((m) => m.score).join(',')}`);
    if (out[i - 1].score === out[i].score) {
      assert.ok(out[i - 1].at >= out[i].at,
        `within a score band the newer entry comes first, got ${out.map((m) => m.at.slice(0, 10)).join(',')}`);
    }
  }
});

test('a FAILED lookup is not an absence of prior work', () => {
  /*
   * The inversion that matters most for this tool. "nothing found" is exactly
   * what somebody wants to hear before starting, so an error rendered as an
   * empty result gets believed and acted on. verdict must say unknown.
   */
  const r = priorWork({ branches: [], commits: [], query: 'roster', ok: false, errors: ['ls-remote failed'] });
  assert.equal(r.verdict, 'unknown');
  assert.notEqual(r.verdict, 'nothing-found');
  assert.deepEqual(r.errors, ['ls-remote failed']);
});

test('a genuinely clear field says so, and only when the lookup worked', () => {
  const r = priorWork({ branches: BRANCHES, commits: COMMITS, query: 'zzqqxx nothing like this' });
  assert.equal(r.verdict, 'nothing-found');
  assert.equal(r.ok, true);
});

test('open fronts are the UNMERGED branches, and merged ones are not fronts', () => {
  const r = priorWork({ branches: BRANCHES, commits: COMMITS, query: '' });
  assert.deepEqual(r.openFronts.map((b) => b.name),
    ['code-b/liveness-from-activity', 'code-b/artifact-loads']);
});

test('short tokens are dropped so every query does not match everything', () => {
  assert.deepEqual(rank(BRANCHES.map((b) => ({ ...b, kind: 'branch' })), 'a of'), []);
});

test('no query means no matches, never all of them', () => {
  assert.deepEqual(priorWork({ branches: BRANCHES, commits: COMMITS }).matches, []);
});
