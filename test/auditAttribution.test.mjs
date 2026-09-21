/**
 * THE FENCE, WATCHED FIRING -- WHICH IT NEVER HAD BEEN.
 *
 * Focused blind pass, finding D-3. The attribution check shipped inside
 * `scripts/audit-daemon.mjs`, which nothing can import, so nobody had
 * watched the fence go red, the dirty branch go red, or the
 * could-not-measure branch go red. Rule 10, and rule 1 unmet on the newest
 * control in the system.
 *
 * The auditor checked the logic by reading it and found it correct. That
 * is not the same as tested: "correct when I read it" is precisely the
 * assurance this repository is built to distrust, and every other finding
 * in that pass was code I had also read and believed.
 *
 * Every branch below is driven with git injected, so these are cheap and
 * hermetic -- there is no reason this could not have existed from the
 * start except that the logic was in the wrong file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';

import { measureReviewed, attributionHolds, ATTRIBUTION } from '../src/auditAttribution.mjs';

const SHA = 'a'.repeat(40);
const TREE = '1'.repeat(40);
const OTHER = 'b'.repeat(40);

/** A runGit stand-in answering the three reads the measurement makes. */
const gitSaying = ({ head = SHA, tree = TREE, status = '' } = {}) => (args) => {
  const key = args.join(' ');
  if (key === 'rev-parse HEAD') return head;
  if (key === 'rev-parse HEAD^{tree}') return tree;
  if (key === 'status --porcelain') return status;
  throw new Error(`unexpected git call: ${key}`);
};

const job = (over = {}) => ({ candidate_sha: SHA, candidate_tree_sha: TREE, ...over });

test('THE POSITIVE CONTROL: a clean worktree at the candidate holds', () => {
  /*
   * First, because every refusal below is only meaningful if the happy
   * path can actually pass. A fence that refuses everything is not a
   * fence, it is an outage (rule 5).
   */
  const m = measureReviewed({ dir: '/ws', runGit: gitSaying() });
  assert.equal(m.ok, true, m.why);
  assert.equal(m.sha, SHA);
  assert.equal(m.tree, TREE);

  const r = attributionHolds(m, job());
  assert.equal(r.ok, true, r.why);
  assert.equal(r.code, ATTRIBUTION.OK);
});

test('A MOVED COMMIT IS REFUSED, and named', () => {
  const m = measureReviewed({ dir: '/ws', runGit: gitSaying({ head: OTHER }) });
  const r = attributionHolds(m, job());
  assert.equal(r.ok, false, 'a worktree at a different commit was accepted');
  assert.equal(r.code, ATTRIBUTION.MOVED);
  assert.match(r.why, /the candidate moved under the audit/);
});

test('A MOVED TREE IS REFUSED TOO -- the half the sha cannot catch', () => {
  /*
   * The reason the tree is read at all. A reviewer that COMMITS in the
   * worktree moves both; one that amends or checks out a different tree at
   * the same sha is not possible, but a job whose recorded tree is stale
   * relative to the checkout is -- and the sha alone would wave it through.
   */
  const m = measureReviewed({ dir: '/ws', runGit: gitSaying({ tree: '2'.repeat(40) }) });
  const r = attributionHolds(m, job());
  assert.equal(r.ok, false, 'a different tree at the right commit was accepted');
  assert.equal(r.code, ATTRIBUTION.MOVED);
});

test('A DIRTY WORKTREE IS ITS OWN CODE, not "moved" and not "fine"', () => {
  /*
   * HEAD^{tree} is the tree of the COMMIT, so uncommitted edits leave it
   * identical -- and the brief TELLS the reviewer to mutate and restore.
   * Without this branch the commonest way a worktree stops being the
   * candidate is the one the fence cannot see.
   */
  const m = measureReviewed({ dir: '/ws', runGit: gitSaying({ status: ' M src/a.mjs\n?? junk' }) });
  assert.equal(m.ok, false);
  assert.equal(m.code, ATTRIBUTION.DIRTY);
  assert.equal(m.dirty, 2, 'the count of changes is not reported, so the message cannot be specific');

  const r = attributionHolds(m, job());
  assert.equal(r.code, ATTRIBUTION.DIRTY, 'dirty was collapsed into a generic refusal');
});

