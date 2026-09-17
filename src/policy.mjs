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

export function isProtectedRelPath(rel) {
  if (typeof rel !== 'string' || rel === '') return false;
  const norm = rel.split(path.sep).join('/').replace(/^\.\//, '');
  return PROTECTED_PATHS.some((entry) => (entry.endsWith('/') ? norm.startsWith(entry) : norm === entry));
}

export function isBaselineTestPath(rel) {
  const norm = String(rel ?? '').split(path.sep).join('/');
  return /^test\/.+\.test\.mjs$/i.test(norm);
}
