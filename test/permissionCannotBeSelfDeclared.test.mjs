import test from 'node:test';
import assert from 'node:assert/strict';
import {
  riskOf, classifyRequest, DECIDER, RISK, hasPrefix, denies,
  OWNER_ONLY_PREFIXES, ROUTINE_PREFIXES, ELEVATED_PREFIXES,
} from '../src/permissionRequest.mjs';

/**
 * A COMPONENT MAY NOT NAME ITS WAY OUT OF THE OWNER'S GATE.
 *
 * Written by code-d against 642a941, BEFORE the fix it demands exists, so that
 * the assertion constrains the fix rather than describing it.
 *
 * THE HISTORY MATTERS, because it is the argument for the shape of this file.
 *
 *   Round 1. `Deploy.Production` with reversible:true routed to the coordinator.
 *   Two causes: hasPrefix matched case-sensitively, and reversible:true returned
 *   ROUTINE before the unknown-action default, so an unrecognised spelling landed
 *   on the caller's own declaration. Fixed in 642a941.
 *
 *   Round 2. `commit.deploy.production` routes to the coordinator. Both lists
 *   anchor at the START of a string the caller chooses, so prefixing anything
 *   allow-listed in front of an owner-only action subtracts the owner.
 *
 * Neither round was really about case, and neither was really about ordering.
 * Both were PREFIX MATCHING ON A STRING THE CALLER CONTROLS. There will be a
 * round 3 and nobody reading this has thought of it yet.
 *
 * SO THIS FILE DOES NOT ENUMERATE ATTACKS. It GENERATES them from the module's
 * own exported lists. Add an entry to OWNER_ONLY_PREFIXES and it is adversarially
 * covered on the next run without anybody remembering to cover it; add an entry
 * to ROUTINE_PREFIXES and it is immediately tried as an evasion prefix against
 * every owner-only action. An enumerated test is evidence that the attacks
 * somebody thought of fail. A generated one is evidence about the SHAPE.
 *
 * WHAT IT ASSERTS, in one sentence: if an action names an owner-only operation,
 * no spelling, casing, padding or prefix may route it anywhere but the owner.
 *
 * A DELIBERATE DECISION RECORDED HERE RATHER THAN LEFT IMPLICIT. It may turn out
 * that some prefix legitimately changes meaning -- that `read.delete.everything`
 * really is a read and really is routine. If so, that is a judgement worth making
 * ON PURPOSE: add the exemption here, named, with the reason. What must not
 * happen is that it stays true silently because a matcher looked at position zero.
 */

const NOW = '2026-09-16T00:00:00.000Z';

/** A concrete action for a list entry, whether or not it ends in a separator. */
const concrete = (p) => (p.endsWith('.') ? `${p}something` : p);

/** Spellings of one action that all mean the same operation. */
const spellings = (a) => [
  a,
  a.toUpperCase(),
  a.replace(/(^|\.)([a-z])/g, (_, s, c) => s + c.toUpperCase()),
  `  ${a}  `,
];

const decide = (action, reversible) => classifyRequest(
  { action, reversible, project: 'p', repo: 'r', lane: 'l' },
  [], { now: NOW },
);

test('NO SPELLING OF AN OWNER-ONLY ACTION ESCAPES THE OWNER', () => {
  /*
   * Round 1, generated. Every owner-only entry, every casing, padded and bare,
   * and with the caller making each of the three claims it can make about
   * reversibility. reversible:true is the self-serving one and is the reason
   * this axis is here at all.
   */
  for (const entry of OWNER_ONLY_PREFIXES) {
    for (const action of spellings(concrete(entry))) {
      for (const reversible of [true, false, undefined]) {
        const c = decide(action, reversible);
        assert.equal(
          c.decider, DECIDER.OWNER,
          `"${action}" (reversible: ${reversible}) was routed to ${c.decider}. `
          + `It names the owner-only operation "${entry}", and a caller must not be able to `
          + 're-spell its way to a smaller decider.',
        );
        assert.equal(c.risk, RISK.IRREVERSIBLE, `"${action}" was classified ${c.risk}`);
      }
    }
  }
});

test('NO PREFIX SUBTRACTS THE OWNER', () => {
  /*
   * Round 2, generated from the allow-list itself rather than from the five
   * strings that happened to occur to me. Every routine and elevated prefix is
   * tried in front of every owner-only action: those are exactly the tokens a
   * caller has to reach for, because they are the ones the module rewards.
   */
  const evasions = [...ROUTINE_PREFIXES, ...ELEVATED_PREFIXES]
    .map((p) => (p.endsWith('.') ? p.slice(0, -1) : p));

  for (const entry of OWNER_ONLY_PREFIXES) {
    const target = concrete(entry);
    for (const prefix of evasions) {
      const action = `${prefix}.${target}`;
      const c = decide(action, true);
      assert.equal(
        c.decider, DECIDER.OWNER,
        `"${action}" was routed to ${c.decider}. Putting "${prefix}" in front of `
        + `"${target}" removed the owner from a decision that is the owner's. `
        + 'A deny-list match must win wherever it appears, not only at position zero — '
        + 'otherwise authority is subtracted by naming.',
      );
    }
  }
});

