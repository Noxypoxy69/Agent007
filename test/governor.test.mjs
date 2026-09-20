/**
 * THE GOVERNOR, AND THE FOUR WAYS IT WOULD BE THEATRE.
 *
 * A single authority above every control is only worth what it is anchored
 * to, so almost every assertion here is about what the governor REFUSES to
 * treat as owner authority -- an env var, a commit trailer, a decision
 * recorded by somebody else, its own say-so. A governor that says yes when
 * asked nicely is worse than none, because the other thirteen controls would
 * then defer to it.
 *
 * The one thing it must NOT do is refuse ordinary work. That is rule 19: an
 * outage gets the layer switched off, and a layer that is off protects
 * nothing. The asymmetry is the design -- UNANCHORED costs escalation, not
 * operation -- and it is asserted in both directions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { govern, anchorState, ANCHOR, VERDICT, OWNER_ONLY } from '../src/governor.mjs';

const REAL = { verified: true, owner: 'danny', method: 'signature' };

/* ── the anchor ─────────────────────────────────────────────────────── */

test('THE POSITIVE CONTROL: a verified anchor naming an owner and a method is ANCHORED', () => {
  const a = anchorState(REAL);
  assert.equal(a.state, ANCHOR.ANCHORED, a.why);
  assert.equal(a.owner, 'danny');
  assert.equal(a.method, 'signature');
});

test('AN ENV VAR IS NOT AN ANCHOR -- this is the hole the audit actually found', () => {
  /*
   * `identity_source: CREDENTIAL` was set from process.env.AGENTBRIDGE_PRINCIPAL_ID
   * with nothing verifying it, so an author produced a gate-satisfying
   * self-audit by exporting two variables. Named explicitly so the refusal
   * cannot be removed without somebody reading why it is here.
   */
  for (const method of ['env', 'trailer', 'self']) {
    const a = anchorState({ verified: true, owner: 'danny', method });
    assert.equal(a.state, ANCHOR.UNANCHORED, `"${method}" was accepted as owner authority`);
    assert.match(a.why, /can produce/);
  }
});

test('"VERIFIED" MUST BE EXACTLY TRUE, because truthy is a caller that did not check', () => {
  for (const v of ['true', 1, {}, [], 'yes', -1]) {
    const a = anchorState({ verified: v, owner: 'danny', method: 'signature' });
    assert.equal(a.state, ANCHOR.UNANCHORED, `verified=${JSON.stringify(v)} was treated as a proof`);
  }
  for (const v of [false, null, undefined, 0, '']) {
    assert.equal(anchorState({ verified: v, owner: 'danny', method: 'signature' }).state, ANCHOR.UNANCHORED);
  }
});

test('AN ANCHOR MUST SAY HOW IT WAS VERIFIED, or nobody can judge whether it counts', () => {
  const a = anchorState({ verified: true, owner: 'danny' });
  assert.equal(a.state, ANCHOR.UNANCHORED);
  assert.match(a.why, /by what method/);
});

test('AN ANCHOR THAT NAMES NOBODY AUTHORISES NOBODY', () => {
  assert.equal(anchorState({ verified: true, method: 'signature' }).state, ANCHOR.UNANCHORED);
  assert.equal(anchorState({ verified: true, owner: '   ', method: 'signature' }).state, ANCHOR.UNANCHORED);
});

test('NO ANCHOR AT ALL IS UNANCHORED, and junk does not throw', () => {
  for (const junk of [null, undefined, 'danny', 42, []]) {
    assert.equal(anchorState(junk).state, ANCHOR.UNANCHORED, `${JSON.stringify(junk)} was an anchor`);
  }
});

/* ── the asymmetry: escalation costs, operation does not ─────────────── */

test('UNANCHORED DOES NOT STOP ORDINARY WORK -- rule 19, or the layer gets switched off', () => {
  const r = govern({ action: 'commit', actor: 'code-b' }, {});
  assert.equal(r.verdict, VERDICT.ALLOW, 'a governor with no anchor refused ordinary work; that is an outage');
  assert.equal(r.anchor, ANCHOR.UNANCHORED);
});

test('UNANCHORED DOES STOP EVERY OWNER-ONLY ACT, generated from the real list', () => {
  /*
   * Rule 7: driven from OWNER_ONLY so a new owner-only action arrives already
   * covered. A hand-typed list stops covering the module the moment somebody
   * adds an entry, and nothing goes red to say so.
   */
  assert.ok(OWNER_ONLY.length >= 5, 'the owner-only list shrank; this test is weaker than it reads');
  for (const action of OWNER_ONLY) {
    const r = govern({ action, actor: 'code-b' }, {});
    assert.equal(r.verdict, VERDICT.REQUIRES_OWNER, `${action} was decided without an owner anchor`);
    assert.match(r.why, /No agent can authorise this/);
  }
});

