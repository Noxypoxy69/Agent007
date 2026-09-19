/**
 * A REAPER THAT TAKES SOMETHING IT SHOULD NOT IS WORSE THAN NO REAPER.
 *
 * This project has already shipped a reaper that "had never run and could never
 * have run" — a correct function on a schedule that did not exist. The mirror
 * image is a reaper that runs and deletes a live session, and that is the one
 * these tests exist for.
 *
 * WHY THE PREDICATE IS TESTED HERE AND NOT IN THE DATABASE. Three attempts to
 * prove it in-transaction were each vacuous for a DIFFERENT reason, and every
 * one of them passed:
 *
 *   1. `FOR UPDATE SKIP LOCKED` skips rows the probing transaction just
 *      inserted — so a planted row "survived" the sweep because it was locked,
 *      not because the predicate spared it.
 *   2. A trigger rewrites `heartbeat_at` on write, so a row inserted with a
 *      nine-hour-old heartbeat is born fresh. The one column the predicate
 *      reads cannot be fabricated in the table it runs against.
 *   3. Which left only "sweep every committed row" reachable — the happy path,
 *      and none of the three safety refusals.
 *
 * Rule 9: a fixture that cannot construct the real case cannot fail for it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  reapableSeats, holdsLiveWork, STALE_WINDOW_MS, REAP_AFTER_WINDOWS,
} from '../src/seatReaper.mjs';

const NOW = Date.parse('2026-09-19T04:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const seat = (session_id, heartbeat_at, extra = {}) => ({
  session_id, agent_id: `a-${session_id}`, heartbeat_at, ...extra,
});

const ids = (rows) => rows.map((r) => r.session_id).sort();

test('THE POSITIVE FIRST: a genuinely dead seat is reclaimable', () => {
  /*
   * Rule 5. Every refusal below is satisfied by a predicate that reclaims
   * nothing — which is the state today, and the reason the roster has fifteen
   * seats for five agents.
   */
  const out = reapableSeats([seat('dead', ago(9 * HOUR))], [], { now: NOW });
  assert.deepEqual(ids(out), ['dead'], 'a seat silent for nine hours was not reclaimable');
  assert.match(out[0].reason, /no heartbeat for \d+s/, `the reason does not say why: ${out[0].reason}`);
});

test('UNKNOWN LIVENESS IS NOT DEATH', () => {
  /*
   * A null heartbeat means nobody ever stamped this row — exactly the state a
   * session is in for its first moments. Sweeping it deletes a session that is
   * starting up. Evidence of death, never absence of evidence.
   */
  for (const beat of [null, undefined, '', '   ', 'not-a-time', 0, {}, []]) {
    assert.deepEqual(reapableSeats([seat('unknown', beat)], [], { now: NOW }), [],
      `heartbeat ${JSON.stringify(beat)} was treated as death`);
  }
});

test('A LIVE SEAT IS NOT DEATH', () => {
  const live = [
    seat('now', ago(0)),
    seat('recent', ago(20 * MIN)),
    seat('one-window', ago(11 * MIN)),
  ];
  assert.deepEqual(reapableSeats(live, [], { now: NOW }), [],
    'a seat that heartbeated within tolerance was reclaimed');
});

test('THE BOUNDARY IS WHERE IT SAYS IT IS, on both sides', () => {
  /*
   * An off-by-one here is the difference between sweeping debris and deleting
   * a session that missed one poll. Tested at the edge rather than in the
   * comfortable middle.
   */
  const cutoffMs = STALE_WINDOW_MS * REAP_AFTER_WINDOWS;

  assert.deepEqual(reapableSeats([seat('under', ago(cutoffMs - MIN))], [], { now: NOW }), [],
    'a seat one minute INSIDE the window was reclaimed');
  assert.deepEqual(ids(reapableSeats([seat('over', ago(cutoffMs + MIN))], [], { now: NOW })), ['over'],
    'a seat one minute PAST the window was spared');
  assert.deepEqual(reapableSeats([seat('exact', ago(cutoffMs))], [], { now: NOW }), [],
    'a seat exactly at the boundary was reclaimed — the comparison must be strict');
});

test('A DEAD SEAT HOLDING LIVE WORK IS NOT OURS TO TAKE', () => {
  /*
   * Deleting it orphans an assigned task whose lease has not expired.
   * reconcile_leases is already the mechanism that recovers that, on its own
   * schedule — two reapers acting on one lifecycle is how the reviewer-lease
   * asymmetry happened. This one defers.
   */
  const tasks = [{
    task_id: 't-held', state: 'assigned',
    assigned_session: 'dead-holding', lease_expires_at: ago(-10 * MIN),
  }];
  assert.deepEqual(reapableSeats([seat('dead-holding', ago(9 * HOUR))], tasks, { now: NOW }), [],
    'a dead seat still leasing an assigned task was reclaimed, orphaning the work');
});

