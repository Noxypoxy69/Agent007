/**
 * TWO EVENTS IN ONE MILLISECOND, AND THE SECOND ONE WAS NEVER DELIVERED.
 *
 * Postgres `timestamptz` is microsecond precision and PostgREST hands it over
 * intact: `2026-09-18T19:30:00.123456+00:00`. `Date.parse` truncates to
 * milliseconds, so `.123456` and `.123999` both became `…123`.
 *
 * The cursor a poller sends back is an event's own `at`, and `eventsFor`
 * compares with a strict `t > after` — correct, because `>=` re-delivers the
 * event that produced the cursor forever. So once the first event set the
 * cursor, the second answered FALSE. And because the cursor only ever moves
 * forward, it answered false on every subsequent poll too. A permanent mail
 * drop, in the mechanism whose entire job is delivering mail.
 *
 * It needs two events inside one millisecond, split across batches. Rare, and
 * not a reason to leave it: a message that silently never arrives is the
 * failure nobody diagnoses, and this system routes assignments through these
 * events. Found by blind audit, 2026-09-18.
 *
 * WHY IT SURVIVED. Every fixture in the suite used millisecond timestamps —
 * `.000Z`, `.400Z` — which is a shape the real store never produces for two
 * rows in the same millisecond. Rule 9: a fixture that cannot construct the
 * real case cannot fail for it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { eventsFor } from '../src/events.mjs';
import { eventsFor as hostedEventsFor } from '../supabase/functions/mcp/_shared.js';

const SESSION = 'danny-win-b1';

/** Two messages inside one millisecond, as PostgREST really renders them. */
const AT_FIRST = '2026-09-18T19:30:00.123456+00:00';
const AT_SECOND = '2026-09-18T19:30:00.123999+00:00';

const messageAt = (at, id) => ({
  message_id: id, to_agent: 'code-b', from_agent: 'fixer',
  type: 'answer', body: 'x', created_at: at, task_id: null,
});

const SURFACES = [['src', eventsFor], ['hosted', hostedEventsFor]];

const state = (messages) => ({
  sessions: [{ agentId: 'code-b', sessionId: SESSION, lane: 'agentbridge' }],
  tasks: [],
  messages,
  actors: undefined,
});

/**
 * `eventsFor` returns the event ARRAY itself, not an envelope around it.
 *
 * The first version of this harness assumed `{ events: [...] }` and every
 * assertion died on `Cannot read properties of undefined (reading 'length')`.
 * It failed loudly rather than passing over the assumption, which is the only
 * reason it cost a minute — a helper that defaulted to `[]` on a shape
 * mismatch would have made this whole file green and inert.
 */
const deliver = (fn, messages, since) => {
  const out = fn({ ...state(messages), session_id: SESSION, agent_id: 'code-b', since });
  assert.ok(Array.isArray(out), `eventsFor returned ${typeof out}, not an array`);
  return out;
};

test('THE POSITIVE FIRST: both events are delivered when nothing has been read', () => {
  /*
   * Rule 5. "The second event arrives" is satisfied by a function that ignores
   * `since` entirely and re-delivers everything forever — which is the spin the
   * cursor exists to prevent. This pins that both are genuinely there to find.
   */
  for (const [name, fn] of SURFACES) {
    const out = deliver(fn, [messageAt(AT_FIRST, 'm1'), messageAt(AT_SECOND, 'm2')], null);
    assert.equal(out.length, 2, `${name}: expected both events, got ${out.length}`);
  }
});

test('AN EVENT IN THE SAME MILLISECOND AS THE CURSOR IS STILL DELIVERED', () => {
  /*
   * THE DEFECT, as one assertion. The poller was woken by m1, sent m1's own
   * `at` back as the cursor, and m2 — which is LATER — was silently dropped.
   * Forever, because the cursor never goes backwards.
   */
  for (const [name, fn] of SURFACES) {
    const out = deliver(fn, [messageAt(AT_FIRST, 'm1'), messageAt(AT_SECOND, 'm2')], AT_FIRST);
    const ids = out.map((e) => e.at ?? null);
    assert.equal(out.length, 1,
      `${name}: expected the later microsecond event, got ${out.length} events (${ids.join(', ')}) — `
      + 'a message that is genuinely newer than the cursor was dropped, and will never be re-offered');
  }
});

