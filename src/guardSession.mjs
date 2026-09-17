/**
 * THE SESSION SNAPSHOT: what the repository looked like before Claude touched it.
 *
 * WHY HEAD IS THE WRONG BASELINE. The first Stop gate audited
 * `git diff --name-only HEAD -- <protected>`, and a committed mutation is not in
 * that diff. Demonstrated end to end in three ordinary calls: write the stop
 * gate, `git commit -am wip`, and the gate approves everything. Comparing
 * against HEAD asks "is the working tree dirty", which is a different question
 * from "did these files change during this session".
 *
 * SO THE BASELINE IS CONTENT, RECORDED BEFORE THE SESSION, STORED OUTSIDE THE
 * REPOSITORY. A commit cannot hide a content change from a content hash, and a
 * write that never passed through PreToolUse -- an MCP repository write, a
 * subagent, a wrapper script -- still changes the bytes and is still caught at
 * Stop. That is the only coverage claim made for those paths: they are NOT
 * prevented, they are detected afterwards.
 *
 * THE HONEST LIMIT OF "OUTSIDE THE REPOSITORY". The snapshot lives beside the
 * agentbridge config, not in the worktree, so repository-scoped rules and a
 * `git checkout` cannot reach it. It is not beyond the reach of a shell running
 * as the same user. This is containment, not a trust boundary; a real one lives
 * in a process the coding agent cannot execute.
 *
 * FAILS CLOSED. A missing, unreadable or malformed snapshot is not "nothing
 * changed" -- it is "nobody knows", and the Stop gate refuses on it.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

export const SNAPSHOT_VERSION = 1;

/**
 * THE ONE PROTECTED-PATH DEFINITION. Both layers import this.
 *
 * There were two lists and they disagreed: PreToolUse protected docs/ROADMAP.md,
 * docs/ORDER.md and all of .claude/**, and the Stop snapshot did not -- so a
 * write that bypassed PreToolUse could change them and Stop would not notice.
 * Two lists of the same thing drift the moment one is edited; there is now one.
 *
 * An entry ending in `/` is a PREFIX and covers everything beneath it.
 */
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

/** Is a repo-relative path protected? Exact match, or under a `/` prefix entry. */
export function isProtectedRelPath(rel) {
  if (typeof rel !== 'string' || rel === '') return false;
  const norm = rel.split(path.sep).join('/').replace(/^\.\//, '');
  return PROTECTED_PATHS.some((entry) => (entry.endsWith('/') ? norm.startsWith(entry) : norm === entry));
}

/** Concrete files to hash. A prefix entry contributes whatever exists beneath it. */
export const PROTECTED_FILES = Object.freeze(
  PROTECTED_PATHS.filter((p) => !p.endsWith('/')),
);

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/** Outside the worktree on purpose. See the header for what that does and does not buy. */
/**
 * Keyed by repository AND Claude session id.
 *
 * It used to be the repository path alone, so every concurrent session in one
 * repo shared -- and overwrote -- the same baseline. Two agents in one worktree
 * is the condition this project actually runs in, so that is not a corner case.
 * A missing session id is its own key and is reported, never silently merged.
 */
export function snapshotPath(repoRoot, sessionId, home = process.env.AGENTBRIDGE_HOME || path.join(homedir(), '.agentbridge')) {
  const id = typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId.trim() : 'no-session-id';
  const key = sha(`${path.resolve(repoRoot)}\u0000${id}`).slice(0, 16);
  return path.join(home, 'guard-sessions', `${key}.json`);
}

/** Every test file, RECURSIVELY — `npm test` globs test/**, so a flat readdir runs a different suite. */
export function discoverTests(repoRoot) {
  const root = path.join(repoRoot, 'test');
  const out = [];
  const visit = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries.sort()) {
      const p = path.join(dir, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) visit(p);
      else if (/\.test\.mjs$/i.test(e)) out.push(path.relative(repoRoot, p).split(path.sep).join('/'));
    }
  };
  visit(root);
  return out.sort();
}

function hashFile(abs) {
  try { return sha(readFileSync(abs)); } catch { return null; }
}

export function buildSnapshot(repoRoot) {
  const files = {};
  for (const rel of PROTECTED_FILES) files[rel] = hashFile(path.join(repoRoot, rel));
  const tests = {};
  for (const rel of discoverTests(repoRoot)) tests[rel] = hashFile(path.join(repoRoot, rel));
  return { version: SNAPSHOT_VERSION, repoRoot: path.resolve(repoRoot), at: new Date().toISOString(), files, tests };
}

/**
 * INITIALISE ONCE. A second call for the same session REFUSES.
 *
 * `--session-start` used to overwrite unconditionally, so the reset was the
 * whole bypass: damage a protected file, re-run --session-start, and Stop
 * approves the damaged state as the new baseline. Demonstrated. A baseline that
 * the thing it measures can rewrite is not a baseline.
 */
export function writeSnapshot(repoRoot, sessionId, snapshot = buildSnapshot(repoRoot)) {
  const file = snapshotPath(repoRoot, sessionId);
  if (existsSync(file)) {
    return { ok: false, file, reason: 'a snapshot already exists for this session and may not be replaced' };
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...snapshot, sessionId: sessionId ?? null }, null, 2)}\n`, 'utf8');
  return { ok: true, file };
}

/** null when absent or unusable. The caller must treat null as REFUSE, never as clean. */
export function readSnapshot(repoRoot, sessionId) {
  const file = snapshotPath(repoRoot, sessionId);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || parsed.version !== SNAPSHOT_VERSION || typeof parsed.files !== 'object') return null;
    if (typeof parsed.tests !== 'object' || parsed.tests === null) return null;
    return parsed;
  } catch { return null; }
}

/**
 * Protected files whose CONTENT differs from the session snapshot.
 *
 * Content, not git status, so committing the change does not hide it and a write
 * that bypassed PreToolUse entirely is still visible here.
 */
export function protectedDrift(repoRoot, snapshot) {
  const drift = [];
  for (const rel of PROTECTED_FILES) {
    const before = snapshot.files[rel] ?? null;
    const now = hashFile(path.join(repoRoot, rel));
    if (before !== now) {
      drift.push({ file: rel, was: before ? 'present' : 'absent', now: now ? 'changed' : 'deleted' });
    }
  }
  return drift;
}

/**
 * Baseline tests whose CONTENT changed, or that vanished.
 *
 * snapshot.tests was collected and never compared. A bypass could weaken an
 * inherited test and Stop would run the weakened version and pass it -- the
 * suite grading itself against rules the session had just relaxed. Measured: a
 * weakened baseline test produced zero drift.
 */
export function baselineTestDrift(repoRoot, snapshot) {
  const drift = [];
  for (const [rel, before] of Object.entries(snapshot.tests ?? {})) {
    const now = hashFile(path.join(repoRoot, rel));
    if (before !== now) drift.push({ file: rel, now: now ? 'changed' : 'deleted' });
  }
  return drift;
}

/**
 * Was this test file present when the session began?
 *
 * Baseline tests carry the session's evidence and are protected. A test CREATED
 * during the session is the agent's own new work and stays editable -- the
 * previous rule made every new test immutable the instant it existed, so a typo
 * in a test written sixty seconds ago could not be fixed.
 */
export function isBaselineTest(relPath, snapshot) {
  if (!snapshot || typeof relPath !== 'string') return false;
  return Object.prototype.hasOwnProperty.call(snapshot.tests, relPath.split(path.sep).join('/'));
}
