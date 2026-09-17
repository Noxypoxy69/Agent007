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
import { execFileSync } from 'node:child_process';

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

/**
 * Concrete files to hash, WITH PREFIX ENTRIES EXPANDED.
 *
 * This was `PROTECTED_PATHS.filter((p) => !p.endsWith('/'))`, which silently
 * dropped every prefix -- so `.claude/` was protected at PreToolUse and ABSENT
 * from the Stop snapshot, recreating the exact two-layer gap the single
 * definition was introduced to close. A regression I wrote while claiming to fix
 * the thing it reintroduced.
 *
 * Expansion is a function of the tree, not a constant, because a file ADDED
 * under a protected prefix during a session must count as drift too. Deletions
 * fall out of the same comparison: a path in the snapshot with no hash now.
 */
export function protectedFilesIn(repoRoot) {
  const out = new Set();
  for (const entry of PROTECTED_PATHS) {
    if (!entry.endsWith('/')) { out.add(entry); continue; }
    const base = path.join(repoRoot, entry);
    const visit = (dir) => {
      let entries = [];
      try { entries = readdirSync(dir); } catch { return; }
      for (const e of entries.sort()) {
        const abs = path.join(dir, e);
        let st;
        try { st = statSync(abs); } catch { continue; }
        if (st.isDirectory()) visit(abs);
        else out.add(path.relative(repoRoot, abs).split(path.sep).join('/'));
      }
    };
    visit(base);
  }
  return [...out].sort();
}

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
  for (const rel of protectedFilesIn(repoRoot)) files[rel] = hashFile(path.join(repoRoot, rel));
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
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    /*
     * ATOMIC EXCLUSIVE CREATE. existsSync-then-write is a check-then-act race:
     * two SessionStart hooks in the same instant both see no file and both
     * write, and the loser's baseline wins. 'wx' fails if the path exists, so
     * the filesystem decides. 0600 because a baseline another user can edit is
     * not a baseline.
     */
    writeFileSync(file, `${JSON.stringify({ ...snapshot, sessionId: sessionId ?? null }, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e?.code === 'EEXIST') {
      return { ok: false, file, reason: 'a snapshot already exists for this session and may not be replaced' };
    }
    return { ok: false, file, reason: `snapshot could not be written: ${e?.message ?? e}` };
  }
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
    /*
     * THE SNAPSHOT MUST BE THIS REPOSITORY'S AND THIS SESSION'S. The filename is
     * a hash of both, but a file is just a file: validating the contents means a
     * snapshot moved, copied or hand-edited to a different key is refused rather
     * than adopted as somebody else's baseline.
     */
    if (path.resolve(parsed.repoRoot ?? '') !== path.resolve(repoRoot)) return null;
    const want = typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId.trim() : null;
    if ((parsed.sessionId ?? null) !== want) return null;
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
  // The union of "was protected then" and "is protected now", so an ADDED file
  // under a protected prefix is drift and so is a DELETED one.
  const names = new Set([...Object.keys(snapshot.files ?? {}), ...protectedFilesIn(repoRoot)]);
  for (const rel of [...names].sort()) {
    const before = snapshot.files?.[rel] ?? null;
    const now = hashFile(path.join(repoRoot, rel));
    if (before !== now) {
      drift.push({
        file: rel,
        now: now === null ? 'deleted' : (before === null ? 'added' : 'changed'),
      });
    }
  }
  return drift;
}

/**
 * Drift measured against git for a session that has NO snapshot: the protected
 * paths AND the baseline tests, which are what a snapshot would have covered.
 *
 * WHY THIS EXISTS. A session whose SessionStart never ran -- because it began
 * before the hook was wired, or outside the repo -- has no baseline, and the Stop
 * gate refuses on a missing baseline because an absent one is not a clean one.
 * That was correct and it BRICKED those sessions: they cannot write their own
 * baseline (only --session-start does) and they cannot run that command either
 * (`node` is allowlisted only with --test). Block, retry, block, forever, with no
 * recovery path from inside. Observed on the operator's machine 2026-09-17.
 *
 * So the gate needs a second opinion that does not depend on a snapshot, and git
 * is one: the protected files are all tracked, so git already knows whether they
 * differ from HEAD.
 *
 * ASKS GIT RATHER THAN COMPARING BYTES, DELIBERATELY. Hashing the working file
 * against `git show HEAD:path` reports every file as drifted on a checkout with
 * core.autocrlf=true, which is the operator's. That would have turned a recovery
 * path into a second outage. `git status` applies the repo's own eol and
 * .gitattributes rules, so it answers the question actually being asked.
 *
 * COVERS BASELINE TESTS AS WELL AS PROTECTED PATHS, and the first version did
 * not. A snapshot records every test file, but only test/claudeGuard.test.mjs is
 * a PROTECTED path -- so checking protected paths alone let a session weaken any
 * other test, mint a baseline from a tree this function called clean, and have
 * the weakened test recorded as normal. That is the reset bypass rebuilt through
 * a different door, and it was measured, not theorised.
 *
 * Returns null when git cannot answer -- NOT an empty array. A caller must treat
 * "could not measure" as unknown, never as clean.
 */
export function baselineBlockingDriftFromGit(repoRoot) {
  let out;
  let indexFlags;
  try {
    out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: repoRoot, encoding: 'utf8', timeout: 20000, windowsHide: true,
    });
    /*
     * `git status` intentionally trusts index hints. A tracked file marked
     * assume-unchanged (`h`) or skip-worktree (`S`) can differ on disk while
     * status reports a clean tree. Recovery may never mint a baseline while a
     * protected file/test is hidden behind either bit.
     */
    indexFlags = execFileSync('git', ['ls-files', '-v'], {
      cwd: repoRoot, encoding: 'utf8', timeout: 20000, windowsHide: true,
    });
  } catch {
    return null;
  }
  const drift = [];
  for (const line of indexFlags.split('\n')) {
    if (line.length < 3) continue;
    const flag = line[0];
    /*
     * ANY LOWERCASE TAG MEANS ASSUME-UNCHANGED, NOT JUST `h`.
     *
     * `git ls-files -v` prints the file's tag -- H cached, S skip-worktree,
     * M unmerged, R removed, C modified, K to-be-killed -- and LOWERCASES it when
     * assume-unchanged is set. A file carrying BOTH bits therefore prints `s`,
     * which a check for exactly 'h' and 'S' walks straight past. Measured: with
     * both bits set, `git status --porcelain` was empty and this function
     * returned [], so recovery would have minted a baseline over a tampered
     * protected file -- the bypass this check exists to close, reopened by
     * setting one additional bit.
     */
    const assumeUnchanged = flag >= 'a' && flag <= 'z';
    const skipWorktree = flag === 'S' || flag === 's';
    if (!assumeUnchanged && !skipWorktree) continue;
    const norm = line.slice(2).split(path.sep).join('/');
    const kind = isProtectedRelPath(norm) ? 'protected'
      : (/^test\/.+\.test\.mjs$/i.test(norm) ? 'baseline-test' : null);
    const how = [
      assumeUnchanged ? 'assume-unchanged' : null,
      skipWorktree ? 'skip-worktree' : null,
    ].filter(Boolean).join('+');
    if (kind) drift.push({ file: norm, now: how, kind });
  }
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue;
    const status = line.slice(0, 2);
    /* Renames read "R  old -> new"; both sides matter. */
    const paths = line.slice(3).split(' -> ').map((p) => p.trim().replace(/^"|"$/g, ''));
    for (const rel of paths) {
      if (rel === '') continue;
      const norm = rel.split(path.sep).join('/');
      const kind = isProtectedRelPath(norm) ? 'protected'
        : (/^test\/.+\.test\.mjs$/i.test(norm) ? 'baseline-test' : null);
      if (kind) drift.push({ file: norm, now: status.trim(), kind });
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
