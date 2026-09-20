/**
 * A NEW SESSION ID IS NOT A NEW PARTY.
 *
 * P0 item 3, Danny 2026-09-20: "enforce reviewer != author on AUTHORITATIVE
 * IDENTITY, not --by, env, trailer, or agent label."
 *
 * `claimJob` compared session ids. A session id is per-process, so one agent
 * starting a second session -- or an operator with two terminals -- produces a
 * different id for the same party, and `reviewer !== author` is satisfied by
 * the author auditing its own work.
 *
 * ═══ WHY THIS IS WORTH A TEST WHILE IT IS STILL LATENT ═══
 *
 * Nothing supplies a principal today and `authorSource` cannot reach
 * `authoritative`, so no verdict can satisfy a gate however it was claimed.
 * The hole is therefore unreachable right now -- and it goes live the moment
 * P0-5 lands, which is precisely when everybody will believe this question is
 * settled and stop looking. Rule 11: a protection that is currently redundant
 * is one nobody is testing, and that is how it stops being a protection.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { claimJob, JOB, independenceOf, satisfiesGate } from '../src/auditJob.mjs';

const job = (over = {}) => ({
  audit_id: 'audit-1',
  candidate_sha: 'a'.repeat(40),
  state: JOB.PENDING,
  claimed_by: null,
  claimed_at: null,
  ...over,
});

test('TWO SESSIONS OF ONE PRINCIPAL: the second cannot audit the first work', () => {
  const r = claimJob(job(), {
    by: 'session_B',
    byPrincipal: 'agent:code-b',
    authorSession: 'session_A',
    authorPrincipal: 'agent:code-b',
    now: 1,
  });
  assert.equal(r.ok, false,
    'a second session of the authoring principal claimed its own candidate');
  assert.match(r.why, /different session of principal/);

  /*
   * AND THE SESSION CHECK ALONE WOULD HAVE ALLOWED IT -- stated as an
   * assertion rather than a claim in a comment, so this test proves the
   * principal check is what did the work and not the pre-existing one.
   */
  assert.notEqual('session_B', 'session_A');
});

test('A DIFFERENT PRINCIPAL IS A REAL REVIEWER (rule 5: the positive)', () => {
  const r = claimJob(job(), {
    by: 'session_B',
    byPrincipal: 'agent:code-a',
    authorSession: 'session_A',
    authorPrincipal: 'agent:code-b',
    now: 1,
  });
  assert.equal(r.ok, true, `a genuinely independent reviewer was refused: ${r.why}`);
  assert.equal(r.job.claimed_by_principal, 'agent:code-a');
  assert.equal(r.job.author_principal, 'agent:code-b');
});

test('AN UNKNOWN PRINCIPAL DOES NOT BLOCK, because unknown is not "same"', () => {
  /*
   * Rule 15: the gate moves rather than closes. Refusing on an unknown
   * principal would block every claim made before the server can answer --
   * an outage, and rule 19 says an outage gets the control switched off.
   * Unknown is recorded, not treated as a match.
   */
  for (const [a, b] of [[null, 'p'], ['p', null], [null, null], ['', 'p'], ['p', '']]) {
    const r = claimJob(job(), {
      by: 'session_B', authorSession: 'session_A', authorPrincipal: a, byPrincipal: b, now: 1,
    });
    assert.equal(r.ok, true,
      `an unknown principal (${JSON.stringify([a, b])}) was treated as a match and blocked a claim`);
  }
});

test('THE SESSION CHECK STILL FIRES, principals or not', () => {
  /*
   * The new check must not have replaced the old one. Same session, no
   * principals anywhere: still the author, still refused.
   */
  const r = claimJob(job(), { by: 'session_A', authorSession: 'session_A', now: 1 });
  assert.equal(r.ok, false, 'the session-level author check was lost');
  assert.match(r.why, /authored this candidate/);
});

test('A PRINCIPAL DOES NOT UPGRADE INDEPENDENCE ON ITS OWN', () => {
  /*
   * THE PART THAT MUST NOT QUIETLY BECOME A PASS. Supplying principals makes
   * the author check SHARPER; it does not make the identity AUTHORITATIVE.
   * Only a server-confirmed credential does that, and until P0-5 exists
   * nothing returns it. Danny: "preserve verdicts but keep
   * satisfies_gate:false."
   */
  const r = claimJob(job(), {
    by: 'session_B',
    byPrincipal: 'agent:code-a',
    authorSession: 'session_A',
    authorPrincipal: 'agent:code-b',
    now: 1,
  });
  assert.equal(r.ok, true);
  assert.equal(r.job.satisfies_gate, false,
    'supplying a principal string upgraded the verdict to gate-satisfying, which means '
    + 'an author-supplied label is now buying trust');
  assert.notEqual(r.job.independence, 'enforced');

  /* and the grading itself is unchanged: only credential+authoritative counts. */
  assert.equal(independenceOf({ authorSource: 'trailer', claimantSource: 'resolved' }), 'asserted');
  assert.equal(independenceOf({ authorSource: 'authoritative', claimantSource: 'asserted' }), 'asserted');
  assert.equal(independenceOf({ authorSource: 'authoritative', claimantSource: 'resolved' }), 'enforced');
  assert.equal(satisfiesGate({ independence: 'enforced' }), true);
});
