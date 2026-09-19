/**
 * THE DETECTOR FOR SELF-CERTIFICATION EXISTED, RAN, WAS RIGHT, AND ONLY WARNED.
 *
 * Measured 2026-09-19. `scripts/check-audit-coverage.mjs` exits 1 and names
 * every commit that changed a control with no audit recorded. The Stop gate
 * already imported auditCoverage, already called it every turn, and appended
 * the answer to `carriedNotice` -- a systemMessage. It never reached `out()`,
 * which is the only thing that blocks.
 *
 * So rule 20 was enforced by whether somebody read a notice. That night three
 * agents each certified their own work, each was wrong, and each was caught
 * only by a separate reader summoned by hand; 101 commits were pushed with 13
 * audited and nothing objected. The gate had said so, under the override-grant
 * block that everyone had stopped reading.
 *
 * WHAT THESE TESTS PIN, and the two directions matter equally:
 *
 *   it BLOCKS on unaudited control work that has been PUSHED -- the moment the
 *   work leaves this machine and other clones can build on it
 *
 *   it does NOT block on unaudited work that is still local, because that
 *   fires on the turn that writes a guard change, before an audit could
 *   possibly exist. A gate that makes ordinary work impossible gets switched
 *   off, and switching this one off loses the drift check with it.
 *
 * The second is not politeness. This repository already records the override
 * incentive as a vulnerability, and rule 16 records that a permanently red
 * gate is one people learn to ignore.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { auditEscalation } from '../src/auditLedger.mjs';

const commit = (sha, over = {}) => ({
  sha,
  subject: `subject for ${sha}`,
  touched: ['src/claudeGuard.mjs'],
  audited: false,
  auditor: null,
  ...over,
});

test('PUSHED and unaudited BLOCKS -- the work has left the machine', () => {
  const r = auditEscalation({ commits: [commit('aaaa1111')], error: null }, []);

  assert.ok(r.block, 'a pushed unaudited control commit must stop the turn, not be mentioned');
  assert.match(r.block, /audit-escaped/, 'ours must be identifiable by prefix (rule 18)');
  assert.match(r.block, /aaaa1111/, 'it must name the commit, or the reader cannot act');
  assert.match(r.block, /src\/claudeGuard\.mjs/, 'and what it touched');
  assert.equal(r.notice, null, 'a block carries its own text; a duplicate notice is noise');
});

test('LOCAL and unaudited does NOT block -- the audit is ahead of the author', () => {
  /*
   * The direction that keeps this usable. If writing a guard commit blocked
   * the very turn that wrote it, nobody could ever land one, and the gate
   * would be disabled -- taking the drift check with it.
   */
  const r = auditEscalation({ commits: [commit('bbbb2222')], error: null }, ['bbbb2222']);

  assert.equal(r.block, null, 'unpushed work must not stop the turn that produced it');
  assert.ok(r.notice, 'but it must still be reported');
  assert.match(r.notice, /audit-missing/);
});

test('a mix blocks on the escaped one only, and does not count the local one', () => {
  const r = auditEscalation(
    { commits: [commit('cccc3333'), commit('dddd4444')], error: null },
    ['dddd4444'],
  );

  assert.ok(r.block);
  assert.match(r.block, /^\[agentbridge:audit-escaped\] 1 commit/,
    'the count must be of ESCAPED commits, not of all unaudited ones');
  assert.match(r.block, /cccc3333/);
  assert.doesNotMatch(r.block, /dddd4444/, 'the local commit is not the reason for blocking');
});

test('AUDITED commits never block, however they were pushed', () => {
  const r = auditEscalation(
    { commits: [commit('eeee5555', { audited: true, auditor: 'someone-else' })], error: null },
    [],
  );

  assert.equal(r.block, null, 'a recorded audit is the whole point of the ledger');
  assert.equal(r.notice, '', 'and a clean range says nothing at all');
});

test('UNKNOWN pushed-ness does not block, and is reported as unknown rather than clean', () => {
  /*
   * null means nobody could ask git -- no upstream, detached head, a clone
   * with a different refspec. An empty array would mean "everything has been
   * pushed" and would block a fresh clone entirely, so the two must not be
   * conflated. And "could not tell" must not render as "nothing to do": that
   * conflation is the one CLAUDE.md names under check-first, where a failed
   * lookup is not an absence of prior work.
   */
  for (const cannotTell of [null, undefined, 'not-an-array']) {
    const r = auditEscalation({ commits: [commit('ffff6666')], error: null }, cannotTell);
    assert.equal(r.block, null, 'blocking on an unanswerable question is an outage');
    assert.match(r.notice, /audit-escalation-unknown/);
    assert.match(r.notice, /UNKNOWN, not clean/);
  }
});

