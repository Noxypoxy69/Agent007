#!/usr/bin/env node
/**
 * DOES THE INSTALLED GIT HOOK STILL MATCH THE ONE IN THE REPOSITORY?
 *
 *   node scripts/verify-hook-integrity.mjs [--json]
 *
 * ═══ THE GAP THIS CLOSES, AND WHAT IT DOES NOT ═══
 *
 * `0fec418` closed WRITES to `.git/` at the rail -- measured, because before
 * it `Write .git/hooks/post-commit`, `Write .git/hooks/pre-commit` and
 * `Write .git/config` were all allowed, and `core.hooksPath` in that config
 * runs a command of the writer's choosing on every git operation.
 *
 * But a rail only constrains what a GUARDED SESSION does after the guard is
 * armed. It says nothing about a hook that was already on disk: dropped
 * before the guard loaded, written by an unguarded session, installed by a
 * process outside this harness, or edited by a person. Such a hook executes
 * with full ambient authority on every single commit and nothing checks it.
 *
 * Refusing a write is prevention. This is DETECTION, and they are different
 * controls -- the first one cannot do the second's job.
 *
 * ═══ WHY THIS IS NOT A PROTECTED_PATHS ENTRY ═══
 *
 * `0fec418` worked this out and its reasoning is worth not re-deriving:
 * `protectedFilesIn` EXPANDS a trailing-slash entry by walking the directory
 * into the hashed baseline, and `.git/` changes on every commit, fetch and
 * index update. Listing it would make the Stop gate report protected-control
 * drift on a repository nobody had touched -- and an alarm that fires every
 * session is one people switch off (rule 16). So `.git/` is a refusal, never
 * a thing to fingerprint, and this checks the ONE file that matters against a
 * pinned template instead.
 *
 * ═══ THE ATTESTATION IS ONLY AS STRONG AS THE TEMPLATE ═══
 *
 * If `templates/hooks/post-commit` were writable, tampering with both sides
 * would pass. The template must be in PROTECTED_PATHS, and this script must
 * be too -- a checker anyone can edit checks nothing. Both are registered;
 * `test/protectedPathParity.test.mjs` keeps the two lists in step.
 *
 * ═══ LINE ENDINGS ARE NORMALISED, DELIBERATELY ═══
 *
 * A byte-exact comparison is the obvious implementation and it is WRONG here.
 * Git may convert eol on checkout, so on a fresh clone the template could
 * arrive CRLF while the installed hook is LF -- and the checker would report
 * TAMPERED for a machine reason. That is rule 21: a test encoding an accident
 * of one checkout, failing in the direction that looks like an attack.
 * Normalising both sides keeps every content difference visible; nobody hides
 * a payload in a carriage return.
 */
import { readFileSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runGit } from '../src/safeGit.mjs';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const TEMPLATE = path.join(REPO, 'templates', 'hooks', 'post-commit');

/** Content identity, insensitive to eol and to a missing trailing newline. */
const digest = (buf) => createHash('sha256')
  /*
   * `\n*$` AND NOT `\n+$`. Fourth-lap blind audit L15: the header claims this
   * is "insensitive to eol and to a missing trailing newline", and `\n+$`
   * only matches when at least one newline is PRESENT. So "exit 0\n"
   * normalised to itself and "exit 0" stayed bare -- different digests, and a
   * hook byte-identical to the template but for a missing final newline
   * reported E_HOOK_INTEGRITY_TAMPERED.
   *
   * That is rule 16 in the worst direction for a security control: an alarm
   * that fires on a clean hook is one people learn to switch off, and this
   * one would have fired on a checkout whose editor trimmed the last line.
   */
  .update(buf.toString('utf8').replace(/\r\n/g, '\n').replace(/\n*$/, '\n'))
  .digest('hex');

/**
 * ASK GIT WHERE THE HOOK IS, NEVER path.join(root, '.git', ...).
 *
 * In a linked worktree `.git` is a FILE containing `gitdir: ...`, not a
 * directory -- measured on this machine: the audit worktrees the daemon
 * creates have a 73-byte `.git`. Joining into it throws ENOTDIR precisely in
 * the detached worktrees this system runs reviewers in.
 */
