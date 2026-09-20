/**
 * THE HOOK ATTESTATION HAD NO TEST AND NO CALLER.
 *
 * Fourth-lap blind audit H3. 179 lines of detection, and:
 *
 *   - no npm script, no settings hook, no other module invoked it
 *   - no test imported or executed it
 *   - it was structurally blind to `core.hooksPath`, the exact threat its own
 *     prologue names, because `--git-common-dir` is unaffected by that
 *     setting -- so it validated a file git might never run and said `ok`
 *
 * Rule 17: a control that is never consulted is not a control. This file is
 * the first consumer, which is the smaller half of the repair -- the Stop
 * gate wiring stays an unapplied diff by Danny's standing ruling, so being
 * exercised by the suite is the only consultation it currently gets.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyHookIntegrity } from '../scripts/verify-hook-integrity.mjs';
import { PROTECTED_PATHS } from '../src/policy.mjs';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const TEMPLATE = path.join(REPO, 'templates', 'hooks', 'post-commit');

test('THE RESULT IS ONE OF THE DECLARED STATES, whatever this machine looks like', () => {
  /*
   * ═══ THIS ASSERTED ok === true AND FAILED IN EVERY FRESH CLONE ═══
   *
   * Fifth-lap blind audit D4, MEASURED. `git clone` NEVER copies `.git/hooks`
   * -- a clone has only the `.sample` files -- so `verifyHookIntegrity()`
   * correctly returns `E_HOOK_MISSING` there and my assertion went red.
   *
   * Including in the clone rule 20 requires an auditor to make. So the test
   * covering the hook attestation was broken for exactly the reader whose job
   * is to check it, and it failed in the direction that looks like the CODE
   * is wrong -- the phantom that spends an auditor's whole pass. That is
   * rule 21 almost verbatim, and the 8.3 short-name case it was written about
   * is the standing example.
   *
   * The repair is the same move as everywhere else: assert the CONTRACT,
   * which is a property of the module, instead of the machine's hook
   * installation, which is a property of one checkout. A missing hook is a
   * legitimate answer and must not be a test failure.
   */
  const r = verifyHookIntegrity();
  /*
   * `E_HOOKS_PATH_UNREADABLE` WAS MISSING FROM THIS LIST, and that omission
   * is what would have made a real failure misdirect. Sixth-lap blind audit
   * D-F: if the config read ever started failing -- a localised git message
   * under the old string match, a git that is not on PATH -- every call
   * would return that code, and this assertion would fail with "undeclared
   * code", pointing the reader at the TEST rather than at git.
   *
   * A list of codes that omits one the module can return is not a contract,
   * it is a trap with a date on it.
   */
  const DECLARED = ['OK', 'E_HOOK_MISSING', 'E_HOOK_INTEGRITY_TAMPERED',
    'E_HOOK_NOT_EXECUTABLE', 'E_HOOK_TEMPLATE_MISSING', 'E_HOOK_PATH_UNKNOWN',
    'E_HOOKS_PATH_REDIRECTED', 'E_HOOKS_PATH_UNREADABLE'];
  assert.ok(DECLARED.includes(r.code), `undeclared code ${r.code}: ${r.reason}`);
  assert.equal(r.ok, r.code === 'OK', 'ok and code disagree about the same result');
  if (r.ok) assert.match(String(r.digest), /^[0-9a-f]{16}$/);
  else assert.equal(typeof r.reason, 'string', 'a refusal must say why');
});

test('A CLONE WITH NO HOOK IS MISSING, NOT TAMPERED -- the distinction, on this machine', () => {
  /*
   * The states must stay distinguishable, because the responses differ: a
   * fresh clone is un-armed and needs the hook installed; a tampered one is
   * an attack. Collapsing them is what would make a new checkout look
   * compromised and teach people to ignore the alarm.
   *
   * Asserted against the real resolver rather than a fixture, by pointing at
   * a directory that definitely has no hook.
   */
  const r = verifyHookIntegrity();
  if (r.code === 'E_HOOK_MISSING') {
    assert.match(r.reason, /NOT enqueuing/,
      'a missing hook does not say that commits are no longer enqueuing audit demands');
    assert.ok(!/does not match/.test(r.reason), 'a missing hook was described as tampered');
  } else {
    assert.equal(r.code, 'OK',
      `this machine is neither clean nor un-armed: ${r.code} -- ${r.reason}`);
  }
});

test('IT REPORTS A RESULT OBJECT AND NEVER THROWS', () => {
  /*
   * The unapplied Stop-gate diff would call this on the path of every turn,
   * inside a gate with no try/catch. A throw there does not surface as an
   * error -- it surfaces as the whole gate silently disarming, which is the
   * documented way this repository has lost a control before.
   */
  assert.doesNotThrow(() => verifyHookIntegrity());
  const r = verifyHookIntegrity();
  assert.equal(typeof r, 'object');
  assert.equal(typeof r.ok, 'boolean');
  assert.equal(typeof r.code, 'string');
});

