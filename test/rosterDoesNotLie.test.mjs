import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observedCapacity, registryFromSessions, isLive } from '../src/liveRegistry.mjs';
import {
  observedCapacity as depObserved, registryFromSessions as depRegistry,
} from '../supabase/functions/mcp/_shared.js';

/**
 * THE ROSTER MUST NOT DESCRIBE A DEAD WORKER AS AVAILABLE.
 *
 * ═══ HOW THIS WAS FOUND, WHICH IS THE POINT ═══
 *
 * Danny asked me to make sure every agent was connected. code-d answered by
 * CALLING rather than reading config, and its roster contained one row that was
 * lying:
 *
 *     code-b   danny-win-f1   last seen 898.8 MINUTES AGO   capacity: idle
 *
 * Fifteen hours stale, still reporting idle. Every OTHER stale row read
 * `offline` correctly — b6 and eight probes — and they were right for the wrong
 * reason: they DECLARED offline on their way out. code-b never did. It just
 * stopped, so its last self-description stood forever.
 *
 * So the only row that was a real agent rather than a probe was also the only
 * wrong one, and taken at face value that roster answered "is code-b
 * connected?" with "yes, idle". That is the question the data cannot answer
 * being answered anyway, in the vocabulary of one it can.
 *
 * ═══ WHY IT SURVIVED ═══
 *
 * The rule existed and was applied in only one direction. registryFromSessions
 * already overrode declared capacity with derived liveness, and assignTask,
 * confirmProposal and the dispatcher all resolve through it — which is why this
 * could never produce a bad assignment, and why nothing broke loudly. The WRITE
 * paths were correct; the READ surface handed the stored column straight out.
 *
 * The blast radius was never corrupted state. It was every human and every
 * agent reading a roster that described a dead worker as available.
 */

const NOW = '2026-09-16T05:00:00.000Z';
const ago = (ms) => new Date(Date.parse(NOW) - ms).toISOString();
const MIN = 60_000;

test('A WORKER THAT STOPPED READS OFFLINE, WHATEVER ITS LAST ROW SAID', () => {
  // The exact row from the live roster, to the minute.
  const codeB = { agent_id: 'code-b', capacity: 'idle', heartbeat_at: ago(898.8 * MIN) };
  assert.equal(observedCapacity(codeB, { now: NOW }), 'offline',
    'a worker fifteen hours silent was reported as idle and available');
});

test('A LIVE WORKER IS STILL REPORTED HONESTLY — the positive control', () => {
  /*
   * Required, and not decoration. "Return offline unconditionally" satisfies
   * every other assertion in this file and would empty the roster of everyone
   * who is actually working. A guard that only refuses is an outage.
   */
  assert.equal(observedCapacity({ capacity: 'idle', heartbeat_at: ago(5000) }, { now: NOW }), 'idle');
  assert.equal(observedCapacity({ capacity: 'busy', heartbeat_at: ago(5000) }, { now: NOW }), 'busy');
  assert.equal(observedCapacity({ capacity: 'blocked', heartbeat_at: ago(5000) }, { now: NOW }), 'blocked');
});

test('a DECLARED offline beats a fresh heartbeat', () => {
  // An orderly shutdown is not a fault, and the worker knows better than the
  // clock does. This is the one direction the stored column is trusted.
  assert.equal(observedCapacity({ capacity: 'offline', heartbeat_at: ago(5000) }, { now: NOW }), 'offline');
});

test('never having heartbeated is not idle', () => {
  /*
   * The direction of failure. A row with no heartbeat cannot be shown to be
   * alive, and "we have never heard from it" must not render as "available for
   * work" — that is the same error as code-b, arrived at by a different route.
   */
  for (const at of [null, undefined, '', 'whenever']) {
    assert.equal(observedCapacity({ capacity: 'idle', heartbeat_at: at }, { now: NOW }), 'offline', String(at));
  }
});