test('the allow-list still works, or this file has just banned everything', () => {
  /*
   * THE POSITIVE HALF, and it is not decoration. The cheapest way to pass both
   * tests above is to route everything to the owner, which would satisfy every
   * assertion and destroy the module's purpose -- a gate that only refuses is an
   * outage. So: genuinely routine work must still be routine.
   */
  for (const entry of ROUTINE_PREFIXES) {
    const action = concrete(entry);
    const names = OWNER_ONLY_PREFIXES.some((o) => action.includes(o.replace(/\.$/, '')));
    if (names) continue; // a routine prefix that also names a denied op is the case above

    assert.equal(
      riskOf(action, {}), RISK.ROUTINE,
      `"${action}" is on the routine allow-list but did not classify as routine. `
      + 'If the fix for the two tests above reached this far, it has over-corrected.',
    );
  }

  // And the line the module drew on purpose: publishing is not local.
  assert.equal(riskOf('push', {}), RISK.ELEVATED,
    'push must stay elevated — it is the step where work stops being local');
});

test('the matcher does not depend on every list entry being lower case', () => {
  /*
   * REDUNDANT TODAY, ON PURPOSE. Every entry on every list is lower case, so
   * case-folding the LIST side currently changes nothing — and a mutation
   * removing it comes back green, which is a no-op rather than a missed catch.
   *
   * code-c made this call independently and then went one step further, which is
   * the right instinct and is why this test exists: UNTESTED BECAUSE CURRENTLY
   * REDUNDANT is how a protection quietly stops being one. The redundancy holds
   * only while every list stays lower case, and the first person to add
   * "Deploy.Production" to the deny-list would find it silently matches nothing
   * — the worst failure this file can have, because it looks like a stricter
   * list and behaves like a shorter one.
   *
   * Asserted against a mixed-case list, where the protection is load-bearing.
   */
  assert.equal(
    hasPrefix('deploy.production', ['Deploy.Production']), true,
    'a deny-list entry with capitals matched nothing — adding one would silently shorten the list',
  );
  assert.equal(
    denies('commit.deploy.production', ['DEPLOY.PRODUCTION']), true,
    'a mixed-case deny-list entry failed to match at a segment boundary',
  );
});

test('reversible may RAISE and may never LOWER', () => {
  /*
   * The property stated in prose by the module's author, asserted directly
   * rather than inferred from the cases above. A caller's claim is believed only
   * when it argues against the caller's own interest.
   */
  for (const list of [ROUTINE_PREFIXES, ELEVATED_PREFIXES]) {
    for (const entry of list) {
      const action = concrete(entry);
      const claimed = riskOf(action, { reversible: true });
      const silent = riskOf(action, {});

      assert.equal(
        claimed, silent,
        `"${action}" classified as ${claimed} when the caller declared reversible:true, `
        + `but ${silent} when it said nothing. A self-serving claim moved the answer.`,
      );
    }
  }

  /*
   * THE CASE THE LOOPS ABOVE CANNOT REACH, and the one where round 1 actually
   * happened: an action on NO list at all.
   *
   * Every entry above is on a list, so a downgrade inserted after the deny
   * checks never touches them — the earlier check answers first. An unknown
   * action is the only input that reaches the bottom of riskOf, which makes it
   * the only input that can observe the default being replaced by the caller's
   * own claim. A mutation reinstating exactly that went UNCAUGHT by this file
   * until these three lines existed.
   */
  for (const unknown of ['zzz.not.on.any.list', 'unlisted-action', 'q.w.e']) {
    assert.equal(
      riskOf(unknown, { reversible: true }), riskOf(unknown, {}),
      `"${unknown}" is on no list, and declaring reversible:true changed its classification. `
      + 'That is the caller classifying itself, which is the whole defect.',
    );
    assert.equal(
      riskOf(unknown, {}), RISK.ELEVATED,
      `"${unknown}" is unrecognised and must be ELEVATED — the header promises unknown actions are not routine`,
    );
  }

  // The one direction a caller is believed: raising.
  assert.equal(riskOf('read.tasks', { reversible: false }), RISK.IRREVERSIBLE,
    'reversible:false must still raise — it is the claim that argues against the caller');
});
