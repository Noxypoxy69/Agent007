/**
 * THE SPLIT, THROUGH THE SHIPPED ENTRY POINT.
 *
 * test/sessionPolicy.test.mjs proves the resolver decides correctly. That is a
 * different claim from "the guard consults it", and CLAUDE.md rule 17 is
 * entirely about the gap between them: "a control that is never consulted is
 * not a control ... the wiring is a separate claim from the logic, and only the
 * logic has tests." So every assertion here goes through evaluateClaudeTool,
 * the function the PreToolUse hook actually calls.
 *
 * ═══ AGENTBRIDGE_HOME IS MOVED, AND THAT IS LOAD-BEARING TWICE ═══
 *
 * It isolates the profile store, obviously. It also isolates the OVERRIDE
 * GRANT -- and without that this whole file would be a hollow gate. The machine
 * running it has a live `paths:["*"]` grant, so a protected write would be
 * ALLOWED for every profile, every assertion below would pass, and the file
 * would prove nothing at all. That failure mode is already recorded in this
 * repository's memory as "a live override grant leaks into the test suite".
 *
 * The NEGATIVE CONTROL at the bottom is what proves the isolation actually
 * worked, rather than being asserted in this comment.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { evaluateClaudeTool } from '../src/claudeGuard.mjs';
import { writePendingAttestation, bindSessionProfile } from '../src/sessionEvidence.mjs';
import { MANUAL_TRUSTED } from '../src/sessionPolicy.mjs';

const REPO = path.resolve(import.meta.dirname, '..');

/**
 * Run `fn` with a private store. The env var is restored afterwards, including
 * on a throw, or one failing test would silently redirect every later one.
 */
function withStore(fn) {
  const home = mkdtempSync(path.join(tmpdir(), 'agentbridge-wiring-'));
  const before = process.env.AGENTBRIDGE_HOME;
  process.env.AGENTBRIDGE_HOME = home;
  try {
    return fn(home);
  } finally {
    if (before === undefined) delete process.env.AGENTBRIDGE_HOME;
    else process.env.AGENTBRIDGE_HOME = before;
    rmSync(home, { recursive: true, force: true });
  }
}

/** Bind `sessionId` as owner-directed in the private store, the real way. */
function attest(sessionId) {
  assert.equal(writePendingAttestation(REPO, MANUAL_TRUSTED).ok, true);
  const bound = bindSessionProfile(REPO, sessionId);
  assert.equal(bound.ok, true, `binding failed: ${bound.reason}`);
}

const call = (toolName, input, sessionId) => evaluateClaudeTool({
  tool_name: toolName, tool_input: input, cwd: REPO, session_id: sessionId,
});

/* ───────────── the protected-path rail, both directions ───────────── */

test('an UNATTESTED session is still refused a protected control', () => withStore(() => {
  /*
   * THE POSITIVE CONTROL, AND IT COMES FIRST. If this ever passes, the
   * assertions below prove nothing: they would be measuring a guard that
   * permits everything rather than a profile that was honoured.
   */
  const r = call('Write', { file_path: 'src/claudeGuard.mjs', content: 'x' }, 'unattested-session');
  assert.equal(r.allowed, false);
  assert.equal(r.id, 'protected-control');
}));

test('an ATTESTED session may edit a guard control, and it is announced', () => withStore(() => {
  attest('manual-1');
  const r = call('Write', { file_path: 'src/claudeGuard.mjs', content: 'x' }, 'manual-1');
  assert.equal(r.allowed, true);
  assert.equal(r.overridden, true);
  assert.match(r.notice, /protected-control-by-profile/);
  /*
   * THE NOTICE MUST SAY WHICH CHANNEL PERMITTED THIS. A reader auditing the
   * transcript has to be able to tell a profile permit from a spent grant --
   * they have different provenance and different questions to ask about them.
   * The first version of this asserted the word "override" was ABSENT, which
   * failed against the sentence "No override was spent": the assertion was
   * matching the vocabulary instead of the claim.
   */
  assert.match(r.notice, /No override was spent/);
  assert.equal(r.notice.includes('protected-control-overridden'), false,
    'a profile permit must not be reported as a grant permit');
}));

