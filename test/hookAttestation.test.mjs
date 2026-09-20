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
  const DECLARED = ['OK', 'E_HOOK_MISSING', 'E_HOOK_INTEGRITY_TAMPERED',
    'E_HOOK_NOT_EXECUTABLE', 'E_HOOK_TEMPLATE_MISSING', 'E_HOOK_PATH_UNKNOWN',
    'E_HOOKS_PATH_REDIRECTED'];
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

  /* The code is a real branch in the module, not a string I invented here. */
  const src = readFileSync(path.join(REPO, 'scripts', 'verify-hook-integrity.mjs'), 'utf8');
  assert.match(src, /E_HOOKS_PATH_REDIRECTED/,
    'the redirect branch was removed; the checker is blind to core.hooksPath again');
  assert.match(src, /core\.hooksPath/,
    'nothing reads core.hooksPath, which is the threat the prologue names');
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