test('a git error is carried through as unknown and never blocks', () => {
  const r = auditEscalation({ commits: [], error: 'git could not be asked' }, []);
  assert.equal(r.block, null);
  assert.match(r.notice, /audit-coverage-unknown/);
  assert.match(r.notice, /UNKNOWN, not as clean/);
});

test('sha comparison is case- and whitespace-insensitive, so a real rev-list matches', () => {
  /*
   * git prints lowercase full shas; a ledger or a caller may carry either
   * case, and rev-list output arrives with newlines already trimmed by the
   * caller but a stray space must not turn a local commit into an escaped one
   * -- which would block for a reason that is not true.
   */
  const r = auditEscalation({ commits: [commit('ABCD7777')], error: null }, ['  abcd7777 ']);
  assert.equal(r.block, null, 'the same commit in different case must be recognised as local');

  /*
   * BOTH SIDES, OR THE TEST ONLY PROVES ONE OF THEM. Found by mutation: the
   * first version varied case only on the COMMIT side, so removing
   * toLowerCase() from the unpushed side changed nothing and the mutation
   * survived. A normalisation applied to one side of a comparison is not a
   * normalisation. This case fails unless BOTH are lowered -- and failing
   * here means blocking on a commit that is actually local, which is the
   * outage direction.
   */
  const upper = auditEscalation({ commits: [commit('abcd7777')], error: null }, ['ABCD7777']);
  assert.equal(upper.block, null,
    'an uppercase entry in the unpushed list must still match a lowercase sha');
});

test('DOCS AND DEPENDENCIES DO NOT STOP A TURN -- they are reported, not blocked', () => {
  /*
   * A LIVE OUTAGE, found by blind audit. isAuditBearing derives from
   * PROTECTED_PATHS, which includes CLAUDE.md, package.json, package-lock.json
   * and docs/. Those are worth protecting a WRITE to; they are not rule-20
   * control changes needing a blind reader.
   *
   * Blocking on them stopped every turn on the operator's machine -- a
   * documentation edit (feb9f64, CLAUDE.md) and an npm-script addition
   * (43672dc, package.json) -- and because the block ran before the suite, it
   * suppressed the test gate too. A gate that stops ordinary work gets
   * switched off, and this one took the drift check with it.
   */
  for (const prose of [['CLAUDE.md'], ['package.json'], ['package-lock.json'], ['docs/ROADMAP.md']]) {
    const r = auditEscalation({ commits: [commit('aaaa1111', { touched: prose })], error: null }, []);
    assert.equal(r.block, null, `${prose[0]} must not stop a turn`);
    assert.ok(r.notice, `${prose[0]} must still be REPORTED -- unaudited is worth saying`);
    assert.match(r.notice, /audit-missing/);
  }
});

test('decision logic DOES stop a turn, and a mixed commit blocks on the code half', () => {
  /* The positive control: narrowing must not have turned the gate off. */
  for (const control of ['src/claudeGuard.mjs', 'src/shellAllowlist.mjs', 'scripts/claude-stop-gate.mjs',
    'src/policy.mjs', 'src/safeGit.mjs', 'bin/agentbridge-claude-guard.mjs']) {
    const r = auditEscalation({ commits: [commit('bbbb2222', { touched: [control] })], error: null }, []);
    assert.ok(r.block, `${control} is decision logic and must stop the turn`);
  }

  const mixed = auditEscalation(
    { commits: [commit('cccc3333', { touched: ['CLAUDE.md', 'src/guardSession.mjs'] })], error: null }, [],
  );
  assert.ok(mixed.block, 'a commit touching prose AND control must still block on the control');
});

test('path spelling does not decide it: separators and case are normalised', () => {
  const win = auditEscalation(
    { commits: [commit('dddd4444', { touched: [`src${String.fromCharCode(92)}ClaudeGuard.mjs`] })], error: null }, [],
  );
  assert.ok(win.block, 'a backslash-separated, differently-cased control path must still block');
});

test('an empty range blocks nothing and says nothing', () => {
  const r = auditEscalation({ commits: [], error: null }, []);
  assert.equal(r.block, null);
  assert.equal(r.notice, '');
});
