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

import { auditEscalation, AUDIT_BEARING_EXTRAS } from '../src/auditLedger.mjs';
import { PROTECTED_PATHS } from '../src/guardSession.mjs';

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

/* ══ the narrowing dropped six controls, and the report lost half its job ══
 *
 * Both found by a blind audit of the commit that added the narrowing. The
 * first is the serious one: an allowlist of names that BLOCK is open by
 * default for everything nobody remembered to type.
 */

test('EVERY AUDIT-BEARING PATH BLOCKS UNLESS IT IS PINNED PROSE -- generated from the real lists', () => {
  /*
   * THE TEST THAT WOULD HAVE CAUGHT IT, AND THE REASON IT IS GENERATED.
   *
   * The narrowing was eleven hand-typed path names, and an auditor measured
   * the blocking set falling 23 -> 11. Six of the twelve dropped were neither
   * prose nor dependencies: both .claude settings files, any .claude hook
   * script, src/moduleGraph.mjs, src/tokenFile.mjs and test/claudeGuard.test.
   * mjs. src/moduleGraph.mjs pushed unaudited went from decision "block" to
   * approving the turn.
   *
   * So the candidates come from the REAL PROTECTED_PATHS and
   * AUDIT_BEARING_EXTRAS rather than a list typed here -- rule 7: generate the
   * fixtures from the real list, so adding an entry extends the coverage with
   * nobody remembering to. Add a control tomorrow and this test demands it
   * block, on the day it is added.
   *
   * THE EXPECTED ANSWER IS PINNED, NOT COMPUTED. Deriving it from the same
   * predicate the subject uses would be hollow gate #2 -- a check that
   * reconstructs the rule agrees with itself through any regression. EXEMPT is
   * therefore typed out, and it is the only list here that is: a new prose
   * file fails this test until somebody adds it deliberately, which is a
   * review step, and it fails in the direction where a control blocks by
   * mistake rather than one going quiet by mistake.
   */
  const EXEMPT = [
    'claude.md',
    'third_party_code.md',
    'docs/claude_guard_provenance.md',
    'docs/order.md',
    'docs/roadmap.md',
    'package.json',
    'package-lock.json',
  ];

  const candidates = [...new Set([...PROTECTED_PATHS, ...AUDIT_BEARING_EXTRAS])]
    /* A trailing slash is a PREFIX in PROTECTED_PATHS, so stand in a real member. */
    .map((p) => (String(p).endsWith('/') ? `${p}settings.json` : String(p)));
  assert.ok(candidates.length >= 20,
    `the real lists produced only ${candidates.length} candidates -- this test is not covering the repo`);

  for (const p of candidates) {
    const shouldBlock = !EXEMPT.includes(p.toLowerCase());
    const r = auditEscalation({ commits: [commit('eeee5555', { touched: [p] })], error: null }, []);
    assert.equal(Boolean(r.block), shouldBlock,
      shouldBlock
        ? `${p} is audit-bearing and is not pinned prose, so it must STOP the turn`
        : `${p} is pinned prose and must not stop a turn`);
  }
});

test('the six paths the narrowing dropped block again, each named', () => {
  /*
   * The generated test above would catch a repeat, but all it can say is
   * "one of the candidates is wrong" -- and the count is deliberately not
   * written here, because an auditor caught the previous version of this
   * comment typing 25 when the real lists yield 22. A literal count in a
   * comment invoking rule 21 is the joke writing itself.
   *
   * These are the six an auditor actually demonstrated,
   * so a future reader gets the names and not a search. Two are modules the
   * guard IMPORTS -- guardSession's own comment says "a file the guard
   * IMPORTS decides what the guard does" -- and .claude holds the
   * configuration that decides whether any hook arms at all.
   */
  for (const p of ['.claude/settings.json', '.claude/settings.local.json', '.claude/poll-hook.mjs',
    'src/moduleGraph.mjs', 'src/tokenFile.mjs', 'test/claudeGuard.test.mjs']) {
    const r = auditEscalation({ commits: [commit('ffff6666', { touched: [p] })], error: null }, []);
    assert.ok(r.block, `${p} went back to being a notice when the narrowing landed; it must block`);
    assert.match(r.block, /audit-escaped/);
  }
});

