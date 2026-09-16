import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventsFor as srcEventsFor } from '../src/events.mjs';
import { eventsFor as depEventsFor } from '../supabase/functions/mcp/_shared.js';
import { actionableEvent } from '../src/workerLoop.mjs';

/**
 * THE TOKEN REACHES THE HOLDER, AND NOBODY ELSE.
 *
 * ═══ THE GAP THIS CLOSES ═══
 *
 * `/return` requires a `lease_token` and has no fallback — correctly, because a
 * path that accepts a return without one is the path every zombie takes by
 * omitting a field. But NOTHING DELIVERED ONE. A worker could be assigned work
 * and then be structurally unable to hand it back, so the loop could not close.
 *
 * Found by c8 building the client half, who then proved the fix meetable rather
 * than proposing it. Recorded in docs/lease-interface.md.
 *
 * The token is minted in the COORDINATOR's assign. The worker is a different
 * process, possibly on a different machine, holding a REGISTRATION token that
 * reaches only /wait, /register and /return — the MCP read surface 401s it. So
 * the assigned event is the one channel that crosses from the authority to the
 * holder.
 *
 * ═══ WHY THIS FILE IS MOSTLY ABOUT WHO CANNOT SEE IT ═══
 *
 * Putting a credential in an event is the kind of change that is correct
 * exactly as long as its scope is, so the scope is what gets asserted — in both
 * directions, and against the deployed splice as well as the source. The
 * argument that makes it safe is that the DELIVERY scope and the FENCING scope
 * are the same scope: `eventsFor` already skips every task whose
 * `assigned_session` is not this caller's.
 *
 * If that ever stops being true, this is a credential broadcast.
 */

const AT = '2026-09-16T01:00:00.000Z';

const assigned = (over = {}) => ({
  task_id: 't1', state: 'assigned', assigned_session: 's-me', assigned_at: AT,
  lease_token: 'tok-me', lane_id: 'lane-a', repo_id: 'repo-a', ...over,
});

const ask = (tasks, session_id = 's-me') =>
  srcEventsFor({ tasks, messages: [], agent_id: 'code-b', session_id });

// ── delivery ───────────────────────────────────────────────────────────────

test('THE HOLDER IS TOLD ITS TOKEN — without this the loop cannot close', () => {
  const [ev] = ask([assigned()]);
  assert.equal(ev.kind, 'assigned');
  assert.equal(ev.lease_token, 'tok-me',
    'the worker was assigned work and given no credential to return it under');
});

test('the worker runtime actually picks it up off the event', () => {
  /*
   * Delivery is not enough on its own: the consumer has to read it. This is the
   * hollow-gate shape the repo has produced thirteen times — a field that is
   * written and never consumed is the reviewer-lease column all over again.
   */
  const [ev] = ask([assigned()]);
  const out = actionableEvent(ev, { task: null });
  assert.equal(out.act, true);
  assert.equal(out.lease_token, 'tok-me', 'the runtime dropped the token it was handed');
});

// ── scope, which is the whole safety argument ──────────────────────────────

test('ANOTHER SESSION\'S TOKEN IS NEVER VISIBLE', () => {
  /*
   * The delivery scope and the fencing scope must be the SAME scope. If a
   * caller could see a token minted for somebody else, this stops being a
   * delivery mechanism and becomes a credential broadcast — and the holder of
   * a stolen token could return work it never did.
   */
  const rows = [
    assigned({ task_id: 't1', assigned_session: 's-me', lease_token: 'tok-me' }),
    assigned({ task_id: 't2', assigned_session: 's-other', lease_token: 'tok-other' }),
    assigned({ task_id: 't3', assigned_session: null, lease_token: 'tok-orphan' }),
  ];

  const mine = JSON.stringify(ask(rows, 's-me'));
  assert.match(mine, /tok-me/, 'the fixture stopped delivering anything, so the absences prove nothing');
  assert.doesNotMatch(mine, /tok-other/, 'another session\'s lease token was disclosed');
  assert.doesNotMatch(mine, /tok-orphan/, 'an unassigned task\'s token was disclosed');

  // And symmetrically, from the other side.
  const theirs = JSON.stringify(ask(rows, 's-other'));
  assert.match(theirs, /tok-other/);
  assert.doesNotMatch(theirs, /tok-me/);
});

test('a task with no lease carries an explicit null, not a missing key', () => {
  /*
   * The runtime treats "holding a task with no token" as a refusal to start.
   * An absent key and a null must read the same to it, so the shape is pinned:
   * a silently missing field is how that guard would be bypassed.
   */
  const [ev] = ask([assigned({ lease_token: null })]);
  assert.equal(ev.lease_token, null);
  assert.ok('lease_token' in ev, 'the key vanished, so a consumer cannot tell absent from unassigned');
});

test('only ASSIGNED events carry a token — a cancellation must not', () => {
  const rows = [{
    task_id: 't9', state: 'cancelled', assigned_session: 's-me',
    cancelled_at: AT, lease_token: 'tok-me',
  }];
  const out = ask(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'cancelled');
  assert.equal(out[0].lease_token, undefined,
    'a cancellation handed out a credential for work that no longer exists');
});

// ── the splice ─────────────────────────────────────────────────────────────

test('THE DEPLOYED COPY AGREES, including on what it withholds', () => {
  /*
   * _shared.js is a hand-maintained splice. This one matters more than most:
   * a drift that dropped the field breaks the loop silently, and a drift that
   * dropped the session filter discloses credentials. Both directions are
   * compared.
   */
  const rows = [
    assigned({ task_id: 't1', assigned_session: 's-me', lease_token: 'tok-me' }),
    assigned({ task_id: 't2', assigned_session: 's-other', lease_token: 'tok-other' }),
    { task_id: 't3', state: 'cancelled', assigned_session: 's-me', cancelled_at: AT, lease_token: 'x' },
  ];

  for (const session_id of ['s-me', 's-other', 's-nobody']) {
    const args = { tasks: rows, messages: [], agent_id: 'code-b', session_id };
    assert.deepEqual(depEventsFor(args), srcEventsFor(args), session_id);
  }

  // The fixture must still exercise both halves or the agreement is vacuous.
  const mine = srcEventsFor({ tasks: rows, messages: [], agent_id: 'code-b', session_id: 's-me' });
  assert.equal(mine.find((e) => e.kind === 'assigned')?.lease_token, 'tok-me');
  assert.equal(JSON.stringify(mine).includes('tok-other'), false);
});
