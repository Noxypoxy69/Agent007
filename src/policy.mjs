/**
 * THE CANONICAL POLICY ARTIFACT. ONE LIST, VERSIONED.
 *
 * The prototype declared EXTERNAL_PROTECTED_PATHS as a second copy of the list
 * already living in src/guardSession.mjs. This repository has spent real hours
 * on exactly that failure -- two lists of one thing drift the moment somebody
 * edits one, and the guard layer and the Stop snapshot disagreed for days
 * because of it.
 *
 * So this module is the artifact, not a convenience copy. It carries a version,
 * and the version participates in candidate identity: an approval issued under
 * one policy cannot be promoted under another, because the candidateId changes
 * with it.
 *
 * INTENDED FINAL SHAPE: generated from, or validated against, the repository's
 * own guardSession list at build time, so a divergence is a build failure rather
 * than a silent disagreement. That generation step is not built yet, and this
 * comment exists so nobody reads the current hand-maintained list as the
 * finished design.
 */
import path from 'node:path';

export const POLICY_VERSION = '2026-09-18-v2';

export const PROTECTED_PATHS = Object.freeze([
  '.claude/',
  'CLAUDE.md',
  'package.json',
  'package-lock.json',
  'src/claudeGuard.mjs',
  'src/guardSession.mjs',
  'src/shellAllowlist.mjs',
  'src/moduleGraph.mjs',
  'bin/agentbridge-claude-guard.mjs',
  'scripts/claude-stop-gate.mjs',
  'test/claudeGuard.test.mjs',
  'docs/CLAUDE_GUARD_PROVENANCE.md',
  'docs/ROADMAP.md',
  'docs/ORDER.md',
  'THIRD_PARTY_CODE.md',
]);

/*
 * MIRRORED FROM guardSession.mjs, AND THAT IS THE DEFECT, NOT THE FIX.
 *
 * guardSession.mjs carries a comment reading "THE ONE PROTECTED-PATH DEFINITION.
 * Both layers import this", written after two lists of protected paths drifted
 * and a write slipped between them. This file is a THIRD list, and it drifted
 * immediately: the worktree exemption landed in guardSession.mjs and not here,
 * so src/verifier.mjs -- which imports from this file -- kept the unexempted
 * behaviour for as long as nobody looked. Found by review.
 *
 * The right repair is one definition with the other importing it. That is a
 * structural change to guard code and is not being smuggled into a bug fix, so
 * the two are kept identical here and test/protectedPathParity.test.mjs FAILS if
 * they ever disagree again. A mirror without a parity check is the thing that
 * produced this.
 */
const PROTECTION_EXEMPT_PREFIXES = Object.freeze(['.claude/worktrees/']);
const NESTED_CONTROL_DIR = /(^|\/)\.claude\//;

export function isProtectedRelPath(rel) {
  if (typeof rel !== 'string' || rel === '') return false;
  const norm = rel.split(path.sep).join('/').replace(/^\.\//, '');
  const exempt = PROTECTION_EXEMPT_PREFIXES.find((p) => norm.startsWith(p));
  if (exempt && !NESTED_CONTROL_DIR.test(norm.slice(exempt.length))) return false;
  return PROTECTED_PATHS.some((entry) => (entry.endsWith('/') ? norm.startsWith(entry) : norm === entry));
}

export function isBaselineTestPath(rel) {
  const norm = String(rel ?? '').split(path.sep).join('/');
  return /^test\/.+\.test\.mjs$/i.test(norm);
}
