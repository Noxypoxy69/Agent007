import test from 'node:test';
import assert from 'node:assert/strict';
import {
  presenceOf, livenessOf, isAvailable, PRESENCE, LIVENESS,
  isLive, observedCapacity, registryFromSessions, STALE_AFTER_MS,
} from '../src/liveRegistry.mjs';
import {
  presenceOf as depPresence, livenessOf as depLiveness, isAvailable as depAvailable,
  registryFromSessions as depRegistry,
} from '../supabase/functions/mcp/_shared.js';

/**
 * PRESENCE IS OWNER INTENT. LIVENESS IS HEARTBEAT AGE. THEY ARE NOT ONE FACT.
 *
 * ═══ THE CONFLATION ═══
 *
 * Two different things currently render as the same word:
 *
 *     code-b   stopped reporting           ->  'offline'
 *     b6       DECLARED offline, leaving   ->  'offline'
 *
 * test/rosterDoesNotLie.test.mjs states the distinction in its own prose --
 * "they DECLARED offline on their way out. code-b never did" -- and then encodes
 * both as one token, so no consumer can act on the difference.
 *
 * It matters because the two call for OPPOSITE responses. A worker that declared
 * offline is gone by intent: leave it, it did what it meant to. A worker that
 * went silent while the owner still intends it to be there is a FAULT: chase it,
 * restart it, tell somebody. Collapsed into one word, a fault is indistinguishable
 * from an orderly shutdown -- which is why code-b sat dead for fifteen hours and
 * nothing anywhere raised its hand.
 *
 * ═══ THE RULE ═══
 *
 * A missed heartbeat is evidence about LIVENESS. It is not the owner changing
 * their mind. So presence must never be computed from the clock, and this file
 * asserts that as a property rather than a spelling.
 *
 * ═══ WHAT IS DELIBERATELY NOT CLAIMED ═══
 *
 * Nothing here loosens who may receive work. Availability is asserted FIRST in
 * every case below, so none of these tests can ever be satisfied by making a
 * dead worker assignable. That direction is the whole risk of this change.
 */

const NOW = '2026-09-16T05:00:00.000Z';
const ago = (ms) => new Date(Date.parse(NOW) - ms).toISOString();

const row = (over = {}) => ({
  agent_id: 'code-b',
  session_id: 'danny-win-f1',
  capacity: 'idle',
  heartbeat_at: ago(1_000),
  ...over,
});

const WENT_SILENT = row({ capacity: 'idle', heartbeat_at: ago(STALE_AFTER_MS + 60_000) });
const DECLARED_OFFLINE = row({ capacity: 'offline', heartbeat_at: ago(1_000) });
const HEALTHY = row({ capacity: 'idle', heartbeat_at: ago(5_000) });

// ── the separation itself ──────────────────────────────────────────────────

test('PRESENCE NEVER READS THE CLOCK', () => {
  // Positive control first: presence must be capable of saying DEPARTED at all,
  // or "always present" would satisfy the real assertion while meaning nothing.
  assert.equal(presenceOf(DECLARED_OFFLINE), PRESENCE.DEPARTED,
    'a worker that declared offline must read as departed');

  assert.equal(presenceOf(WENT_SILENT), PRESENCE.PRESENT,
    'a missed heartbeat was read as the owner withdrawing the agent');

  // The rule in one line: move ONLY the heartbeat, presence must not move.
  assert.equal(presenceOf(WENT_SILENT), presenceOf({ ...WENT_SILENT, heartbeat_at: ago(1_000) }),
    'presence changed when only the heartbeat changed');
  assert.equal(presenceOf(HEALTHY), PRESENCE.PRESENT);
});

test('PRESENCE IS THE WORKER\'S OWN WORD, NOT THE OWNER\'S — the limit, pinned', () => {
  /*
   * THIS TEST EXISTS TO STOP A FIELD BEING READ AS MORE THAN IT IS.
   *
   * The contract says presence = owner intent. This module does NOT deliver
   * that, and the gap is load-bearing: migration 20260915122811 records that
   * there is exactly ONE registration token shared by every worker, and
   * `registered_by` ships the comment "PROVENANCE ONLY -- never an
   * authorization check". So nothing readable from a session distinguishes one
   * worker from another, and nothing carries the owner's intent at all.
   *
   * A session can therefore take ITSELF out and cannot put itself in. That
   * asymmetry is the only safe reading, and it is asserted here so that a later
   * change granting a session the power to assert its own presence has to
   * delete an assertion that says why it must not.
   */
  const anySession = { agent_id: 'anyone', capacity: 'idle', heartbeat_at: ago(5_000) };

  // A session can remove itself -- the one direction its own word is trusted.
  assert.equal(presenceOf({ ...anySession, capacity: 'offline' }), PRESENCE.DEPARTED);

  // And every other self-description reads PRESENT, which is exactly why this
  // is not owner intent: presence is the default, not something granted.
  for (const declared of ['idle', 'busy', 'blocked', 'wat', undefined, null]) {
    assert.equal(presenceOf({ ...anySession, capacity: declared }), PRESENCE.PRESENT,
      `capacity ${String(declared)} should not have been able to claim more than PRESENT`);
  }
});

