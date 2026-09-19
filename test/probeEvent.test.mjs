/**
 * THE PROBE HAS TO REACH THE AGENT, OR THE MEASUREMENT IS THEATRE.
 *
 * src/livenessProbe.mjs decides four states from an answered probe and was
 * imported by nothing but its own test — an auditor flagged that under rule 17
 * and was right. The decision logic existed; the round trip did not.
 *
 * This is the delivery half: an outstanding probe becomes an ordinary event on
 * the channel the agent already polls, carrying the id it must name back.
 *
 * THE PROPERTY THAT MATTERS, and the reason this file exists rather than a
 * comment: the probe must be answerable by the AGENT and by nothing below it.
 * The supervisor never reads event bodies — "a poll that interpreted its own
 * wake-up would be a dispatcher" — so it cannot answer, and another worker
 * cannot either, because an ack that does not name the outstanding id is not an
 * ack. Delivery is what makes that reachable; the matching is tested in
 * test/livenessProbe.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { eventsFor } from '../src/events.mjs';
import { eventsFor as hostedEventsFor } from '../supabase/functions/mcp/_shared.js';

const SESSION = 'danny-win-b1';
const SURFACES = [['src', eventsFor], ['hosted', hostedEventsFor]];

const call = (fn, extra = {}) => fn({
  tasks: [],
  messages: [],
  sessions: [{ agentId: 'code-b', sessionId: SESSION, lane: 'agentbridge' }],
  session_id: SESSION,
  agent_id: 'code-b',
  since: null,
  ...extra,
});

const outstanding = {
  session_id: SESSION,
  probe_id: 'p-7f3a',
  probe_sent_at: '2026-09-19T01:00:00.000Z',
  probe_attempts: 2,
};

test('THE POSITIVE FIRST: an outstanding probe is delivered, carrying its id', () => {
  /*
   * Rule 5. Every "is not delivered" assertion below is satisfied by a function
   * that never delivers a probe at all, which is the state this commit exists
   * to change.
   */
  for (const [name, fn] of SURFACES) {
    const probes = call(fn, { session: outstanding }).filter((e) => e.kind === 'probe');
    assert.equal(probes.length, 1, `${name}: expected exactly one probe, got ${probes.length}`);
    assert.equal(probes[0].probe_id, 'p-7f3a',
      `${name}: the probe arrived without the id the agent must name back`);
    assert.equal(probes[0].answer_with, 'ack_probe',
      `${name}: the probe does not say how to answer it — an agent seeing its first probe cannot`);
    assert.equal(probes[0].attempt, 2, `${name}: the attempt number was lost`);
  }
});

test('NO PROBE OUTSTANDING MEANS NO PROBE EVENT', () => {
  /*
   * A valid ack clears probe_id, so "outstanding" and "unanswered" are the same
   * condition. If this delivered anyway, every poll would carry a stale
   * question and an agent answering it would ack a probe nobody is waiting on.
   */
  for (const [name, fn] of SURFACES) {
    for (const session of [null, undefined, {}, { probe_id: null }, { probe_id: '' }, { probe_id: '   ' }]) {
      const probes = call(fn, { session }).filter((e) => e.kind === 'probe');
      assert.equal(probes.length, 0,
        `${name}: a probe was delivered for session ${JSON.stringify(session)}`);
    }
  }
});

test('THE PROBE IS REDELIVERED ON EVERY POLL WHILE IT IS OPEN', () => {
  /*
   * THE ONE DELIBERATE DEPARTURE FROM THE CURSOR, and it is the difference
   * between a question and a fact.
   *
   * `since` filters things that HAPPENED — an assignment, a message. A probe is
   * a question that is still open. Gating it behind the cursor would mean a
   * worker that polled once, missed it, and advanced its cursor could never
   * answer, and would then be marked silent for never having been asked. So it
   * is filtered by "still outstanding", not by "newer than what you have seen".
   */
  for (const [name, fn] of SURFACES) {
    const long = call(fn, { session: outstanding, since: '2026-09-19T02:00:00.000Z' });
    assert.equal(long.filter((e) => e.kind === 'probe').length, 1,
      `${name}: a cursor AHEAD of the probe suppressed it — the agent can never answer and will `
      + 'be called silent for never being asked');
  }
});

test('A PROBE FOR A SESSION IS NOT DELIVERED TO ANOTHER', () => {
  /*
   * The caller supplies the row; this asserts the function does not invent one.
   * Handing agent A a probe minted for agent B would let A answer B's question
   * and keep a dead session looking alive — the exact forgery the id exists to
   * prevent, arriving through the front door.
   */
  for (const [name, fn] of SURFACES) {
    const events = call(fn, { session: null, session_id: SESSION });
    assert.equal(events.filter((e) => e.kind === 'probe').length, 0,
      `${name}: a probe appeared for a session that had none recorded`);
  }
});

test('THE ORDINARY EVENTS STILL WORK, and the probe does not crowd them out', () => {
  /*
   * The delivery path is shared. A change that quietly dropped assignments or
   * messages would be far worse than the liveness gap it closes.
   */
  const messages = [{
    message_id: 'm1', to_agent: 'code-b', from_agent: 'fixer',
    type: 'answer', body: 'x', created_at: '2026-09-19T01:30:00.000Z', task_id: null,
  }];
  for (const [name, fn] of SURFACES) {
    const withProbe = call(fn, { session: outstanding, messages });
    assert.equal(withProbe.filter((e) => e.kind === 'message').length, 1,
      `${name}: the message was lost when a probe was outstanding`);
    assert.equal(withProbe.filter((e) => e.kind === 'probe').length, 1,
      `${name}: the probe was lost when a message was present`);

    const withoutProbe = call(fn, { messages });
    assert.equal(withoutProbe.length, 1,
      `${name}: adding the probe branch changed the ordinary result`);
  }
});

test('THE TWO SURFACES DELIVER THE SAME PROBE', () => {
  const a = call(eventsFor, { session: outstanding }).filter((e) => e.kind === 'probe');
  const b = call(hostedEventsFor, { session: outstanding }).filter((e) => e.kind === 'probe');
  assert.deepEqual(a, b, 'the two surfaces disagree about the probe they deliver');
});

test('THE CONTROL: the probe branch really discriminates', () => {
  /*
   * Rule 1. A delivery that always emits satisfies the positive; one that never
   * emits satisfies every negative. This pins both in one place.
   */
  const emitted = call(eventsFor, { session: outstanding }).some((e) => e.kind === 'probe');
  const silent = call(eventsFor, { session: { probe_id: null } }).some((e) => e.kind === 'probe');
  assert.equal(emitted, true, 'the probe branch never fires — the positives are inert');
  assert.equal(silent, false, 'the probe branch always fires — the negatives are inert');
});
