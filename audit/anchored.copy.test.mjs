/* VERBATIM COPY of test/ownerIdentityAnchored.test.mjs at ed666cd, relocated to
 * audit/ so it can be executed (same directory depth, so ../src resolves).
 * Nothing changed. Verified byte-identical below the header by the auditor. */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateDecision, activeDecisions, resolveOwnerDecision, createDecision,
  isOwnerId, OWNER_IDS,
} from '../src/ownerDecisions.mjs';
import {
  validateDecision as hostedValidate,
  activeDecisions as hostedActive,
  resolveOwnerDecision as hostedResolve,
  isOwnerId as hostedIsOwnerId,
  OWNER_IDS as HOSTED_OWNER_IDS,
} from '../supabase/functions/mcp/_shared.js';
import { ACTORS } from '../src/coordination.mjs';

const AT = '2026-09-18T19:00:00.000Z';

/** A decision that is valid in every respect except the name on it. */
const decisionBy = (who, extra = {}) => ({
  decision_id: `d-probe-${String(who).toLowerCase()}`,
  owner_id: who,
  decision_type: 'policy',
  statement: 'a statement that is perfectly well formed',
  scope_type: 'bridge',
  scope_id: null,
  effect: 'allow',
  capabilities: ['*'],
  constraints: null,
  created_at: AT,
  created_by: who,
  supersedes: null,
  revoked_at: null,
  ...extra,
});

/* Both surfaces, so a fix that lands on one is not mistaken for a fix. */
const SURFACES = [
  ['src', validateDecision, activeDecisions, resolveOwnerDecision, isOwnerId, OWNER_IDS],
  ['hosted', hostedValidate, hostedActive, hostedResolve, hostedIsOwnerId, HOSTED_OWNER_IDS],
];

test('THE POSITIVE FIRST: a genuine owner decision still validates and still resolves', () => {
  for (const [name, validate, active, resolve] of SURFACES) {
    const real = decisionBy('danny');
    const v = validate(real);
    assert.deepEqual(v.errors, [], `${name}: a real owner decision was refused`);
    assert.equal(v.ok, true, `${name}: a real owner decision was refused`);

    assert.equal(active([real]).length, 1, `${name}: a real owner decision is not live`);
    assert.equal(resolve([real], 'deploy.production').outcome, 'allowed',
      `${name}: a real owner decision does not grant`);
  }
});

test('THE ALIAS THE ROSTER RECOGNISES IS STILL THE OWNER', () => {
  for (const [name, validate] of SURFACES) {
    assert.equal(validate(decisionBy('owner')).ok, true, `${name}: the alias "owner" was refused`);
    assert.equal(validate(decisionBy('DANNY')).ok, true, `${name}: capitalisation voided a real decision`);
    assert.equal(validate(decisionBy('  danny  ')).ok, true, `${name}: whitespace voided a real decision`);
  }
});

const IMPOSTORS = ACTORS
  .filter((a) => a.actor_type !== 'owner')
  .flatMap((a) => [a.actor_id, ...(a.aliases ?? [])]);

test('NO NON-OWNER ACTOR CAN RECORD A DECISION IN ITS OWN NAME', () => {
  assert.ok(IMPOSTORS.length >= 3,
    `the roster yielded only ${IMPOSTORS.length} non-owner names; this gate is covering almost nothing`);

  for (const [name, validate] of SURFACES) {
    const accepted = [];
    for (const who of IMPOSTORS) {
      const v = validate(decisionBy(who));
      if (v.ok) accepted.push(who);
    }
    assert.deepEqual(accepted, [],
      `${name}: these non-owners minted a valid bridge-wide ["*"] decision in their own name: ${accepted.join(', ')}`);
  }
});

