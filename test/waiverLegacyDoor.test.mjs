/**
 * THE LEGACY WAIVER BRANCH HAD NO VALIDATION, AND I WROTE IT.
 *
 * Blind audit, 2026-09-20, finding D1 (HIGH). `c5aa5e2` taught parseLedger to
 * honour `owner_waiver: true` rows so that eight carefully-written rows would
 * stop being read as clearances. It honoured them with NONE of the checks the
 * typed `owner_bootstrap_waiver` form gets:
 *
 *   check                                   typed     owner_waiver row
 *   SHA_ONLY hex on each commit             yes       ABSENT
 *   grants_audit_pass must be false         yes       ABSENT
 *   audit_performed must be false           yes       ABSENT
 *   non-empty reason                        yes       ABSENT
 *
 * And `isWaived` prefix-matches in BOTH directions, so a one-character
 * `commit` waives every sha beginning with that character -- about a
 * sixteenth of history per row, forward as well as backward.
 *
 * THE COMMIT MESSAGE FOR THE TYPED FORM SAID, IN THE SAME FILE: "Bound to
 * explicit shas by construction: see waiverShas, which refuses anything that
 * is not bare hex, so no waiver can ever widen to cover a commit written
 * after it." That sentence was true of the branch I was looking at and false
 * of the branch I had just added. The house pattern exactly: the message
 * states the result one layer wider than the code.
 *
 * These tests are the defect, written before the fix so the fix has something
 * to turn green.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseLedger, isWaived } from '../src/auditLedger.mjs';

const FULL = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

test('D1: A ONE-CHARACTER commit MUST NOT WAIVE A SIXTEENTH OF HISTORY', () => {
  const led = parseLedger('{"commit":"a","auditor":"x","owner_waiver":true}');

  assert.equal(isWaived(led, FULL), false,
    'a legacy waiver naming the single character "a" waived an unrelated commit '
    + 'that merely starts with it. Sixteen such lines waive everything, forever, '
    + 'including commits written afterwards');
  assert.equal(led.malformed.length, 1,
    'a legacy waiver with a non-sha commit was accepted rather than reported malformed');
});

test('D1: THE HEX RULE APPLIES TO BOTH SPELLINGS, not just the typed one', () => {
  /*
   * Rule 7: generated from the same refusal surface the typed form already
   * has, so the two branches cannot drift apart again.
   */
  for (const bad of ['*', '', '   ', 'HEAD', 'HEAD~50..HEAD', 'main', 'refs/heads/main',
    'a', 'ab', 'a'.repeat(6), 'a'.repeat(41), 'g'.repeat(40), 'a*']) {
    const led = parseLedger(JSON.stringify({ commit: bad, auditor: 'x', owner_waiver: true }));
    assert.equal(led.waived.size, 0, `legacy waiver accepted a non-sha commit: ${JSON.stringify(bad)}`);
    assert.equal(led.audited.size, 0,
      `legacy waiver ${JSON.stringify(bad)} fell through and was filed as a real AUDIT`);
  }

  /* THE POSITIVE (rule 5): a real sha in the legacy form still waives. */
  const ok = parseLedger('{"commit":"6b33d7d2","auditor":"x","owner_waiver":true}');
  assert.equal(ok.waived.size, 1, 'the legacy form stopped working entirely');
  assert.equal(ok.audited.size, 0, 'the legacy form went back to being read as an audit');
});

test('D1: A LEGACY ROW CANNOT CLAIM TO GRANT A PASS EITHER', () => {
  /*
   * The typed form refuses `grants_audit_pass: true` outright -- "a shape that
   * upgrades in place is a hole with a polite name on it". The legacy form
   * accepted it and honoured the waiver anyway, so the stricter rule was
   * decoration: anyone writing the dangerous field simply used the other
   * spelling.
   */
  for (const over of [{ grants_audit_pass: true }, { audit_performed: true }]) {
    const led = parseLedger(JSON.stringify({
      commit: '6b33d7d2', auditor: 'x', owner_waiver: true, ...over,
    }));
    assert.equal(led.waived.size, 0, `legacy row honoured despite ${JSON.stringify(over)}`);
    assert.equal(led.audited.size, 0, `legacy row with ${JSON.stringify(over)} became an AUDIT`);
    assert.equal(led.malformed.length, 1, `legacy row with ${JSON.stringify(over)} was silently ignored`);
  }
});

test('D2: THE ON-DISK ASSERTION MUST READ THE ROW, not the parser own constant', () => {
  /*
   * ownerBootstrapWaiver.test.mjs loops over `led.waivers` asserting
   * `grants_audit_pass === false`. For the eight legacy rows parseLedger
   * CONSTRUCTS that field as a literal `false` and never reads the row, so for
   * eight of the nine waivers that assertion compared the parser's constant
   * with itself -- hollow gate 2, a gate agreeing with itself through the
   * thing it is checking.
   *
   * With the fix, a legacy row carrying the dangerous field is malformed and
   * never becomes a waiver at all, so the surviving waivers are ones where the
   * field was genuinely absent-or-false. This asserts the DISCRIMINATION: a
   * bad row must not appear in `waivers` wearing a manufactured `false`.
   */
  const led = parseLedger([
    '{"commit":"6b33d7d2","auditor":"x","owner_waiver":true}',
    '{"commit":"524165f9","auditor":"x","owner_waiver":true,"grants_audit_pass":true}',
  ].join('\n'));

  assert.equal(led.waivers.length, 1,
    'the row claiming to grant a pass still produced a waivers entry, and that entry '
    + 'carries a grants_audit_pass:false the parser invented rather than read');
  assert.equal(led.waivers[0].commits[0], '6b33d7d2');
});

test('D13: A MIS-CASED type IS NOT SILENTLY AN AUDIT', () => {
  /*
   * `row.type === WAIVER_TYPE` is exact. A human writing
   * "Owner_Bootstrap_Waiver" -- and this whole feature exists BECAUSE a human
   * hand-wrote waiver rows -- falls through to the audit branch and, carrying
   * commit and auditor, is filed as a clean audit. The new shape has the same
   * brittleness as the old one, one field over.
   */
  const led = parseLedger(JSON.stringify({
    type: 'Owner_Bootstrap_Waiver',
    commit: '6b33d7d2',
    auditor: 'x',
    commits: ['6b33d7d2'],
    audit_performed: false,
    grants_audit_pass: false,
    reason: 'r',
  }));
  assert.equal(led.audited.size, 0,
    'a waiver whose type differs only in casing was filed as a real audit, which is '
    + 'the exact failure this feature was built to stop');
});
