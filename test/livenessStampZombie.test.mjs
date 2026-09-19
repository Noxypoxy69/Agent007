/**
 * THE ZOMBIE ROW: PERMANENTLY FRESH, PERMANENTLY DEAD, NEVER AGES OUT.
 *
 * Measured 2026-09-19 while answering the question "is capacity 'offline'
 * ABSORBING?" -- the item fixer handed code-a and then finished when code-a
 * went dark.
 *
 * THE ANSWER IS YES, AND THE SHORT-CIRCUIT IS NOT THE BUG. isLive refuses a
 * row that DECLARED capacity 'offline' before it looks at the clock, and that
 * is deliberate: dispatch.mjs:252 says a declared shutdown is a worker saying
 * so and must not be handed work. These tests pin that it STAYS that way --
 * "fixing" it by ignoring the declaration would hand work to a worker that
 * said it was leaving, which is a real regression traded for a reporting bug.
 *
 * THE BUG IS THE COMPOSITION WITH touchLiveness, which patches heartbeat_at
 * and nothing else (index.ts:258, fired from /task, /return, /wait, /review).
 * Nothing ever clears the declaration, so a deregistered session whose poll
 * supervisor outlived its SessionEnd is refreshed forever while reading dead
 * forever -- and because ageing is driven by heartbeat_at, it can never be
 * reclaimed by the staleness sweep.
 *
 * Reachable: sessionEnd only kills the supervisor when it can find AND verify
 * the pid (`if (rec && alive(rec.pid))`), and poll records are observably
 * absent while their logs remain.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT CONTAIN. A first version of this work
 * also shipped shouldStampLiveness(), a fix refusing to refresh a
 * declared-offline row. It was REVERTED: nothing in the repository could call
 * it (its only consumer is the edge function, which needs a deploy), so it was
 * an exported control nothing consults -- and it tripped two gates saying so,
 * the dead-export ratchet and the _shared.js splice check. The FINDING below is
 * the durable part; the fix belongs with the deploy that can wire it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isLive,
  observedCapacity,
  registryFromSessions,
  STALE_AFTER_MS,
} from '../src/liveRegistry.mjs';

const NOW = '2026-09-19T02:00:00Z';
const ago = (ms) => new Date(Date.parse(NOW) - ms).toISOString();

const row = (over = {}) => ({
  agent_id: 'code-a',
  session_id: 'claude-zombie',
  capacity: 'offline',
  heartbeat_at: ago(1000),
  ...over,
});

/* ── the property that must NOT change ──────────────────────────────────── */

test('a DECLARED shutdown is still refused work, however fresh its heartbeat', () => {
  assert.equal(isLive(row({ heartbeat_at: ago(1000) }), { now: NOW }), false,
    'a worker that said it is leaving must not be handed work -- dispatch.mjs:252');

  /*
   * The positive control. Without it, the assertion above passes against a
   * fixture that was never live for some unrelated reason (rule 5).
   */
  assert.equal(isLive(row({ capacity: 'idle', heartbeat_at: ago(1000) }), { now: NOW }), true,
    'precondition: the identical row with capacity idle IS live, so capacity is what decided it');
});

/* ── the defect ─────────────────────────────────────────────────────────── */

test('THE ZOMBIE: a one-second-old and a one-hour-old offline row are indistinguishable', () => {
  const fresh = row({ heartbeat_at: ago(1000) });
  const stale = row({ heartbeat_at: ago(60 * 60 * 1000) });

  assert.equal(isLive(fresh, { now: NOW }), false);
  assert.equal(isLive(stale, { now: NOW }), false);

  /*
   * This is the whole finding. Ageing is driven by heartbeat_at, and both rows
   * answer identically, so no staleness sweep can ever tell the reclaimable
   * one from the one being actively refreshed. Being refreshed forever is what
   * makes it a zombie rather than a corpse.
   */
  assert.equal(
    observedCapacity(fresh, { now: NOW }),
    observedCapacity(stale, { now: NOW }),
    'if these ever differ, the row became reclaimable and this finding is closed',
  );

  assert.ok(60 * 60 * 1000 > STALE_AFTER_MS,
    'precondition: the stale fixture really is past the window, so the comparison means something');
});

/* ── the reader, end to end ─────────────────────────────────────────────── */

test('registryFromSessions reports the zombie as offline, which is right and is not enough', () => {
  const reg = registryFromSessions([row({ heartbeat_at: ago(1000) })], { now: NOW });

  assert.equal(reg.sessions.length, 1, 'precondition: the row survived into the registry');
  assert.equal(reg.sessions[0].capacity, 'offline',
    'the READ path is correct -- a reader is told offline, which is true');

  /*
   * So the blast radius is NOT a bad assignment: every write path goes through
   * this derivation and would refuse the row. It is that the row is immortal.
   * Recorded so nobody reads "the reader is correct" as "there is nothing
   * left to do here".
   */
  assert.equal(isLive(reg.sessions[0], { now: NOW }), false,
    'and it stays offline when re-derived, so no amount of re-reading reclaims it');
});