test('AN EXPIRED LEASE DOES NOT PROTECT A DEAD SEAT', () => {
  /*
   * The other direction, and the one that would quietly disable the reaper:
   * if any assigned task counted, a seat holding long-expired work would be
   * immortal. reconcile_leases will free that task; this seat is debris.
   */
  const tasks = [{
    task_id: 't-stale', state: 'assigned',
    assigned_session: 'dead', lease_expires_at: ago(2 * HOUR),
  }];
  assert.deepEqual(ids(reapableSeats([seat('dead', ago(9 * HOUR))], tasks, { now: NOW })), ['dead'],
    'an EXPIRED lease kept a dead seat alive forever');
});

test('ONLY assigned WORK PROTECTS, and only for the right session', () => {
  const dead = [seat('dead', ago(9 * HOUR))];
  const live = ago(-10 * MIN);

  for (const state of ['runnable', 'returned', 'accepted', 'cancelled', 'blocked']) {
    const tasks = [{ task_id: 't', state, assigned_session: 'dead', lease_expires_at: live }];
    assert.deepEqual(ids(reapableSeats(dead, tasks, { now: NOW })), ['dead'],
      `state ${state} protected a dead seat, but only assigned work can be orphaned`);
  }

  const other = [{ task_id: 't', state: 'assigned', assigned_session: 'somebody-else', lease_expires_at: live }];
  assert.deepEqual(ids(reapableSeats(dead, other, { now: NOW })), ['dead'],
    "another session's live work protected this seat");
});

test('MALFORMED INPUT IS NEVER RECLAIMED', () => {
  /*
   * This decides what gets DELETED. Every unusable input must fail towards
   * leaving the row alone.
   */
  const junk = [null, undefined, 42, 'seat', [], {}, { session_id: '' }, { session_id: 42 }];
  assert.deepEqual(reapableSeats(junk, [], { now: NOW }), [], 'malformed rows were reclaimed');
  assert.deepEqual(reapableSeats(null, null, { now: NOW }), [], 'a non-array was reclaimed');
  assert.deepEqual(reapableSeats([seat('dead', ago(9 * HOUR))], [], { now: 'not-a-clock' }), [],
    'an unusable clock produced deletions');
  assert.deepEqual(reapableSeats([seat('dead', ago(9 * HOUR))], [], {}), [],
    'a missing clock produced deletions');
});

test('THE REAL ROSTER SHAPE, which is what this was written for', () => {
  /*
   * Rule 9: the measured case, not an invented one. These are the ages
   * observed on 2026-09-19 — four seats for code-b, two for fixer created ten
   * seconds apart, and one live.
   */
  const roster = [
    seat('social-sparks-app-c8', ago(163881 * 1000)),
    seat('danny-win-b1', ago(62086 * 1000)),
    seat('alias-probe', ago(61054 * 1000)),
    seat('danny-win-b2', ago(21450 * 1000)),
    seat('claude-probe-watcher-4', ago(3692 * 1000)),
    seat('claude-watchproof1', ago(3619 * 1000)),
    seat('danny-win-fixer', ago(9 * 1000)),
  ];
  const out = ids(reapableSeats(roster, [], { now: NOW }));
  assert.ok(!out.includes('danny-win-fixer'), 'the one live seat was reclaimed');
  assert.equal(out.length, 6, `expected the six dead seats, got ${out.length}: ${out.join(', ')}`);
});

test('holdsLiveWork IS EXACT about the session it protects', () => {
  const tasks = [{ task_id: 't', state: 'assigned', assigned_session: 's1', lease_expires_at: ago(-MIN) }];
  assert.equal(holdsLiveWork('s1', tasks, NOW), true, 'the holder was not protected');
  assert.equal(holdsLiveWork('s2', tasks, NOW), false, 'a different session was protected');
  assert.equal(holdsLiveWork('', tasks, NOW), false, 'an empty session id matched');
  assert.equal(holdsLiveWork(null, tasks, NOW), false, 'a null session id matched');
  assert.equal(holdsLiveWork('s1', null, NOW), false, 'a null task list protected something');
});

test('THE CONTROL: this predicate really discriminates', () => {
  /*
   * Rule 1. A predicate that reclaims everything satisfies the positive; one
   * that reclaims nothing satisfies every refusal. This pins both in one place
   * — and it is the assertion that would have caught all three vacuous
   * in-database probes.
   */
  const mixed = [seat('dead', ago(9 * HOUR)), seat('live', ago(0)), seat('unknown', null)];
  assert.deepEqual(ids(reapableSeats(mixed, [], { now: NOW })), ['dead'],
    'the predicate does not separate the three cases');
});
