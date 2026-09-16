import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventsFor as srcEventsFor } from '../src/events.mjs';
import { eventsFor as depEventsFor, ownTask as depOwnTask } from '../supabase/functions/mcp/_shared.js';
import { ownTask, ownTasks } from '../src/ownWork.mjs';
import { actionableEvent, nextAction, ACTION } from '../src/workerLoop.mjs';

/**
 * THE TOKEN REACHES THE HOLDER BY EXACTLY ONE ROUTE.
 *
 * ═══ THE GAP, AND THE ROUTE THAT CLOSED IT ═══
 *
 * `/return` requires a `lease_token` and has no fallback — correctly, because a
 * path accepting a return without one is the path every zombie takes by
 * omitting a field. Nothing delivered one, so a worker could be assigned work
 * and be structurally unable to hand it back. Found by c8 building the client
 * half; recorded in docs/lease-interface.md.
 *
 * ═══ IT WAS DELIVERED ON THE EVENT FIRST, AND THAT WAS TAKEN BACK OUT ═══
 *
 * 0f47999 put the token on the assigned event. It worked. c8 then argued for
 * /task instead and the argument is better, so this file now asserts the
 * reverse of what it originally did — deliberately, and the reasoning is kept
 * because somebody will propose the event route again:
 *
 *   THE WORKER MUST CALL /task ANYWAY. The event is deliberately not sufficient
 *   to act on, so the read is not a cost the event route avoided; it is a call
 *   that always happens. The token on the event was redundant, not convenient.
 *
 *   A CREDENTIAL DOES NOT BELONG IN A REPLAYABLE FEED. Events are at-least-once
 *   and cursor-driven: the same one can arrive twice, or late, carrying a
 *   credential that may no longer be current. /task answers with the token only
 *   to the session that still holds the task, at the moment it asks.
 *
 *   AND IT ERODED THE DOORBELL. An event carrying a credential is ALMOST enough
 *   to act on, which is the exact property the design refuses.
 *
 * So there are two assertions here, and both matter: the token DOES reach the
 * holder, and it does NOT reach it the other way. One route, not two — because
 * a credential available from two places is two places to audit, and they will
 * disagree the first time somebody changes one.
 */

const AT = '2026-09-16T01:00:00.000Z';

const assigned = (over = {}) => ({
  task_id: 't1', state: 'assigned', assigned_session: 's-me', assigned_at: AT,
  lease_token: 'tok-me', lease_expires_at: '2026-09-16T01:15:00.000Z', leased_at: AT,
  lane_id: 'lane-a', repo_id: 'repo-a', allowed_paths: ['src/a.mjs'], ...over,
});

const evs = (tasks, session_id = 's-me') =>
  srcEventsFor({ tasks, messages: [], agent_id: 'code-b', session_id });

// ── the route that delivers ────────────────────────────────────────────────

test('THE HOLDER GETS ITS TOKEN FROM /task — without this the loop cannot close', () => {
  const task = ownTask([assigned()], { task_id: 't1', session_id: 's-me' });
  assert.equal(task.lease_token, 'tok-me',
    'the worker was assigned work and given no credential to return it under');
});

test('and the runtime can act on what it gets', () => {
  /*
   * Delivery is not enough on its own — the consumer has to be able to USE it.
   * A field written and never consumed is the reviewer-lease column again.
   */
  const task = ownTask([assigned()], { task_id: 't1', session_id: 's-me' });
  const w = {
    session_id: 's-me', task,
    lease: { lease_token: task.lease_token, lease_expires_at: task.lease_expires_at, leased_at: task.leased_at },
    run: null, pausedTaskIds: [],
  };
  assert.equal(nextAction(w, { now: AT }).action, ACTION.START,
    'the runtime refused to start on a task it had a live token for');
});

test('a restarted worker recovers the token without any event', () => {
  /*
   * After a crash the cursor is gone with the process, so there is no event to
   * replay — which is precisely the case the event route could not serve.
   */
  const mine = ownTasks([assigned(), assigned({ task_id: 't2', assigned_session: 's-other' })],
    { session_id: 's-me' });
  assert.deepEqual(mine.map((t) => t.lease_token), ['tok-me']);
});

