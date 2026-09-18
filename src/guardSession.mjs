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
import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, realpathSync,
} from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { runGit } from './safeGit.mjs';

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
  'src/policy.mjs',
  'src/verifier.mjs',
  'bin/agentbridge-claude-guard.mjs',
  'scripts/claude-stop-gate.mjs',
  'test/claudeGuard.test.mjs',
  'docs/CLAUDE_GUARD_PROVENANCE.md',
  'docs/ROADMAP.md',
  'docs/ORDER.md',
  'THIRD_PARTY_CODE.md',
]);

/*
 * CARVED OUT OF `.claude/`, AND THE CARVE-OUT IS NARROW ON PURPOSE.
 *
 * Claude Code puts agent worktrees at `.claude/worktrees/<id>/`. That is a
 * SEPARATE GIT CHECKOUT that happens to sit inside this one, and the `.claude/`
 * prefix swallowed all of it: every file of every worktree read as a protected
 * control of THIS repository. Two consequences, both measured 2026-09-18.
 *
 * Every audit trips the gate. Rule 20 requires an independent auditor working in
 * its own checkout, so the guard was refusing the process the rules mandate --
 * and a control that blocks the documented workflow is the outage shape rule 17
 * is about.
 *
 * And protectedFilesIn walks prefixes, so a baseline would hash EVERY FILE OF
 * EVERY WORKTREE on every session start: a whole second checkout, per snapshot,
 * for files that are not this repository's controls at all.
 *
 * WHY THIS DOES NOT OPEN A HOLE. A worktree's own `.claude/settings.json` is not
 * this session's hook configuration -- this session reads the one at ITS repo
 * root, which stays protected. A session rooted INSIDE a worktree computes
 * paths relative to its own root, where `.claude/settings.json` is protected
 * again by the same rule. The exemption is for the path as seen from the OUTER
 * repository, where those files genuinely are somebody else's checkout.
 *
 * It is a prefix, not a glob, and it names one directory. Anything else under
 * `.claude/` remains protected.
 */
const PROTECTION_EXEMPT_PREFIXES = Object.freeze(['.claude/worktrees/']);

/*
 * AND THE EXEMPTION STOPS AT A NESTED `.claude/`, WHICH THE FIRST VERSION GOT
 * WRONG AND ARGUED ITSELF OUT OF.
 *
 * That version said a worktree's own .claude/settings.json is "ITS session's to
 * protect, relative to ITS root". True once a session is running there, and
 * irrelevant before one is: an OUTER session can write
 * `.claude/worktrees/<id>/.claude/settings.json` carrying
 * {"hooks":{"disableAllHooks":true}} BEFORE any agent starts in that worktree,
 * and the agent then boots with no guard at all. Nothing protects it in the
 * meantime, so there is no later moment at which the inner session's own
 * protection gets a chance to apply.
 *
 * The original safety argument covered the inner direction and the lookalike
 * directories and did not cover this one. Found by review, not by me.
 *
 * So: worktree CONTENT stays exempt -- a checkout legitimately differs from the
 * outer tree and that was the whole point -- but a `.claude/` directory ANYWHERE
 * inside a worktree is protected again. That is the directory that decides
 * whether a guard runs, and pre-planting it is the whole attack.
 */
const NESTED_CONTROL_DIR = /(^|\/)\.claude\//;

