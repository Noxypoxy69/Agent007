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
  /*
   * LONGER THAN AN OWNER NAME — catches a matcher that widened to "contains".
   */
  `not-${o}`, `${o}-impostor`, `x${o}`, `${o}x`, `c8-${o}`, `${o}.evil`,
  `${o} `.repeat(2).trim(), `${o}${o}`,

  /*
   * SHORTER THAN AN OWNER NAME, AND THIS DIRECTION WAS COVERED BY ACCIDENT.
   *
   * An audit measured which fixtures actually caught the widening mutations
   * `o.includes(want)` and `o.startsWith(want)`. The answer was not one of the
   * near-misses above — every one of them is strictly LONGER than an owner name,
   * so none can be contained in one. What caught them were the roster entries
   * "a" and "d", the single-letter aliases of code-a and code-d. A roster
   * cleanup that dropped those aliases would silently reopen two widenings and
   * nothing here would notice.
   *
   * Coverage that depends on an unrelated list keeping an incidental property
   * is not coverage. These are derived from the owner names themselves, so the
   * direction is covered by design.
   */
  ...(o.length > 1 ? [o.slice(0, 1), o.slice(0, -1), o.slice(1)] : []),

  /*
   * SEPARATED — catches a matcher that normalises punctuation away.
   *
   * Mutating `isOwnerId` to strip non-alphanumerics before comparing was
   * UNCAUGHT: `d-a-n-n-y` and `D.A.N.N.Y` both became the owner. Every fixture
   * above differs from an owner name by ADDED WORDS, and none by interior
   * punctuation, so a normalising widening passed straight through.
   */
  o.split('').join('-'), o.split('').join('.'), o.split('').join(' '), o.split('').join('_'),
]);

const IMPOSTORS = [...ROSTER_IMPOSTORS, ...NEAR_MISSES];