test('THE ESCALATION IS CLOSED END TO END, NOT MERELY AT THE VALIDATOR', () => {
  for (const [name, , active, resolve] of SURFACES) {
    const forged = decisionBy('c8');

    assert.deepEqual(active([forged]), [],
      `${name}: a forged decision is live`);

    for (const action of ['deploy.production', 'merge.main', 'spend.money', 'rm.everything']) {
      const r = resolve([forged], action);
      assert.notEqual(r.outcome, 'allowed',
        `${name}: a coordinator minted authority over ${action} by naming itself the owner`);
      assert.equal(r.outcome, 'no_decision',
        `${name}: ${action} resolved to ${r.outcome}; a forged record must leave the ledger EMPTY, `
        + 'not merely unmatched');
    }
  }
});

test('THE ROW THAT IS ACTUALLY IN THE PRODUCTION LEDGER IS REFUSED', () => {
  const live = {
    decision_id: 'd-review-ruling-t-wire-gate-scripts-corrected-20260917',
    owner_id: 'main',
    decision_type: 'policy',
    statement: 'a review ruling recorded under the name "main"',
    scope_type: 'repo',
    scope_id: 'agentbridge',
    effect: 'allow',
    capabilities: ['review.accept'],
    constraints: {},
    created_at: '2026-09-17T10:14:57.766636+00:00',
    created_by: 'main',
    supersedes: 'd-review-ruling-t-wire-gate-scripts-20260917',
    revoked_at: null,
  };

  for (const [name, validate, active] of SURFACES) {
    const v = validate(live);
    assert.equal(v.ok, false, `${name}: the "main" decision still validates`);
    assert.match(v.errors.join(' '), /is not the owner/,
      `${name}: refused for the wrong reason: ${v.errors.join('; ')}`);
    assert.deepEqual(active([live]), [], `${name}: the "main" decision is still live`);
  }
});

test('createDecision CANNOT LAUNDER IT EITHER', () => {
  const built = createDecision({
    decision_id: 'd-built', owner_id: 'c8', statement: 'built, not hand-rolled',
    scope_type: 'bridge', effect: 'allow', capabilities: ['*'],
    created_by: 'c8', created_at: AT,
  });
  assert.equal(validateDecision(built).ok, false, 'the constructor laundered a forged owner');
});

test('THE TWO SURFACES AGREE, NAME FOR NAME', () => {
  for (const who of ['danny', 'owner', 'DANNY', 'main', 'c8', 'code-b', '', '   ']) {
    assert.equal(isOwnerId(who), hostedIsOwnerId(who), `the two surfaces disagree about "${who}"`);
    assert.equal(validateDecision(decisionBy(who)).ok, hostedValidate(decisionBy(who)).ok,
      `the two surfaces disagree about a decision by "${who}"`);
  }
  assert.deepEqual([...OWNER_IDS], [...HOSTED_OWNER_IDS], 'the two OWNER_IDS lists have drifted');
});

test('OWNER_IDS MATCHES THE ROSTER, SO THE DUPLICATION CANNOT DRIFT SILENTLY', () => {
  const fromRoster = ACTORS
    .filter((a) => a.actor_type === 'owner')
    .flatMap((a) => [a.actor_id, ...(a.aliases ?? [])])
    .map((s) => s.toLowerCase())
    .sort();

  assert.ok(fromRoster.length > 0, 'the roster declares no owner at all');
  assert.deepEqual([...OWNER_IDS].map((s) => s.toLowerCase()).sort(), fromRoster,
    'OWNER_IDS and the ACTORS roster disagree about who the owner is');
});

test('THE CONTROL: this gate can actually fail', () => {
  assert.equal(isOwnerId('danny'), true, 'the owner check refuses the owner — the positives are vacuous');
  assert.equal(isOwnerId('c8'), false, 'the owner check accepts a coordinator — the negatives are vacuous');
  assert.notEqual(
    validateDecision(decisionBy('danny')).ok,
    validateDecision(decisionBy('c8')).ok,
    'the validator cannot tell the owner from a coordinator, so every assertion above is inert',
  );
});
