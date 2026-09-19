/**
 * A HEADLINE THAT CONTRADICTS ITS OWN EVIDENCE IS A CONTROL NOBODY WILL BELIEVE.
 *
 * Found by blind audit against a577ba5. The Stop gate collected TWO different
 * findings into one `selfConfigAlarm` list:
 *
 *   disarmed        gateConfigArms read the file and a control is really gone.
 *   unattributable  an IGNORED settings file declares a key that could weaken
 *                   something -- while quite possibly arming every control
 *                   correctly. What is wrong is that it is not in git.
 *
 * and printed ONE sentence over both: "THE GATE'S OWN CONFIGURATION NO LONGER
 * ARMS IT". For the second case that sentence is simply false. A reader who
 * checks finds the config armed, concludes the gate is crying wolf, and learns
 * to skip it -- CLAUDE.md rule 16 by a different road, and rule 14's warning
 * that a control which cries wolf burns the credibility of every other one.
 *
 * THE FIRST ASSERTION HERE FAILS AGAINST THE SHIPPED VERSION. That is the point
 * of it -- rule 1.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { selfConfigHeadline } from '../src/guardSession.mjs';

const DISARM = { kind: 'disarmed', line: '  .claude/settings.json: Stop no longer runs the stop gate' };
const UNATTR = { kind: 'unattributable', line: '  .claude/settings.local.json: declares hooks -- a file that is not in git' };

/* ── the defect ───────────────────────────────────────────────────────── */

test('AN UNATTRIBUTABLE FILE IS NOT CALLED DISARMED', () => {
  const h = selfConfigHeadline([UNATTR]);
  assert.doesNotMatch(h, /NO LONGER ARMS IT/,
    'the gate asserted a control was off on evidence that says nothing of the kind');
  assert.match(h, /NOT IN GIT/, 'it did not say what is actually wrong');
  assert.ok(h.includes(UNATTR.line), 'the evidence line was dropped');
});

test('A REAL DISARM STILL GETS THE DISARM SENTENCE', () => {
  /*
   * THE POSITIVE FIRST, rule 5. A fix that silenced the true case as well as
   * the false one would pass the test above and destroy the control.
   */
  const h = selfConfigHeadline([DISARM]);
  assert.match(h, /NO LONGER ARMS IT/, 'a genuine disarm lost its headline');
  assert.ok(h.includes(DISARM.line));
});

test('BOTH AT ONCE GET BOTH SENTENCES, not one collapsed into the other', () => {
  /*
   * Collapsing would reintroduce the same defect pointing the other way: a real
   * disarm reported as a mere attribution problem, which is much the worse
   * direction to be wrong in.
   */
  const h = selfConfigHeadline([UNATTR, DISARM]);
  assert.match(h, /NO LONGER ARMS IT/);
  assert.match(h, /NOT IN GIT/);
  assert.ok(h.includes(DISARM.line) && h.includes(UNATTR.line), 'an entry was dropped');
  assert.ok(h.indexOf('NO LONGER ARMS IT') < h.indexOf('NOT IN GIT'),
    'the louder finding was not first');
});

/* ── the boundaries ───────────────────────────────────────────────────── */

test('NOTHING TO SAY PRINTS NOTHING', () => {
  /*
   * The caller interpolates this directly, so '' has to mean silent. A stray
   * newline or header on an empty list would put the sentence into every
   * ordinary drift message -- see the note above about crying wolf.
   */
  for (const empty of [[], null, undefined, 'nonsense', 42, [{}], [{ line: '   ' }]]) {
    assert.equal(selfConfigHeadline(empty), '', `${JSON.stringify(empty)} produced a headline`);
  }
});

test('AN UNRECOGNISED KIND IS REPORTED, NOT DROPPED', () => {
  /*
   * A third kind pushed by a future caller must not vanish from the message
   * while still blocking the turn. A refusal with no stated reason is the
   * hardest kind to act on, and this gate has produced one before.
   */
  const odd = { kind: 'something-new', line: '  .claude/settings.json: a reason from the future' };
  const h = selfConfigHeadline([odd]);
  assert.ok(h.includes(odd.line), 'a finding blocked the turn and was not printed');
  assert.match(h, /DOES NOT\s+RECOGNISE/);
});

test('A BARE STRING IS READ AS A DISARM, because that is what it used to be', () => {
  /*
   * The old list held strings and every one of them came from the arming check.
   * Anything that still pushes one must keep meaning what it meant, rather than
   * being silently discarded by the shape check.
   */
  const h = selfConfigHeadline(['  .claude/settings.json: Stop no longer runs the stop gate']);
  assert.match(h, /NO LONGER ARMS IT/);
});

test('THE CONTROL: this distinguishes, in both directions', () => {
  assert.notEqual(selfConfigHeadline([DISARM]), selfConfigHeadline([UNATTR]));
  assert.notEqual(selfConfigHeadline([DISARM]), '');
});
