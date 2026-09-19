/**
 * MARKDOWN UNDER `.claude/` IS NOT PROSE, AND THE FILE'S OWN COMMENT SAID SO
 * WHILE THE REGEX DID THE OPPOSITE.
 *
 * `src/auditLedger.mjs` exempts prose from blocking a turn, `\.md$`, and the
 * comment directly above that regex ends:
 *
 *     "Note what is NOT exempt any more: .claude/** is decision CONFIGURATION --
 *      settings.json decides whether the hooks arm at all ... Weakening either is
 *      the cheapest way to disable a control without touching it."
 *
 * `\.md$` matches `.claude/agents/auditor.md` exactly as well as it matches
 * CLAUDE.md, so every markdown file under the one directory that sentence
 * singles out was back on the exempt list. An agent definition is a system
 * prompt and a tool roster; a slash-command file is instructions that run when
 * somebody types its name. Both change what an agent DOES. Found by blind audit,
 * 2026-09-19.
 *
 * THE SECOND HALF OF THIS FILE IS THE OVER-BLOCK THE FIX NEARLY CAUSED, which I
 * found in my own change before it shipped: `isAuditBearing` walks
 * PROTECTED_PATHS directly rather than through `isProtectedRelPath`, so the
 * worktree carve-out never reaches it and a blanket `.claude/` rule would have
 * started blocking every markdown file in every agent worktree.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isBlockingControl, isAuditBearing } from '../src/auditLedger.mjs';

/* ── the positive first ───────────────────────────────────────────────── */

test('THE PRECONDITION: these paths are audit-bearing at all', () => {
  /*
   * Rule 5. "A markdown file under .claude/ blocks" passes vacuously against a
   * path that was never audit-bearing, so assert the premise rather than
   * assuming it -- and rule 6, assert it, do not guard on it.
   */
  for (const p of ['.claude/agents/auditor.md', '.claude/commands/deploy.md', '.claude/settings.json']) {
    assert.equal(isAuditBearing(p), true, `${p} is not audit-bearing, so this file proves nothing`);
  }
});

test('PROSE STILL DOES NOT BLOCK, which is why the exemption exists', () => {
  /*
   * The exemption is load-bearing: blocking a turn on a documentation edit took
   * the operator machine down once and nearly got this gate switched off
   * entirely. A fix that closed the .claude/ hole by deleting the exemption
   * would pass every assertion below and be strictly worse.
   */
  for (const p of ['CLAUDE.md', 'docs/ROADMAP.md', 'docs/ORDER.md', 'THIRD_PARTY_CODE.md']) {
    assert.equal(isBlockingControl(p), false, `${p} now blocks a turn on a prose edit`);
  }
  assert.equal(isBlockingControl('package.json'), false);
  assert.equal(isBlockingControl('package-lock.json'), false);
});

/* ── the defect ───────────────────────────────────────────────────────── */

test('AN AGENT OR COMMAND DEFINITION BLOCKS, whatever its extension', () => {
  for (const p of [
    '.claude/agents/auditor.md',
    '.claude/commands/deploy.md',
    '.claude/skills/thing/SKILL.md',
    '.claude/README.md',
    '.claude/anything/added/next/month.md',
  ]) {
    assert.equal(isBlockingControl(p), true, `${p} was treated as prose; it decides what an agent does`);
  }
});

test('AND IT IS ASKED AS A SHAPE, so a case variant is the same file', () => {
  /*
   * NTFS resolves .Claude to the same directory. PROTECTED_PATHS folds case for
   * this reason and a junction named `.Claude` reaching a control is a measured
   * finding in this repository, not a hypothetical.
   */
  for (const p of ['.Claude/agents/x.md', '.CLAUDE/commands/y.md']) {
    assert.equal(isBlockingControl(p), true, `${p} escaped by spelling`);
  }
});

test('A BACKSLASH PATH IS THE SAME PATH, because git and Windows disagree', () => {
  assert.equal(isBlockingControl('.claude\\agents\\auditor.md'), true);
});

/* ── the over-block the fix nearly caused ─────────────────────────────── */

test('A WORKTREE\'S OWN MARKDOWN DOES NOT BLOCK: it is somebody else\'s checkout', () => {
  /*
   * MEASURED IN MY OWN DRAFT, not theorised. A blanket `.claude/` rule blocks
   * these, because isAuditBearing never consults PROTECTION_EXEMPT_PREFIXES. An
   * over-block introduced by a fix is the shape two audits caught on this
   * surface on 2026-09-18.
   */
  for (const p of [
    '.claude/worktrees/audit-1/CLAUDE.md',
    '.claude/worktrees/audit-1/docs/notes.md',
    '.claude/worktrees/audit-1/README.md',
  ]) {
    assert.equal(isBlockingControl(p), false, `${p} blocks the session that spawned the auditor`);
  }
});

test('BUT A `.claude/` NESTED INSIDE A WORKTREE IS PROTECTED AGAIN', () => {
  /*
   * The carve-out was always narrow here. An OUTER session can write
   * `.claude/worktrees/<id>/.claude/settings.json` BEFORE any agent starts
   * there, and the agent then boots with no guard at all -- so that directory is
   * the one thing the exemption must not cover. Same rule as guardSession's.
   */
  for (const p of [
    '.claude/worktrees/audit-1/.claude/settings.json',
    '.claude/worktrees/audit-1/.claude/agents/x.md',
    '.claude/worktrees/audit-1/sub/.claude/commands/y.md',
  ]) {
    assert.equal(isBlockingControl(p), true, `${p} is how an agent boots disarmed`);
  }
});

test('THE CONTROL: this distinguishes, in both directions', () => {
  assert.equal(isBlockingControl('.claude/agents/auditor.md'), true);
  assert.equal(isBlockingControl('CLAUDE.md'), false);
  assert.equal(isBlockingControl('src/guardSession.mjs'), true);
  assert.equal(isBlockingControl('src/somethingUnprotected.mjs'), false);
});