test('COULD NOT READ IS UNREADABLE, NOT A MATCH', () => {
  /*
   * The direction that must never fail open. A verdict about a tree nobody
   * can identify is exactly what the fence exists to refuse -- and a
   * `catch` that returned the claim's own values would have looked like a
   * pass.
   */
  const exploding = () => { throw Object.assign(new Error('boom'), { stderr: 'fatal: not a git repository' }); };
  const m = measureReviewed({ dir: '/gone', runGit: exploding });
  assert.equal(m.ok, false);
  assert.equal(m.code, ATTRIBUTION.UNREADABLE);
  assert.match(m.why, /not a git repository/);

  assert.equal(attributionHolds(m, job()).ok, false);
  assert.equal(attributionHolds(m, job()).code, ATTRIBUTION.UNREADABLE);
});

test('A MISSING runGit IS UNREADABLE, not silently clean', () => {
  const m = measureReviewed({ dir: '/ws' });
  assert.equal(m.ok, false);
  assert.equal(m.code, ATTRIBUTION.UNREADABLE);
});

test('AN ABSENT OR MALFORMED CLAIM IS NOT A MATCH', () => {
  /*
   * The empty case is the one that passes silently: a row missing both
   * fields would compare '' with '' and hold. Asserted for every shape a
   * legacy or hand-edited row can take.
   */
  const m = measureReviewed({ dir: '/ws', runGit: gitSaying() });
  for (const bad of [
    {}, { candidate_sha: SHA }, { candidate_tree_sha: TREE },
    { candidate_sha: '', candidate_tree_sha: '' },
    { candidate_sha: SHA.slice(0, 8), candidate_tree_sha: TREE.slice(0, 8) },
    { candidate_sha: null, candidate_tree_sha: null },
  ]) {
    const r = attributionHolds(m, bad);
    assert.equal(r.ok, false, `a claim of ${JSON.stringify(bad)} was accepted as matching`);
    assert.equal(r.code, ATTRIBUTION.MOVED);
  }
});

test('attributionHolds DECIDES FROM ITS ARGUMENTS ALONE -- no git, measured', () => {
  /*
   * THE TITLE USED TO SAY "IS PURE -- it reads nothing and calls nothing",
   * and the body proved neither. Blind audit L4: it handed the function a
   * hand-built measurement and asserted two return values, with a comment
   * claiming "if it ever reaches for git, this throws" -- it would not
   * have thrown, it would have called the real runGit and quietly passed.
   * A name and a comment advertising coverage the assertions do not carry
   * is rule 4 inside a test file about rule 4.
   *
   * So the property is now MEASURED the only way it can be: every module
   * the function could reach git through is stubbed to throw, and the call
   * is made inside that. If it reaches for any of them the test fails with
   * the stub's own message rather than passing silently.
   */
  const handBuilt = { ok: true, sha: SHA, tree: TREE };

  const tripwires = [];
  for (const name of ['execFileSync', 'execSync', 'spawnSync', 'execFile', 'spawn', 'exec']) {
    const original = childProcess[name];
    tripwires.push([name, original]);
    childProcess[name] = () => {
      throw new Error(`attributionHolds reached child_process.${name} -- it is not a pure comparison`);
    };
  }
  try {
    assert.equal(attributionHolds(handBuilt, job()).ok, true);
    assert.equal(attributionHolds(handBuilt, job({ candidate_sha: OTHER })).ok, false);
  } finally {
    for (const [name, original] of tripwires) childProcess[name] = original;
  }

  /* THE TRIPWIRE ITSELF WORKS (rule 5): with the stubs in place a function
   * that DOES shell out must fail, or the block above proves nothing. */
  let tripped = false;
  const original = childProcess.execFileSync;
  childProcess.execFileSync = () => { throw new Error('tripwire'); };
  try { childProcess.execFileSync('git', ['--version']); } catch { tripped = true; } finally {
    childProcess.execFileSync = original;
  }
  assert.equal(tripped, true, 'the tripwire does not fire, so the assertions above measured nothing');
});

test('MEASUREMENT MAKES EXACTLY THE THREE READS, in the worktree', () => {
  /*
   * Rule 4: the far end. A measurement that asked the REPOSITORY rather
   * than the worktree would answer about the wrong tree and still look
   * correct here, so the cwd is asserted rather than assumed.
   */
  const seen = [];
  const recording = (args, opts) => {
    seen.push({ args: args.join(' '), cwd: opts?.cwd });
    return gitSaying()(args);
  };
  measureReviewed({ dir: '/ws', runGit: recording });

  assert.deepEqual(seen.map((s) => s.args),
    ['rev-parse HEAD', 'rev-parse HEAD^{tree}', 'status --porcelain']);
  assert.deepEqual([...new Set(seen.map((s) => s.cwd))], ['/ws'],
    'a read was taken somewhere other than the worktree under review');
});
