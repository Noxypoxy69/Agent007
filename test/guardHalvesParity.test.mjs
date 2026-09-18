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
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { isProtectedRelPath, protectedFilesIn, PROTECTED_PATHS } from '../src/guardSession.mjs';

/*
 * GENERATED FROM PROTECTED_PATHS, NOT HAND-WRITTEN. RULE 7.
 *
 * THE PREVIOUS VERSION OF THIS LIST WAS ELEVEN PATHS I TYPED, AND IT MADE THIS
 * WHOLE FILE WORTHLESS AS EVIDENCE. Measured by an independent auditor: the file
 * returned 6 of 6 at efb7990 AND at its parent, including on three paths where
 * the Stop gate flipped from refusing a tampered control to passing it. A gate
 * that cannot distinguish the commit it was cited for is not a gate, and I cited
 * it -- "parity gate 6 of 6" -- in that commit's own message.
 *
 * The specific miss: `.claude/` is a PREFIX entry, so `.claude/node_modules/**`
 * and `.claude/worktrees/<w>/node_modules/.claude/**` are protected by the
 * matcher. A walk that prunes directories named `node_modules` drops them, and
 * no path I had typed went anywhere near one. Hollow gate 10 -- a fixture that
 * cannot construct the case cannot fail for it.
 *
 * So the shapes are now derived from the real list and the real exemption. A
 * protected prefix added to PROTECTED_PATHS extends this corpus without anybody
 * remembering to, which is the property rule 7 actually asks for.
 */
const EXEMPT_PREFIX = '.claude/worktrees/';

/** Shapes that have each been a real defect in this function, per protected prefix. */
const SHAPES_UNDER_A_PREFIX = Object.freeze([
  'settings.json',                                  // the control itself
  'node_modules/settings.json',                     // prefix-protected, prune drops it
  'node_modules/deep/hooks.json',
  '.git/settings.json',                             // same, other pruned name
  'worktrees/agent-x/README.md',                    // worktree CONTENT: exempt
  'worktrees/agent-x/src/claudeGuard.mjs',          // exempt
  'worktrees/agent-x/CLAUDE.md',                    // exempt
  'worktrees/agent-x/.claude/settings.json',        // nested control: protected
  'worktrees/agent-x/.claude/hooks/pre.mjs',        // the pre-plant target
  'worktrees/agent-x/nested/deep/.claude/settings.json',
  'worktrees/agent-x/node_modules/.claude/settings.json', // nested control behind a pruned name
  'worktrees/agent-x/.git/.claude/settings.json',
  'worktrees-evil/settings.json',                   // lookalike: must NOT inherit
  'worktreesx/settings.json',
]);

const FIXTURE_FILES = Object.freeze([
  ...PROTECTED_PATHS.filter((p) => !p.endsWith('/')),
  ...PROTECTED_PATHS.filter((p) => p.endsWith('/'))
    .flatMap((prefix) => SHAPES_UNDER_A_PREFIX.map((s) => prefix + s)),
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

/*
 * TERMINATION, AS A TEST RATHER THAN AS A PROBE I RAN ONCE.
 *
 * This property was verified by a scratchpad script, which is the weakest place
 * to put it: CLAUDE.md's own hierarchy puts a check script above a file above a
 * comment, and a probe nobody runs again is below all three. It is also no
 * longer runnable -- the guard now refuses to execute a script this session
 * wrote and did not commit, because that is a two-call disarm.
 *
 * WHAT IT PINS. `protectedFilesIn` must not follow a reparse point. Two sibling
 * junctions aimed at an ancestor previously did not terminate, killed at 60s and
 * again at 600s; a single junction aimed at a large system directory cost 367s,
 * which exceeds the SessionStart budget twelvefold. An over-budget hook is
 * CANCELLED and its turn APPROVED, so this is a silent-allow property, not a
 * performance one.
 *
 * The time assertion is deliberately loose. It is not a benchmark -- it is there
 * so that following links again fails LOUDLY here instead of being discovered as
 * a cancelled Stop hook on somebody's machine.
 */
test('TERMINATION: the walk does not follow a junction, so a cycle cannot cost the budget', () => {
  const root = buildFixture();
  try {
    const target = path.join(root, '.claude');
    let made = 0;
    for (const name of ['p', 'q']) {
      try {
        symlinkSync(target, path.join(root, '.claude/worktrees/agent-x', name), 'junction');
        made += 1;
      } catch { /* counted below */ }
    }
    /*
     * The positive first (rule 5): if the fixture could not be built, this test
     * proves nothing and must SAY so rather than passing quietly.
     */
    assert.equal(made, 2, 'could not create the junctions, so termination was not exercised');

    const started = Date.now();
    const files = protectedFilesIn(root);
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 5000, `the walk took ${elapsed}ms on two junctions; it is following reparse points again`);
    assert.ok(
      files.includes('.claude/worktrees/agent-x/.claude/settings.json'),
      'termination must not have cost the nested-control coverage it exists beside',
    );
    assert.equal(
      files.some((f) => f.includes('/p/') || f.includes('/q/')), false,
      'nothing reached through a junction belongs in this repository\'s baseline',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