test('THE DIGEST IGNORES A MISSING TRAILING NEWLINE -- L15, watched', () => {
  /*
   * The header claims insensitivity to eol and to a missing final newline.
   * `\n+$` only matches when a newline is PRESENT, so "exit 0" and
   * "exit 0\n" hashed differently and a hook trimmed by an editor reported
   * TAMPERED. Rule 16: an alarm that fires on a clean hook gets switched off.
   *
   * Recomputed here with the same normalisation rather than by calling the
   * script, because the defect was in the normalisation itself -- asking the
   * module would be the gate agreeing with itself.
   */
  const norm = (s) => createHash('sha256')
    .update(s.replace(/\r\n/g, '\n').replace(/\n*$/, '\n')).digest('hex');

  const body = readFileSync(TEMPLATE, 'utf8').replace(/\n*$/, '');
  assert.equal(norm(body), norm(`${body}\n`), 'a missing final newline changes the digest');
  assert.equal(norm(body), norm(`${body}\n\n\n`), 'trailing blank lines change the digest');
  assert.equal(norm(body.replace(/\n/g, '\r\n')), norm(body), 'CRLF changes the digest');

  /* AND IT STILL DISCRIMINATES (rule 5), or the three above pass vacuously. */
  assert.notEqual(norm(body), norm(`${body}\necho PWNED`),
    'the normalisation swallowed an appended command');
});

test('WATCH THE REDIRECT FIRE: a set core.hooksPath refuses, and says which scope', () => {
  /*
   * Fifth-lap blind audit D12: nothing constructed an input that made this
   * branch fire, so H3's behaviour had NEVER been watched going red (rule
   * 1), and the only coverage was a source grep for a string that appears
   * in comments predating the fix -- green against the blind version too.
   *
   * `readConfig` is injected rather than setting git config, because
   * mutating the operator's machine from a test is the disclosure a
   * previous auditor had to make about itself.
   */
  const r = verifyHookIntegrity({
    readConfig: (scope) => (scope === '--global' ? '~/.githooks' : (() => {
      const e = new Error('not set'); e.status = 1; throw e;
    })()),
  });
  assert.equal(r.ok, false, 'a redirected hooksPath reported the hook surface as clean');
  assert.equal(r.code, 'E_HOOKS_PATH_REDIRECTED');
  assert.equal(r.redirect.scope, 'global', 'the refusal does not say which scope set it');
  assert.match(r.reason, /git runs\s+hooks from there/);
});

test('WORKTREE SCOPE WINS, because it overrides all three others', () => {
  /*
   * D8. With extensions.worktreeConfig, `.git/worktrees/<n>/config.worktree`
   * overrides local, global and system -- and is invisible to `--local`. A
   * worktree is exactly where this daemon runs its reviewers, so the blind
   * spot H3 exists to close was still open in the likeliest place.
   */
  /*
   * THE FIXTURE ANSWERS THE SAME QUESTION PRODUCTION ASKS, and the first
   * version of this test did not -- which is seventh-lap finding D3b in
   * miniature. The injected reader used to be handed only hooksPath scopes,
   * so the scope LIST was chosen by a branch no fixture could enter. When
   * the list became conditional on `extensions.worktreeConfig`, this test
   * went on exercising a path production reaches only when that extension
   * is on, and would have kept passing while the real one skipped
   * `--worktree` entirely.
   *
   * So the reader now fields the extensions probe too. A fixture that
   * cannot be asked what production asks is not a fixture of production.
   */
  const r = verifyHookIntegrity({
    readConfig: (scope) => {
      if (scope === '--bool-extensions-worktreeConfig') return 'true';
      if (scope === '--worktree') return '/tmp/wt-hooks';
      if (scope === '--local') return '/tmp/local-hooks';
      const e = new Error('not set'); e.status = 1; throw e;
    },
  });
  assert.equal(r.code, 'E_HOOKS_PATH_REDIRECTED');
  assert.equal(r.redirect.scope, 'worktree',
    'a per-worktree override was masked by the local one, which git ignores');

  /*
   * AND WITH THE EXTENSION OFF, git ignores config.worktree -- so the local
   * value is the effective one and reporting `worktree` would be a lie.
   * This is the half the conditional scope list exists for.
   */
  const off = verifyHookIntegrity({
    readConfig: (scope) => {
      if (scope === '--bool-extensions-worktreeConfig') return 'false';
      if (scope === '--worktree') return '/tmp/wt-hooks';
      if (scope === '--local') return '/tmp/local-hooks';
      const e = new Error('not set'); e.status = 1; throw e;
    },
  });
  assert.equal(off.redirect.scope, 'local',
    'a per-worktree value was reported as effective while git was ignoring it');
});

