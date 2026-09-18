/**
 * THE GUARD HAS TWO HALVES AND THEY DISAGREE.
 *
 * `isProtectedRelPath` decides what PreToolUse REFUSES TO WRITE.
 * `protectedFilesIn` decides what the Stop gate HASHES INTO THE BASELINE, which
 * is what it can later detect as changed.
 *
 * A path the matcher protects but the walk never hashes is defended against a
 * direct tool write and INVISIBLE to every other route: an MCP write, `npm test`
 * executing repository JavaScript, a git operation. Prevention without
 * detection.
 *
 * Measured at 0427b0d+ on a fixture, three paths diverge, all of them a nested
 * `.claude/` inside an agent worktree:
 *
 *   .claude/worktrees/agent-x/.claude/settings.json        matcher true / walk false
 *   .claude/worktrees/agent-x/.claude/hooks/pre.mjs        matcher true / walk false
 *   .claude/worktrees/agent-x/nested/deep/.claude/...      matcher true / walk false
 *
 * WHY: `9703912` exempted `.claude/worktrees/` from both halves. A follow-up
 * added `NESTED_CONTROL_DIR` to the MATCHER, re-protecting a `.claude/`
 * directory anywhere inside a worktree -- that is the directory deciding whether
 * a guard runs, and pre-planting it is the attack. The WALK
 * (`guardSession.mjs`, the `continue` in `protectedFilesIn`) did not get the
 * same treatment: it still skips on a bare prefix test.
 *
 * THIS IS NOT FIXED BY COPYING THE MATCHER'S CHECK. The walk skips at the
 * DIRECTORY on purpose -- descending a whole second checkout per worktree on
 * every session start was half the reason for the exemption (62 -> 18 files on a
 * one-worktree fixture). Re-protecting nested `.claude/` means descending FOR IT
 * SPECIFICALLY rather than skipping wholesale. That trade is the owner's, which
 * is why this file reports the gap instead of guessing at the fix.
 *
 * RULE 16 COMPLIANCE, because the last deliberately-red test in this repository
 * failed it. A red gate nobody has shown can go green is a countdown, not a
 * ratchet. So:
 *   - REACHABILITY is proven below against a corrected walk: the demand CAN be
 *     satisfied, and the proof runs every time rather than being asserted in a
 *     comment.
 *   - STAND-DOWN is proven below and is BEHAVIOURAL: if the exemption is ever
 *     removed, the premise is gone, and the demand retires itself instead of
 *     staying red forever.
 *   - The premise is detected by BEHAVIOUR, not by importing a module-private
 *     constant, so deleting that constant cannot make this file fail to LOAD.
 *     A file that fails to resolve runs zero assertions and vanishes from the
 *     count -- hollow gate 9, which happened here this week.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { isProtectedRelPath, protectedFilesIn, PROTECTED_PATHS } from '../src/guardSession.mjs';

/** Files planted in a throwaway fixture. NEVER the operator's repository. */
const FIXTURE_FILES = Object.freeze([
  // ordinary controls at the repo root -- the POSITIVE control (rule 5)
  '.claude/settings.json',
  'CLAUDE.md',
  'src/claudeGuard.mjs',
  'package.json',
  // worktree CONTENT, legitimately exempt: a checkout differs from the outer tree
  '.claude/worktrees/agent-x/README.md',
  '.claude/worktrees/agent-x/src/claudeGuard.mjs',
  '.claude/worktrees/agent-x/CLAUDE.md',
  // a nested control directory inside a worktree -- the contested set
  '.claude/worktrees/agent-x/.claude/settings.json',
  '.claude/worktrees/agent-x/.claude/hooks/pre.mjs',
  '.claude/worktrees/agent-x/nested/deep/.claude/settings.json',
  // a lookalike directory: must NOT inherit the exemption
  '.claude/worktrees-evil/settings.json',
]);

function buildFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'guard-parity-'));
  for (const rel of FIXTURE_FILES) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, 'fixture');
  }
  return root;
}

