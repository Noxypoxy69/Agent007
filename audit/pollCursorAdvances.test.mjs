/**
 * THE POLL CARRIES A CURSOR, AND NOT CARRYING ONE WAS A REQUEST LOOP.
 *
 * WHY THIS EXISTS. scripts/bridge-session-poll.mjs recomputed `since` as
 * `now - 600s` on every iteration of its supervisor loop. `wait-for-work`
 * returns the moment any event sits inside that window, and the supervisor
 * re-spawns immediately because it only backs off on a FAILING status. So one
 * message meant: return instantly, respawn, return instantly, respawn — a fresh
 * node process and a /wait round trip every few hundred milliseconds, each one
 * pulling all tasks and 200 messages, for the full ten minutes the event stayed
 * inside the trailing window. Per session, per event. That script is registered
 * as a SessionStart hook for every session on this machine, so the mail the poll
 * exists to deliver was the trigger.
 *
 * WHY IT HAD NO COVERAGE, which is the more useful half. The wiring test
 * (test/bridgeSessionPoll.test.mjs) points the supervisor at an unreachable
 * host on purpose, so every cycle fails transport and the ONLY path it can
 * exercise is the error branch. The success path — the one with the defect —
 * was untested by construction, and the suite was green over it. Moving the
 * cursor decision into an exported pure function is what makes it watchable at
 * all (CLAUDE.md rule 10).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { advanceCursor } from '../scripts/bridge-session-poll.mjs';

const T0 = '2026-09-18T19:00:00.000Z';
const T1 = '2026-09-18T19:05:00.000Z';
const T2 = '2026-09-18T19:10:00.000Z';

/** Exactly what `wait-for-work` prints when a message arrives. */
const realOutput = (at) => [
  `message   from fixer [answer]  at ${at}`,
  `  cursor  ${at}`,
  '  read the details with `agentbridge workers` or the coordination log',
  '',
].join('\n');

test('THE POSITIVE FIRST: a printed cursor moves the poll forward', () => {
  /*
   * Rule 5. Every "does not move" assertion below is satisfied by a function
   * that never moves at all, which would reinstate the defect exactly.
   */
  assert.equal(advanceCursor(T0, realOutput(T1)), T1,
    'the cursor did not advance, so the next poll re-asks for the event it just received');
});

test('THE DEFECT ITSELF: a delivered event is not re-delivered', () => {
  /*
   * The whole spin in one assertion. Feed the supervisor its own output and ask
   * whether the window it would use next still contains the event it was just
   * woken by. Before the fix the answer was yes, for ten minutes.
   */
  const woken = advanceCursor(T0, realOutput(T1));
  assert.ok(Date.parse(woken) >= Date.parse(T1),
    `next poll would start at ${woken}, which is at or before the event at ${T1}: the event re-fires`);

  // And feeding the SAME output again is a no-op rather than a rewind.
  assert.equal(advanceCursor(woken, realOutput(T1)), T1, 'a repeated batch moved the cursor');
});

test('FORWARD ONLY: an older or unparseable value never rewinds the poll', () => {
  /*
   * Rewinding re-delivers everything, which is the spin with extra steps. An
   * older value is not merely useless, it is the harmful direction.
   */
  assert.equal(advanceCursor(T2, realOutput(T1)), T2, 'an older cursor rewound the poll');
  assert.equal(advanceCursor(T1, '  cursor  not-a-timestamp\n'), T1, 'an unparseable cursor was adopted');
  assert.equal(advanceCursor(T1, '  cursor  \n'), T1, 'an empty cursor was adopted');
  assert.equal(advanceCursor(T1, ''), T1, 'an empty stdout moved the cursor');
  assert.equal(advanceCursor(T1, undefined), T1, 'absent stdout moved the cursor');
  assert.equal(advanceCursor(T1, null), T1, 'null stdout moved the cursor');
});

test('THE LATEST OF SEVERAL WINS, whatever order they are printed in', () => {
  const batch = [
    `  cursor  ${T0}`,
    `  cursor  ${T2}`,
    `  cursor  ${T1}`,
    '',
  ].join('\n');
  assert.equal(advanceCursor(T0, batch), T2,
    'a later line overwrote an earlier, higher cursor — the poll would re-read the gap');
});

test('ANCHORED TO ITS OWN LINE, so the CLI\'s own prose cannot be read as data', () => {
  /*
   * CLAUDE.md rule 13, which this repository has rediscovered independently
   * three times: a loose match reads the tool's own explanatory output as if it
   * were a value. `wait-for-work` prints an advisory line right after the
   * cursor, and event lines carry timestamps too.
   */
  const noise = [
    'message   from fixer [answer]  at 2026-09-18T19:59:00.000Z',
    '  read the details with `agentbridge workers` or the coordination log',
    'assigned  t-123  lane agentbridge  at 2026-09-18T19:58:00.000Z',
    'the cursor is at 2026-09-18T19:57:00.000Z according to somebody',
    '',
  ].join('\n');
  assert.equal(advanceCursor(T0, noise), T0,
    'a timestamp from an event line or prose was adopted as the cursor');
});

test('A REAL TRANSCRIPT FROM THIS MACHINE PARSES', () => {
  /*
   * Rule 9: a fixture that cannot construct the real case cannot fail for it.
   * This is copied from an actual poll wake-up in the session that wrote this
   * file, not invented — including the two leading spaces the CLI emits.
   */
  const captured = 'message   from fixer [answer]  at 2026-09-18T18:53:38.649836+00:00\n'
    + '  cursor  2026-09-18T18:53:38.649836+00:00\n'
    + '  read the details with `agentbridge workers` or the coordination log\n';
  assert.equal(
    advanceCursor('2026-09-18T18:00:00.000Z', captured),
    '2026-09-18T18:53:38.649836+00:00',
    'the shape the CLI really prints is not recognised',
  );
});

test('THE CONTROL: this gate can actually fail', () => {
  /*
   * Rule 1. A function that returned its input unchanged would satisfy every
   * "does not move" assertion above; a function that returned any parsed
   * timestamp would satisfy every "moves" assertion. This pins that it
   * discriminates, so neither degenerate implementation passes.
   */
  assert.notEqual(advanceCursor(T0, realOutput(T1)), T0, 'advanceCursor never moves — the positives are inert');
  assert.equal(advanceCursor(T2, realOutput(T1)), T2, 'advanceCursor always moves — the guards are inert');
});