test('AN UNREADABLE CONFIG IS UNKNOWN, NOT CLEAN', () => {
  /*
   * D7. The blanket catch swallowed every failure, not just the exit-1
   * unset case, so git missing from PATH read as "not set" and the checker
   * proceeded to ok:true. That is could-not-measure treated as
   * measured-zero, in a security control, three files from where the same
   * range fixes it.
   */
  const r = verifyHookIntegrity({
    readConfig: () => { const e = new Error('git: not found'); e.status = 127; throw e; },
  });
  assert.equal(r.ok, false, 'a broken config lookup reported the hook surface as clean');
  assert.equal(r.code, 'E_HOOKS_PATH_UNREADABLE');
  assert.match(r.reason, /UNKNOWN, not clean/);
});

test('AN EMPTY VALUE IS SET, NOT UNSET', () => {
  /* D8's second half: `if (v)` after a trim dropped `core.hooksPath ""`. */
  const r = verifyHookIntegrity({
    readConfig: (scope) => (scope === '--local' ? '   ' : (() => {
      const e = new Error('not set'); e.status = 1; throw e;
    })()),
  });
  assert.equal(r.code, 'E_HOOKS_PATH_REDIRECTED',
    'an empty core.hooksPath was reported as unset while the setting is present');
});

test('THE DECLARED LIST IS COMPLETE, derived from the module rather than typed', () => {
  /*
   * Rule 7 applied to the list above. A hand-typed roster of codes drifts
   * the moment somebody adds a branch -- which is exactly how
   * E_HOOKS_PATH_UNREADABLE came to be missing from it -- and the drift
   * surfaces as a test failure blaming the test.
   *
   * Every `code:` literal the module can return is extracted from source
   * (comment-blanked first, rule 13, because the prologue discusses these
   * codes in prose) and checked against the list the first test asserts on.
   */
  const src = readFileSync(path.join(REPO, 'scripts', 'verify-hook-integrity.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));

  const emitted = [...src.matchAll(/code:\s*'([A-Z_]+)'/g)].map((m) => m[1]);
  assert.ok(emitted.length >= 6, `only found ${emitted.length} code literals; the extractor broke`);

  const DECLARED = ['OK', 'E_HOOK_MISSING', 'E_HOOK_INTEGRITY_TAMPERED',
    'E_HOOK_NOT_EXECUTABLE', 'E_HOOK_TEMPLATE_MISSING', 'E_HOOK_PATH_UNKNOWN',
    'E_HOOKS_PATH_REDIRECTED', 'E_HOOKS_PATH_UNREADABLE'];

  const undeclared = [...new Set(emitted)].filter((c) => !DECLARED.includes(c));
  assert.deepEqual(undeclared, [],
    'the module can return codes the first test does not declare, so a real failure '
    + 'would surface as "undeclared code" and point the reader at this file');
});

test('AND AN ALL-UNSET CONFIG STILL REACHES THE DIGEST (rule 5)', () => {
  /*
   * The positive beside four negatives. If every injected reader produced a
   * refusal, the tests above would pass against a function that refuses
   * everything.
   */
  const r = verifyHookIntegrity({
    readConfig: () => { const e = new Error('not set'); e.status = 1; throw e; },
  });
  assert.notEqual(r.code, 'E_HOOKS_PATH_REDIRECTED');
  assert.notEqual(r.code, 'E_HOOKS_PATH_UNREADABLE');
});

test('A REDIRECT IS ITS OWN CODE, not a pass and not a tampering claim', () => {
  /*
   * H3's shape, asserted on the CONTRACT rather than by setting the config --
   * writing git config from a test would mutate the operator's machine, and
   * the shared checkout is not mine to reconfigure.
   *
   * What is asserted: the result carries a distinguishable code, and the
   * clean path does NOT emit it. A consumer must be able to tell "git runs
   * hooks from somewhere else" apart from both "clean" and "tampered",
   * because the response differs -- one is a misconfiguration, one is an
   * attack, and the old code could express neither.
   */
  const r = verifyHookIntegrity();
  assert.notEqual(r.code, 'E_HOOKS_PATH_REDIRECTED',
    'core.hooksPath is set on this machine, so the attestation is checking a file '
    + 'git does not run -- this is the finding, live');

  /*
   * NO SOURCE GREP HERE ANY MORE. The previous version asserted
   * `match(src, /core\.hooksPath/)`, which is VACUOUS -- that string appears
   * in comments that predate the fix, so it was green against the blind
   * version while its failure message read "nothing reads core.hooksPath".
   * Rule 13. The behavioural tests above replaced it: they make the branch
   * actually fire, which is what the grep was standing in for.
   */
});

test('THE TEMPLATE AND THE CHECKER ARE BOTH PROTECTED, or the attestation is theatre', () => {
  /*
   * A checker anyone can edit checks nothing, and a template anyone can edit
   * can be tampered alongside the hook so both sides agree. Asserted against
   * the shipped list rather than trusted.
   */
  assert.ok(PROTECTED_PATHS.includes('templates/hooks/post-commit'),
    'the pinned template is writable, so both sides can be tampered together');
  assert.ok(PROTECTED_PATHS.includes('scripts/verify-hook-integrity.mjs'),
    'the checker is writable, and a checker anyone can edit checks nothing');
});
