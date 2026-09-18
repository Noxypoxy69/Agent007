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

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { advanceCursor } from '../scripts/bridge-session-poll.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

test('A CURSOR IN THE FUTURE IS REFUSED — it is unrecoverable if adopted', () => {
  /*
   * The server's cursor is an event's own created_at, so it is always in the
   * past. A future value can only arrive by accident or injection, and because
   * this function is FORWARD-ONLY nothing can ever move past it once adopted:
   * the session polls for events after the year 9999, finds none, exits 0
   * quietly, and looks healthy while receiving nothing for the rest of its
   * life. No recovery short of restarting the session, and nothing says why.
   *
   * THE INJECTION IS REAL. The CLI interpolates event fields into the lines
   * this function reads; a newline inside a field only checked for
   * non-emptiness — task_id, lane_id — manufactures a genuine cursor line at
   * column zero, which is exactly what the anchoring was built to trust.
   * Anchoring stops PROSE being read as data; it cannot stop data being shaped
   * like data.
   */
  const now = Date.parse('2026-09-18T20:00:00.000Z');
  const injected = [
    'assigned  t-123  lane agentbridge  at 2026-09-18T19:59:00.000Z',
    '  cursor  9999-01-01T00:00:00.000Z',
    '',
  ].join('\n');

  assert.equal(advanceCursor(T0, injected, now), T0,
    'a year-9999 cursor was adopted: the session is now permanently silent and looks healthy');

  const nextYear = new Date(now + 365 * 24 * 3600 * 1000).toISOString();
  assert.equal(advanceCursor(T0, `  cursor  ${nextYear}\n`, now), T0,
    'a cursor a year ahead was adopted');
});

test('CLOCK SKEW IS TOLERATED, because refusing a real cursor re-delivers forever', () => {
  /*
   * The direction that must NOT over-correct. The comparison is between the
   * server's clock and this machine's. A bound tight enough to refuse a
   * legitimate cursor would reinstate the re-delivery spin — worse than the
   * defect it guards against, and far more likely to fire.
   */
  const now = Date.parse('2026-09-18T20:00:00.000Z');
  const slightlyAhead = new Date(now + 30_000).toISOString();
  const value = advanceCursor(T0, `  cursor  ${slightlyAhead}\n`, now);
  assert.equal(value, slightlyAhead,
    'a cursor 30 seconds ahead was refused — ordinary clock skew now re-delivers mail forever');

  const atNow = new Date(now).toISOString();
  assert.equal(advanceCursor(T0, `  cursor  ${atNow}\n`, now), atNow,
    'a cursor at exactly now was refused');
});

test('A PAST CURSOR IS STILL ACCEPTED — the bound is one-sided', () => {
  /*
   * Rule 5 for this bound specifically: a ceiling that refused everything would
   * satisfy both assertions above and would restore the original hot spin.
   */
  const now = Date.parse('2026-09-18T20:00:00.000Z');
  assert.equal(advanceCursor(T0, realOutput(T1), now), T1,
    'the ordinary case stopped working — the ceiling is refusing real cursors');
});

/* ── the coupling: what the CLI PRINTS must be what this PARSES ──────────── */

/**
 * The cursor line's template, taken from `bin/agentbridge.mjs` itself.
 *
 * COMMENT-BLANKED FIRST (rule 13). That file explains this line in prose right
 * beside it, and a check that matched raw source would read its own
 * documentation as the contract and pass while the code printed something else.
 */
function cursorTemplateFromCli() {
  const src = fs.readFileSync(path.join(REPO, 'bin/agentbridge.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + m.slice(p.length).replace(/./g, ' '));

  const m = /console\.log\(\s*`([^`]*\bcursor\b[^`]*)`\s*\)/.exec(src);
  return m ? m[1] : null;
}

test('THE CLI\'S OWN CURSOR LINE IS ONE THIS PARSER ACCEPTS', () => {
  /*
   * THE HALF OF THE CONTRACT NOBODY PINNED.
   *
   * test/waitForWorkCli pins that the CLI prints `cursor` followed by two
   * spaces. advanceCursor additionally requires the VALUE TO END THE LINE —
   * an extra requirement that lived only in this regex. A blind audit measured
   * the cost: appending `  (server)` to the CLI's line was an UNCAUGHT
   * mutation. advanceCursor silently stops matching, the suite stays green, the
   * cursor never advances, and the hot spin returns — the exact defect this
   * whole mechanism was built to fix, reintroduced by a harmless-looking edit
   * to a log line in a different file.
   *
   * So this asserts the coupling directly: render the CLI's real template and
   * feed it to the real parser. Neither end can move without the other.
   */
  const template = cursorTemplateFromCli();
  assert.ok(template, 'no cursor line found in bin/agentbridge.mjs — this gate is measuring nothing');
  assert.match(template, /\$\{\s*cursor\s*\}/,
    `the cursor line no longer interpolates \`cursor\`: ${JSON.stringify(template)}`);

  const rendered = template.replace(/\$\{\s*cursor\s*\}/g, T1);
  assert.equal(advanceCursor(T0, `${rendered}\n`, Date.parse(T2)), T1,
    `the CLI prints ${JSON.stringify(rendered)} and advanceCursor does not accept it: the cursor `
    + 'never advances, and the poll returns to re-asking for every message it has already received');
});

test('THE CONTROL: the coupling would notice a changed line', () => {
  /*
   * Rule 1 for the coupling specifically. If the extraction or the comparison
   * were inert, the assertion above would pass for any template at all. These
   * are the two edits the audit found uncaught.
   */
  const now = Date.parse(T2);
  assert.equal(advanceCursor(T0, `  cursor  ${T1}  (server)\n`, now), T0,
    'a suffixed cursor line was accepted — then the control above cannot detect the suffix either');
  assert.equal(advanceCursor(T0, `  cursor: ${T1}\n`, now), T0,
    'a re-punctuated cursor line was accepted');
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