test('NO NON-OWNER ACTOR CAN RECORD A DECISION IN ITS OWN NAME', () => {
  assert.ok(ROSTER_IMPOSTORS.length >= 3,
    `the roster yielded only ${ROSTER_IMPOSTORS.length} non-owner names; this gate is covering almost nothing`);
  assert.ok(NEAR_MISSES.length >= 8,
    `only ${NEAR_MISSES.length} near-misses were derived; a substring match would go unnoticed`);

  /*
   * THE CORPUS MUST COVER BOTH DIRECTIONS BY DESIGN, not by accident.
   *
   * Asserting the near-misses exist says nothing about their SHAPE. These pin
   * that the corpus contains names shorter than an owner name (so a matcher
   * widened to `owner.includes(candidate)` is reachable) and names differing
   * only by interior punctuation (so a matcher that normalises it away is
   * reachable). Without these two, the gate was relying on `code-a` and
   * `code-d` keeping their single-letter aliases.
   */
  const shortest = Math.min(...[...OWNER_IDS].map((o) => o.length));
  assert.ok(NEAR_MISSES.some((n) => n.length < shortest),
    'no near-miss is shorter than an owner name: a widening to "the owner name contains the '
    + 'candidate" cannot be reached by this corpus');
  assert.ok(NEAR_MISSES.some((n) => /[^a-z0-9]/i.test(n) && n.replace(/[^a-z0-9]/gi, '').length <= shortest),
    'no near-miss is an owner name broken up by punctuation: a matcher that strips separators '
    + 'before comparing cannot be reached by this corpus');

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

test('A DELETED DENY IS NOT MASKED BY A SURVIVING ALLOW — the ordering property', () => {
  /*
   * THE HEADLINE CLAIM OF d8f6d2b, AND IT WAS COMPLETELY UNGATED.
   *
   * That commit says the escalation is "checked BEFORE the match handling on
   * purpose — if a DENY was suppressed by junk while some other valid ALLOW
   * still matches, answering `allowed` would be the same deletion wearing a
   * result." An audit mutated the code to reinstate exactly that masking and
   * the mutation survived the DEDICATED gate and the WHOLE SUITE: no fixture
   * anywhere constructed the shape the claim is about.
   *
   * So here it is. A narrow DENY is deleted by junk; a broader ALLOW still
   * matches the same action. If ordering regresses, resolution answers
   * `allowed` and the owner's refusal is gone behind a result that looks
   * legitimate.
   */
  const denyTask = {
    ...decisionBy('danny'),
    decision_id: 'd-task-deny',
    scope_type: 'task', scope_id: 't-1',
    effect: 'deny', capabilities: ['deploy.*'],
  };
  const allowBridge = {
    ...decisionBy('danny'),
    decision_id: 'd-bridge-allow',
    scope_type: 'bridge', scope_id: null,
    effect: 'allow', capabilities: ['deploy.*'],
  };
  const junk = { supersedes: 'd-task-deny' };

  for (const [name, , , resolve] of SURFACES) {
    assert.equal(resolve([denyTask, allowBridge], 'deploy.production', { task: 't-1' }).outcome, 'denied',
      `${name}: the narrow DENY does not win on its own — the fixture cannot show masking`);

    const r = resolve([denyTask, allowBridge, junk], 'deploy.production', { task: 't-1' });
    assert.notEqual(r.outcome, 'allowed',
      `${name}: a junk row deleted the owner's DENY and the broader ALLOW answered in its place — `
      + 'the deletion is wearing a result');
    assert.equal(r.outcome, 'owner_required', `${name}: expected owner_required, got ${r.outcome}`);
  }
});

test('A VALID ROW THAT SUPERSEDES ITSELF CANNOT DELETE A DENY', () => {
  /*
   * Found by audit. Every row here VALIDATES, so the invalid-superseder check
   * never fired: a decision naming its own id in `supersedes` removed itself
   * and took the owner's ruling with it, and the permission layer routed the
   * resulting silence to a coordinator.
   */
  const selfSuperseding = {
    ...decisionBy('danny'),
    decision_id: 'd-self',
    effect: 'deny', capabilities: ['deploy.*'],
    supersedes: 'd-self',
  };
  for (const [name, , active, resolve] of SURFACES) {
    assert.deepEqual(active([selfSuperseding]), [], `${name}: a self-superseding row is somehow in force`);
    const r = resolve([selfSuperseding], 'deploy.production');
    assert.notEqual(r.outcome, 'allowed', `${name}: a self-superseding DENY resolved to allowed`);
    assert.equal(r.outcome, 'owner_required',
      `${name}: the owner's DENY vanished into ${r.outcome}, which routes reversible actions to a peer`);
  }
});

test('A CYCLE OF VALID ROWS CANNOT DELETE A DENY EITHER', () => {
  const a = {
    ...decisionBy('danny'), decision_id: 'd-a', effect: 'deny',
    capabilities: ['deploy.*'], supersedes: 'd-b',
  };
  const b = {
    ...decisionBy('danny'), decision_id: 'd-b', effect: 'deny',
    capabilities: ['deploy.*'], supersedes: 'd-a',
  };
  for (const [name, , active, resolve] of SURFACES) {
    assert.deepEqual(active([a, b]), [], `${name}: a cycle left something in force`);
    assert.equal(resolve([a, b], 'deploy.production').outcome, 'owner_required',
      `${name}: two rows replacing each other deleted the owner's DENY silently`);
  }
});

test('A REVOKED SUPERSEDER STILL RESTORES WHAT IT REPLACED', () => {
  /*
   * The direction that must NOT change. Revoking a replacement is how the owner
   * takes back a change of mind, and it must bring the original back into force
   * rather than escalate — otherwise every revocation becomes a prompt.
   */
  const original = {
    ...decisionBy('danny'), decision_id: 'd-orig', effect: 'deny', capabilities: ['deploy.*'],
  };
  const replacement = {
    ...decisionBy('danny'), decision_id: 'd-repl', effect: 'allow',
    capabilities: ['deploy.*'], supersedes: 'd-orig', revoked_at: AT,
  };
  for (const [name, , active, resolve] of SURFACES) {
    assert.deepEqual(active([original, replacement]).map((d) => d.decision_id), ['d-orig'],
      `${name}: revoking a replacement did not restore the decision it replaced`);
    assert.equal(resolve([original, replacement], 'deploy.production').outcome, 'denied',
      `${name}: a revoked replacement turned a restored DENY into something else`);
  }
});

test('A REVISION HISTORY OF ANY LENGTH STILL ANSWERS — chains of 3, 4 and 5', () => {
  /*
   * THE REGRESSION b53581b SHIPPED, AND ITS COMMIT MESSAGE CLAIMED THE
   * OPPOSITE: "A normal supersession leaves the replacement in force, so
   * nothing is orphaned and ordinary resolution is untouched."
   *
   * True for a 2-chain. FALSE from three onwards. `live` meant "valid and not
   * named in anyone's supersedes", so in A <- B <- C the middle row was not in
   * force, A's only replacement was therefore not in force, and A was reported
   * orphaned — escalating an action the owner had settled, forever, with a
   * reason naming the OLDEST id in the chain.
   *
   * THE ONLY ORDINARY-SUPERSESSION POSITIVE IN THIS FILE WAS A 2-CHAIN, which
   * is the single length where the broken predicate still gives the right
   * answer. Hollow gate 10 exactly: the fixture could not reach the branch that
   * diverged. These are the lengths that can.
   */
  const link = (id, supersedes, effect) => ({
    ...decisionBy('danny'),
    decision_id: id,
    effect,
    capabilities: ['deploy.*'],
    supersedes,
  });

  for (const [name, , active, resolve] of SURFACES) {
    for (const len of [3, 4, 5]) {
      const rows = [];
      for (let i = 0; i < len; i += 1) {
        // Last link ALLOWs; every earlier one denied, so a regression is loud.
        rows.push(link(`d-${i}`, i === 0 ? null : `d-${i - 1}`, i === len - 1 ? 'allow' : 'deny'));
      }
      const head = `d-${len - 1}`;

      assert.deepEqual(active(rows).map((d) => d.decision_id), [head],
        `${name}: a ${len}-step revision history left the wrong row in force`);

      const r = resolve(rows, 'deploy.production');
      assert.equal(r.outcome, 'allowed',
        `${name}: a ${len}-step revision history resolved ${r.outcome} instead of obeying its head `
        + `(${head}) — the owner settled this and is being asked again: ${r.reason}`);
    }
  }
});

test('A DIAMOND: replaced twice, one replacement in force', () => {
  /*
   * Two rows supersede the same victim; one is itself superseded and one
   * stands. The victim IS properly replaced and must not escalate.
   */
  const victim = { ...decisionBy('danny'), decision_id: 'd-v', effect: 'deny', capabilities: ['deploy.*'] };
  const deadBranch = {
    ...decisionBy('danny'), decision_id: 'd-x', effect: 'allow',
    capabilities: ['deploy.*'], supersedes: 'd-v',
  };
  const killsDeadBranch = {
    ...decisionBy('danny'), decision_id: 'd-y', effect: 'allow',
    capabilities: ['deploy.*'], supersedes: 'd-x',
  };
  const liveBranch = {
    ...decisionBy('danny'), decision_id: 'd-z', effect: 'allow',
    capabilities: ['deploy.*'], supersedes: 'd-v',
  };

  for (const [name, , , resolve] of SURFACES) {
    const r = resolve([victim, deadBranch, killsDeadBranch, liveBranch], 'deploy.production');
    assert.notEqual(r.outcome, 'owner_required',
      `${name}: a decision replaced by something still in force was reported abandoned: ${r.reason}`);
    assert.equal(r.outcome, 'allowed', `${name}: expected the surviving replacement to answer, got ${r.outcome}`);
  }
});

test('A CHAIN THAT ENDS IN A DEAD ROW STILL ESCALATES', () => {
  /*
   * The direction the walk must NOT lose. If the head of the chain is junk, the
   * ledger still cannot say what the owner decided, however many valid hops
   * precede it.
   */
  const a = { ...decisionBy('danny'), decision_id: 'c-a', effect: 'deny', capabilities: ['deploy.*'] };
  const b = {
    ...decisionBy('danny'), decision_id: 'c-b', effect: 'deny',
    capabilities: ['deploy.*'], supersedes: 'c-a',
  };
  const junkHead = { supersedes: 'c-b' };

  for (const [name, , , resolve] of SURFACES) {
    assert.equal(resolve([a, b, junkHead], 'deploy.production').outcome, 'owner_required',
      `${name}: a chain whose head is not a valid decision answered anyway`);
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
