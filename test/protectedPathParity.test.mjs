/**
 * TWO PROTECTED-PATH DEFINITIONS EXIST AND MUST NOT DRIFT.
 *
 * guardSession.mjs carries a comment reading "THE ONE PROTECTED-PATH
 * DEFINITION. Both layers import this" -- written after exactly this failure,
 * where two lists disagreed and a write slipped through the gap between them.
 *
 * There are three now. src/policy.mjs holds an independent copy and
 * src/verifier.mjs imports from it, so guardSession.mjs is not the one
 * definition its own comment claims. Measured 2026-09-18: the agent-worktree
 * exemption landed in guardSession.mjs alone, and verifier.mjs kept judging
 * worktree paths as protected controls of the outer repository for as long as
 * nobody thought to look. Found by review, not by a test, because no test
 * compared them.
 *
 * This is that test. It does not make the duplication acceptable -- the repair
 * is one definition with the other importing it, which is a structural change
 * to guard code and belongs in its own commit. Until then, drift fails here
 * rather than in production.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isProtectedRelPath as fromGuardSession, PROTECTED_PATHS as LIST_A } from '../src/guardSession.mjs';
import { isProtectedRelPath as fromPolicy } from '../src/policy.mjs';

/*
 * The corpus is built from the SHIPPED list rather than typed out, so a path
 * added to PROTECTED_PATHS is compared automatically instead of waiting for
 * somebody to remember this file. Rule 19: a list of names fails in both
 * directions, and a hand-typed corpus is a list of names.
 */
const CORPUS = [
  ...LIST_A.flatMap((entry) => (entry.endsWith('/')
    ? [`${entry}settings.json`, `${entry}nested/deep/file.mjs`, entry]
    : [entry, `${entry}.bak`, `x/${entry}`])),
  // the worktree exemption and its edges
  '.claude/worktrees/agent-x/README.md',
  '.claude/worktrees/agent-x/src/claudeGuard.mjs',
  '.claude/worktrees/agent-x/.claude/settings.json',
  '.claude/worktrees/agent-x/nested/.claude/settings.json',
  '.claude/worktrees/',
  '.claude/worktrees-evil/settings.json',
  '.claude/worktreesx/settings.json',
  // shapes that have caused trouble before
  './CLAUDE.md', 'CLAUDE.md', 'docs/../CLAUDE.md', '', 'src/collect.mjs',
  'test/claudeGuard.test.mjs', 'test/ordinary.test.mjs',
];

test('both protected-path implementations agree on every path in the corpus', () => {
  const disagreements = CORPUS
    .map((p) => ({ p, a: fromGuardSession(p), b: fromPolicy(p) }))
    .filter(({ a, b }) => a !== b);

  assert.deepEqual(
    disagreements, [],
    'guardSession.mjs and policy.mjs disagree about these paths. src/verifier.mjs '
    + 'uses the policy.mjs answer, so a disagreement here is a real difference in '
    + 'what the verifier protects, not a cosmetic one.',
  );
});

test('the corpus is not vacuously agreeing -- it contains both verdicts', () => {
  /*
   * Two implementations that both return false for everything would pass the
   * test above. This one fails if the corpus stops exercising the distinction.
   */
  const verdicts = new Set(CORPUS.map((p) => fromGuardSession(p)));
  assert.ok(verdicts.has(true), 'the corpus must contain at least one protected path');
  assert.ok(verdicts.has(false), 'and at least one unprotected path');
});

test('the worktree exemption is present in BOTH, not just the one that was patched', () => {
  /*
   * The specific drift that occurred. Asserted on both sides by name so the
   * failure says which file is behind rather than only that they differ.
   */
  for (const [name, fn] of [['guardSession.mjs', fromGuardSession], ['policy.mjs', fromPolicy]]) {
    assert.equal(fn('.claude/worktrees/agent-x/README.md'), false,
      `${name} is missing the agent-worktree exemption`);
    assert.equal(fn('.claude/worktrees/agent-x/.claude/settings.json'), true,
      `${name} would let an outer session pre-plant a hook config before the agent boots`);
  }
});

/* ============================================================================
 * THE FILES THAT DECIDE WHAT "PROTECTED" MEANS WERE NOT PROTECTED.
 *
 * Measured 2026-09-18 against the shipped hook: an Edit to src/guardSession.mjs
 * and src/shellAllowlist.mjs was DENIED, and an Edit to src/policy.mjs and
 * src/verifier.mjs was ALLOWED. policy.mjs holds the isProtectedRelPath that
 * verifier.mjs imports -- so a guarded session could rewrite the definition of
 * "protected" without touching a protected file, and nothing would refuse it.
 * The list named src/moduleGraph.mjs and not the two files that decide the
 * answer.
 * ==========================================================================*/

test('the policy and verifier sources are themselves protected', () => {
  for (const [name, fn] of [['guardSession.mjs', fromGuardSession], ['policy.mjs', fromPolicy]]) {
    for (const f of ['src/policy.mjs', 'src/verifier.mjs']) {
      assert.equal(fn(f), true,
        `${name} leaves ${f} unprotected -- it decides what protected MEANS`);
    }
  }
});

/* ============================================================================
 * THE COMPARE IS CASE-FOLDED, BECAUSE THE FILESYSTEM IS.
 *
 * An exact string compare on a platform where .CLAUDE, .Claude and .claude are
 * ONE directory. Through the shipped binary these were ALLOW while the
 * canonical spelling was denied, and writing .CLAUDE/settings.json modifies
 * .claude/settings.json -- git reports the canonical path as modified. So one
 * permitted write carrying disableAllHooks removed PreToolUse AND the Stop
 * hook, and the detected-at-Stop fallback that two other modules delegate to
 * never ran. Reported by three separate blind audits before it was fixed.
 * ==========================================================================*/

test('a protected path is protected in every casing, in BOTH implementations', () => {
  for (const [name, fn] of [['guardSession.mjs', fromGuardSession], ['policy.mjs', fromPolicy]]) {
    for (const p of [
      '.CLAUDE/settings.json', '.Claude/settings.json', '.claude/settings.json',
      'SRC/claudeGuard.mjs', 'src/claudeGuard.MJS', 'src/CLAUDEGuard.mjs',
      'CLAUDE.MD', 'claude.md', 'package.JSON', 'src/Policy.mjs',
    ]) {
      assert.equal(fn(p), true, `${name} lets ${p} through, and it is the same file as the canonical spelling`);
    }
  }
});

test('and folding does not swallow ordinary paths', () => {
  /*
   * The positive half. Without it the test above passes for a function that
   * returns true for everything, which is rule 5.
   */
  for (const [name, fn] of [['guardSession.mjs', fromGuardSession], ['policy.mjs', fromPolicy]]) {
    for (const p of ['src/collect.mjs', 'docs/notes.md', 'test/sessionWatch.test.mjs', 'README.md']) {
      assert.equal(fn(p), false, `${name} now over-blocks ${p}`);
    }
  }
});

test('the worktree exemption folds too, and its nested control still does not', () => {
  assert.equal(fromGuardSession('.CLAUDE/worktrees/x/README.md'), false, 'exempt in any casing');
  assert.equal(fromGuardSession('.claude/worktrees/x/.CLAUDE/settings.json'), true,
    'a nested control directory stays protected however it is spelled');
});
