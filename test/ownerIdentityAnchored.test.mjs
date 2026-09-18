/**
 * AN OWNER DECISION MUST NAME THE ACTUAL OWNER.
 *
 * WHY THIS EXISTS. `validateDecision` required `created_by === owner_id` and
 * nothing else. Both fields arrive on the same record from the same caller, so
 * that compared a claim against itself. A coordinator writing
 * `{owner_id: "c8", created_by: "c8"}` satisfied it exactly as well as the
 * owner did, and `resolveOwnerDecision` then answered `allowed` for every
 * action it had typed into `capabilities` — `["*"]` included.
 *
 * Binding `created_by` to the authenticated token label (555ae82) closed the
 * forgery of the NAME `danny` and left minting under a DIFFERENT name wide
 * open. That commit's message said it closed the escalation. It did not, and
 * the gate it shipped with — test/ownerDecisionAuthorship.test.mjs — never
 * constructs the `owner_id === created_by === <not the owner>` case, which is
 * why it went green over a live hole.
 *
 * NOT HYPOTHETICAL. Read out of the production ledger 2026-09-18: of 33
 * decisions, two carry `owner_id: "main"` / `created_by: "main"`, and
 * `d-review-ruling-t-wire-gate-scripts-corrected-20260917` was ACTIVE, granting
 * `review.accept` at repo scope. That row is reproduced verbatim below.
 *
 * THE HOSTILE FIXTURES ARE GENERATED FROM THE REAL ROSTER (rule 7), not typed:
 * every non-owner actor the bridge knows about is tried as an owner_id. Adding
 * a seat to ACTORS extends this test without anybody remembering to.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateDecision, activeDecisions, resolveOwnerDecision, createDecision,
  isOwnerId, OWNER_IDS, revokeDecision,
} from '../src/ownerDecisions.mjs';
import {
  validateDecision as hostedValidate,
  activeDecisions as hostedActive,
  resolveOwnerDecision as hostedResolve,
  isOwnerId as hostedIsOwnerId,
  OWNER_IDS as HOSTED_OWNER_IDS,
  revokeDecision as hostedRevoke,
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
  /*
   * Rule 5. Every negative below passes against a module that refuses
   * everything, or against a fixture that stopped being a decision at all.
   * This is the assertion that stops that.
   */
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
  /*
   * `canonicalActor` resolves `owner` to `danny`, so a record spelled that way
   * means the same person. Voiding it would be a different bug: an identity
   * check that turns on spelling silently drops real rulings.
   */
  for (const [name, validate] of SURFACES) {
    assert.equal(validate(decisionBy('owner')).ok, true, `${name}: the alias "owner" was refused`);
    assert.equal(validate(decisionBy('DANNY')).ok, true, `${name}: capitalisation voided a real decision`);
    assert.equal(validate(decisionBy('  danny  ')).ok, true, `${name}: whitespace voided a real decision`);
  }
});

/**
 * Every actor that is NOT the owner, taken from the live roster.
 *
 * Includes each actor's aliases, because an alias is a spelling an attacker can
 * type just as easily as the canonical id.
 */
const ROSTER_IMPOSTORS = ACTORS
  .filter((a) => a.actor_type !== 'owner')
  .flatMap((a) => [a.actor_id, ...(a.aliases ?? [])]);

/**
 * NEAR-MISSES, DERIVED FROM THE OWNER NAMES THEMSELVES.
 *
 * WHY THE ROSTER ALONE IS NOT ENOUGH, and this is rule 7 applied properly
 * rather than recited. A blind audit mutated `isOwnerId` from an exact match to
 * a SUBSTRING match — `want.includes(o)` — and the gate stayed 9/9 green. Not
 * one assertion fired, while `not-danny`, `danny-impostor`, `c8-danny`,
 * `downer` and `chatgpt-owner` all became valid owners able to resolve
 * `deploy.production` to `allowed`.
 *
 * The reason is structural: no name in ACTORS contains `danny` or `owner` as a
 * substring, so a corpus generated from the roster can never reach a widening
 * of the matcher. Generating from the real list extends coverage as SEATS are
 * added; it says nothing about the matcher's SHAPE. `chatgpt-owner` is a
 * perfectly plausible coordinator_tokens.label.
 *
 * So these are derived from OWNER_IDS instead — still generated, not typed, so
 * adding an owner spelling extends them too.
 */
const NEAR_MISSES = [...OWNER_IDS].flatMap((o) => [
  `not-${o}`, `${o}-impostor`, `x${o}`, `${o}x`, `c8-${o}`, `${o}.evil`,
  `${o} `.repeat(2).trim(), `${o}${o}`,
]);