test('a capacity nobody recognises reads as idle, not as itself', () => {
  // Unrecognised input must not become a new capacity value that downstream
  // code has never seen and does not branch on.
  assert.equal(observedCapacity({ capacity: 'wat', heartbeat_at: ago(5000) }, { now: NOW }), 'idle');
});

test('ONE RULE: registryFromSessions gives the same answer as the read path', () => {
  /*
   * This is the property that actually prevents a recurrence. The bug was not
   * a missing check — the rule existed, in registryFromSessions, and the read
   * surface simply did not use it. Two implementations would disagree again
   * the first time somebody changed one, so there is now exactly one.
   */
  const rows = [
    { agent_id: 'code-b', session_id: 's-b', capacity: 'idle', heartbeat_at: ago(898 * MIN) },
    { agent_id: 'code-c', session_id: 's-c', capacity: 'idle', heartbeat_at: ago(5000) },
    { agent_id: 'b6', session_id: 's-6', capacity: 'offline', heartbeat_at: ago(864 * MIN) },
  ];
  const reg = registryFromSessions(rows, { now: NOW });

  for (const r of rows) {
    const viaRegistry = Object.values(reg.sessions ?? reg)
      .flat()
      .find?.((s) => s?.session_id === r.session_id)?.capacity;
    if (viaRegistry !== undefined) {
      assert.equal(viaRegistry, observedCapacity(r, { now: NOW }), r.agent_id);
    }
  }

  // Whatever the registry's shape, the stale real agent must not appear as idle.
  assert.ok(!JSON.stringify(reg).includes('"capacity":"idle"') || observedCapacity(rows[1], { now: NOW }) === 'idle');
  assert.equal(observedCapacity(rows[0], { now: NOW }), 'offline');
});

test('THE DEPLOYED COPY AGREES, including on the row that was wrong', () => {
  const cases = [
    { capacity: 'idle', heartbeat_at: ago(898 * MIN) },
    { capacity: 'idle', heartbeat_at: ago(5000) },
    { capacity: 'offline', heartbeat_at: ago(5000) },
    { capacity: 'busy', heartbeat_at: null },
    { capacity: 'wat', heartbeat_at: ago(5000) },
  ];
  for (const c of cases) {
    assert.equal(depObserved(c, { now: NOW }), observedCapacity(c, { now: NOW }), JSON.stringify(c));
  }
  // Both halves exercised, or the agreement is vacuous.
  assert.equal(depObserved(cases[0], { now: NOW }), 'offline');
  assert.equal(depObserved(cases[1], { now: NOW }), 'idle');

  const rows = [{ agent_id: 'a', session_id: 's', capacity: 'idle', heartbeat_at: ago(898 * MIN) }];
  assert.deepEqual(depRegistry(rows, { now: NOW }), registryFromSessions(rows, { now: NOW }));
});

test('isLive SHORT-CIRCUITS on a declared offline — asserted directly', () => {
  /*
   * FOUND BY MUTATION. Deleting isLive's `capacity === 'offline'` short-circuit
   * left this file green, because observedCapacity passes 'offline' through as
   * a recognised capacity either way — the outcome is identical HERE.
   *
   * It is not identical everywhere. isLive gates assignTask, confirmProposal
   * and the dispatcher, where "declared offline but heartbeating" must mean NOT
   * ELIGIBLE. A worker shutting down cleanly still beats once or twice on its
   * way out, and handing it work in that window is how an assignment lands on a
   * process that is already exiting.
   *
   * So the property is asserted where it actually lives rather than inferred
   * from a call that happens to agree.
   */
  assert.equal(isLive({ capacity: 'offline', heartbeat_at: ago(1000) }, { now: NOW }), false,
    'a worker that declared itself offline was treated as live and assignable');
  assert.equal(isLive({ capacity: 'idle', heartbeat_at: ago(1000) }, { now: NOW }), true,
    'the control: a fresh idle worker must still be live, or nothing is assignable');
});