test('AN AGENT CANNOT SELF-AUTHORISE BY RECORDING A DECISION THAT SAYS IT MAY', () => {
  /*
   * The laundering case, and the sharpest way this module could go wrong. An
   * `allow` on the ledger must not become owner authority just because it
   * exists -- without an anchor there is nothing behind the word "owner".
   */
  const r = govern(
    { action: 'deploy.production', actor: 'code-b' },
    { decision: { effect: 'allow', decided_by: 'code-b' } },
  );
  assert.equal(r.verdict, VERDICT.REQUIRES_OWNER, 'an agent authorised a production deploy by writing a row');
});

/* ── anchored, which is where the subtle failure lives ───────────────── */

test('ANCHORED: the owner\'s own decision carries, and says by what method', () => {
  const r = govern(
    { action: 'deploy.production', actor: 'code-b' },
    { proof: REAL, decision: { effect: 'allow', decided_by: 'danny' } },
  );
  assert.equal(r.verdict, VERDICT.ALLOW, r.why);
  assert.match(r.why, /signature/);
});

test('A DECISION IS NOT OWNER AUTHORITY BECAUSE IT SITS BESIDE ONE', () => {
  /*
   * THE LAUNDERING THAT WOULD ACTUALLY GET THROUGH. A verified anchor for
   * danny plus an `allow` recorded by a coordinator is the shape where a
   * careless implementation says yes: the anchor is real, the decision is
   * real, and they have nothing to do with each other. CLAUDE.md: no
   * coordinator may approve the owner's acts on his behalf.
   */
  const r = govern(
    { action: 'merge.main', actor: 'code-b' },
    { proof: REAL, decision: { effect: 'allow', decided_by: 'chatgpt-work coordinator' } },
  );
  assert.equal(r.verdict, VERDICT.REQUIRES_OWNER, 'a coordinator approved an owner-only act beside a valid anchor');
  assert.match(r.why, /not the anchored owner/);
});

test('AN UNSIGNED "decided_by" DOES NOT MATCH BY BEING ABSENT', () => {
  /*
   * The presence-guard fail-open, which is this author's recurring bug: if
   * the comparison were skipped when decided_by is missing, an allow with no
   * author would pass.
   */
  for (const decided_by of [undefined, null, '', '   ']) {
    const r = govern(
      { action: 'spend', actor: 'x' },
      { proof: REAL, decision: { effect: 'allow', decided_by } },
    );
    assert.equal(r.verdict, VERDICT.REQUIRES_OWNER, `an allow with decided_by=${JSON.stringify(decided_by)} passed`);
  }
});

test('ANCHORED WITH NO DECISION IS STILL THE OWNER\'S CALL', () => {
  const r = govern({ action: 'destructive', actor: 'code-b' }, { proof: REAL });
  assert.equal(r.verdict, VERDICT.REQUIRES_OWNER);
  assert.match(r.why, /no decision covers it/);
});

test('AN OWNER DENY IS HONOURED IN BOTH REGIMES', () => {
  /*
   * A relayed HOLD fails safe and may be acted on immediately -- the
   * direction of the failure sets the bar. So a deny does not need an anchor
   * to be worth obeying.
   */
  assert.equal(
    govern({ action: 'deploy.production' }, { proof: REAL, decision: { effect: 'deny', decided_by: 'danny' } }).verdict,
    VERDICT.DENY,
  );
  assert.equal(
    govern({ action: 'commit' }, { decision: { effect: 'deny' } }).verdict,
    VERDICT.DENY,
    'a standing deny was ignored for an ordinary action',
  );
});

test('A STANDING require_owner ROUTES AN ORDINARY ACTION TO THE OWNER', () => {
  const r = govern({ action: 'commit' }, { decision: { effect: 'require_owner' } });
  assert.equal(r.verdict, VERDICT.REQUIRES_OWNER);
});

/* ── refusing to answer is not permitting ────────────────────────────── */

test('AN UNNAMED ACTION IS DENIED, because permitting the unnamed permits everything', () => {
  for (const action of [undefined, null, '', '  ', 42]) {
    assert.equal(govern({ action }, { proof: REAL }).verdict, VERDICT.DENY,
      `action=${JSON.stringify(action)} was not denied`);
  }
});

test('THE OWNER-ONLY LIST IS OVERRIDABLE FOR POLICY, and an override still anchors', () => {
  const r = govern({ action: 'custom.act', ownerOnly: ['custom.act'] }, {});
  assert.equal(r.verdict, VERDICT.REQUIRES_OWNER, 'a policy-supplied owner-only action was decided locally');
});
