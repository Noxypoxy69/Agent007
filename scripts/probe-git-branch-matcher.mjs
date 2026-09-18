/*
 * ===========================================================================
 * FALSIFIED. ITS "PASS" IS WORTHLESS. THE CANDIDATE BELOW ALLOWS REF MUTATION.
 *
 * Kept only as the worked example of a hollow gate. Audited 2026-09-17; see
 * docs/GUARD_FINDINGS_2026-09-17_fixer.md for the leaking strings. In short:
 *
 *   - `git branch --abbrev --unset-upstream` -> candidate ALLOWS; git deletes
 *     branch.<current>.remote/.merge. `--abbrev` takes an OPTIONAL argument and
 *     judgeGitBranch eats the next token unconditionally.
 *   - `git branch --format --list newref` -> candidate ALLOWS; git creates the
 *     ref. `listing` asks whether the TOKEN `--list` appears, not whether git
 *     parses it as a flag -- so a value consumed by --format still sets it.
 *     That is CLAUDE.md trap 12 inside a patch that cites trap 12.
 *   - `-t` / `--track` appear in neither the flag sets NOR the table below.
 *
 * The table cannot see any of it: every deny-case appends " main", so no case
 * exercises a read flag PRECEDING a writer. Two mutations survive it (adding
 * `-t` to the read set; dropping the `eq === -1` guard) and it still PASSes.
 * candidate() also masks 4 of 38 deny-cases that never reach judgeGitBranch --
 * `-c` is caught by GIT_POISON and `-f` by WRITE_FLAGS, both coincidences.
 *
 * DO NOT use this as the basis for a patch. Real cases belong in
 * test/claudeGuard.test.mjs, generated from a single exported flag table.
 * ===========================================================================
 *
 * ONE-SHOT EVIDENCE for an UNAPPLIED patch. See docs/GUARD_FINDINGS_2026-09-17_fixer.md.
 *
 * THIS IS NOT A TEST AND MUST NOT BECOME ONE. It judges a COPY of the git-branch
 * rule living in this file, so once the patch lands it would agree with itself
 * through exactly the regression it claims to catch -- CLAUDE.md hollow gate 2.
 * When the real cases land in test/claudeGuard.test.mjs, DELETE THIS FILE.
 *
 * It exists because src/shellAllowlist.mjs is in PROTECTED_PATHS and the patch
 * could not be applied from a session, so the candidate had to be proven beside
 * the shipped rule instead of in place of it.
 *
 * Rule 2: it IMPORTS the shipped judge rather than restating it, so the
 * "shipped" column cannot drift away from what actually ships.
 *
 *   node scripts/probe-git-branch-matcher.mjs
 *   node scripts/probe-git-branch-matcher.mjs --mutate-positional
 *   node scripts/probe-git-branch-matcher.mjs --mutate-readflags
 */
import { judgeShellCommand, tokenize } from '../src/shellAllowlist.mjs';

/* ---------- CANDIDATE, verbatim as proposed for src/shellAllowlist.mjs ---------- */

const GIT_BRANCH_READ_FLAGS = new Set([
  '--list', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose',
  '--show-current', '--color', '--no-color', '--column', '--no-column',
  '-i', '--ignore-case', '--omit-empty',
]);

const GIT_BRANCH_READ_VALUE_FLAGS = new Set([
  '--contains', '--no-contains', '--merged', '--no-merged',
  '--points-at', '--sort', '--format', '--abbrev',
]);

/* Rule 1/2: two mutations, so a PASS below is watched rather than assumed. */
const MUT_POSITIONAL = process.argv.includes('--mutate-positional');
const MUT_READFLAGS = process.argv.includes('--mutate-readflags');
if (MUT_READFLAGS) GIT_BRANCH_READ_FLAGS.delete('-a');