test('LIVENESS IS HEARTBEAT AGE AND NOTHING ELSE', () => {
  assert.equal(livenessOf(HEALTHY, { now: NOW }), LIVENESS.LIVE);
  assert.equal(livenessOf(WENT_SILENT, { now: NOW }), LIVENESS.STALE);

  // A declared-offline worker that is still beating is LIVE. Its own statement
  // is about availability, not about whether the process is running -- and
  // folding it in here would rebuild the conflation from the other side.
  assert.equal(livenessOf(DECLARED_OFFLINE, { now: NOW }), LIVENESS.LIVE,
    'a declared-offline worker with a fresh heartbeat was reported as not running');

  // No evidence is its own answer, never LIVE and never STALE.
  for (const at of [null, undefined, '', 'whenever']) {
    assert.equal(livenessOf(row({ heartbeat_at: at }), { now: NOW }), LIVENESS.UNKNOWN, String(at));
  }
});

test('A FAULT IS DISTINGUISHABLE FROM AN ORDERLY SHUTDOWN', () => {
  // Neither may receive work. Asserted BEFORE the distinction, so this test can
  // never pass by making either one assignable.
  assert.equal(isAvailable(WENT_SILENT, { now: NOW }), false, 'a silent worker became assignable');
  assert.equal(isAvailable(DECLARED_OFFLINE, { now: NOW }), false, 'a declared-offline worker became assignable');

  // And yet a reader can tell which is which.
  assert.notDeepEqual(
    { presence: presenceOf(WENT_SILENT), liveness: livenessOf(WENT_SILENT, { now: NOW }) },
    { presence: presenceOf(DECLARED_OFFLINE), liveness: livenessOf(DECLARED_OFFLINE, { now: NOW }) },
    'a fault and an orderly shutdown are still indistinguishable',
  );
});

// ── availability is unchanged, which is the safety claim ───────────────────

test('AVAILABILITY IS EXACTLY WHAT isLive ALREADY MEANT — no row changed side', () => {
  /*
   * The risk in separating these concepts is that "may receive work" quietly
   * widens. This asserts the truth table is IDENTICAL, over the cases that
   * decide assignment, rather than asserting it in prose.
   */
  const cases = [
    HEALTHY,
    WENT_SILENT,
    DECLARED_OFFLINE,
    row({ capacity: 'busy', heartbeat_at: ago(5_000) }),
    row({ capacity: 'blocked', heartbeat_at: ago(5_000) }),
    row({ capacity: 'idle', heartbeat_at: null }),
    row({ capacity: 'idle', heartbeat_at: 'not-a-date' }),
    row({ capacity: 'idle', heartbeat_at: ago(-60_000) }),   // a heartbeat from the future
    row({ capacity: 'wat', heartbeat_at: ago(5_000) }),
  ];
  for (const c of cases) {
    assert.equal(isAvailable(c, { now: NOW }), isLive(c, { now: NOW }), JSON.stringify(c));
  }

  // Both verdicts must actually occur, or the agreement above is vacuous.
  assert.equal(isAvailable(HEALTHY, { now: NOW }), true);
  assert.equal(isAvailable(WENT_SILENT, { now: NOW }), false);
});

test('THE DISPATCH TOKEN IS UNCHANGED: a stale row still reads offline to resolveWorker', () => {
  /*
   * src/laneRegistry.mjs admits any session whose capacity !== 'offline'. That
   * filter is NOT in this slice, so the capacity emitted by registryFromSessions
   * must keep its exact meaning or a stale worker becomes resolvable -- work
   * assigned to a process that is not there.
   *
   * This is the assertion that stops the new vocabulary leaking into the
   * dispatch path.
   */
  const reg = registryFromSessions([WENT_SILENT], { now: NOW });
  assert.equal(reg.sessions[0].capacity, 'offline',
    'a stale session stopped reading offline, so resolveWorker would now admit it');
  assert.equal(observedCapacity(WENT_SILENT, { now: NOW }), 'offline');
});