/** Is a repo-relative path protected? Exact match, or under a `/` prefix entry. */
export function isProtectedRelPath(rel) {
  if (typeof rel !== 'string' || rel === '') return false;
  const norm = rel.split(path.sep).join('/').replace(/^\.\//, '');
  const exempt = PROTECTION_EXEMPT_PREFIXES.find((p) => norm.startsWith(p));
  if (exempt && !NESTED_CONTROL_DIR.test(norm.slice(exempt.length))) return false;
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
  /*
   * TERMINATION, AND IT IS NOT OPTIONAL NOW THAT THE WALK DESCENDS WORKTREES.
   *
   * The walk used to prune at an exempt directory and never enter a second
   * checkout, which made it structurally immune to whatever lived in there.
   * Consulting the matcher removed that immunity, and a directory junction is
   * ordinary on Windows -- no elevation needed, and pnpm and `npm link` create
   * them routinely. Measured on a fixture: ONE junction under the worktrees
   * directory walked 255 entries to depth 191 and stopped only because Windows
   * raised ELOOP at its reparse limit, which is the operating system halting it
   * rather than this code. TWO sibling junctions gave branching factor two to
   * that depth and did not terminate at all -- killed at 60s, then at 600s.
   *
   * buildSnapshot and protectedDrift both call this, so that is every
   * SessionStart and every Stop hanging, on a gate whose whole budget is 420s.
   * A guard that hangs is a guard somebody switches off, which loses every
   * layer at once -- rule 19, arrived at the expensive way.
   *
   * The visited set is keyed on REALPATH, so a cycle closes the first time it
   * revisits a real directory. That gives provable termination rather than a
   * bound somebody guessed: the set of real directories is finite and each is
   * entered at most once. A depth cap was the obvious alternative and is worse,
   * because a cap silently truncates coverage and looks identical to a clean
   * sweep -- the shape this whole file exists to avoid.
   *
   * ONE ACCEPTED CONSEQUENCE, stated rather than discovered later: if a real
   * directory is reachable by two protected spellings, only the first is
   * recorded. The bytes are identical either way, so nothing goes unhashed;
   * what is lost is the second NAME for it.
   */
  const seenDirs = new Set();
  for (const entry of PROTECTED_PATHS) {
    if (!entry.endsWith('/')) { out.add(entry); continue; }
    const base = path.join(repoRoot, entry);
    const visit = (dir) => {
      /*
       * Resolved BEFORE the read, so a junction pointing at an ancestor is
       * caught on entry rather than after it has already listed the directory.
       * An unresolvable path is not walked: unknown is not clean, and it cannot
       * be proven acyclic.
       */
      let real;
      try { real = realpathSync(dir); } catch { return; }
      if (seenDirs.has(real)) return;
      seenDirs.add(real);
      let entries = [];
      try { entries = readdirSync(dir); } catch { return; }
      for (const e of entries.sort()) {
        /*
         * PRUNED BY NAME, which is the remedy the previous comment named for
         * slowness and which is now load-bearing for cost rather than for
         * correctness -- the visited set is what guarantees termination. No
         * entry in PROTECTED_PATHS lives under either of these, so pruning them
         * cannot lose coverage; that is asserted by the LOST=0 check rather
         * than assumed.
         */
        if (e === 'node_modules' || e === '.git') continue;
        const abs = path.join(dir, e);
        let st;
        try { st = statSync(abs); } catch { continue; }
        const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
        /*
         * THE WALK CONSULTS THE MATCHER RATHER THAN CARRYING ITS OWN RULE.
         *
         * It used to skip an exempt directory outright and then add every file
         * beneath a walked prefix unconditionally -- a SECOND definition of
         * "protected", living in the walk, which is the duplication this file's
         * header is about. The two definitions then diverged: 436b927 taught the
         * matcher that a `.claude/` directory ANYWHERE inside a worktree is a
         * control again, and the walk was not taught the same thing.
         *
         * Measured on a fixture before this change: three paths were
         * matcher=true / walk=false, all of them a nested `.claude/` inside an
         * agent worktree. PreToolUse refused a direct write to them while the
         * Stop gate held no hash for them at all, so a change arriving by any
         * route that bypasses PreToolUse -- an MCP write, `npm test` executing
         * repository JavaScript, a git operation -- was undetectable. Prevention
         * without detection, on the files that decide whether a guard runs.
         *
         * THE COST IS REAL AND WAS MEASURED, NOT ESTIMATED. Descending means
         * walking each agent worktree: 18 files in 0.3ms became 23 files in
         * 211ms on the operator's repo, 5049 entries across 626 directories,
         * with 0 paths LOST from the previous result. That zero is the evidence
         * that "under a walked prefix" and isProtectedRelPath agree everywhere
         * outside the exemption, which is what makes the swap safe rather than
         * merely stricter. Danny took the trade explicitly.
         *
         * IF THIS EVER GETS SLOW, PRUNE BY NAME -- `node_modules`, `.git` -- and
         * do NOT restore the blanket skip. The skip is what produced the gap.
         */
        if (st.isDirectory()) visit(abs);
        else if (isProtectedRelPath(rel)) out.add(rel);
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

  /*
   * NEVER MINT A BASELINE FROM A TREE THAT ALREADY DIFFERS. THIS CHECK LIVES
   * HERE, IN THE MINTING FUNCTION, AND NOT IN A CALLER.
   *
   * It used to live only in the Stop gate's recovery path, and the exclusive
   * create below carried a comment claiming it closed the reset bypass:
   * "Initialise once; a second call says so." That is true and it is not
   * enough. The snapshot path is keyed on sha256(repoRoot, sessionId), so a
   * NEW session is a new key, EEXIST never fires, and the whole bypass is
   * available again to anyone who starts another session.
   *
   * Measured end to end, 2026-09-17, six steps in a throwaway repository:
   * session A baselines a clean tree; .claude/settings.json is edited to
   * disable hooks; A's Stop gate blocks correctly; A cannot re-baseline
   * (EEXIST does its job); session B baselines the SAME damaged tree without
   * complaint; B's Stop gate returns {} -- approval. The damage had become the
   * baseline. The defence existed, was correct, and sat in the path almost
   * nobody takes, while the path every session takes had none.
   *
   * So the refusal belongs to the act of minting, not to whoever remembers to
   * ask. Both existing callers inherit it and so does the next one.
   *
   * THIS IS NOT ONE GATE'S PROBLEM, which is why it is worth this much comment.
   * src/shellAllowlist.mjs defers to the Stop gate in terms -- "THE BOUNDARY IS
   * NOT HERE" -- and src/claudeGuard.mjs defers to it twice more: every mcp__
   * tool and every tool it cannot classify are not blocked at the door but
   * "detected at Stop by protected-file drift". Three layers, one destination,
   * and the destination could be re-based. (Observation owed to the independent
   * fix on fix/stop-gate-rebaseline, which reached the same conclusion from the
   * other end.)
   *
   * WHAT IT STILL DOES NOT COVER, stated because a fix that overstates its reach
   * is exactly how the previous one got believed: git compares the working tree
   * against HEAD, so damage that has been COMMITTED reads as clean and can still
   * be adopted as a baseline. Closing that needs an authority outside the
   * writable checkout. Reviewing the commit is what catches it today.
   */
  const gitDrift = baselineBlockingDriftFromGit(repoRoot);
  if (gitDrift === null) {
    /* Unknown is not clean. A tree git cannot describe is one this function
     * cannot certify, and certifying it is the whole failure mode. */
    return {
      ok: false,
      file,
      cause: 'unmeasurable',
      drift: null,
      reason: 'git could not be consulted to check the protected files, so a baseline taken now would record an unverified state as normal',
    };
  }
  if (gitDrift.length) {
    return {
      ok: false,
      file,
      cause: 'dirty',
      drift: gitDrift,
      reason: 'files the baseline would cover already differ from git, so a baseline taken now would adopt that state as normal',
    };
  }

  mkdirSync(path.dirname(file), { recursive: true });
  try {
    /*
     * ATOMIC EXCLUSIVE CREATE. existsSync-then-write is a check-then-act race:
     * two SessionStart hooks in the same instant both see no file and both
     * write, and the loser's baseline wins. 'wx' fails if the path exists, so
     * the filesystem decides. 0600 because a baseline another user can edit is
     * not a baseline.
     *
     * THIS CLOSES THE SAME-SESSION REPLACEMENT AND NOTHING WIDER. The key
     * includes the session id, so it says nothing at all about a different
     * session looking at the same damaged tree. The check above is what covers
     * that, and this comment used to imply it was covered here.
     */
    writeFileSync(file, `${JSON.stringify({ ...snapshot, sessionId: sessionId ?? null }, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e?.code === 'EEXIST') {
      return { ok: false, file, cause: 'exists', drift: null, reason: 'a snapshot already exists for this session and may not be replaced' };
    }
    return { ok: false, file, cause: 'unwritable', drift: null, reason: `snapshot could not be written: ${e?.message ?? e}` };
  }
  return { ok: true, file, cause: null, drift: null };
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
    out = runGit(['status', '--porcelain', '--untracked-files=all'], {
      cwd: repoRoot, timeout: 20000,
    });
    /*
     * `git status` intentionally trusts index hints. A tracked file marked
     * assume-unchanged (`h`) or skip-worktree (`S`) can differ on disk while
     * status reports a clean tree. Recovery may never mint a baseline while a
     * protected file/test is hidden behind either bit.
     */
    indexFlags = runGit(['ls-files', '-v'], { cwd: repoRoot, timeout: 20000 });
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

/*
 * THE OVERRIDE CHANNEL, AND WHY IT HAD TO EXIST.
 *
 * Measured 2026-09-18: EVERY guarded session is refused on src/guardSession.mjs
 * and src/shellAllowlist.mjs with protected-control. So the only parties that
 * could repair the guard were the operator's own terminal and sessions where
 * the hook had never loaded -- and the second of those is a BUG being used as a
 * permission. Four guard commits landed that way tonight because nothing was
 * watching the session that made them. A control that can only be fixed by
 * evading it teaches everyone to evade it.
 *
 * THE GRANT LIVES OUTSIDE THE CHECKOUT, for the same reason the snapshot does:
 * anything inside the worktree is writable by the thing being measured. It sits
 * beside the snapshots under AGENTBRIDGE_HOME.
 *
 * WHAT THIS DOES NOT CLAIM. A session can write outside the repository -- paths
 * outside the root are explicitly "not ours to judge" -- so an agent COULD forge
 * one of these. That is exactly as true of the baseline snapshots this file
 * already relies on, and the honest posture is the one the header takes: real
 * containment is a disposable workspace, not a file permission. What the design
 * buys is that an override is NARROW, EXPIRING and LOUD -- scoped to named
 * paths, dead after its expiry, and reported on every decision it permits. A
 * forged grant does not vanish into a clean run; it appears in the record as an
 * override nobody granted, which is a question somebody can ask.
 */
export function overridePath(repoRoot, home = process.env.AGENTBRIDGE_HOME || path.join(homedir(), '.agentbridge')) {
  const key = sha(path.resolve(repoRoot)).slice(0, 16);
  return path.join(home, 'overrides', `${key}.json`);
}

/**
 * The active override for this repo, or null. Never throws: an unreadable or
 * malformed grant is NO grant, because a parse error must not open the gate.
 */
export function readOverride(repoRoot, now = Date.now()) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(overridePath(repoRoot), 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (!Array.isArray(parsed.paths) || parsed.paths.length === 0) return null;
  if (typeof parsed.reason !== 'string' || parsed.reason.trim() === '') return null;
  /*
   * expires_at MUST BE A STRING, AND THE CHECK IS LOAD-BEARING RATHER THAN
   * TIDINESS. The comment above promises "never throws", the try/catch covers
   * only readFileSync and JSON.parse, and Date.parse coerces its argument -- so
   * `{"expires_at":{"toString":1}}` threw a TypeError straight out of this
   * function, through overrideCovers and judgeWrite, out of the hook binary,
   * which then exited 1 with empty stdout. Claude Code reads that as
   * NON-BLOCKING and lets the tool through. A malformed grant did not fail
   * closed; it disabled the guard, and it did not have to name the file it was
   * unlocking. Found by audit, 2026-09-18, one commit after I shipped it.
   *
   * An array also coerced: ["2099-01-01"] parsed as a valid future expiry.
   */
  if (typeof parsed.expires_at !== 'string') return null;
  const expires = Date.parse(parsed.expires_at);
  if (!Number.isFinite(expires)) return null;
  /*
   * NO EXPIRY IS NOT A LONG EXPIRY. A grant without a usable timestamp is
   * refused rather than treated as permanent, which is the direction a
   * forgotten override should fail in.
   */
  if (expires <= now) return null;
  return {
    paths: parsed.paths.filter((p) => typeof p === 'string' && p !== ''),
    reason: parsed.reason,
    granted_by: typeof parsed.granted_by === 'string' ? parsed.granted_by : '(unrecorded)',
    expires_at: new Date(expires).toISOString(),
  };
}

/** Does an active grant name this repo-relative path? Exact paths only, no globs. */
export function overrideCovers(repoRoot, rel, now = Date.now()) {
  const grant = readOverride(repoRoot, now);
  if (!grant) return null;
  const norm = String(rel ?? '').split(path.sep).join('/').replace(/^\.\//, '');
  /*
   * EXACT MATCH, NOT A PREFIX. A grant for `src/` would be a general off switch
   * wearing a path, and the point of naming paths is that somebody had to name
   * them. Listing four files is cheap; a wildcard is how this becomes permanent.
   */
  return grant.paths.includes(norm) ? grant : null;
}
