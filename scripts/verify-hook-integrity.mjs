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
  .update(buf.toString('utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '\n'))
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
    const p = String(runGit(['rev-parse', '--git-path', 'hooks/post-commit'], { cwd: REPO })).trim();
    return p ? path.resolve(REPO, p) : null;
  } catch {
    return null;
  }
}

export function verifyHookIntegrity() {
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
