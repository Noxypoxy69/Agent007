/**
 * P0-5, AND THE ONE PROPERTY THAT MATTERS: AN AGENT CANNOT AUTHENTICATE ITSELF.
 *
 * The hole this replaces, measured by a blind auditor on 2026-09-20:
 *
 *     const principal = str_(process.env.AGENTBRIDGE_PRINCIPAL_ID);
 *     identity_source: principal ? IDENTITY.CREDENTIAL : IDENTITY.OBSERVED
 *
 * A non-empty environment variable WAS the credential. An author produced a
 * fully `enforced`, gate-satisfying self-audit by exporting two variables and
 * choosing two different strings -- while three comments in the module insisted
 * authorship was "bound from the active authenticated session, which is a thing
 * the author does not get to type."
 *
 * So nearly every assertion here is about what must NOT reach `credential`, and
 * the fixtures are the things an agent can actually produce.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolvePrincipal, mayWriteCredential, SOURCE, NEVER_CREDENTIAL,
} from '../src/principalResolution.mjs';

/** What the server returns when it has checked a lease it minted. */
const verified = (over = {}) => ({
  verified: true, session: 'session_01ABC', task_id: 't-42', attempt: 3, method: 'lease', ...over,
});

/* ── the positive control, first ──────────────────────────────────────── */

test('THE POSITIVE CONTROL: a server-verified lease authenticates the session', () => {
  const r = resolvePrincipal({ lease: verified(), env: { session: 'session_01ABC' } });
  assert.equal(r.source, SOURCE.CREDENTIAL, r.why);
  assert.equal(r.session, 'session_01ABC');
  assert.equal(mayWriteCredential(r), true);
  assert.match(r.why, /holds the lease/);
});

/* ── nothing an agent can produce may authenticate it ─────────────────── */

test('THE ENVIRONMENT CANNOT AUTHENTICATE, whatever it says', () => {
  /*
   * The exact hole. Every field an agent can export is present and maximal,
   * and no lease was verified.
   */
  const r = resolvePrincipal({
    env: { session: 'session_IAMTHEOWNER', principal: 'danny', agent: 'code-b' },
  });
  assert.equal(r.source, SOURCE.OBSERVED, 'an exported variable authenticated a principal');
  assert.equal(mayWriteCredential(r), false);
  assert.match(r.why, /no lease verification/);
});

test('A SOURCE THE ACTOR CONTROLS CANNOT REACH credential, generated from the real list', () => {
  /*
   * Rule 7: driven from NEVER_CREDENTIAL so a name added there arrives
   * covered. Each fixture is otherwise a PERFECT credential -- verified true,
   * a session, a task -- so the method is the only thing refusing it.
   */
  assert.ok(NEVER_CREDENTIAL.length >= 5, 'the never-list shrank; this test is weaker than it reads');
  for (const method of NEVER_CREDENTIAL) {
    for (const spelling of [method, method.toUpperCase(), `  ${method}  `]) {
      const r = resolvePrincipal({ lease: verified({ method: spelling }) });
      assert.equal(r.source, SOURCE.OBSERVED, `"${spelling}" authenticated a principal`);
      assert.equal(mayWriteCredential(r), false);
    }
  }
});

test('"verified" MUST BE EXACTLY TRUE, because truthy is a caller that did not check', () => {
  for (const v of ['true', 1, {}, [], 'yes', -1, 'verified']) {
    const r = resolvePrincipal({ lease: verified({ verified: v }) });
    assert.equal(r.source, SOURCE.UNVERIFIABLE, `verified=${JSON.stringify(v)} was accepted as proof`);
  }
  for (const v of [false, null, undefined, 0, '']) {
    assert.equal(mayWriteCredential(resolvePrincipal({ lease: verified({ verified: v }) })), false);
  }
});

test('A LEASE THAT NAMES NO SESSION AUTHENTICATES NOBODY', () => {
  for (const s of [null, undefined, '', '   ', 42]) {
    const r = resolvePrincipal({ lease: verified({ session: s }) });
    assert.equal(r.source, SOURCE.UNVERIFIABLE, `session=${JSON.stringify(s)} produced an identity`);
  }
});

/* ── the subtle one ───────────────────────────────────────────────────── */

test('A DISAGREEMENT ABOUT IDENTITY IS NOT AN AUTHENTICATED IDENTITY', () => {
  /*
   * THE CASE A CARELESS IMPLEMENTATION GETS WRONG. The lease is genuinely
   * verified and genuinely belongs to a session -- just not the one this
   * process was launched as. Trusting the server and carrying on would let a
   * process borrow an identity it can prove possession of but was not started
   * under, which is how a reviewer becomes its own author.
   */
  const r = resolvePrincipal({
    lease: verified({ session: 'session_OTHER' }),
    env: { session: 'session_01ABC' },
  });
  assert.equal(r.source, SOURCE.OBSERVED, 'a borrowed lease authenticated this process');
  assert.equal(mayWriteCredential(r), false);
  assert.match(r.why, /disagreement about identity/);

  /* But agreement, or an environment that claims nothing, is fine. */
  assert.equal(resolvePrincipal({ lease: verified(), env: {} }).source, SOURCE.CREDENTIAL);
});

/* ── absence is honest, not an error ──────────────────────────────────── */

test('NO EVIDENCE AT ALL IS UNVERIFIABLE, and does not throw', () => {
  for (const junk of [undefined, {}, { lease: null, env: null }, { lease: 'yes' }, { lease: 42 }]) {
    const r = resolvePrincipal(junk);
    assert.equal(mayWriteCredential(r), false, `${JSON.stringify(junk)} authenticated something`);
    assert.ok(typeof r.why === 'string' && r.why.length > 0, 'a refusal with no reason');
  }
  assert.equal(resolvePrincipal({}).source, SOURCE.UNVERIFIABLE);
});

test('mayWriteCredential IS A SEPARATE QUESTION, and refuses junk', () => {
  /*
   * Separate from resolvePrincipal the way admitVerification is separate from
   * decideVerify: the function that DESCRIBES a state must not be the one that
   * APPROVES on it, or each new caller re-decides the rule and one gets it
   * wrong.
   */
  for (const junk of [null, undefined, {}, { source: 'credential' }, { source: 'credential', session: '  ' }]) {
    assert.equal(mayWriteCredential(junk), false, `${JSON.stringify(junk)} was allowed to write credential`);
  }
  assert.equal(mayWriteCredential({ source: SOURCE.OBSERVED, session: 'session_x' }), false);
});

test('THE CONTROL: this distinguishes, in both directions', () => {
  /* A resolver that refused everything would satisfy every refusal above. */
  assert.equal(mayWriteCredential(resolvePrincipal({ lease: verified() })), true);
  assert.equal(mayWriteCredential(resolvePrincipal({ env: { session: 'x' } })), false);
});