test('THE CURSOR IS STILL EXCLUSIVE — the event that produced it does not repeat', () => {
  /*
   * The direction that must NOT change. Making the comparison inclusive would
   * "fix" the drop by re-delivering the cursor event on every poll, which is
   * the hot spin this whole cursor mechanism exists to stop. The strictness is
   * correct; the precision was wrong.
   */
  for (const [name, fn] of SURFACES) {
    const out = deliver(fn, [messageAt(AT_FIRST, 'm1')], AT_FIRST);
    assert.equal(out.length, 0,
      `${name}: the event that produced the cursor came back — that is the re-delivery spin`);
  }
});

test('MILLISECOND AND SECOND PRECISION STILL BEHAVE', () => {
  /*
   * The store does not always emit six digits, and neither do older fixtures.
   * A precision fix that only works at microsecond resolution would break every
   * existing caller.
   */
  for (const [name, fn] of SURFACES) {
    const ms = '2026-09-18T19:30:00.400Z';
    const later = '2026-09-18T19:30:00.401Z';
    const whole = '2026-09-18T19:30:01Z';

    assert.equal(deliver(fn, [messageAt(later, 'm')], ms).length, 1,
      `${name}: a millisecond-later event was dropped`);
    assert.equal(deliver(fn, [messageAt(ms, 'm')], ms).length, 0,
      `${name}: a millisecond cursor stopped being exclusive`);
    assert.equal(deliver(fn, [messageAt(whole, 'm')], ms).length, 1,
      `${name}: a whole-second timestamp was dropped`);
    assert.equal(deliver(fn, [messageAt(ms, 'm')], whole).length, 0,
      `${name}: an older event was delivered`);
  }
});

test('AN UNPARSEABLE CURSOR STILL THROWS RATHER THAN REPLAYING HISTORY', () => {
  /*
   * events.mjs refuses a bad `since` on purpose: treating it as null replays
   * the whole history as new work, and a worker waking to a hundred stale
   * assignments ACTS on them. A precision change must not soften that.
   */
  for (const [name, fn] of SURFACES) {
    assert.throws(() => deliver(fn, [messageAt(AT_FIRST, 'm')], 'not-a-timestamp'),
      /not a timestamp/i, `${name}: a malformed cursor no longer throws`);
  }
});

test('THE TWO SURFACES AGREE', () => {
  const cases = [null, AT_FIRST, AT_SECOND, '2026-09-18T19:30:00.400Z'];
  for (const since of cases) {
    const a = deliver(eventsFor, [messageAt(AT_FIRST, 'm1'), messageAt(AT_SECOND, 'm2')], since);
    const b = deliver(hostedEventsFor, [messageAt(AT_FIRST, 'm1'), messageAt(AT_SECOND, 'm2')], since);
    assert.equal(a.length, b.length,
      `the surfaces disagree for since=${since}: src ${a.length} vs hosted ${b.length}`);
  }
});

test('THE CONTROL: the fixture really does straddle one millisecond', () => {
  /*
   * Rule 9, asserted rather than assumed. If someone "tidies" these fixtures to
   * millisecond precision, every assertion above keeps passing while testing
   * nothing — the exact shape that let this defect live.
   */
  assert.equal(Date.parse(AT_FIRST), Date.parse(AT_SECOND),
    'the two fixtures no longer fall inside the same millisecond; this gate is inert');
  assert.notEqual(AT_FIRST, AT_SECOND, 'the fixtures are identical');
  assert.ok(/\.\d{6}/.test(AT_FIRST) && /\.\d{6}/.test(AT_SECOND),
    'the fixtures lost their microsecond digits — the store emits six');
});