export function judgeGitBranch(tokens) {
  const args = tokens.slice(2);
  const listing = args.includes('--list') || MUT_POSITIONAL;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('-')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg : arg.slice(0, eq);
      if (GIT_BRANCH_READ_VALUE_FLAGS.has(name)) {
        if (eq === -1) {
          i += 1;
          if (i >= args.length) {
            return { allowed: false, reason: `git branch ${name} is missing its value` };
          }
        }
        continue;
      }
      if (eq === -1 && GIT_BRANCH_READ_FLAGS.has(arg)) continue;
      return { allowed: false, reason: `git branch ${name} is not a read-only listing flag` };
    }
    if (!listing) {
      return {
        allowed: false,
        reason: 'git branch writes a ref unless it is listing; a positional name needs --list',
      };
    }
  }
  return { allowed: true };
}

/* Candidate verdict for a whole command, reusing the shipped front-end checks. */
function candidate(command) {
  const shipped = judgeShellCommand(command);
  const { tokens } = tokenize(command);
  const values = tokens.map((t) => t.value);
  if (values[0] !== 'git' || values[1] !== 'branch') return shipped;
  /* Upstream filters (metacharacters, WRITE_FLAGS, -c poison) still bind: if the
   * shipped judge refused for a reason OTHER than the branch rule, keep that. */
  if (!shipped.allowed && !/git branch writes a ref/.test(shipped.reason ?? '')) return shipped;
  return judgeGitBranch(values);
}

/* ---------- THE TABLE ---------- */

const MUST_ALLOW = [
  'git branch',
  'git branch --list',
  'git branch --list "worktree-agent-*"',
  "git branch --list 'worktree-agent-*'",
  'git branch --list worktree-agent-a7a1a55d7bb99f5b9',
  'git branch -a',
  'git branch --all',
  'git branch -r',
  'git branch -v',
  'git branch -vv',
  'git branch --show-current',
  'git branch --merged main',
  'git branch --no-merged main',
  'git branch --contains 9a7404d',
  'git branch --points-at HEAD',
  'git branch --sort=-committerdate',
  'git branch -a --list "b/*"',
];

/* Rule 7/8: GENERATED from git's real writer surface, not five strings I liked.
 * Crossed with and without --list, so --list cannot be used to smuggle a writer. */
const WRITER_FLAGS = [
  '-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy',
  '-f', '--force', '-u', '--set-upstream', '--unset-upstream',
  '--set-upstream-to=origin/main', '--edit-description', '--create-reflog',
];
const MUST_DENY = [
  'git branch newref',
  'git branch -D main',
  'git branch --list --delete main',
  'git branch --merged',
  ...WRITER_FLAGS.map((f) => `git branch ${f} main`),
  ...WRITER_FLAGS.map((f) => `git branch --list ${f} main`),
];

let fail = 0;
let shippedRejectedReads = 0;

console.log('=== MUST ALLOW (read-only listing forms) ===');
for (const cmd of MUST_ALLOW) {
  const s = judgeShellCommand(cmd).allowed;
  const c = candidate(cmd).allowed;
  if (!s) shippedRejectedReads += 1;
  if (!c) { fail += 1; console.log(`  CANDIDATE FAILS: ${cmd}`); }
  console.log(`  shipped=${s ? 'allow' : 'DENY '} candidate=${c ? 'allow' : 'DENY '}  ${cmd}`);
}

console.log('\n=== MUST DENY (writers) ===');
for (const cmd of MUST_DENY) {
  const s = judgeShellCommand(cmd).allowed;
  const c = candidate(cmd).allowed;
  if (c) { fail += 1; console.log(`  CANDIDATE LEAKS: ${cmd}`); }
  if (s) { fail += 1; console.log(`  SHIPPED LEAKS:   ${cmd}`); }
  console.log(`  shipped=${s ? 'ALLOW' : 'deny '} candidate=${c ? 'ALLOW' : 'deny '}  ${cmd}`);
}

console.log(`\nallow-cases=${MUST_ALLOW.length} deny-cases=${MUST_DENY.length}`);
console.log(`shipped wrongly refused ${shippedRejectedReads} read-only form(s) -- this is the bug`);
console.log(fail === 0 ? 'CANDIDATE: PASS (0 failures)' : `CANDIDATE: FAIL (${fail})`);
process.exitCode = fail === 0 ? 0 : 1;
