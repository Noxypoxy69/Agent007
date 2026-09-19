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
  readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, lstatSync, readlinkSync, existsSync,
  realpathSync,
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
  /*
   * THE GUARD'S OWN DEPENDENCIES, WHICH WERE NOT ON THIS LIST.
   *
   * Everything above was added because somebody noticed it. That is an
   * enumeration, and the guard's import closure had drifted past it: computed
   * 2026-09-18 from bin/agentbridge-claude-guard.mjs and
   * scripts/claude-stop-gate.mjs, eight local files were reachable and THREE of
   * them were unprotected --
   *
   *   src/safeGit.mjs         the guard calls runGit; a rewrite changes what the
   *                           guard executes and how it reads the repository
   *   src/auditLedger.mjs     the audit-coverage reporter, which is exactly the
   *                           D5 finding an audit raised earlier the same day:
   *                           one commit disables it and nothing notices
   *   src/actionAuthority.mjs added by the Action Authority wiring hours before
   *                           this line, by me, unprotected
   *
   * A file the guard IMPORTS decides what the guard does. Leaving it writable
   * while protecting the importer is protecting the front door of a building
   * with an open side entrance -- and the guard now FAILS TO LOAD AT ALL if one
   * is missing, so deleting a single unprotected file took the whole control
   * offline (ERR_MODULE_NOT_FOUND, measured).
   *
   * THE LIST IS NOT THE FIX. test/guardDependenciesProtected.test.mjs derives
   * the closure and fails if any member is unprotected, so the next import does
   * not depend on somebody remembering this paragraph.
   */
  'src/safeGit.mjs',
  'src/auditLedger.mjs',
  'src/actionAuthority.mjs',
  /*
   * AND THE DERIVED GATE CAUGHT THE VERY NEXT ONE, which is the point of the
   * paragraph above. src/gitIndexLease.mjs was added as a shellAllowlist import
   * on 2026-09-18 -- by me, unprotected, exactly as actionAuthority was hours
   * earlier -- and test/guardDependenciesProtected.test.mjs named it in the
   * same run that wired it. Nobody had to remember; the closure is computed.
   * It decides whether a commit is refused, so a rewrite of it silently
   * reopens the shared index, and deleting it takes the whole rail offline
   * with ERR_MODULE_NOT_FOUND.
   */
  'src/gitIndexLease.mjs',
  /*
   * `.mcp.json` DEFINES COMMANDS AND WAS NOT PROTECTED.
   *
   * A blind audit raised this from the other end: the Stop gate admitted
   * `enabledMcpjsonServers` and `enableAllProjectMcpServers` as harmless keys in
   * an ignored settings file, and they are not harmless, because the file they
   * turn on is a list of server COMMANDS to spawn and nothing guarded it.
   *
   * THE FIRST FIX WAS THE WRONG END, AND IT WOULD HAVE TAKEN THIS MACHINE DOWN.
   * I refused the two keys. `.claude/settings.local.json` on this machine
   * carries both of them, that file is GITIGNORED so it can never be committed,
   * and the relief branch for an ignored file is "declares nothing dangerous" --
   * so the next time the operator approved a permission mid-turn and Claude Code
   * rewrote that file, the session would have blocked permanently with no
   * recovery available to it. Rule 19's outage, introduced by a fix for a leak,
   * which is the pairing two audits caught on this surface on 2026-09-18.
   *
   * So the key stays admitted and the FILE gets protected. It is tracked, so
   * drift in it is attributable and recoverable by committing -- the property
   * the whole `landed` branch rests on, and the one an ignored file can never
   * have. Rule 8: fix the matcher, not the five strings the prober tried.
   */
  '.mcp.json',
  /*
   * THREE MORE THE CLOSURE GREW, AND THE DERIVED GATE CAUGHT THEM THE SAME DAY.
   *
   * Wiring the §7.1 audit trigger into scripts/claude-stop-gate.mjs made it
   * import src/auditJob.mjs, which imports src/reviewerPacket.mjs, which imports
   * src/resultEnvelope.mjs. Three files entered the guard's import closure and
   * none was protected -- so each was writable with no grant, and since the
   * binary fails to load when one is missing, deleting any of them disables the
   * guard outright.
   *
   * This is the third time that has happened (actionAuthority, gitIndexLease,
   * now these) and the third time nobody had to notice: the closure is COMPUTED
   * by test/guardDependenciesProtected.test.mjs, which named all three in the
   * same run that wired them. The paragraph above is right that the list is not
   * the fix.
   *
   * reviewerPacket in particular decides what a blind reviewer is allowed to
   * see. A session that could rewrite it could hand every future auditor the
   * maker's own account of the work.
   */
  'src/auditJob.mjs',
  'src/reviewerPacket.mjs',
  'src/resultEnvelope.mjs',
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
/*
 * CASE-INSENSITIVE, because the filesystem this runs on is. NTFS resolves
 * `.Claude` and `.CLAUDE` to the same directory, so a junction named
 * `.claude/worktrees/x/.Claude` reaches the same control an inner session boots
 * from -- and without the `i` flag this regex did not match it, so the walk did
 * not record it and PreToolUse did not refuse planting it: an unprivileged,
 * undetected disarm. Found by audit. This is the match-not-enumerate fix (one
 * flag covers every spelling), not a list of cased variants. NOTE the exempt
 * PREFIX check and the PROTECTED_PATHS exact/prefix compares are still
 * case-sensitive; a fully case-folded matcher is a separate, broader change
 * tracked elsewhere and is not smuggled in here.
 */
const NESTED_CONTROL_DIR = /(^|\/)\.claude\//i;

/** Is a repo-relative path protected? Exact match, or under a `/` prefix entry. */
/*
 * THE COMPARE IS CASE-FOLDED, BECAUSE THE FILESYSTEM IS.
 *
 * This was an exact string compare on a platform where .CLAUDE, .Claude and
 * .claude are ONE directory. Measured through the shipped hook binary, all
 * ALLOW while the canonical spelling was denied:
 *
 *   .CLAUDE/settings.json   .Claude/settings.json   SRC/claudeGuard.mjs
 *   src/claudeGuard.MJS     CLAUDE.MD   claude.md   package.JSON
 *
 * These are not lookalikes. Writing .CLAUDE/settings.json modifies
 * .claude/settings.json -- git reports the canonical path as modified -- so one
 * permitted write carrying disableAllHooks removes PreToolUse AND the Stop
 * hook, and the "detected at Stop" fallback that claudeGuard and shellAllowlist
 * delegate to four times never runs. No grant, no metacharacter, one call.
 * realpathSync does not canonicalise case on Windows, so normalizedCandidates
 * produced the same wrong spelling twice and the second candidate never helped.
 *
 * Reported by THREE separate blind audits before it was fixed. code-a closed
 * the nested-control half with a case-insensitive flag; this is the main
 * comparator, which stayed exact.
 *
 * ON CASE-SENSITIVE FILESYSTEMS this over-protects: a genuinely distinct file
 * named src/Policy.mjs becomes unwritable. That is the direction to fail in --
 * refusing a file nobody has is a nuisance, permitting a write to the hook
 * configuration is the end of every layer at once. Folding is not a lookalike
 * list; a spelling nobody enumerated is covered because case folding is a
 * property, not a set.
 */