const withFixture = (fn) => {
  const root = buildFixture();
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

/** Every mismatch, COLLECTED. Asserting inside the loop reports one of three. */
function mismatches(root) {
  const walked = new Set(protectedFilesIn(root));
  return FIXTURE_FILES
    .filter((rel) => isProtectedRelPath(rel) !== walked.has(rel))
    .map((rel) => `${rel}  matcher=${isProtectedRelPath(rel)} walk=${walked.has(rel)}`);
}

/**
 * Is the worktree exemption live at all? Detected by BEHAVIOUR so that removing
 * the exemption -- the thing that would make this whole file moot -- cannot
 * break this file's import and silently delete its assertions.
 */
const exemptionIsLive = () => isProtectedRelPath('.claude/worktrees/agent-x/README.md') === false;

test('THE POSITIVE FIRST: the walk really does hash ordinary controls', () => {
  withFixture((root) => {
    const walked = new Set(protectedFilesIn(root));
    for (const rel of ['.claude/settings.json', 'CLAUDE.md', 'src/claudeGuard.mjs', 'package.json']) {
      assert.equal(walked.has(rel), true, `${rel} must be in the Stop baseline`);
    }
    assert.ok(walked.size >= 4, 'the walk returned almost nothing; the fixture or the walk is broken');
    assert.ok(PROTECTED_PATHS.length > 10, 'the protected list did not load');
  });
});

test('the lookalike directory does NOT inherit the exemption, in both halves', () => {
  withFixture((root) => {
    const walked = new Set(protectedFilesIn(root));
    assert.equal(isProtectedRelPath('.claude/worktrees-evil/settings.json'), true);
    assert.equal(walked.has('.claude/worktrees-evil/settings.json'), true);
  });
});

test('worktree CONTENT is exempt in both halves, which is the intended carve-out', () => {
  withFixture((root) => {
    const walked = new Set(protectedFilesIn(root));
    for (const rel of ['.claude/worktrees/agent-x/README.md', '.claude/worktrees/agent-x/src/claudeGuard.mjs']) {
      assert.equal(isProtectedRelPath(rel), false, `${rel} is somebody else's checkout`);
      assert.equal(walked.has(rel), false, `${rel} must not be hashed into this repo's baseline`);
    }
  });
});

/*
 * REACHABILITY (rule 16). The demand below is red today. This proves it is
 * SATISFIABLE, so it is a ratchet rather than an IOU -- and it runs, rather than
 * being claimed in a comment.
 *
 * This corrected walk is a DEMONSTRATION, not a second copy of the shipped rule:
 * the demand above and below is asserted against the SHIPPED protectedFilesIn.
 * This one exists only to show a fix exists.
 */
function correctedWalk(root) {
  const out = [];
  const visit = (dir) => {
    for (const e of readdirSync(dir).sort()) {
      const abs = path.join(dir, e);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) { visit(abs); continue; }
      if (isProtectedRelPath(rel)) out.push(rel);
    }
  };
  visit(root);
  return out;
}

test('REACHABILITY: a walk that consults the matcher satisfies the demand', () => {
  withFixture((root) => {
    const walked = new Set(correctedWalk(root));
    const bad = FIXTURE_FILES.filter((rel) => isProtectedRelPath(rel) !== walked.has(rel));
    assert.deepEqual(bad, [], 'the demand below is achievable; this is not an IOU');
    assert.ok(walked.has('.claude/worktrees/agent-x/.claude/hooks/pre.mjs'),
      'and it is achievable specifically for the nested control directory');
  });
});

test('THE PREMISE, stated as an assertion rather than guarded on', () => {
  /*
   * Rule 6: `if (premise) { assert(...) }` is a test that passes by not running.
   * So the premise is ASSERTED, and it is the only thing this test asserts. If
   * the exemption is ever removed, THIS test fails and says the demand below is
   * moot -- which is the stand-down, made loud instead of silent.
   */
  assert.equal(exemptionIsLive(), true,
    'The worktree exemption is gone. That removes the premise of the DEMAND below, '
    + 'which should now pass on its own. Delete this file rather than leaving a '
    + 'gate whose reason has expired.');
});

/*
 * THE DEMAND. Expected RED until the walk re-protects a nested `.claude/`.
 *
 * It stands down automatically above if the exemption is removed. It is proven
 * reachable above. It reports ALL mismatches rather than the first, because an
 * assert inside a loop reports one of three and the reader fixes one of three.
 */
test('DEMAND (expected red): what PreToolUse protects, the Stop gate must be able to see', () => {
  /*
   * NO PRECONDITION GUARD HERE, DELIBERATELY. An early return would make this
   * pass vacuously the day the premise changes. It does not need one: if the
   * exemption is removed, the walk stops skipping, both halves cover the same
   * paths, and this assertion goes green ON ITS OWN. The stand-down is the
   * assertion itself, not a branch around it.
   */
  withFixture((root) => {
    assert.deepEqual(
      mismatches(root),
      [],
      'These paths are refused by PreToolUse but are NOT in the Stop baseline, so a '
      + 'change reaching them by any route that bypasses PreToolUse -- an MCP write, '
      + 'npm test running repo JS, a git operation -- is undetectable. Fix: make the '
      + 'protectedFilesIn skip in src/guardSession.mjs descend for a nested .claude/ '
      + 'instead of skipping the worktree wholesale. See the header for why this is '
      + 'not a copy of the matcher check.',
    );
  });
});