test('the gate configuration is refused to an attested session too', () => withStore(() => {
  /*
   * THE HARD BOUNDARY. .claude/settings.json decides whether the guard runs at
   * all -- for this session and every later one, including autonomous workers.
   * The Stop gate refuses a grant for it, so permitting it here would spend a
   * permission and still lose the turn.
   */
  attest('manual-1');
  for (const file of ['.claude/settings.json', '.claude/settings.local.json']) {
    const r = call('Write', { file_path: file, content: '{"disableAllHooks":true}' }, 'manual-1');
    assert.equal(r.allowed, false, `${file} must stay refused`);
    assert.equal(r.id, 'protected-control');
  }
}));

test('an attestation bound to ANOTHER session does not travel', () => withStore(() => {
  attest('manual-1');
  const r = call('Write', { file_path: 'src/claudeGuard.mjs', content: 'x' }, 'some-other-session');
  assert.equal(r.allowed, false);
  assert.equal(r.id, 'protected-control');
}));

/* ───────────────────────── the shell rail ───────────────────────── */

test('the shell allowlist applies to an unattested session', () => withStore(() => {
  const r = call('Bash', { command: 'cd src' }, 'unattested-session');
  assert.equal(r.allowed, false);
  assert.equal(r.id, 'shell-not-allowlisted');
}));

test('the shell allowlist does not apply to an attested session', () => withStore(() => {
  attest('manual-1');
  // Every one of these was refused to this very session while it was written.
  for (const command of ['cd src', 'grep -n "a\\|b" src/policy.mjs', 'git clone . /tmp/x']) {
    const r = call('Bash', { command }, 'manual-1');
    assert.equal(r.allowed, true, `${command} should be permitted: ${r.reason ?? ''}`);
  }
}));

test('promotion is refused whatever the profile says', () => withStore(() => {
  attest('manual-1');
  for (const command of ['git push origin main', 'npm publish', 'supabase functions deploy mcp']) {
    const r = call('Bash', { command }, 'manual-1');
    assert.equal(r.allowed, false, `${command} must not be permitted`);
    assert.equal(r.id, 'promotion-needs-owner');
  }
}));

/* ──────────────────────── the other profiles ──────────────────────── */

test('a review session may not write at all', () => withStore(() => {
  const before = process.env.AGENTBRIDGE_REVIEW_ONLY;
  process.env.AGENTBRIDGE_REVIEW_ONLY = '1';
  try {
    // Even an ordinary, unprotected file.
    const r = call('Write', { file_path: 'docs/scratch-note.md', content: 'x' }, 'review-1');
    assert.equal(r.allowed, false);
    assert.equal(r.id, 'review-only-session');
  } finally {
    if (before === undefined) delete process.env.AGENTBRIDGE_REVIEW_ONLY;
    else process.env.AGENTBRIDGE_REVIEW_ONLY = before;
  }
}));

test('an attested session still cannot take an owner action', () => withStore(() => {
  /*
   * PRODUCTION AUTHORITY IS NOT A PROFILE QUESTION. The action rail sits ABOVE
   * the profile resolution in evaluateClaudeTool precisely so that this cannot
   * be relaxed by a later edit that consults the profile one branch too early.
   */
  attest('manual-1');
  const r = call('mcp__claude_ai_Supabase__apply_migration', { name: 'm', query: 'select 1' }, 'manual-1');
  assert.equal(r.allowed, false);
  assert.equal(r.id, 'action-needs-owner');
}));

/* ─────────────────────── the negative control ─────────────────────── */

test('NEGATIVE CONTROL: the private store really is private', () => {
  /*
   * WITHOUT withStore, the operator's live grant applies. This asserts that the
   * isolation above is doing something -- if this test and the first one agreed,
   * the store move would be decorative and every assertion in this file would be
   * measuring the ambient grant instead of the profile.
   *
   * It asserts the two verdicts DIFFER rather than pinning either, because
   * whether a live grant exists is a fact about the machine and not about this
   * code. Skipped, loudly, when there is no ambient grant to contrast with.
   */
  const ambient = call('Write', { file_path: 'src/claudeGuard.mjs', content: 'x' }, 'unattested-session');
  const isolated = withStore(() => call('Write', { file_path: 'src/claudeGuard.mjs', content: 'x' }, 'unattested-session'));

  assert.equal(isolated.allowed, false, 'the isolated store must have no grant in it');
  if (ambient.allowed) {
    assert.notDeepEqual(ambient, isolated, 'the store move changed the verdict, so it is real');
  } else {
    // No live grant on this machine: nothing to contrast, and that is not a failure.
    assert.equal(ambient.id, 'protected-control');
  }
});