const IMPOSTORS = [...ROSTER_IMPOSTORS, ...NEAR_MISSES];

test('NO NON-OWNER ACTOR CAN RECORD A DECISION IN ITS OWN NAME', () => {
  assert.ok(ROSTER_IMPOSTORS.length >= 3,
    `the roster yielded only ${ROSTER_IMPOSTORS.length} non-owner names; this gate is covering almost nothing`);
  assert.ok(NEAR_MISSES.length >= 8,
    `only ${NEAR_MISSES.length} near-misses were derived; a substring match would go unnoticed`);

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
  /*
   * Rule 4: validate() returning {ok:false} is a PROXY for the grant being
   * refused. What matters is what resolveOwnerDecision answers, because that is
   * the call every worker actually makes before acting.
   */
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
  /*
   * Verbatim from get_owner_decisions, 2026-09-18, state "active". Kept as a
   * literal because it is evidence, not a fixture: this is the shape that was
   * really there, and if a later change makes it valid again the reader should
   * see exactly what got let back in.
   */
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

test('A DROPPED ROW MUST NOT RESURRECT WHAT IT SUPERSEDED', () => {
  /*
   * THE REGRESSION THIS FIX INTRODUCED, found by blind audit and reproduced
   * here before being corrected.
   *
   * `activeDecisions` computed its superseded set from the rows that had
   * already PASSED validation. So refusing a row did not merely stop it
   * granting — it also un-superseded whatever that row had replaced. A standing
   * owner DENY recorded under a non-owner name, superseding an older
   * bridge-wide ALLOW, previously resolved `denied`. After the anchor landed it
   * resolved ALLOWED, on both surfaces, and reached
   * settleOpenRequestsAgainstPolicy.
   *
   * The commit that introduced it told the reader "it fails safe: a dropped
   * allow leaves resolveOwnerDecision with nothing to match". That is true only
   * when the dropped row supersedes nothing, which is the case the fixture
   * happened to cover.
   *
   * THE RULE: an invalid row neither GRANTS nor REVIVES. It still suppresses
   * what it names, so the chain resolves to nothing and the action goes back to
   * the owner. Both directions fail closed — the alternative lets a refused row
   * hand back an ALLOW, which is the one direction that must never happen.
   */
  const older = {
    ...decisionBy('danny'),
    decision_id: 'd-old',
    effect: 'allow',
    capabilities: ['deploy.*'],
  };
  const newer = {
    ...decisionBy('main'),
    decision_id: 'd-new',
    effect: 'deny',
    capabilities: ['deploy.*'],
    supersedes: 'd-old',
  };

  for (const [name, , active, resolve] of SURFACES) {
    const live = active([older, newer]);
    assert.deepEqual(live.map((d) => d.decision_id), [],
      `${name}: refusing d-new brought d-old back to life as ${live.map((d) => d.decision_id).join(', ')}`);

    const r = resolve([older, newer], 'deploy.production');
    assert.notEqual(r.outcome, 'allowed',
      `${name}: a standing DENY was dropped and the ALLOW it replaced resurrected — `
      + 'deploy.production is now permitted by a decision the owner had already superseded');
  }
});

test('THE PRODUCTION ROW WITH ITS PREDECESSOR, which is how it really sits', () => {
  /*
   * Hollow gate 10, in the gate written one commit earlier. The fixture below
   * carries `supersedes`, and the test that shipped with the fix asserted on
   * that row ALONE in a one-element array — where `supersedes` is inert. The
   * field that reaches the divergent branch was in the fixture and the fixture
   * was too narrow to execute it.
   *
   * index.ts refuses a `supersedes` target that does not exist, so the
   * predecessor provably exists in the live ledger. This is the shape the
   * system actually produces (rule 9).
   */
  const predecessor = {
    ...decisionBy('main'),
    decision_id: 'd-review-ruling-t-wire-gate-scripts-20260917',
    scope_type: 'repo',
    scope_id: 'agentbridge',
    capabilities: ['review.accept'],
    supersedes: null,
  };
  const live = {
    ...decisionBy('main'),
    decision_id: 'd-review-ruling-t-wire-gate-scripts-corrected-20260917',
    scope_type: 'repo',
    scope_id: 'agentbridge',
    capabilities: ['review.accept'],
    supersedes: 'd-review-ruling-t-wire-gate-scripts-20260917',
  };

  for (const [name, , active, resolve] of SURFACES) {
    assert.deepEqual(active([predecessor, live]).map((d) => d.decision_id), [],
      `${name}: refusing the "main" row revived its "main" predecessor`);
    assert.notEqual(
      resolve([predecessor, live], 'review.accept', { repo: 'agentbridge' }).outcome, 'allowed',
      `${name}: review.accept is still granted, by the predecessor instead of the row`,
    );
  }
});

test('AN UNVALIDATED ROW CANNOT DELETE AN OWNER DECISION', () => {
  /*
   * THE DIRECTION I CHOSE, AND THE JUSTIFICATION I GAVE FOR IT, WAS FALSE.
   *
   * 62b3158 computes the superseded set from every surviving row WITHOUT
   * validating it, and argued that was the safe direction because "a control
   * that fails towards 'ask the owner' is recoverable". A blind audit measured
   * it: it does not fail towards the owner. A standing owner DENY suppressed by
   * a junk row resolves to `no_decision`, and for the elevated/reversible class
   * the permission layer then routes it to `decider: "coordinator"` — a PEER
   * AGENT, not Danny. I turned an unappealable owner refusal into something
   * another agent can approve, and wrote in the commit message that it failed
   * closed.
   *
   * The row does not have to be plausible. `{ supersedes: <id> }` is enough:
   * no decision_id, no statement, no scope, no capabilities, no author.
   *
   * SO AN INVALID SUPERSEDER ESCALATES RATHER THAN DELETES. The predecessor
   * still does not apply — reviving it is the resurrection 065ee23 closed — but
   * the answer is owner_required, which is a question for the owner, not
   * silence that a coordinator may fill.
   */
  const real = {
    ...decisionBy('danny'),
    decision_id: 'd-owner-deny-prod',
    effect: 'deny',
    capabilities: ['deploy.*'],
  };
  const junk = { supersedes: 'd-owner-deny-prod' };

  for (const [name, , active, resolve] of SURFACES) {
    assert.equal(resolve([real], 'deploy.production').outcome, 'denied',
      `${name}: the owner's DENY does not apply even on its own — fixture is wrong`);

    assert.deepEqual(active([real, junk]), [],
      `${name}: the suppressed decision is live again — that is the resurrection`);

    const r = resolve([real, junk], 'deploy.production');
    assert.notEqual(r.outcome, 'no_decision',
      `${name}: a bare {supersedes} object silently deleted the owner's DENY, leaving `
      + 'no_decision — which the permission layer routes to a COORDINATOR for anything reversible');
    assert.equal(r.outcome, 'owner_required',
      `${name}: expected owner_required, got ${r.outcome}`);
  }
});

test('A VALID SUPERSESSION STILL WORKS, so the fix above is not a blunt instrument', () => {
  /*
   * Rule 5 again. "Nothing is ever active" satisfies every assertion above.
   * This is the positive that stops the supersession logic being disabled
   * wholesale in the name of closing the resurrection.
   */
  const older = { ...decisionBy('danny'), decision_id: 'd-1', effect: 'deny', capabilities: ['deploy.*'] };
  const newer = {
    ...decisionBy('danny'), decision_id: 'd-2', effect: 'allow', capabilities: ['deploy.*'], supersedes: 'd-1',
  };

  for (const [name, , active, resolve] of SURFACES) {
    assert.deepEqual(active([older, newer]).map((d) => d.decision_id), ['d-2'],
      `${name}: a legitimate supersession stopped working`);
    assert.equal(resolve([older, newer], 'deploy.production').outcome, 'allowed',
      `${name}: the owner's own replacement decision does not apply`);
  }
});

test('REVOCATION IS ANCHORED TOO, ON BOTH SURFACES', () => {
  /*
   * UNGATED UNTIL AN AUDIT SAID SO, AND THE HOSTED HALF HAD NEVER LANDED.
   *
   * 62b3158 said revokeDecision was "Anchored." It was anchored in src and left
   * untouched in _shared.js — the DEPLOYED copy — so the two surfaces disagreed
   * in three directions at once. Nothing noticed because no test imported
   * revokeDecision from either file, and sharedSpliceMatches covers only
   * detectCollisions, wentStale and supervisoryReport.
   *
   * Reverting src to the old compare-against-itself form was measured as a
   * MISSED mutation: every existing fixture sets `by === owner_id`, so the old
   * and new forms agree on all of them. These are the cases where they do not.
   */
  const at = '2026-09-18T21:00:00.000Z';
  const ownerRow = decisionBy('danny');
  const mainRow = { ...decisionBy('main'), decision_id: 'd-main' };

  for (const [name, revoke] of [['src', revokeDecision], ['hosted', hostedRevoke]]) {
    assert.equal(revoke(ownerRow, { at, by: 'danny' }).ok, true,
      `${name}: the owner cannot revoke their own decision`);
    assert.equal(revoke(ownerRow, { at, by: 'owner' }).ok, true,
      `${name}: the owner's alias cannot revoke — the anchor's folding is not applied here`);
    assert.equal(revoke(ownerRow, { at, by: 'DANNY' }).ok, true,
      `${name}: capitalisation blocked a legitimate revocation`);

    assert.equal(revoke(mainRow, { at, by: 'main' }).ok, false,
      `${name}: "main" revoked its own record — the compare-against-itself form is still here`);
    assert.equal(revoke(ownerRow, { at, by: 'c8' }).ok, false,
      `${name}: a coordinator revoked the owner's decision`);
    assert.equal(revoke({ ...ownerRow, owner_id: undefined }, { at, by: 'c8' }).ok, false,
      `${name}: a row with no owner_id was revocable by anyone`);
  }
});

test('created_by IS ANCHORED INDEPENDENTLY, not compared to owner_id', () => {
  /*
   * ALSO MEASURED AS AN UNCAUGHT MUTATION. Reverting `created_by` to strict
   * equality with owner_id changed nothing in the suite, because every fixture
   * — decisionBy() included — sets the two fields to the SAME string, so both
   * forms agree on all of them. The divergent pairs are the whole reason the
   * change exists, and no test constructed one. That is hollow gate 10 again,
   * in the commit that states the lesson.
   *
   * It matters on the hosted surface specifically: created_by is not
   * caller-supplied there, it is the authenticated coordinator_tokens.label, so
   * any spelling difference from the payload's owner_id voided a real decision.
   */
  const pairs = [
    ['danny', 'danny', true],
    ['DANNY', 'danny', true],
    ['owner', 'danny', true],
    ['danny', 'owner', true],
    ['  danny  ', 'danny', true],
    ['danny', 'code-b', false],
    ['code-b', 'danny', false],
    ['main', 'main', false],
  ];

  for (const [name, validate] of SURFACES.map((s) => [s[0], s[1]])) {
    for (const [owner_id, created_by, want] of pairs) {
      const v = validate({ ...decisionBy('danny'), owner_id, created_by });
      assert.equal(v.ok, want,
        `${name}: owner_id=${JSON.stringify(owner_id)} created_by=${JSON.stringify(created_by)} `
        + `expected ok=${want}, got ${v.ok} — ${v.errors.join('; ')}`);
    }
  }
});

test('createDecision CANNOT LAUNDER IT EITHER', () => {
  /*
   * The builder is the path the CLI and the edge function both use. A record
   * that validate() refuses must not become valid by going through the
   * constructor first.
   */
  const built = createDecision({
    decision_id: 'd-built', owner_id: 'c8', statement: 'built, not hand-rolled',
    scope_type: 'bridge', effect: 'allow', capabilities: ['*'],
    created_by: 'c8', created_at: AT,
  });
  assert.equal(validateDecision(built).ok, false, 'the constructor laundered a forged owner');
});

test('THE TWO SURFACES AGREE, NAME FOR NAME', () => {
  /*
   * _shared.js is a hand-maintained splice. A fix applied to one copy and not
   * the other is the standing failure mode in this repository, and the hosted
   * copy is the one that is actually deployed.
   */
  for (const who of ['danny', 'owner', 'DANNY', 'main', 'c8', 'code-b', '', '   ']) {
    assert.equal(isOwnerId(who), hostedIsOwnerId(who), `the two surfaces disagree about "${who}"`);
    assert.equal(validateDecision(decisionBy(who)).ok, hostedValidate(decisionBy(who)).ok,
      `the two surfaces disagree about a decision by "${who}"`);
  }
  assert.deepEqual([...OWNER_IDS], [...HOSTED_OWNER_IDS], 'the two OWNER_IDS lists have drifted');
});

test('OWNER_IDS MATCHES THE ROSTER, SO THE DUPLICATION CANNOT DRIFT SILENTLY', () => {
  /*
   * src/ownerDecisions.mjs is pure by declaration and cannot import the roster,
   * so the owner names are written twice. This is the gate that holds them
   * together — CLAUDE.md's "a check script beats a comment". If somebody makes
   * a second person an owner in ACTORS, this fails until the ledger agrees.
   */
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
  /*
   * Rule 1, and rule 14 — measure the specific assertion. Every test above is
   * green if `isOwnerId` returns true for everything AND green if it returns
   * false for everything would be caught by the positive; this pins that the
   * discrimination itself is real rather than the fixtures being identical.
   */
  assert.equal(isOwnerId('danny'), true, 'the owner check refuses the owner — the positives are vacuous');
  assert.equal(isOwnerId('c8'), false, 'the owner check accepts a coordinator — the negatives are vacuous');
  assert.notEqual(
    validateDecision(decisionBy('danny')).ok,
    validateDecision(decisionBy('c8')).ok,
    'the validator cannot tell the owner from a coordinator, so every assertion above is inert',
  );
});