function hookPath() {
  try {
    /*
     * `--git-path hooks/post-commit` IS THE OBVIOUS QUERY AND IT IS WRONG
     * HERE, because `runGit` hardens every call with
     * `-c core.hooksPath=/dev/null` -- so git helpfully resolves against the
     * OVERRIDE and answers `/dev/null/post-commit`. Caught on this script's
     * very first run, which reported the hook missing at
     * `C:\dev\null\post-commit`.
     *
     * That is worth keeping visible: the hardening that makes git safe to
     * call is the same thing that made it lie about where hooks live, and a
     * checker reporting E_HOOK_MISSING for that reason would have read as
     * "the trigger is not installed" on a machine where it was.
     *
     * `--git-common-dir` is unaffected by hooksPath, and it is also the
     * CORRECT source in a linked worktree: hooks live in the main
     * repository's admin directory, not the worktree's, so a per-worktree
     * answer would check a file git never runs.
     */
    const common = String(runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: REPO })).trim();
    return common ? path.join(common, 'hooks', 'post-commit') : null;
  } catch {
    return null;
  }
}

/**
 * IS GIT BEING POINTED SOMEWHERE ELSE ENTIRELY?
 *
 * Fourth-lap blind audit H3, and it is the sharpest kind of finding: this
 * script's own prologue names `core.hooksPath` as the attack -- "runs a
 * command of the writer's choosing on every git operation" -- and then never
 * read it.
 *
 * `553724b` moved to `--git-common-dir` precisely BECAUSE it is unaffected by
 * `hooksPath`, which fixed a real bug (`runGit` hardens with
 * `core.hooksPath=/dev/null`, so `--git-path` answered `/dev/null/...`). But
 * it made the checker validate `<common>/hooks/post-commit` UNCONDITIONALLY,
 * whether or not git would ever run that file. A recoverable bug became a
 * permanent blind spot, and `ok: true` meant "the file I chose to look at is
 * unchanged" while git ran something else.
 *
 * ═══ WHY AN EXPLICIT SCOPE, AND WHY runGit IS STILL SAFE HERE ═══
 *
 * `runGit` hardens every call with `-c core.hooksPath=/dev/null`, so the
 * obvious `git config --get core.hooksPath` would read back the OVERRIDE and
 * report `/dev/null` on a machine with no setting at all -- the same trap
 * that made `--git-path` answer `/dev/null/post-commit`, one command along.
 *
 * `--local`, `--global` and `--system` each read one config FILE and ignore
 * the command-line scope `-c` writes to. So the hardening cannot mask the
 * answer, and there is no reason to reach around `runGit` -- my first version
 * of this used a bare `execFileSync` and the safeGit scan caught it, which is
 * that gate doing precisely its job.
 *
 * All three scopes, because `hooks/pre-commit` in this repository tells
 * readers to run `git config --global core.hooksPath ~/.githooks` -- the repo
 * documents the step that disarms its own attestation.
 */
export function hooksPathOverride(readConfig = null) {
  /*
   * INJECTABLE, so the redirect branch can be watched going red. Fifth-lap
   * blind audit D12: nothing constructed an input that made it fire, so
   * H3's behaviour had never been watched failing (rule 1), and the only
   * coverage was a source grep for the string `core.hooksPath` -- which
   * appears in comments that PREDATE the fix, so it was green against the
   * blind version too. Rule 13, in a file added to close a rule 17 finding.
   */
  const ask = typeof readConfig === 'function'
    ? readConfig
    : (scope) => String(runGit(['config', scope, '--get', 'core.hooksPath'], { cwd: REPO }));

  /*
   * `--worktree` FIRST, AND IT WAS THE SCOPE THAT MATTERED MOST. Fifth-lap
   * blind audit D8: with `extensions.worktreeConfig` enabled, a value in
   * `.git/worktrees/<n>/config.worktree` OVERRIDES all three of the others
   * and is invisible to `--local` -- and a worktree is exactly where this
   * daemon runs its reviewers. The blind spot H3 exists to close was still
   * open in the one place it is most likely to be exploited. Ordered by
   * git's own precedence, highest first, so the first hit is the effective
   * one rather than merely a set one.
   */
  for (const scope of ['--worktree', '--local', '--global', '--system']) {
    let raw;
    try {
      raw = ask(scope);
    } catch (e) {
      /*
       * EXIT 1 IS "UNSET IN THIS SCOPE" AND IS THE COMMON CASE. ANYTHING
       * ELSE IS "COULD NOT LOOK", AND THE OLD BLANKET CATCH TREATED THEM
       * ALIKE -- so git missing from PATH, a vanished cwd or a hung child
       * all read as "not set" and the checker went on to report ok:true.
       *
       * That is the could-not-measure-is-not-measured-zero primitive,
       * reintroduced three files from where this same range fixes it, in a
       * security control. Fifth-lap blind audit D7.
       *
       * `--worktree` outside a worktree-config repo also exits non-zero with
       * a usage error, which is genuinely "not applicable here" rather than
       * a failure, so it is allowed to fall through like an unset scope.
       */
      const status = e?.status;
      const usage = /worktree/i.test(String(e?.stderr ?? '')) && scope === '--worktree';
      if (status === 1 || usage) continue;
      return {
        scope: scope.replace('--', ''),
        value: null,
        unreadable: String(e?.stderr || e?.message || e).trim(),
      };
    }

    /*
     * AN EMPTY VALUE IS SET, NOT UNSET. `git config core.hooksPath ""`
     * stores an empty string, and `if (v)` after a trim dropped it -- so the
     * setting was present and reported absent. D8's second half.
     */
    if (raw !== null && raw !== undefined) {
      const v = String(raw).trim();
      if (v !== '' || String(raw).length > 0) return { scope: scope.replace('--', ''), value: v };
    }
  }
  return null;
}