export function isProtectedRelPath(rel) {
  if (typeof rel !== 'string' || rel === '') return false;
  const norm = rel.split(path.sep).join('/').replace(/^\.\//, '').toLowerCase();
  const exempt = PROTECTION_EXEMPT_PREFIXES.find((p) => norm.startsWith(p.toLowerCase()));
  if (exempt && !NESTED_CONTROL_DIR.test(norm.slice(exempt.length))) return false;
  return PROTECTED_PATHS.some((e) => {
    const entry = e.toLowerCase();
    return entry.endsWith('/') ? norm.startsWith(entry) : norm === entry;
  });
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
   * THE WALK DOES NOT FOLLOW REPARSE POINTS, AND THAT IS THE WHOLE TERMINATION
   * ARGUMENT. Two earlier attempts at this got it wrong; both are recorded here
   * because the wrong answers are more instructive than the right one.
   *
   * ATTEMPT ONE pruned at the exempt directory and never entered a worktree at
   * all. Structurally immune to everything below, and it cost the nested
   * `.claude/` coverage that 436b927 added the matcher half for.
   *
   * ATTEMPT TWO descended and kept a visited set keyed on `realpathSync`,
   * claiming "provable termination: each real directory entered at most once".
   * That claim was FALSE on Windows, measured: realpath preserves the case of
   * whatever spelling it is handed, INCLUDING the case stored inside a
   * junction's target, so one real directory yields many keys. One directory was
   * measured entered 17 times; 64 case-variant junctions cost 81.6s against a
   * true answer of 18 files; a single junction aimed at a large system directory
   * cost 367s, which is 87% of the Stop budget and twelve times the SessionStart
   * budget. That matters more than it sounds: an over-budget hook is CANCELLED,
   * its output discarded, and the turn approved -- so the cost was not an
   * outage, it was a silent allow.
   *
   * Attempt two also pruned directories named `node_modules` and `.git` for
   * cost, before consulting the matcher. `.claude/` is a PREFIX entry, so
   * `.claude/node_modules/**` IS protected, and the prune dropped five
   * matcher-protected paths -- reopening the very parity gap the same commit
   * claimed to close. Its justification reasoned about the literal array entries
   * rather than the prefix expansion the function computes.
   *
   * SO: NO REALPATH, NO VISITED SET, NO NAME PRUNE. `lstatSync` reports a
   * junction or symlink as a link rather than resolving it, and a link is
   * skipped. The walk then covers only real directories of this checkout, which
   * is finite and acyclic, so it terminates for the same reason any tree walk
   * does -- not because of a bound somebody guessed.
   *
   * It closes four things at once: the junction cost, the cycles, the
   * case-identity problem, and a dedup hole where an exempt alias sorting first
   * won the race and a control was hashed under NO name.
   *
   * WHAT SKIPPING LINKS COSTS, stated rather than found later: a symlinked
   * control is not hashed under the link's name. Its TARGET is still hashed
   * under the target's own name if it lives inside the repository, so the bytes
   * are covered; a link pointing OUTSIDE the repository is not this
   * repository's control to hash, which is the same judgement `isProtectedPath`
   * already makes about paths outside the root.
   *
   * KNOWN RESIDUAL, NOT FIXED HERE: with the prune gone, a worktree's
   * `node_modules` is walked even though nothing in it is protected. That is
   * cost, not correctness, and the honest remedy is a budget with a LOUD refusal
   * -- which needs an error channel out of this function and therefore changes
   * both callers. Bolting a silent cap on here would recreate exactly the
   * truncation-that-reports-success shape this file exists to prevent.
   */
  for (const entry of PROTECTED_PATHS) {
    if (!entry.endsWith('/')) { out.add(entry); continue; }
    const base = path.join(repoRoot, entry);
    const visit = (dir) => {
      let entries = [];
      try { entries = readdirSync(dir); } catch { return; }
      for (const e of entries.sort()) {
        const abs = path.join(dir, e);
        /*
         * lstat, NOT stat: stat resolves the link and hands back the target's
         * type, which is how a junction got followed. A link is skipped whatever
         * it points at, so no reparse point is ever entered.
         */
        let st;
        try { st = lstatSync(abs); } catch { continue; }
        const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
        /*
         * A LINK IS NEVER DESCENDED -- that is the termination guarantee, and it
         * holds because NTFS forbids a directory HARDLINK, so every cycle needs a
         * reparse point and no reparse point is ever entered.
         *
         * BUT SKIPPING THE LINK ENTIRELY WAS ITS OWN HOLE, found by audit. Two
         * ways:
         *   - a FILE symlink at a protected path (e.g. `.claude/settings.json` ->
         *     `real.json`) was dropped from the baseline, so an edit to the file
         *     it points at was undetectable. The guard's own switch, invisible.
         *   - a DIRECTORY junction placed AT a protected path (e.g.
         *     `.claude/worktrees/x/.claude` -> attacker-controlled bytes) aliased
         *     the real control away, and nothing recorded that the alias existed.
         *
         * So a link at a protected path is RECORDED, never followed. hashFile is
         * link-aware: for a file link it hashes the bytes it resolves to, for a
         * directory link it hashes the TARGET STRING -- so planting or repointing
         * a junction at a control path shows as drift, while a cycle still cannot
         * be entered. What this does NOT catch is a junction that was ALREADY in
         * place, with its payload already written, when the baseline was minted;
         * that is the mint-over-a-damaged-tree problem, entangled with
         * `.claude/worktrees/` being gitignored, and it is not this walk's to
         * close.
         */
        if (st.isSymbolicLink()) {
          /*
           * TWO CHECKS, BECAUSE THE PRE-PLANT LINK SITS AT AN EXEMPT PATH.
           *
           * `isProtectedRelPath(rel)` catches a FILE link at a protected path
           * (D4). It does NOT catch the D1 junction: it is named `.claude` and
           * lives at `.claude/worktrees/x/.claude`, whose own path is EXEMPT --
           * only its CHILDREN (`.../.claude/settings.json`) match the nested
           * rule, and we cannot see children without descending a link we must
           * not descend. So the second check asks the matcher the container
           * question: would a path INSIDE this directory be a control? The
           * trailing separator exercises NESTED_CONTROL_DIR for the directory
           * itself, which is exactly the junction's disguise. This leans on the
           * matcher's slash handling, and the D1 test below fails if that ever
           * changes -- the reliance is pinned, not assumed.
           */
          if (isProtectedRelPath(rel) || isProtectedRelPath(`${rel}/`)) out.add(rel);
          continue;
        }
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
      /*
       * lstat AND SKIP LINKS, for the same reason protectedFilesIn does, and it
       * is not cosmetic here: this list becomes the argv of the Stop gate's
       * `spawnSync(node, ['--test', ...])`. With `statSync` a junction under
       * `test/` was followed -- two sibling junctions aimed at an ancestor did
       * not terminate (killed at 30s), which hangs the very hook that is
       * supposed to time the suite, and a hook that is killed is a SILENT ALLOW.
       * A junction pointing outside the repository additionally made the gate
       * run outside files as this repository's own suite. `test/` is not a
       * protected prefix, so nothing else refuses writing a link into it. Found
       * by audit; the previous "do not follow reparse points" change fixed the
       * walk and left this second walk thirty lines below it untouched.
       */
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) visit(p);
      else if (/\.test\.mjs$/i.test(e)) out.push(path.relative(repoRoot, p).split(path.sep).join('/'));
    }
  };
  visit(root);
  return out.sort();
}

/*
 * LINK-AWARE, because protectedFilesIn now records a link that sits at a
 * protected path instead of dropping it.
 *
 * A plain file hashes its bytes, exactly as before -- the common case is
 * untouched and pays one extra lstat.
 *
 * A link's content is BOTH where it points and, when it resolves to a file,
 * that file's bytes. A directory link resolves to no bytes, so its target
 * string is its whole identity -- which is what makes planting or repointing a
 * junction at a control path a content change the Stop gate can see. The target
 * is framed with NUL bytes ahead of the body so the two fields cannot be
 * confused by a body that happens to contain the target text, the same framing
 * discipline src/deployGate.mjs uses and for the same reason.
 */
function hashFile(abs) {
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      const target = readlinkSync(abs);
      let body = Buffer.alloc(0);
      try { if (statSync(abs).isFile()) body = readFileSync(abs); } catch { /* dir link or dangling: no body */ }
      return sha(Buffer.concat([Buffer.from(` link ${target} `, 'utf8'), body]));
    }
    return sha(readFileSync(abs));
  } catch { return null; }
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
   * A SESSIONLESS MINT IS REFUSED, BECAUSE IT WOULD SEED THE SHARED KEY.
   *
   * snapshotPath folds a missing or empty session id to the literal
   * 'no-session-id', so minting without one writes a baseline every other
   * sessionless payload would then adopt. readSnapshot now refuses to READ that
   * key; this refuses to WRITE it, so the two sides agree and the shared baseline
   * cannot exist. Fail-closed: a real Claude Code payload always carries
   * session_id, so this only bites the anomalous sessionless case, and the Stop
   * gate's no-snapshot path already handles an ok:false mint by blocking the turn
   * with a readable reason rather than approving it.
   */
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    return {
      ok: false,
      file,
      cause: 'no-session',
      drift: null,
      reason: 'a baseline may not be minted for a request with no session id: a sessionless payload folds to a shared key, which is how one session adopts another session\'s baseline',
    };
  }

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
  /*
   * A MISSING OR EMPTY session id FOLDS TO THE SHARED 'no-session-id' KEY in
   * snapshotPath, so without this a sessionless payload reads whatever baseline
   * was last minted at that shared key -- one session adopting another's, which
   * is fail-open in the function whose whole job is refusing that. Refuse it
   * outright; the caller treats null as REFUSE, never as clean.
   *
   * Proven by composing this clause over the shipped function: the four
   * sessionless ids (undefined, null, '', whitespace) flip from snapshot to null,
   * while a real id, a wrong id and the literal 'no-session-id' already returned
   * null -- so it closes the hole without becoming a blanket deny. The matching
   * mint-side refusal is in writeSnapshot, so a sessionless mint cannot re-seed
   * the shared key either.
   */
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return null;
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
    // sessionId is a non-empty string here -- the guard at the top of this
    // function returns null for every missing/empty id -- so the old
    // `... ? sessionId.trim() : null` ternary's null arm was unreachable dead
    // code (D3 from the null-session audit; a mutation confirmed removing it
    // fails nothing). A dead arm that looks like a check is worse than none,
    // because the next reader counts it as coverage.
    const want = sessionId.trim();
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
/**
 * Is this a control file belonging to an agent worktree rather than to us?
 *
 * `.claude/worktrees/<id>/.claude/...` -- the outer `.claude/worktrees/` prefix
 * is exempt CONTENT, and the nested `.claude/` inside it is re-protected,
 * because pre-planting a hook configuration before an agent boots is a real
 * attack. Both of those remain true. This only identifies the shape.
 */
function isWorktreeNestedControl(rel) {
  if (!rel.startsWith('.claude/worktrees/')) return false;
  return NESTED_CONTROL_DIR.test(rel.slice('.claude/worktrees/'.length));
}

/** The worktree directory a nested control belongs to, or null. */
function worktreeDirOf(repoRoot, rel) {
  const parts = rel.split('/');            // .claude worktrees <id> ...
  if (parts.length < 4) return null;
  return path.join(repoRoot, parts[0], parts[1], parts[2]);
}

/**
 * Does this settings file REDUCE hook enforcement? Fails closed on anything it
 * cannot read.
 *
 * The threat is exact: a settings file that leaves an agent booting with no
 * guard. A file that keeps the guard armed is not that, whoever wrote it.
 */
/*
 * ── THE FIRST VERSION OF THIS DECIDED "ARMED" FROM A SUBSTRING ───────────────
 *
 * A blind audit broke it seven ways, every one measured through the drift
 * function the Stop gate actually calls. It asked only whether two `=== true`
 * comparisons were absent and whether two NAMES appeared anywhere in a command
 * string. It never asked whether the hook would FIRE, FINISH, or be EXECUTED --
 * or whether the file armed anything at all:
 *
 *   {}                                   no hooks key, so "benign" -- an agent
 *                                        boots with NO guard. The no-hooks-key
 *                                        rule was written for settings.local
 *                                        .json and was applied to settings.json.
 *   matcher that never fires             CLAUDE.md rule 17 IS this bug: the
 *                                        guard was correctly named and never
 *                                        consulted, and a session deleted
 *                                        src/claudeGuard.mjs with no refusal.
 *   "command": "echo x # ...guard..."    the name as a SUBSTRING of an echo.
 *   timeout: 0                           an over-budget hook is cancelled, its
 *                                        output discarded, and the turn
 *                                        APPROVED -- a silent allow, which
 *                                        protectedFilesIn's own header says.
 *   type: not "command"                  named, present, never executed.
 *   env: { AGENTBRIDGE_HOME: ... }       not a hook change, so it never drifted
 *                                        -- and this file reads BOTH the
 *                                        snapshot and the GRANT FILE from that
 *                                        variable. An unlimited forged-grant
 *                                        channel, silent at Stop.
 *   permissions.defaultMode bypass       likewise invisible.
 *
 * So the question is no longer "does it weaken" -- a negative check over an
 * open-ended document, which is unbounded by construction. It is "is this
 * recognisably the propagated copy the exemption was written for", which is a
 * positive check over a closed surface. Anything else drifts and the operator
 * looks at it.
 *
 * THE RESIDUAL, STATED: this is an allowlist of KEYS, and a key Claude Code
 * adds later will drift until somebody adds it here. That direction is an
 * operator seeing a diff they did not expect, which is the safe one; the old
 * direction was an agent booting unguarded in silence.
 */