// ── the route that must NOT deliver ────────────────────────────────────────

test('THE EVENT CARRIES NO CREDENTIAL', () => {
  const [ev] = evs([assigned()]);
  assert.equal(ev.lease_token, undefined,
    'a credential is back in an at-least-once, replayable feed');
  assert.ok(!JSON.stringify(ev).includes('tok-me'), 'the token leaked into the event by another name');

  // The fixture must still be producing an event, or this proves nothing.
  assert.equal(ev.kind, 'assigned');
  assert.equal(ev.task_id, 't1');
});

test('so the runtime CANNOT act on the event alone — it must read', () => {
  /*
   * The doorbell property, asserted from the consumer's side. The event tells
   * it which task; holding that task with no token is a refusal to start, so
   * the only way forward is the authenticated read.
   */
  const [ev] = evs([assigned()]);
  const take = actionableEvent(ev, { task: null });
  assert.equal(take.act, true);
  assert.equal(take.lease_token, null, 'the event handed over a credential');

  const w = { session_id: 's-me', task: { task_id: 't1' }, lease: { lease_token: take.lease_token }, run: null };
  const out = nextAction(w, { now: AT });
  assert.equal(out.action, ACTION.ABANDON,
    'the runtime started work holding a task it had no token for');
  assert.match(out.reason, /nothing could be returned under it/);
});

// ── scope: the whole safety argument for handing out a credential at all ───

test('ANOTHER SESSION\'S TOKEN IS NEVER VISIBLE, by either route', () => {
  const rows = [
    assigned({ task_id: 't1', assigned_session: 's-me', lease_token: 'tok-me' }),
    assigned({ task_id: 't2', assigned_session: 's-other', lease_token: 'tok-other' }),
  ];

  assert.equal(ownTask(rows, { task_id: 't2', session_id: 's-me' }), null);
  assert.ok(!JSON.stringify(ownTasks(rows, { session_id: 's-me' })).includes('tok-other'));
  assert.ok(!JSON.stringify(evs(rows, 's-me')).includes('tok-other'));

  // The fixture must still deliver SOMETHING to s-me, or the absences above
  // are satisfied by delivering nothing at all.
  assert.equal(ownTask(rows, { task_id: 't1', session_id: 's-me' }).lease_token, 'tok-me');
});

// ── the splice ─────────────────────────────────────────────────────────────

test('THE DEPLOYED COPY AGREES, on both the delivery and the withholding', () => {
  /*
   * _shared.js is a hand-maintained splice, and this pair matters more than
   * most: a drift that dropped ownTask's session check discloses credentials,
   * and a drift that re-added the token to the event puts one back in the feed.
   */
  const rows = [
    assigned({ task_id: 't1', assigned_session: 's-me', lease_token: 'tok-me' }),
    assigned({ task_id: 't2', assigned_session: 's-other', lease_token: 'tok-other' }),
  ];

  for (const session_id of ['s-me', 's-other', 's-nobody']) {
    const args = { tasks: rows, messages: [], agent_id: 'code-b', session_id };
    assert.deepEqual(depEventsFor(args), srcEventsFor(args), `events: ${session_id}`);
    for (const task_id of ['t1', 't2', 'nope']) {
      assert.deepEqual(depOwnTask(rows, { task_id, session_id }),
        ownTask(rows, { task_id, session_id }), `ownTask: ${session_id}/${task_id}`);
    }
  }

  // Both halves still exercised, or the agreement is vacuous.
  assert.equal(depOwnTask(rows, { task_id: 't1', session_id: 's-me' }).lease_token, 'tok-me');
  assert.equal(depOwnTask(rows, { task_id: 't2', session_id: 's-me' }), null);
  assert.ok(!JSON.stringify(depEventsFor({ tasks: rows, messages: [], agent_id: 'code-b', session_id: 's-me' }))
    .includes('tok-'));
});