test('THE REGISTRY CARRIES THE SEPARATION, so a reader need not recompute it', () => {
  /*
   * The original defect was a second implementation at the read site. The
   * separated facts are therefore emitted by the same function that computes
   * the dispatch token, not left for each consumer to derive.
   */
  const reg = registryFromSessions([WENT_SILENT, DECLARED_OFFLINE, HEALTHY].map((r, i) => ({
    ...r, session_id: `s${i}`,
  })), { now: NOW });

  const [silent, declared, healthy] = reg.sessions;

  assert.deepEqual(
    { presence: silent.presence, liveness: silent.liveness, available: silent.available },
    { presence: PRESENCE.PRESENT, liveness: LIVENESS.STALE, available: false },
  );
  assert.deepEqual(
    { presence: declared.presence, liveness: declared.liveness, available: declared.available },
    { presence: PRESENCE.DEPARTED, liveness: LIVENESS.LIVE, available: false },
  );
  assert.deepEqual(
    { presence: healthy.presence, liveness: healthy.liveness, available: healthy.available },
    { presence: PRESENCE.PRESENT, liveness: LIVENESS.LIVE, available: true },
  );

  // And every row agrees with the standalone functions -- one rule, one place.
  for (const s of reg.sessions) {
    const src = [WENT_SILENT, DECLARED_OFFLINE, HEALTHY][reg.sessions.indexOf(s)];
    assert.equal(s.presence, presenceOf(src));
    assert.equal(s.liveness, livenessOf(src, { now: NOW }));
    assert.equal(s.available, isAvailable(src, { now: NOW }));
  }
});

// ── the splice ─────────────────────────────────────────────────────────────

test('THE DEPLOYED SPLICE AGREES ON THE BRANCHES THIS CHANGE ADDED', () => {
  /*
   * supabase/functions/mcp/_shared.js is a hand-maintained copy, and the suite
   * exercises the ORIGINALS. test/sharedSpliceMatches.test.mjs compares
   * detectCollisions, wentStale and supervisoryReport -- none of which reach
   * presence or liveness -- so without this file the splice of THIS change is
   * compared by nothing.
   *
   * A fixture that cannot reach the changed branch cannot fail for it, so every
   * distinct verdict is driven here rather than one representative row: LIVE,
   * STALE and UNKNOWN; PRESENT and DEPARTED; available true and false.
   */
  const cases = [
    HEALTHY,
    WENT_SILENT,
    DECLARED_OFFLINE,
    row({ capacity: 'offline', heartbeat_at: ago(STALE_AFTER_MS + 60_000) }), // departed AND stale
    row({ capacity: 'busy', heartbeat_at: ago(5_000) }),
    row({ capacity: 'blocked', heartbeat_at: ago(5_000) }),
    row({ capacity: 'wat', heartbeat_at: ago(5_000) }),
    row({ capacity: 'idle', heartbeat_at: null }),
    row({ capacity: 'idle', heartbeat_at: 'whenever' }),
    row({ capacity: 'idle', heartbeat_at: ago(-60_000) }),
  ];

  for (const c of cases) {
    assert.equal(depPresence(c), presenceOf(c), 'presence: ' + JSON.stringify(c));
    assert.equal(depLiveness(c, { now: NOW }), livenessOf(c, { now: NOW }), 'liveness: ' + JSON.stringify(c));
    assert.equal(depAvailable(c, { now: NOW }), isAvailable(c, { now: NOW }), 'available: ' + JSON.stringify(c));
  }

  // THE AGREEMENT IS NOT VACUOUS: every verdict the branch can produce actually
  // occurred above. Without this, deleting a branch from BOTH copies would keep
  // this test green -- they would agree on being equally wrong.
  const seen = {
    presence: new Set(cases.map((c) => presenceOf(c))),
    liveness: new Set(cases.map((c) => livenessOf(c, { now: NOW }))),
    available: new Set(cases.map((c) => isAvailable(c, { now: NOW }))),
  };
  assert.deepEqual([...seen.presence].sort(), ['departed', 'present']);
  assert.deepEqual([...seen.liveness].sort(), ['live', 'stale', 'unknown']);
  assert.deepEqual([...seen.available].sort(), [false, true]);

  // And the whole row shape, which is what a reader actually consumes.
  const rows = cases.map((c, i) => ({ ...c, session_id: `s${i}` }));
  assert.deepEqual(depRegistry(rows, { now: NOW }), registryFromSessions(rows, { now: NOW }));
});