function isPropagatedWorktreeControl(abs, rel) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(abs, 'utf8').replace(/^﻿/, '')); } catch { return false; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;

  /*
   * NOTHING OUTSIDE THIS SET IS EXEMPT. `env` above all: it redirects
   * AGENTBRIDGE_HOME, which is where this module reads the grant file from.
   */
  const ALLOWED_KEYS = new Set(['hooks', 'disableAllHooks', 'permissions',
    'enabledMcpjsonServers', 'enableAllProjectMcpServers']);
  for (const key of Object.keys(parsed)) if (!ALLOWED_KEYS.has(key)) return false;

  // Only an explicit false is acceptable; "true", 1 and absent-but-truthy are not.
  if ('disableAllHooks' in parsed && parsed.disableAllHooks !== false) return false;

  if (parsed.permissions !== undefined) {
    const p = parsed.permissions;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
    if (p.defaultMode !== undefined && p.defaultMode !== 'default') return false;
  }

  const isLocal = /(^|\/)settings\.local\.json$/i.test(rel);
  const { hooks } = parsed;

  if (hooks === undefined) {
    /*
     * A settings.local.json legitimately carries no hooks -- it never armed
     * anything. A settings.json with no hooks is the DISARMED file, and
     * treating the two alike is what let {} through.
     */
    return isLocal;
  }
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false;
  if ('disableAllHooks' in hooks && hooks.disableAllHooks !== false) return false;

  /** A hook entry that will actually run, not merely be mentioned. */
  /*
   * ── "DOES IT CONTAIN THE NAME" WAS STILL A SUBSTRING TEST ─────────────────
   *
   * The previous version required type command, a non-inert prefix and a
   * survivable timeout, and then asked whether the command STRING CONTAINED the
   * guard's name. A blind audit broke that three more ways, each measured
   * through the same drift function the Stop gate calls, each returning EXEMPT:
   *
   *   "exit 0 # ...agentbridge-claude-guard..."   named, inert. The inert test
   *   "true # agentbridge-claude-guard"           was an ENUMERATION of echo,
   *                                               colon, hash and rem -- rule 8
   *                                               again, in the commit that
   *                                               claimed to have fixed it. A
   *                                               PreToolUse hook exiting 0
   *                                               with empty stdout is a SILENT
   *                                               ALLOW.
   *   "node ./decoy/agentbridge-claude-guard.mjs" right name, ATTACKER'S FILE.
   *                                               Any path the session can
   *                                               create with that basename
   *                                               substitutes for the guard.
   *   armed + an extra SessionStart group,        THE WORST: armed() is a
   *   or a second PreToolUse group, or an         .some(). Nothing constrained
   *   extra entry inside the guard's group        what ELSE the file carried,
   *                                               so arbitrary code could be
   *                                               planted into another agent's
   *                                               checkout, silent at Stop.
   *
   * So the question stops being "is the guard mentioned somewhere" and becomes
   * "is EVERY hook in this file one of our own controls, invoked the way the
   * project invokes it". A closed shape, not a search.
   *
   * WHAT THIS COSTS, STATED: if the project changes how it spells a hook
   * command, existing worktree copies drift until they are refreshed. That
   * direction is an operator seeing an unexpected diff. The direction it
   * replaces was arbitrary code execution in a sibling checkout, unreported.
   */
  const CONTROL_COMMAND = new RegExp(
    '^node\\s+"?\\$CLAUDE_PROJECT_DIR/'
    + '(bin/agentbridge-claude-guard\\.mjs|scripts/claude-stop-gate\\.mjs|scripts/bridge-session-poll\\.mjs)'
    + '"?(\\s+--[a-z-]+)*\\s*$',
  );

  const entryRuns = (h, needle) => h
    && h.type === 'command'
    && typeof h.command === 'string'
    && CONTROL_COMMAND.test(h.command.trim())   // the whole command, not a substring
    && h.command.includes(needle)
    && (h.timeout === undefined || (Number.isFinite(h.timeout) && h.timeout >= 5));

  /*
   * EVERY entry of EVERY group of EVERY event must be one of our controls.
   * This is the half that closes the extra-hook class: a file may carry the
   * guard AND anything else, and the previous check only looked for the guard.
   */
  const KNOWN_EVENTS = new Set(['PreToolUse', 'Stop', 'SessionStart', 'SessionEnd']);
  for (const [event, groups] of Object.entries(hooks)) {
    if (event === 'disableAllHooks') continue;
    if (!KNOWN_EVENTS.has(event)) return false;
    if (!Array.isArray(groups)) return false;
    for (const group of groups) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) return false;
      for (const h of group.hooks) {
        if (!h || h.type !== 'command' || typeof h.command !== 'string') return false;
        if (!CONTROL_COMMAND.test(h.command.trim())) return false;
        if (h.timeout !== undefined && !(Number.isFinite(h.timeout) && h.timeout >= 5)) return false;
      }
    }
  }

  const armed = (event, needle, matchesAll) => Array.isArray(hooks[event]) && hooks[event].some(
    (group) => group
      && matchesAll(group.matcher)
      && Array.isArray(group.hooks)
      && group.hooks.some((h) => entryRuns(h, needle)),
  );

  // PreToolUse must cover EVERY tool. Rule 19: a narrower matcher is the bug
  // that let a real session delete the guard's own source.
  const allTools = (m) => m === '*';
  // Stop takes no tool name; the shipped configuration uses the empty matcher.
  const allStops = (m) => m === '' || m === '*' || m === undefined;

  return armed('PreToolUse', 'agentbridge-claude-guard', allTools)
    && armed('Stop', 'claude-stop-gate', allStops);
}

