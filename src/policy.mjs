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
  'src/policy.mjs',
  'src/verifier.mjs',
  /*
   * THE GUARD'S OWN DEPENDENCIES. Kept identical to guardSession.mjs, which
   * carries the full reasoning: a file the guard IMPORTS decides what the guard
   * does, and the import closure had drifted past both of these hand-maintained
   * lists. src/verifier.mjs reads THIS copy, so a path missing here is a real
   * difference in what the verifier protects.
   *
   * test/protectedPathParity.test.mjs is what catches a one-sided edit -- and it
   * caught this one: the three entries went into guardSession.mjs first and the
   * suite went red on the next run.
   */
  'src/safeGit.mjs',
  'src/auditLedger.mjs',
  'src/actionAuthority.mjs',
  // The shared-index commit check, imported by src/shellAllowlist.mjs. Added
  // 2026-09-18, and the parity gate above caught this side too -- it went into
  // guardSession.mjs first and the suite went red on the next run, which is the
  // second time that sentence has been written in this file about this list.
  'src/gitIndexLease.mjs',
  // `.mcp.json` defines server COMMANDS to spawn and was unprotected. Full
  // reasoning in guardSession.mjs, including why the fix went here rather than
  // refusing the settings key that enables it -- that route was an outage with
  // no recovery. Added 2026-09-19; put in BOTH lists in the same edit, which is
  // the third time this file's own comments ask for.
  '.mcp.json',
  // The §7.1 trigger pulled these into the guard's import closure:
  // claude-stop-gate -> auditJob -> reviewerPacket -> resultEnvelope. Full
  // reasoning in guardSession.mjs. Added to BOTH lists in one edit, which is
  // the fourth time this file's comments ask for that.
  'src/auditJob.mjs',
  'src/reviewerPacket.mjs',
  'src/resultEnvelope.mjs',
  /* Added with guardSession's copy: the parity gate refuses a one-sided edit,
   * which is the whole reason two lists are survivable. */
  'src/auditQueueStore.mjs',
  /*
   * THE SessionStart/SessionEnd HOOK, which .claude/settings.json wires to
   * node and which nothing protected. Raised as a lead by the audit of
   * 6b33d7d: it is not in the guard's import CLOSURE -- the Stop gate does
   * not import it -- so the closure test could never have demanded it, and
   * it was outside what that commit claimed to cover.
   *
   * It is still a file this repository executes on every session boundary,
   * with whatever the guard would have refused. A session that could
   * rewrite it owns the liveness watcher, and CLAUDE.md devotes a section
   * to what the silent death of this exact file already cost.
   *
   * Being reachable-as-a-hook and being reachable-by-import are different
   * questions, and only the second had a gate.
   */
  'scripts/bridge-session-poll.mjs',
  /*
   * RUN BY .git/hooks/post-commit ON EVERY COMMIT ON THIS MACHINE, and
   * unprotected until an auditor looked. ac59b22 swept ".claude/settings.json"
   * for hooks and found one; it did not think to sweep .git/hooks, so the
   * sweep missed a file that executes strictly more often than the one it
   * added. The hook's own header argues it belongs there because "every
   * commit reaches this hook regardless of which tool issued it" -- which is
   * the argument for protecting it.
   */
  'scripts/enqueue-audit-job.mjs',
  /*
   * REGISTERED AS CONTROLS BY 69de290 AND LEFT WRITABLE. This module's own
   * principle is "a file worth refusing a write to is a file worth auditing
   * a change to"; the converse was missing. src/governor.mjs is wired at
   * bin/agentbridge.mjs:3977 and src/principalResolution.mjs decides whether
   * an identity counts as authenticated -- a session that can rewrite either
   * does not need to defeat any of the rest of this list.
   *
   * src/tokenFile.mjs is deliberately NOT here. It is audit-bearing but
   * writable, and test/claudeGuardToolDispatch.test.mjs pins that as the
   * negative control for the root-spelling check. I added it, broke that
   * test, and took it back out: the finding named these two, and widening
   * past a finding is how a fix acquires a defect of its own.
   */
  'src/principalResolution.mjs',
  'src/governor.mjs',
  // The verification layer the Stop gate now consumes. Full reasoning in
  // guardSession.mjs. Both lists in one edit, as this file keeps asking.
  'src/verifyCache.mjs',
  'src/verifyIdentity.mjs',
  'src/verifyRunner.mjs',
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
/*
 * THE `i` IS LOAD-BEARING IN THE TWIN AND WAS MISSING HERE.
 *
 * guardSession.mjs carries the reasoning: NTFS resolves `.Claude` and `.CLAUDE`
 * to the same directory, so without the flag a junction named
 * `.claude/worktrees/x/.Claude` reaches the same control an inner session boots
 * from, the walk does not record it, and PreToolUse does not refuse planting it
 * -- "an unprivileged, undetected disarm. Found by audit."
 *
 * Harmless TODAY only because both call sites lowercase first, and an audit
 * measured zero behavioural differences across fifteen paths. That is rule 11:
 * untested because currently redundant is how a protection quietly stops being
 * one. The masking `.toLowerCase()` is one edit away from being removed on one
 * side, and protectedPathParity compares the ARRAYS plus a two-path corpus, so
 * it would not notice.
 */
const NESTED_CONTROL_DIR = /(^|\/)\.claude\//i;

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
/**
 * Directories no session may write into, refused WITHOUT being hashed.
 *
 * `.git/` is arbitrary execution and nothing covered it. Measured by a blind
 * auditor through the shipped hook binary:
 *
 *     Write .git/hooks/post-commit   allowed
 *     Write .git/hooks/pre-commit    allowed
 *     Write .git/config              allowed
 *
 * `core.hooksPath` in that config file runs a command of the writer's
 * choosing on every git operation, and a hook file runs on every commit.
 * Neither is reachable through any path rule this repository had.
 *
 * WHY IT IS NOT A PROTECTED_PATHS PREFIX ENTRY, which is where it obviously
 * belongs: `protectedFilesIn` EXPANDS a trailing-slash entry by walking the
 * directory into the hashed baseline. `.git/` changes on every commit, every
 * fetch and every index update, so the snapshot would drift constantly and
 * the Stop gate would report protected-control drift on a repository nobody
 * touched -- an alarm that fires every session is one people switch off
 * (rule 16). It is a refusal, not a thing to fingerprint, so it is checked
 * separately and never enters the digest.
 */
export const NEVER_WRITABLE_DIRS = Object.freeze(['.git/']);

export function isProtectedRelPath(rel) {
  if (typeof rel !== 'string' || rel === '') return false;
  const norm = rel.split(path.sep).join('/').replace(/^\.\//, '').toLowerCase();
  /* Refused outright, and deliberately not part of the hashed set. */
  if (NEVER_WRITABLE_DIRS.some((d) => norm === d.slice(0, -1) || norm.startsWith(d))) return true;
  const exempt = PROTECTION_EXEMPT_PREFIXES.find((p) => norm.startsWith(p.toLowerCase()));
  if (exempt && !NESTED_CONTROL_DIR.test(norm.slice(exempt.length))) return false;
  return PROTECTED_PATHS.some((e) => {
    const entry = e.toLowerCase();
    return entry.endsWith('/') ? norm.startsWith(entry) : norm === entry;
  });
}

export function isBaselineTestPath(rel) {
  const norm = String(rel ?? '').split(path.sep).join('/');
  return /^test\/.+\.test\.mjs$/i.test(norm);
}