test('A BLOCKING COMMIT DOES NOT ERASE THE REPORT OF THE NON-BLOCKING ONES', () => {
  /*
   * The second finding. `notice` was set to null whenever anything blocked,
   * and `notice` is the ONLY channel naming the unaudited commits that do not
   * block. So one escaped control commit made every unaudited prose commit
   * vanish from both channels -- while the commit message claimed "the REPORT
   * still covers everything isAuditBearing covers".
   *
   * Reporting less the moment something goes wrong is backwards: that is
   * exactly when the reader needs the whole picture.
   */
  const r = auditEscalation({
    commits: [
      commit('11111111', { touched: ['src/policy.mjs'] }),
      commit('22222222', { touched: ['CLAUDE.md'] }),
      commit('33333333', { touched: ['docs/ROADMAP.md'] }),
    ],
    error: null,
  }, []);

  assert.ok(r.block, 'the control commit must still block');
  assert.match(r.block, /11111111/, 'and the block must name it');
  assert.ok(r.notice, 'the report must survive the block, not be replaced by it');
  assert.match(r.notice, /22222222/, 'the unaudited CLAUDE.md commit must still be reported');
  assert.match(r.notice, /33333333/, 'and so must the unaudited docs commit');
});

test('A MALFORMED COMMIT RECORD IS REPORTED, NOT THROWN', () => {
  /*
   * Found by blind audit. auditEscalation normalises its own inputs with a
   * comment explaining that a throw here "disables the control silently" --
   * and then hands the records to formatCoverage, which did
   * c.touched.slice(0, 4) with no guard at all.
   *
   *   touched null       -> Cannot read properties of null (reading 'slice')
   *   touched undefined  -> Cannot read properties of undefined
   *   touched 'a string' -> c.touched.slice(...).join is not a function
   *
   * In the Stop gate that whole call sits inside a catch whose entire body is
   * a comment about reporters not taking the gate down. So the throw does not
   * surface as an error: it surfaces as the ENTIRE rule-20 escalation never
   * firing, on exactly the turn where something was unusual enough to produce
   * a malformed record.
   *
   * Not reachable through auditCoverage today, which always builds arrays --
   * which is the same argument that was true of three other things in this
   * file that turned out to be reachable. A reporter that crashes reports
   * nothing, and nothing is indistinguishable from "everything is audited".
   */
  for (const touched of [null, undefined, 'src/policy.mjs', 42, {}]) {
    const coverage = { commits: [{ sha: 'aaaa1111', subject: 's', touched, audited: false }], error: null };
    assert.doesNotThrow(() => auditEscalation(coverage, []),
      `touched=${JSON.stringify(touched)} took the reporter down`);
  }

  for (const bad of [{ sha: null }, { sha: 7 }, { subject: null }, { subject: {} }]) {
    const coverage = {
      commits: [{ sha: 'aaaa1111', subject: 's', touched: ['CLAUDE.md'], audited: false, ...bad }],
      error: null,
    };
    assert.doesNotThrow(() => auditEscalation(coverage, []),
      `${JSON.stringify(bad)} took the reporter down`);
  }

  /*
   * The positive control: hardening must not have turned the reporter into a
   * thing that silently says nothing. A well-formed unaudited commit is still
   * named.
   */
  const good = auditEscalation(
    { commits: [{ sha: 'bbbb2222', subject: 'real', touched: ['CLAUDE.md'], audited: false }], error: null }, [],
  );
  assert.match(good.notice ?? '', /bbbb2222/);
  assert.match(good.notice ?? '', /CLAUDE\.md/);
});