export function protectedDrift(repoRoot, snapshot) {
  const drift = [];
  // The union of "was protected then" and "is protected now", so an ADDED file
  // under a protected prefix is drift and so is a DELETED one.
  const names = new Set([...Object.keys(snapshot.files ?? {}), ...protectedFilesIn(repoRoot)]);
  for (const rel of [...names].sort()) {
    const before = snapshot.files?.[rel] ?? null;
    const now = hashFile(path.join(repoRoot, rel));
    if (before === now) continue;
    const state = now === null ? 'deleted' : (before === null ? 'added' : 'changed');

    /*
     * ── RULE 20 MANDATED A STEP THAT BLOCKED THE SESSION PERFORMING IT ──────
     *
     * Measured 2026-09-18. code-b was stop-blocked with 21 drift lines and
     * ELEVEN were agent worktrees' own `.claude/` directories -- one of them
     * belonging to its own blind audit agent, running at that moment. The
     * harness mints those two files when it creates a worktree-isolated
     * subagent; no agent writes them. So performing the audit the rules require
     * tripped the gate, every turn, with no way back: the gate re-baselines only
     * from a tree git calls clean, and `.claude/worktrees/` is gitignored, so
     * those entries never make the tree dirty and never clear either.
     *
     * WHAT THEY ACTUALLY CONTAIN, read before this was written rather than
     * assumed: a COPY of this repository's own settings.json -- PreToolUse
     * matcher "*" calling the guard, Stop calling the stop gate, SessionStart
     * calling the guard, `disableAllHooks: false` -- plus a copy of
     * settings.local.json. They ARM the guard in the worktree. They are the
     * opposite of the attack the nested-`.claude/` rule exists to stop.
     *
     * SO THE TEST IS WHAT THE FILE SAYS, NOT WHERE IT IS OR WHEN IT APPEARED.
     * A proposal to exempt files "arriving with the directory at creation" was
     * declined: an attacker creating a worktree with a planted settings file
     * inside it is also a file arriving at creation. Timing correlates with the
     * threat today; content IS the threat.
     *
     * AND THIS IS THE STOP GATE ONLY. `isProtectedRelPath` still refuses every
     * WRITE to these paths, so no session can author one through a tool. The
     * attack needs a file that disables hooks, and such a file still drifts
     * here, still blocks the turn, and still cannot be written. What changed is
     * that a worktree whose guard configuration matches ours no longer blocks
     * the session that spawned it.
     */
    if (isWorktreeNestedControl(rel)) {
      /*
       * DELETED IS EXEMPT ONLY WHEN THE WORKTREE ITSELF IS GONE.
       *
       * This read `if (state === 'deleted') continue;` with a comment saying
       * "the worktree went away". The comment described a worktree; the code
       * described ONE FILE. Measured by audit: delete only settings.json and
       * leave the worktree running, and a live agent checkout stripped of its
       * project settings produced ZERO drift. The shipped test could not see it
       * because it only ever deleted the whole directory.
       */
      if (state === 'deleted') {
        const wt = worktreeDirOf(repoRoot, rel);
        if (wt && !existsSync(wt)) continue;   // the whole checkout is gone
        drift.push({ file: rel, now: state });
        continue;
      }
      if (isPropagatedWorktreeControl(path.join(repoRoot, rel), rel)) continue;
    }

    drift.push({ file: rel, now: state });
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
/*
 * THE HORIZON THE readOverride COMMENT BELOW SPECIFIES.
 *
 * That comment was written, argued and left referring to a constant nobody
 * defined, so readOverride threw a ReferenceError on EVERY call: no grant could
 * be read, and because the hook binary converts a throw into a deny, every guard
 * call on the machine was refused. The guard caught its own author mid-edit and
 * failed closed, which is the behaviour de4c1ab added and is exactly right --
 * but it froze both live sessions until somebody finished the line.
 *
 * AUTHORSHIP IS DISPUTED AND THE DEADLOCK WAS NOT. code-a believes this hunk is
 * mine; I have no record of writing it. Neither of us could prove it, and each
 * of us declined to touch the other's half-finished security edit -- correctly,
 * in general, and here it meant nobody would fix a one-line break blocking
 * everyone. Defining the constant the comment already names in words is
 * completing a stated intent, not overriding a design decision. If the hunk's
 * author wants a different horizon, change this number; the reasoning it belongs
 * to is fifteen lines below.
 */
const MAX_GRANT_MS = 30 * 24 * 60 * 60 * 1000;

/*
 * A GRANT IS ABOUT A REPOSITORY, NOT A DIRECTORY.
 *
 * This keyed on sha(path.resolve(repoRoot)), and A WORKTREE IS A DIFFERENT
 * ROOT. Measured on the operator's machine, 2026-09-18, across all 17 roots
 * git knows about:
 *
 *   HAS GRANT  <key A>  <home>/Agent007                 (the main checkout)
 *   NO GRANT   <key B>  <home>/Documents/wt-code-a      (an agent worktree)
 *   NO GRANT   ...15 more agent worktrees, each its own key
 *
 * So every grant the owner has ever written applied to exactly one directory --
 * and it was not the directory the agents were working in. Each agent resolved
 * to a key with no file behind it and ran with NO grant at all, which is why
 * they kept hitting the Stop gate and routing it back to him. Nobody decided
 * that; it is the key naming a directory when the thing being granted is a
 * repository and a set of repo-RELATIVE paths.
 *
 * git rev-parse --git-common-dir is the identity that is actually shared: every
 * worktree of one repository reports the same one. It prints a relative ".git"
 * from the main checkout and an absolute path from a worktree, so it is
 * resolved against the root either way.
 *
 * AND THE SPELLING IS CANONICALISED, because a hash makes every difference
 * total. An 8.3 alias and a case variant are the same directory and hash to
 * different keys -- the same class that let CLAUDE~1/settings.json
 * past isProtectedPath until realpathSync.native was used there. A grant that
 * silently does not apply because cwd was spelled differently is the failure
 * this whole comment is about, arrived at a second way.
 *
 * FALLING BACK IS SAFE IN THE RIGHT DIRECTION. If git cannot answer -- not a
 * repository, git missing, a timeout -- this returns the path for the directory
 * itself. That resolves to a key with no grant file, which means NO GRANT,
 * which is the direction every check in this module already fails in.
 */
function canonicalKeyPath(target) {
  let out = target;
  // realpathSync.native expands 8.3 short names; the non-native one does not.
  try { out = realpathSync.native(out); } catch { /* may not exist yet: use the lexical form */ }
  out = out.split('\\').join('/').replace(/\/+$/, '');
  // NTFS and APFS are case-insensitive; a case variant must not be a new key.
  return process.platform === 'win32' ? out.toLowerCase() : out;
}

/*
 * ONE git ANSWER PER DIRECTORY PER PROCESS.
 *
 * Every guard decision asks git which repository this is, and a single Write
 * payload reaches overrideCovers twice. Measured by audit: this added two
 * synchronous subprocesses and roughly 220 ms to every PreToolUse call, where
 * there had been none. The hook process is short-lived and the answer cannot
 * change inside it, so it is asked once and remembered.
 */
const gitAnswers = new Map();
function gitRevParse(dir, flag) {
  const key = `${flag} ${dir}`;
  if (gitAnswers.has(key)) return gitAnswers.get(key);
  let answer = null;
  try {
    const out = String(runGit(['-C', dir, 'rev-parse', flag], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })).trim();
    if (out) answer = out;
  } catch { /* not a repository, git missing, or a timeout */ }
  gitAnswers.set(key, answer);
  return answer;
}

export function overrideKeySource(repoRoot) {
  const resolved = path.resolve(repoRoot);
  const common = gitRevParse(resolved, '--git-common-dir');
  if (common) return canonicalKeyPath(path.resolve(resolved, common));
  return canonicalKeyPath(resolved);
}

/*
 * A GRANT'S PATHS ARE RELATIVE TO THE REPOSITORY, NOT TO WHEREVER THE SESSION
 * HAPPENS TO BE STANDING.
 *
 * Keying the grant on the repository (which is right) made EVERY SUBDIRECTORY
 * share the repository's key -- not just every worktree. The paths were still
 * being matched against a path relative to the session's cwd, and cwd comes
 * from the hook payload. So one grant naming ".claude/settings.json" became a
 * write permit for <repo>/.claude/settings.json, <repo>/projA/.claude/settings.json,
 * <repo>/projB/... -- several different files the owner named once, and the
 * announcement printed the same relative path for all of them, so a reader of
 * the transcript could not tell which file had been written.
 *
 * Measured by audit: at the parent commit those subdirectory writes were DENIED
 * and at ecd2270 they were ALLOWED. The commit disclosed the widening as "every
 * worktree"; subdirectories are a strictly larger set, and unlike worktrees they
 * change WHICH FILE the grant covers.
 *
 * So a candidate is translated into the repository's own frame before it is
 * matched. If git cannot answer, the old directory-relative behaviour stands --
 * and in that case the key has also fallen back to the directory, so there is
 * almost never a grant there to apply.
 */
/*
 * CANONICAL SPELLING, CASE PRESERVED.
 *
 * Two separate requirements pull against each other here and both are load
 * bearing:
 *
 *  - The spelling must be canonical, because `git rev-parse --show-toplevel`
 *    answers with the LONG path while the session's cwd may be an 8.3 alias.
 *    Comparing those two with path.relative yields ".." and silently falls back
 *    to the cwd-relative answer -- which is the exact over-permission this
 *    function exists to stop. Caught by a test whose temp directory was an 8.3
 *    path, i.e. the ordinary case, not a contrived one.
 *
 *  - The CASE must NOT be folded, unlike the grant KEY. A grant entry is matched
 *    exactly, so folding here would turn src/claudeGuard.mjs into
 *    src/claudeguard.mjs and stop every grant applying.
 */
function canonicalSpelling(target) {
  try { return realpathSync.native(target).split('\\').join('/'); } catch { /* may not exist yet */ }
  try {
    const dir = realpathSync.native(path.dirname(target));
    return path.join(dir, path.basename(target)).split('\\').join('/');
  } catch { return String(target).split('\\').join('/'); }
}

/**
 * The repo-root-relative, canonically-spelled form of a path -- the ONE spelling
 * a grant entry must contain in order to match.
 *
 * EXPORTED BECAUSE THE REFUSAL HAS TO QUOTE IT. overrideCovers canonicalises the
 * candidate and then compares it LITERALLY against grant.paths, so the canonical
 * spelling is the only one that ever matches. The refusal used to quote the path
 * as the caller typed it and say "ask for an override naming this exact path" --
 * so an operator who followed that instruction with TEST/GUARDTOOLROSTER.TEST.MJS
 * or ./test/guardToolRoster.test.mjs wrote a grant that did nothing, and the
 * pressure went back to the session whose hooks never loaded. Measured by audit,
 * in the commit whose stated purpose was to stop naming routes that do not work.
 */
/**
 * The repository root containing this directory, canonically spelled, or null.
 *
 * EXPORTED BECAUSE PROTECTION AND GRANTS HAVE TO JUDGE IN THE SAME FRAME. The
 * grant side already resolved into the repository; isProtectedPath judged
 * relative to the session's cwd and returned false for anything starting with
 * "..". So from a subdirectory the two rails disagreed about one repository:
 *
 *   cwd = <repo>/projA
 *   Write '../.claude/settings.json'  ALLOW    <- the hook configuration
 *   Write '../src/claudeGuard.mjs'    ALLOW
 *   Write '../test/alpha.test.mjs'    DENY     <- baseline tests already resolved
 *
 * That last line is why this is a bug rather than a policy: one rail had the
 * repository frame and the other did not. cwd arrives from the hook payload, and
 * starting a session in a subdirectory is ordinary rather than an attack.
 *
 * Null when git cannot answer, and the caller keeps its cwd-relative judgement
 * in that case -- the direction that judges MORE, never less.
 */
export function repoRootOf(dir) {
  const resolved = path.resolve(dir);
  const top = gitRevParse(resolved, '--show-toplevel');
  return top ? canonicalSpelling(top) : null;
}

export function canonicalGrantPath(dir, rel) {
  return repoRelative(dir, rel);
}

function repoRelative(dir, rel) {
  const resolved = path.resolve(dir);
  const asGiven = String(rel ?? '').split(path.sep).join('/').replace(/^\.\//, '');
  const top = gitRevParse(resolved, '--show-toplevel');
  if (!top) return asGiven;

  const absolute = canonicalSpelling(path.resolve(resolved, asGiven));
  const fromTop = path.relative(canonicalSpelling(top), absolute).split(path.sep).join('/');
  // Outside the repository entirely: keep the original, which will not match a
  // repo-relative grant entry -- the direction that refuses.
  return fromTop === '' || fromTop.startsWith('..') ? asGiven : fromTop;
}

/**
 * Where a per-repository store lives, under one key derivation.
 *
 * ONE KEY, NOT TWO. The grant store is named
 * `sha256(canonical git-common-dir)[0:16]`, and that spelling is load-bearing:
 * for a week nothing printed it and nothing wrote it down, the key was the
 * DIRECTORY rather than the repository, and across 17 roots on one machine
 * exactly one had a grant -- not the one anybody was working in. A grant at the
 * wrong key fails exactly like the guard being strict, which is why it was
 * re-diagnosed three times.
 *
 * So a second store keyed "the same way" by a second copy of that expression is
 * the defect this file already carries a header about. It is computed once here
 * and every store asks for it.
 */
export function repoStorePath(repoRoot, kind, ext,
  home = process.env.AGENTBRIDGE_HOME || path.join(homedir(), '.agentbridge')) {
  const key = sha(overrideKeySource(repoRoot)).slice(0, 16);
  return path.join(home, kind, `${key}${ext}`);
}

export function overridePath(repoRoot, home = process.env.AGENTBRIDGE_HOME || path.join(homedir(), '.agentbridge')) {
  return repoStorePath(repoRoot, 'overrides', '.json', home);
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
  /*
   * A GRANT NAMES PATHS, ACTIONS, OR BOTH -- AND MUST NAME AT LEAST ONE.
   *
   * `paths` was the only kind of thing a grant could cover, because the only
   * thing the guard refused was a write. Action Authority adds a second kind:
   * deny-unless-approved for OWNER-level ACTIONS, which are tool names like
   * mcp__claude_ai_Supabase__apply_migration and have no repo-relative path to
   * name. Danny chose deny-unless-approved over deny-outright on 2026-09-18
   * (d-owner-action-authority-gating-20260918), and that choice is what requires
   * an approval channel to exist at all.
   *
   * ONE FILE, NOT TWO. A second store would mean a second expiry rule, a second
   * shape check and a second thing to forge -- and the hard-won checks below
   * (expires_at must be a STRING, must be finite, must be bounded by
   * MAX_GRANT_MS) would have to be correct twice. They were not correct once
   * until an audit found the coercion hole.
   *
   * AN EMPTY GRANT IS STILL NO GRANT. Requiring at least one of the two keeps
   * the old behaviour for a file with `"paths": []` and refuses a file that
   * names nothing at all, rather than returning a live grant covering nothing --
   * which would announce itself on every permit while permitting none.
   */
  const hasPaths = Array.isArray(parsed.paths) && parsed.paths.length > 0;
  const hasActions = Array.isArray(parsed.actions) && parsed.actions.length > 0;
  if (!hasPaths && !hasActions) return null;
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
  /*
   * AND AN EXPIRY FAR ENOUGH AWAY IS NOT AN EXPIRY AT ALL.
   *
   * `expires <= now` was the only bound, so every well-formed future date
   * passed. Measured 2026-09-18 against efb7990: a grant carrying
   * `+275760-09-13T00:00:00.000Z` -- the largest date Date.parse accepts -- read
   * as LIVE. That is a permanent write permit for the named controls wearing the
   * word "expires", and it needs no exploit to produce: a typo in the year, or a
   * grant written once and never revisited, arrives at the same place.
   *
   * The whole safety argument for this channel is that it is SELF-CLOSING --
   * "narrow, expiring and loud". A bound that any date satisfies closes nothing,
   * so the horizon is stated as a number rather than implied by the format.
   *
   * WHY 30 DAYS. Every grant this repository has actually issued was measured in
   * hours. Thirty days is far beyond real use and still finite, so a forgotten
   * grant dies on its own; refusing is the same direction the checks above
   * already fail in. A repair that genuinely needs longer is a decision somebody
   * should have to make again, which is the point.
   */
  if (expires - now > MAX_GRANT_MS) return null;
  return {
    paths: hasPaths ? parsed.paths.filter((p) => typeof p === 'string' && p !== '') : [],
    actions: hasActions ? parsed.actions.filter((a) => typeof a === 'string' && a !== '') : [],
    reason: parsed.reason,
    granted_by: typeof parsed.granted_by === 'string' ? parsed.granted_by : '(unrecorded)',
    expires_at: new Date(expires).toISOString(),
  };
}

/**
 * Does an active grant approve this ACTION? Exact tool names only, no globs.
 *
 * THE EXACTNESS IS THE WHOLE CONTROL, and it is the same argument the path side
 * already makes. A prefix or a glob here is not a convenience, it is a different
 * permission: `mcp__claude_ai_Supabase__*` reads as "approve the migration I am
 * about to run" and means "approve every Supabase action for the life of the
 * grant, including the ones nobody has thought of yet". The owner approves acts,
 * not namespaces.
 *
 * WHY IT DOES NOT FALL BACK TO THE PATH LIST. A grant naming
 * `.claude/settings.json` says the owner agreed to a FILE being repaired. It
 * does not say they agreed to a production migration, and quietly letting one
 * list satisfy the other is how a narrow permission becomes a broad one without
 * anybody deciding. The two lists are separate because the two decisions are.
 */
export function actionApproved(repoRoot, toolName, now = Date.now()) {
  if (typeof toolName !== 'string' || toolName === '') return null;
  const grant = readOverride(repoRoot, now);
  /*
   * "*" HERE TOO, FOR THE SAME REASON AND WITH THE SAME LIMIT. An owner who has
   * granted every path and then has to enumerate every tool name has not been
   * given full access, they have been given a second list to maintain -- and
   * the tool roster changes underneath them, so the list is stale the day a
   * connector is added. One exact token, not a pattern language.
   *
   * It does not widen what an approved action may TOUCH: claudeGuard still runs
   * the protected-path check for an approved action, and a wildcard grant does
   * not reach the gate's own configuration.
   */
  if (!grant) return null;
  if (!grant.actions.includes('*') && !grant.actions.includes(toolName)) return null;
  return grant;
}

/** Does an active grant name this repo-relative path? Exact paths only, no globs. */
/*
 * THE TWO PATHS A GRANT CANNOT COVER, AND WHY BOTH LAYERS MUST AGREE ON THEM.
 *
 * The Stop gate refuses to let an override suppress drift in its own hook
 * configuration: an override is a decision to permit a REPAIR, and it cannot
 * also be a decision to let the repaired file dictate how long the gate may
 * look. That reasoning is sound and unchanged.
 *
 * It lived in scripts/claude-stop-gate.mjs alone, so PreToolUse did not know
 * about it -- and the refusal for these paths told the operator to ask for an
 * override, which PreToolUse then honoured and Stop then refused. The grant was
 * spent, the file was modified, and the turn died: "a permission that cannot be
 * spent, which is worse than no permission because it looks like one", quoting
 * the gate's own source back at itself. Found by blind audit.
 *
 * Exported here so there is ONE list. Two lists of one thing drift the moment
 * somebody edits one, which src/policy.mjs carries a header about.
 */
export const GATE_SELF_CONFIG = Object.freeze(['.claude/settings.json', '.claude/settings.local.json']);

/** Is this repo-relative path one a grant can never cover? */
export function isGateSelfConfig(rel) {
  const norm = String(rel ?? '').split(path.sep).join('/').replace(/^\.\//, '').toLowerCase();
  return GATE_SELF_CONFIG.some((p) => p.toLowerCase() === norm);
}

/**
 * Does this settings file still ARM every control, read from the file itself?
 *
 * ═══ WHY THIS EXISTS: A CORRECT RULE WITH AN UNRECOVERABLE CONSEQUENCE ═══
 *
 * The Stop gate excludes its own configuration from BOTH reliefs -- grants and
 * committed work -- and the reasoning is right: `.claude/settings.json` decides
 * whether the guard runs at all, so "I committed it" must not be a stronger
 * permission than an override, and an override must not let the repaired file
 * dictate how long the gate may look. Neither of those should change.
 *
 * THE CONSEQUENCE NOBODY COSTED. A session's snapshot is minted once and may
 * never be re-minted -- deliberately, because a session that re-baselines a
 * damaged tree adopts the damage. So when ANOTHER session legitimately commits
 * a settings change, every already-running session is blocked on drift it did
 * not cause, against a file that matches HEAD, with no recovery but restarting
 * and losing its context. Measured here across most of a working session: the
 * commit added two poll hooks and removed nothing, leaving the file strictly
 * MORE armed than the snapshot, and the gate refused every turn regardless.
 *
 * ATTRIBUTION IS THE WRONG QUESTION, WHICH IS WHY THE EXCLUSION IS RIGHT. That
 * a change was committed says who made it, not whether it disarmed anything. So
 * this asks the other question directly, of the artefact: are the controls still
 * there and still enabled? A file that answers yes has not disarmed the gate --
 * whoever wrote it, however it got there.
 *
 * IT IS ONLY HALF A PERMISSION, and the caller must supply the other half. This
 * says "armed"; the Stop gate additionally requires the working file to MATCH
 * HEAD before it relieves anything. Together those close the attack the
 * exclusion was built for, and each alone does not:
 *
 *   armed but uncommitted  -- could be this session's own unrecorded edit, and
 *                             "armed" does not mean "harmless"; an ADDED hook
 *                             runs too. Still blocks.
 *   committed but disarmed -- exactly the "commit it" bypass. Still blocks,
 *                             because this returns false.
 *
 * AND MATCHING HEAD SUBSUMES THE TIMEOUT ATTACK the gate's own header records:
 * a granted edit once chose a Stop timeout of 99999 and the gate did not block.
 * A file identical to HEAD carries HEAD's timeout, so inflating it requires a
 * commit that changes HEAD -- which is a diff a reader can see, not a silent
 * local edit.
 *
 * PURE, and takes the TEXT rather than a path, so the suite can watch it fail
 * without a filesystem -- rule 10. Malformed JSON is NOT armed: a settings file
 * nobody can parse is one Claude Code cannot load either.
 *
 * @param {string} text  the settings file's contents
 * @returns {{armed: boolean, missing: string[]}}
 */
export function gateConfigArms(text) {
  const missing = [];
  let cfg;
  try {
    cfg = JSON.parse(String(text ?? ''));
  } catch {
    return { armed: false, missing: ['the file is not readable JSON'] };
  }
  if (!cfg || typeof cfg !== 'object') return { armed: false, missing: ['no settings object'] };

  /*
   * `disableAllHooks` TURNS EVERYTHING OFF IN ONE FIELD, so it is checked first
   * and on its own. A config can name every hook correctly and still run none
   * of them.
   */
  if (cfg.disableAllHooks === true) missing.push('disableAllHooks is true');

  const commandsFor = (event) => {
    const entries = Array.isArray(cfg?.hooks?.[event]) ? cfg.hooks[event] : [];
    const out = [];
    for (const e of entries) {
      for (const h of Array.isArray(e?.hooks) ? e.hooks : []) {
        if (typeof h?.command === 'string') out.push({ command: h.command, matcher: e?.matcher });
      }
    }
    return out;
  };

  /*
   * MATCHED ON THE SCRIPT THE HOOK RUNS, not on a spelling of the whole command
   * line. The command is quoted, carries an interpolated project directory and
   * may gain flags; pinning the literal string would refuse every legitimate
   * edit and teach people to route around this. Rule 19 -- the property is
   * "this event still reaches that program".
   */
  /*
   * THE SCRIPT MUST BE THE THING BEING RUN, NOT A SUBSTRING OF THE LINE.
   *
   * This was `h.command.includes(script)`, and every one of these read as ARMED
   * while running no control at all:
   *
   *   echo skipping scripts/claude-stop-gate.mjs
   *   # node "$CLAUDE_PROJECT_DIR/bin/agentbridge-claude-guard.mjs"
   *   node "$CLAUDE_PROJECT_DIR/tmp/claude-stop-gate.mjs"      <- a different file
   *
   * CLAUDE.md rule 13, committed inside the check written to catch disarms, and
   * defended in my own header as "route on the shape". A substring is not a
   * shape. Found by blind audit.
   *
   * So: the line must start with node (after any leading whitespace), and the
   * script must appear as a PATH SEGMENT under the repo's own directories --
   * `bin/` or `scripts/` -- rather than anywhere in the string. A leading `#`
   * or another program fails the first test; a relocated copy fails the second.
   *
   * STILL NOT A PROOF THAT IT EXECUTES, and that residual is named rather than
   * implied: this reads a declaration, not a process. A command that reaches
   * node and the right path can still be neutered by a wrapper this cannot see.
   * What it now refuses is the class where the string is present and nothing
   * runs, which is what was measured.
   */
  const invokes = (command, script) => {
    const cmd = String(command ?? '').trim();
    if (!/^node(\.exe)?\b/i.test(cmd) && !/^"[^"]*node(\.exe)?"/i.test(cmd)) return false;
    return new RegExp(`[/\\\\](bin|scripts)[/\\\\]${script.replace(/\./g, '\\.')}(["'\\s]|$)`)
      .test(cmd);
  };
  const runs = (event, script) => commandsFor(event).some((h) => invokes(h.command, script));

  if (!runs('PreToolUse', 'agentbridge-claude-guard.mjs')) {
    missing.push('PreToolUse no longer runs the guard');
  } else {
    /*
     * A MATCHER THAT IS NOT `*` IS A DISARM WEARING A CONFIGURATION. This is
     * the measured 2026-09-17 incident: the matcher listed tool NAMES, Windows
     * sessions run shell through a PowerShell tool that was not on the list,
     * and a real session deleted the guard's own source with no refusal from
     * anywhere. The guard's unit tests were green throughout.
     */
    /*
     * `*`, `""` AND OMITTED ARE ALL MATCH-ALL, and demanding `*` alone was an
     * over-block I shipped. Claude Code's hooks reference lists all three as
     * "Match all" -- and this repository's own settings.json uses `""` for
     * Stop, SessionStart and SessionEnd. So a perfectly armed config committed
     * with `""` on the guard entry would have been called a DISARM: relief
     * refused, every session with an older snapshot Stop-blocked with no
     * recovery but a restart, and a false alarm printed saying the gate was no
     * longer armed. That is the exact deadlock this whole change exists to end,
     * re-armed on a wrong premise. Found by blind audit.
     *
     * THE MATCHER AND THE COMMAND MUST BE THE SAME HOOK ENTRY. `.some()` across
     * all entries let a decoy satisfy it: a match-all entry running a commented
     * string, plus a real guard entry scoped to `Read`, and the guard then runs
     * for Read alone. That is the 2026-09-17 shape this check exists to catch --
     * the matcher listed tool names, PowerShell was not among them, and a
     * session deleted the guard's own source with no refusal from anywhere.
     */
    const matchAll = (m) => m === '*' || m === '' || m === undefined || m === null;
    const wild = commandsFor('PreToolUse')
      .some((h) => invokes(h.command, 'agentbridge-claude-guard.mjs') && matchAll(h.matcher));
    if (!wild) {
      missing.push('no PreToolUse entry both runs the guard and matches all tools, '
        + 'so some tools bypass it');
    }
  }

  if (!runs('Stop', 'claude-stop-gate.mjs')) missing.push('Stop no longer runs the stop gate');
  if (!runs('SessionStart', 'agentbridge-claude-guard.mjs')) {
    missing.push('SessionStart no longer mints a snapshot');
  }

  return { armed: missing.length === 0, missing };
}

/**
 * Does an IGNORED settings file declare anything that could take a control away?
 *
 * ═══ WHY THIS IS NOT A LIST OF SAFE KEY NAMES ANY MORE ═══
 *
 * It was one: seven names, admitted, everything else refused. Blind audit,
 * 2026-09-19: Claude Code documents on the order of 145 top-level settings keys,
 * so the operator flipping ANY ordinary one in /config -- a theme, a verbosity,
 * an update preference -- wrote a key this did not recognise into
 * `.claude/settings.local.json`, which is GITIGNORED and therefore can never be
 * committed, and the session blocked with no recovery at all.
 *
 * That is CLAUDE.md rule 19 exactly, in the direction the rule says is worse:
 * "allowing by known name leaks; denying by unknown name is an outage; and an
 * outage gets the hook switched off, which loses every layer at once." The
 * first attempt at the shell rail default-DENIED 25 of a real 54-tool roster and
 * had to be rewritten for the same reason.
 *
 * SO IT ASKS ABOUT THE VALUE, WHICH IS A PROPERTY OF THE OPERATION, RATHER THAN
 * ABOUT THE KEY, WHICH IS A PROPERTY OF THE VOCABULARY. A settings file takes a
 * control away in exactly two ways: it names something to RUN, or it turns a
 * control off. Both are visible in the shape.
 *
 *   NEVER_ADDITIVE   keys that carry an executable or disable a control no
 *                    matter what they contain. Named, because their danger is
 *                    not visible in the value -- `disableAllHooks: true` is a
 *                    boolean.
 *   inert subtree    any other key is admitted only if nothing anywhere under
 *                    it looks like a command or a path. `theme: "dark"` and
 *                    `cleanupPeriodDays: 20` pass; a statusLine running
 *                    `node ~/x.mjs` does not.
 *
 * THIS IS STRICTLY NARROWER THAN WHAT IT REPLACES, which is the only reason it
 * can ship without its own outage: every key the old list admitted is still
 * admitted except the two named below, and keys it refused are now admitted only
 * when their values are inert.
 *
 * ═══ THE MCP KEYS: THE AUDIT WAS RIGHT AND MY FIRST FIX WAS THE WRONG END ═══
 *
 * The same audit found that `enabledMcpjsonServers` and
 * `enableAllProjectMcpServers` were admitted as harmless, and they were not:
 * `.mcp.json` was NOT a protected path and it DEFINES COMMANDS, so admitting the
 * key that turns it on granted execution through an unguarded file.
 *
 * I refused the two keys, and that would have taken this machine down.
 * `.claude/settings.local.json` here carries BOTH of them; it is gitignored, so
 * it can never be committed; so the next time Claude Code rewrote it -- which it
 * does whenever the operator approves a permission mid-turn -- the session would
 * have blocked permanently with no recovery. An outage introduced by a fix for a
 * leak, on the surface where that pairing has already happened twice.
 *
 * `.mcp.json` IS PROTECTED NOW INSTEAD, in PROTECTED_PATHS, where the reasoning
 * is written out. It is tracked, so drift in it is attributable and recoverable
 * by committing -- which is the property an ignored file can never have, and the
 * reason moving the fix to that end costs nothing. Rule 8: fix the matcher, not
 * the strings. The keys stay admitted.
 *
 * ═══ AND THE ONE THAT STAYS FOR A DIFFERENT REASON ═══
 *
 * `permissions` is admitted. Claude Code writes it into settings.local.json
 * when the operator approves a permission mid-turn, so refusing it would block
 * every session in which the owner said yes to anything -- and that specific
 * file's unrecoverability is a hole this gate already shipped once. Broadening
 * `permissions.allow` genuinely does weaken; it is admitted anyway because the
 * alternative is the outage, and that trade is written down here rather than
 * left as an unexplained name on a list.
 *
 * FAILS CLOSED on anything unreadable, unparseable or not an object.
 *
 * @param {string} text  the settings file's contents
 * @returns {{addsOnly:boolean, weakens:string[]}}  weakens names dotted paths
 */
const NEVER_ADDITIVE = Object.freeze([
  'hooks',                        // runs commands; the whole point of the guard
  'env',                          // AGENTBRIDGE_HOME redirects the grant store itself
  'disableAllHooks',              // turns every layer off in one boolean
  'statusLine',                   // carries a command
  'apiKeyHelper',                 // carries a command
  'awsAuthRefresh',               // carries a command
  'awsCredentialExport',          // carries a command
  'otelHeadersHelper',            // carries a command
  'gcpAuthRefresh',               // carries a command -- MISSED, see NAMES_AN_EXECUTABLE
  'processWrapper',               // wraps every process this session spawns
  'policyHelper',                 // runs a helper executable
  'enabledPlugins',               // a plugin carries hooks; enabling one arms them
  'pluginConfigs',                // the same, one level down
  // NOT enabledMcpjsonServers / enableAllProjectMcpServers -- see the header.
  // .mcp.json is protected instead, which closes the hole without the outage.
]);

/*
 * ═══ AND THE LIST ABOVE IS A LIST, WHICH IS WHY IT MISSED THREE ═══
 *
 * A blind audit generated payloads from the real 145-key settings reference and
 * found `gcpAuthRefresh` admitted -- the direct twin of `awsAuthRefresh` and
 * `awsCredentialExport`, which were both on the list. Also `processWrapper`
 * ("Run through launcher") and `policyHelper` ("Run helper executable"). Adding
 * those three by name fixes the three it measured and nothing else, which is
 * CLAUDE.md rule 8 in the direction the rule warns about: fix the matcher, not
 * the strings the prober happened to try.
 *
 * So the names are ALSO asked as a shape. Claude Code's settings vocabulary is
 * consistent about this: a key that runs something is named for it -- Helper,
 * Wrapper, Refresh, Export, Command, Script, Exec. A key added next release
 * following that convention is covered on the day it ships, with nobody
 * remembering to extend anything.
 *
 * The explicit list stays because not every dangerous key follows the
 * convention (`hooks`, `env`), and because a name somebody can read beats a
 * regex somebody has to decode.
 */
const NAMES_AN_EXECUTABLE = /(?:helper|wrapper|refresh|export|command|script|exec)$/i;

/*
 * ═══ AND A CONTROL TURNED OFF BY A BOOLEAN IS INVISIBLE TO A VALUE TEST ═══
 *
 * The design sentence said a settings file takes a control away in exactly two
 * ways -- it names something to RUN, or it turns a control off -- and that both
 * are visible in the shape. Only the first was. The audit measured THIRTEEN
 * control-off keys admitted, every one of them a boolean or an emptied array:
 *
 *   sandbox.enabled:false            skipDangerousModePermissionPrompt:true
 *   allowManagedHooksOnly:false      skipAutoPermissionPrompt:true
 *   respectGitignore:false           allowAllClaudeAiMcps:true
 *   blockedMarketplaces:[]           strictKnownMarketplaces:[]
 *   allowedMcpServers:[]             permissions.defaultMode:'bypassPermissions'
 *
 * NEVER_ADDITIVE carried exactly ONE boolean control-off key against a roster of
 * 145. So this asks the second question the sentence promised, and asks it as a
 * shape over the key name for the same reason as above: skip-, disable-,
 * bypass-, allowAll-, and anything named Dangerous, are how this vocabulary
 * spells "turn a protection off".
 */
/*
 * A key phrased as a PERMISSION or a REQUIREMENT loosens when it is false or
 * emptied; one phrased as a SUPPRESSION loosens when it is true. Reading the
 * direction from the name is what lets one rule cover `skipX: true` and
 * `allowManagedHooksOnly: false` without refusing `skipX: false`, which is a
 * settings file explicitly turning nothing off -- the safest kind there is.
 */
const RESTRICTIVE_KEY = /^(?:allow|strict|trusted|require|respect|enforce|block)/i;
/*
 * `allowAll` AND `enableAll` READ AS RESTRICTIVE AND ARE THE OPPOSITE, so they
 * are matched FIRST. `allowManagedHooksOnly: false` loosens; `allowAllClaudeAiMcps:
 * true` also loosens, and the same prefix carries both. The "All" is the tell,
 * and reading the direction off `allow` alone got this backwards on the first
 * run -- caught by the corpus the audit supplied, not by me.
 */
const PERMIT_EVERYTHING_KEY = /^(?:allowAll|enableAll|trustAll)/i;
/*
 * AND A DOUBLE NEGATIVE: `disableBypassPermissionsMode` DISABLES A DANGER, so it
 * is a RESTRICTION and `false` is what loosens it. `disableAllHooks` disables a
 * protection and `true` is what loosens that. Same prefix, opposite direction,
 * decided by whether the thing being disabled is itself dangerous.
 *
 * Narrow on purpose: it does not catch `skipDangerousModePermissionPrompt`,
 * where the object is a PROMPT -- a protection -- and `true` loosens correctly.
 * The prefix set is the tell, not the word "dangerous" alone.
 */
const DISABLES_A_DANGER = /^(?:disable|block|prevent)\w*(?:bypass|dangerous|unsafe)/i;
const SUPPRESSIVE_KEY = /^(?:skip|disable|bypass|unsafe|ignore|omit)|dangerous/i;

/** A value that reads as "no protection", wherever it appears. */
const PERMISSIVE_VALUE = /^(?:bypass|dangerous|none|off|never|acceptEdits|plan)/i;

/**
 * Does this key/value pair take a protection away?
 *
 * APPLIED TO EVERY KEY, NOT ONLY TO KEYS THAT LOOK LIKE CONTROLS. `sandbox`,
 * `permissions` and `enabledPlugins` are ordinary nouns, and the thing that
 * disarms them sits one level in -- `{"sandbox":{"enabled":false}}` was measured
 * admitted. A name-keyed rule cannot see that, which is the same reason the
 * value test could not see a boolean: each rule was blind to exactly what the
 * other was looking at.
 */
function loosens(key, value, depth = 0) {
  if (depth > 6) return false;                       // malformed or hostile nesting

  if (typeof value === 'boolean') {
    if (PERMIT_EVERYTHING_KEY.test(key)) return value === true;
    if (DISABLES_A_DANGER.test(key)) return value === false;
    if (RESTRICTIVE_KEY.test(key)) return value === false;
    if (SUPPRESSIVE_KEY.test(key)) return value === true;
    if (/^enabled$/i.test(key)) return value === false;   // sandbox.enabled, etc.
    return false;
  }
  if (typeof value === 'string') {
    return (/mode$/i.test(key) || SUPPRESSIVE_KEY.test(key)) && PERMISSIVE_VALUE.test(value.trim());
  }
  if (Array.isArray(value)) {
    /*
     * AN EMPTIED DENYLIST PERMITS EVERYTHING IT EXISTED TO RESTRICT, and an
     * emptied allowlist is the same move spelled the other way -- both were
     * measured admitted (blockedMarketplaces:[], allowedMcpServers:[]).
     */
    if (RESTRICTIVE_KEY.test(key) && value.length === 0) return true;
    return value.some((v) => loosens(key, v, depth + 1));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([k, v]) => loosens(k, v, depth + 1));
  }
  return false;
}

/**
 * Could this string name something to execute?
 *
 * DELIBERATELY BROAD, and the cost of a false positive is bounded: one extra key
 * named in a refusal the operator can act on. The cost of a false NEGATIVE is a
 * command running out of a file nobody can diff.
 *
 * NOT CALLED `looksExecutable`, WHICH IS WHAT I FIRST CALLED IT, AND THE NAME
 * ALONE BROKE A RATCHET. `src/coordination.mjs` exports a `looksExecutable` that
 * is genuinely test-only debt. `classifyExports` decides production use by
 * matching the NAME across every file under src/bin/bridge/mcp/scripts, not by
 * resolving the binding -- so a private helper here, in a file that export has
 * never been imported into, made it read as wired and the test-only floor fell
 * 80 -> 79. The gate caught it ("both baselines are honest", failing LOW) and
 * the tempting fix was to lower the constant, which would have written off a
 * real orphan as called. A distinct name keeps the count measuring what it
 * claims to.
 */
function namesSomethingRunnable(s) {
  if (typeof s !== 'string' || s === '') return false;
  if (/[/\\]/.test(s)) return true;                      // any path separator
  /*
   * PARENTHESES AND BRACES ARE NOT ON THIS LIST, and putting them there was an
   * over-block the audit's corpus caught: `language: "Portugues (Brasil)"` is
   * prose, and a settings file carrying it could never be committed to clear the
   * drift. Substitution still refuses -- `$(...)` on the `$`, backticks on the
   * backtick -- so nothing executable is admitted by dropping them.
   */
  if (/[$`|&;><*]/.test(s)) return true;                 // shell metacharacters
  if (/\.(mjs|cjs|js|ts|sh|bash|ps1|bat|cmd|exe|py|rb|pl)$/i.test(s)) return true;

  /*
   * ═══ "CONTAINS A SPACE" WAS HERE AND IT WAS AN UNRECOVERABLE OVER-BLOCK ═══
   *
   * The claim this shipped with -- "STRICTLY NARROWER than what it replaces, so
   * it cannot introduce its own outage" -- was FALSE, and a blind audit
   * falsified it with realistic values, all in a GITIGNORED file:
   *
   *     outputStyle: "Table First"          <- admitted UNCONDITIONALLY before
   *     language: "Portugues (Brasil)"
   *     model: "arn:aws:...inference-profile/..."
   *     autoMemoryDirectory: "~/notes"
   *
   * Any value carrying a space refused, which is a large share of the
   * reference's string-valued keys. And the cost is not an annoyance: the file
   * is gitignored, so it can never be committed, so the drift can never be
   * relieved, and the auditor traced the recovery path to a human deleting the
   * file at a terminal. Rule 19: an outage gets the hook switched off, which
   * loses every layer at once.
   *
   * A SPACE IS NOT A COMMAND. `node x.mjs` is caught by the extension rule and
   * by the separator rule; `sudo rm -rf` is caught by the separator in its
   * argument. What a bare space adds over those is prose -- which is most of
   * what these keys actually hold.
   *
   * What a space DOES indicate is a command WITH ARGUMENTS, so the first token
   * is checked against the same executable shapes rather than the whole string.
   * That keeps `git push --force` refused and lets `Table First` through.
   */
  const first = s.trim().split(/\s+/)[0];
  if (first !== s && first !== '') {
    if (/[/\\]/.test(first)) return true;
    if (/\.(mjs|cjs|js|ts|sh|bash|ps1|bat|cmd|exe|py|rb|pl)$/i.test(first)) return true;
    if (KNOWN_INTERPRETERS.has(first.toLowerCase())) return true;
  }
  return false;
}

/*
 * Bare command names that take arguments, so `<name> <something>` is a command
 * rather than prose. An ENUMERATION, named as one: it cannot be complete, and it
 * is not load-bearing on its own -- anything with a path, an extension or a
 * metacharacter is already refused above, and a key NAMED for an executable is
 * refused whatever it contains.
 */
const KNOWN_INTERPRETERS = new Set([
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'deno', 'bun',
  'python', 'python3', 'py', 'ruby', 'perl', 'php',
  'sh', 'bash', 'zsh', 'dash', 'powershell', 'pwsh', 'cmd',
  'sudo', 'doas', 'env', 'nohup', 'xargs', 'eval', 'exec',
  'git', 'curl', 'wget', 'ssh', 'scp', 'docker', 'make',
  'gcloud', 'aws', 'az', 'kubectl',
]);

/**
 * Does a never-additive key appear anywhere under this value?
 *
 * Used for the `permissions` exemption, which skips the executable-string test
 * because its entries ARE command strings. Skipping the whole walk would have
 * made `permissions` a place to hide a `hooks` or `env` declaration -- a
 * carve-out that swallows the thing it was carved out of, which is precisely how
 * the worktree exemption opened seven payloads on 2026-09-18.
 */
function subtreeHasControlKey(v) {
  if (Array.isArray(v)) return v.some(subtreeHasControlKey);
  if (v && typeof v === 'object') {
    return Object.entries(v).some(([k, val]) => (
      NEVER_ADDITIVE.includes(k) || subtreeHasControlKey(val)
    ));
  }
  return false;
}

/** Is everything under this value inert? Walks arrays and objects to the leaves. */
function subtreeIsInert(v) {
  if (v === null || typeof v === 'boolean' || typeof v === 'number') return true;
  if (typeof v === 'string') return !namesSomethingRunnable(v);
  if (Array.isArray(v)) return v.every(subtreeIsInert);
  if (typeof v === 'object') {
    return Object.entries(v).every(([k, val]) => (
      !NEVER_ADDITIVE.includes(k) && subtreeIsInert(val)
    ));
  }
  return false;   // undefined, a function, anything unexpected: not inert
}

export function settingsAddsOnly(text) {
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch {
    return { addsOnly: false, weakens: ['the file could not be parsed, and an unreadable config is not a safe one'] };
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { addsOnly: false, weakens: ['the file is not a settings object'] };
  }

  const weakens = [];
  for (const [key, value] of Object.entries(cfg)) {
    if (NEVER_ADDITIVE.includes(key)) {
      weakens.push(`${key} (runs a command or turns a control off, whatever it contains)`);
      continue;
    }
    if (NAMES_AN_EXECUTABLE.test(key)) {
      weakens.push(`${key} (its name says it runs something, whatever it contains)`);
      continue;
    }
    /*
     * ALREADY DECIDED, AND THE SHAPE RULES MUST NOT RE-OPEN IT.
     *
     * `enableAllProjectMcpServers` matches `^enableAll`, so the new
     * permit-everything rule refused it -- and the live
     * `.claude/settings.local.json` on the operator machine carries it. That is
     * the unrecoverable over-block this whole change exists to remove,
     * reintroduced by the fix for the under-block, on the very file the audit
     * used as its example. Caught by "THE MEASURED FIXTURE", which is there
     * precisely because a fixture that is a shape the system really produces is
     * the only one that can fail for the real case.
     *
     * The decision stands where the header made it: these two are admitted, and
     * `.mcp.json` -- the file they enable, which is tracked and therefore
     * recoverable -- is protected instead.
     */
    if (key === 'enabledMcpjsonServers' || key === 'enableAllProjectMcpServers') continue;

    if (loosens(key, value)) {
      weakens.push(`${key} (turns a protection off; a boolean or an emptied list is invisible to a value test)`);
      continue;
    }
    if (key === 'permissions') {
      /*
       * EXEMPT FROM THE EXECUTABLE-STRING TEST ONLY, and that is now two
       * separate exclusions rather than one.
       *
       * `permissions.allow` entries ARE command strings by their nature, which
       * is the whole reason for the carve-out. `permissions.defaultMode:
       * "bypassPermissions"` is not a command and is not an allow entry -- it is
       * the permission system being switched off -- and the audit measured it
       * admitted straight through this branch. The header's stated trade covers
       * "broadening permissions.allow" and nothing else; this is the rest.
       */
      if (subtreeHasControlKey(value)) {
        weakens.push('permissions (a control-bearing key is hiding inside the one exemption)');
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        const off = Object.entries(value)
          .filter(([k]) => k !== 'allow' && k !== 'deny' && k !== 'ask' && k !== 'additionalDirectories')
          .filter(([k, v]) => loosens(k, v));
        if (off.length) {
          weakens.push(`permissions.${off.map(([k]) => k).join(', permissions.')} `
            + '(the carve-out covers allow/deny entries, not switching the permission system off)');
        }
      }
      continue;
    }
    if (!subtreeIsInert(value)) {
      weakens.push(`${key} (its value names something that looks executable)`);
    }
  }
  return { addsOnly: weakens.length === 0, weakens };
}

/**
 * Turn the Stop gate's self-config alarms into a headline that MATCHES THEM.
 *
 * A HEADLINE THAT CONTRADICTS ITS OWN EVIDENCE, found by blind audit. The gate
 * collected two different findings into one list and printed one sentence over
 * both:
 *
 *   disarmed        `gateConfigArms` read the file and a control is genuinely
 *                   gone. "NO LONGER ARMS IT" is exactly right.
 *   unattributable  an IGNORED settings file declares a key that could weaken
 *                   something. The file may still arm every control perfectly;
 *                   what is wrong is that it is not in git, so nobody can read,
 *                   diff or revert what it says.
 *
 * The second printed the first's sentence. So the gate asserted a control was
 * off while the lines beneath it said nothing of the kind -- and a reader who
 * checks finds the config armed, concludes the gate is crying wolf, and learns
 * to skip it. That is CLAUDE.md rule 16 arriving by a different road: a control
 * nobody believes is a control nobody has.
 *
 * Both together get both sentences, in severity order, because collapsing them
 * would reintroduce the same defect pointing the other way.
 *
 * PURE, and separated from the printing for the reason rule 10 gives: the Stop
 * gate runs its work at import, so nothing inside it can be exercised by the
 * suite. This can.
 *
 * @param {Array<{kind?:string, line?:string}|string>} alarms
 * @returns {string} '' when there is nothing to say
 */
export function selfConfigHeadline(alarms) {
  const list = Array.isArray(alarms) ? alarms : [];
  const entries = list
    .map((a) => (typeof a === 'string' ? { kind: 'disarmed', line: a } : a))
    .filter((a) => a && typeof a === 'object' && typeof a.line === 'string' && a.line.trim() !== '');
  if (entries.length === 0) return '';

  const of = (kind) => entries.filter((a) => a.kind === kind);
  /*
   * AN UNRECOGNISED KIND IS REPORTED, NOT DROPPED. A future caller pushing a
   * third kind would otherwise have its finding silently vanish from the
   * headline while still blocking the turn -- a refusal with no stated reason,
   * which is the hardest kind to act on.
   */
  const known = new Set(['disarmed', 'unattributable']);
  const other = entries.filter((a) => !known.has(a.kind));

  const parts = [];
  if (of('disarmed').length) {
    parts.push('AND THE GATE\'S OWN CONFIGURATION NO LONGER ARMS IT, which is why committing it '
      + `bought nothing:\n${of('disarmed').map((a) => a.line).join('\n')}`);
  }
  if (of('unattributable').length) {
    parts.push('AND THE GATE\'S OWN CONFIGURATION IS NOT IN GIT, so what it declares cannot be '
      + `read, diffed or reverted by anyone else:\n${of('unattributable').map((a) => a.line).join('\n')}`);
  }
  if (other.length) {
    parts.push('AND THE GATE\'S OWN CONFIGURATION WAS FAULTED FOR A REASON THIS MESSAGE DOES NOT '
      + `RECOGNISE:\n${other.map((a) => a.line).join('\n')}`);
  }
  return `\n${parts.join('\n')}`;
}

export function overrideCovers(repoRoot, rel, now = Date.now()) {
  const grant = readOverride(repoRoot, now);
  if (!grant) return null;
  const norm = repoRelative(repoRoot, rel);
  /*
   * EXACT MATCH, NOT A PREFIX -- AND ONE DELIBERATE EXCEPTION THE OWNER ASKED
   * FOR REPEATEDLY.
   *
   * The reasoning above is still right for ordinary grants: a grant for `src/`
   * is a general off switch wearing a path, and naming paths matters because
   * somebody had to name them. That argument assumes MANY NARROW ACTORS, each
   * needing a few files for a task.
   *
   * That is not this machine. There are THREE generalist agents who each work
   * across the whole repository, and Danny's words on 2026-09-18 after asking
   * roughly ten times: "Then we have idle agents there's only 3 of you, I can't
   * make 200 agents so they can all have small access." Under a
   * no-globs-ever rule, the only expressible full grant is an enumeration of
   * every protected path plus every test file -- which nobody writes by hand,
   * so what actually got written was a four-path grant that left the work
   * blocked. The rule did not produce least privilege; it produced idle agents
   * and an owner doing their jobs for them.
   *
   * SO "*" IS ACCEPTED, AND ONLY AS THE WHOLE ENTRY. Not a prefix, not
   * `src/*`, not a pattern language -- one exact token that means what it
   * plainly says, so nobody has to reason about what a glob covers. Every other
   * protection on this channel is unchanged and still applies to it: a reason
   * is required, an expiry is required and is bounded by MAX_GRANT_MS, a
   * malformed grant is NO grant, and every permit announces itself with the
   * grantor, the expiry and the reason.
   *
   * WHAT "*" STILL CANNOT DO, which is the reason this is safe enough to offer:
   * it does not reach .claude/settings.json or .claude/settings.local.json. The
   * Stop gate refuses an override for its own hook configuration regardless of
   * what a grant says -- see GATE_SELF_CONFIG -- so the one file that decides
   * whether the guard runs at all is outside this and stays outside it. A
   * wildcard grant is broad; it is not an off switch.
   *
   * AND THAT SENTENCE IS WEAKER THAN IT SOUNDS, SO HERE IS THE HONEST VERSION.
   * A blind audit measured it end to end: a wildcard permits writing
   * src/claudeGuard.mjs, and one parseable edit later .claude/settings.json is
   * ALLOW with no notice at all -- the Stop gate classifies that drift as
   * granted rather than blocking, because overrideCovers now answers yes. So
   * refusing the two JSON files while permitting the module they configure buys
   * ONE TURN of delay, not containment.
   *
   * That is not a defect in this code: test/wildcardGrant.test.mjs asserts a
   * wildcard MUST cover src/claudeGuard.mjs, and that is the owner's decision,
   * taken deliberately after asking about ten times. The defect was the CLAIM.
   * The next reader of "the one hard limit" would take it for a containment
   * property, and it is a speed bump.
   *
   * STATED PROPERLY: a wildcard grant is full write access to the guard,
   * announced once. GATE_SELF_CONFIG stops the most direct spelling and delays
   * the rest by a turn. Rule 4 -- .claude/settings.json is a PROXY for "the
   * guard runs", and guarding the proxy is not guarding the property.
   *
   * SEPARATELY AND WORSE, and pre-existing rather than introduced here: the
   * USER-scope hook configuration at ~/.claude/settings.json carries hooks and
   * disableAllHooks, applies to every project on the machine, and is writable
   * with NO grant at all -- PROTECTED_PATHS and GATE_SELF_CONFIG are both
   * repo-relative. Measured identical before and after this change. That is the
   * route that needs no wildcard, and it is in front of the owner.
   */
  if (grant.paths.includes('*') && !isGateSelfConfig(norm)) return grant;
  return grant.paths.includes(norm) ? grant : null;
}