export function verifyHookIntegrity({ readConfig = null } = {}) {
  /*
   * CHECKED FIRST, because every answer below is about a file git may not
   * run. Rule 15: the gate moves rather than closes -- this is its own code,
   * not a silent pass and not a tampering claim.
   */
  const redirect = hooksPathOverride(readConfig);
  if (redirect && redirect.unreadable) {
    /*
     * COULD NOT LOOK IS ITS OWN ANSWER. Reporting "no redirect" here would
     * be the exact failure D7 names -- a control concluding clean because
     * its own lookup broke.
     */
    return {
      ok: false,
      code: 'E_HOOKS_PATH_UNREADABLE',
      redirect,
      reason: `could not read core.hooksPath from ${redirect.scope} config (${redirect.unreadable}), `
        + 'so whether git runs the hook this attestation checks is UNKNOWN, not clean',
    };
  }
  if (redirect) {
    return {
      ok: false,
      code: 'E_HOOKS_PATH_REDIRECTED',
      redirect,
      reason: `core.hooksPath is set in ${redirect.scope} config to "${redirect.value}", so git runs `
        + 'hooks from there and NOT from the directory this attestation checks. Whatever the '
        + 'digest below would have said is about a file git ignores',
    };
  }

  if (!existsSync(TEMPLATE)) {
    return { ok: false, code: 'E_HOOK_TEMPLATE_MISSING', reason: `no pinned template at ${TEMPLATE}: there is nothing to compare against, which is not the same as a clean hook` };
  }
  const hook = hookPath();
  if (!hook) {
    return { ok: false, code: 'E_HOOK_PATH_UNKNOWN', reason: 'git could not say where hooks/post-commit lives, so the hook could not be checked at all' };
  }

  /*
   * MISSING IS ITS OWN ANSWER, NOT TAMPERED. A repository where nobody
   * installed the hook is un-armed, not attacked -- the audit trigger simply
   * is not running. Collapsing the two would make a fresh clone look
   * compromised and teach people to ignore the alarm; keeping them apart is
   * the same distinction as "could not measure" versus "measured a failure".
   */
  if (!existsSync(hook)) {
    return { ok: false, code: 'E_HOOK_MISSING', hook, reason: `no post-commit hook installed at ${hook}: commits are NOT enqueuing audit demands` };
  }

  const want = digest(readFileSync(TEMPLATE));
  const got = digest(readFileSync(hook));
  if (want !== got) {
    return {
      ok: false,
      code: 'E_HOOK_INTEGRITY_TAMPERED',
      hook,
      expected: want.slice(0, 16),
      actual: got.slice(0, 16),
      reason: `${hook} does not match templates/hooks/post-commit. It runs with full ambient authority on every commit`,
    };
  }

  /*
   * THE EXECUTABLE BIT, ON POSIX ONLY. Windows has no such mode and
   * `statSync().mode` reports something meaningless there, so asserting it
   * everywhere would fail on the machine this actually runs on -- rule 21
   * again, in the other direction.
   */
  if (process.platform !== 'win32') {
    const mode = statSync(hook).mode & 0o777;
    if ((mode & 0o111) === 0) {
      return { ok: false, code: 'E_HOOK_NOT_EXECUTABLE', hook, mode: mode.toString(8), reason: `${hook} matches the template but is not executable (${mode.toString(8)}), so git silently skips it` };
    }
  }

  return { ok: true, code: 'OK', hook, digest: want.slice(0, 16) };
}

/* Run directly: print and exit. Imported: just the function. */
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const r = verifyHookIntegrity();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  } else if (r.ok) {
    process.stdout.write(`hook ok  ${r.hook}\n  digest ${r.digest}\n`);
  } else {
    process.stderr.write(`[agentbridge:${r.code}] ${r.reason}\n`);
  }
  process.exit(r.ok ? 0 : 1);
}
