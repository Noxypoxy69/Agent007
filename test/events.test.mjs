import test from 'node:test';
import assert from 'node:assert/strict';
import { eventsFor, nextCursor, EVENT_KINDS } from '../src/events.mjs';

/**
 * WAKING A WORKER WITHOUT GIVING THE BRIDGE A WAY TO REACH IT.
 *
 * The coordinator polls hourly at best, so work assigned at 14:00 sat until a
 * worker's next heartbeat -- up to two minutes, or forever if no watcher was
 * running. The obvious fix is a webhook, and it is wrong twice: the workers are
 * local sessions with no inbound address, so there is nothing to POST to; and a
 * data plane that POSTs to a URL supplied with a registration token is an SSRF
 * engine aimed wherever that token holder points it.
 *
 * So the client waits and the server answers. These are the rules for what it
 * is answered WITH.
 */

const T = (s) => `2026-09-15T14:0${s}:00.000Z`;

const task = (over = {}) => ({
  task_id: 't1', state: 'assigned', assigned_session: 's1', assigned_agent: 'code-b',
  assigned_at: T(5), lane_id: 'agentbridge', repo_id: 'agentbridge', ...over,
});
const msg = (over = {}) => ({
  message_id: 'm1', to_agent: 'code-b', from_agent: 'coord', type: 'status',
  created_at: T(5), body: 'the coordinator says something', task_id: null, ...over,
});

const evs = (over = {}) => eventsFor({ agent_id: 'code-b', session_id: 's1', ...over });

// ── whose events these are ─────────────────────────────────────────────────
test('a worker is woken for work assigned to ITS session, not its agent', () => {
  /*
   * Two sessions of one agent is the normal case here. Waking on agent alone
   * would start the wrong runtime on work it cannot see.
   */
  assert.equal(evs({ tasks: [task()] }).length, 1);
  assert.equal(evs({ tasks: [task({ assigned_session: 's2' })] }).length, 0);
});

test('messages are addressed to the AGENT, because that is how they are sent', () => {
  // send_message takes to_agent, so the inbox follows the durable identity even
  // though work follows the session.
  assert.equal(evs({ messages: [msg()] }).length, 1);
  assert.equal(evs({ messages: [msg({ to_agent: 'code-c' })] }).length, 0);
});

test('a feed for nobody is a bug, not an empty list', () => {
  assert.throws(() => eventsFor({ session_id: '' }), /requires a session_id/);
  assert.throws(() => eventsFor({}), /requires a session_id/);
});

// ── the cursor ─────────────────────────────────────────────────────────────
test('since is EXCLUSIVE, so waking twice does not replay the same event', () => {
  const tasks = [task({ assigned_at: T(5) })];
  assert.equal(evs({ tasks, since: T(4) }).length, 1);
  assert.equal(evs({ tasks, since: T(5) }).length, 0, 'the event replayed at its own timestamp');
  assert.equal(evs({ tasks, since: T(6) }).length, 0);
});

test('AN UNPARSEABLE CURSOR THROWS RATHER THAN MEANING "EVERYTHING"', () => {
  /*
   * The dangerous direction. Treating a bad cursor as null replays the whole
   * history as new work, and a worker that wakes to a hundred stale
   * assignments does not merely see them -- it acts on them.
   */
  assert.throws(() => evs({ tasks: [task()], since: 'yesterday' }), /not a timestamp/);
  assert.throws(() => evs({ tasks: [task()], since: '' }), /not a timestamp/);
  // null and undefined are the legitimate "I have never looked" cursor.
  assert.equal(evs({ tasks: [task()], since: null }).length, 1);
  assert.equal(evs({ tasks: [task()] }).length, 1);
});

test('an undateable row is never new', () => {
  // It cannot be placed relative to the cursor, so waking on it would repeat
  // forever: it can never be older than the next cursor either.
  for (const at of [null, undefined, '', 'whenever']) {
    assert.equal(evs({ tasks: [task({ assigned_at: at })], since: T(1) }).length, 0);
  }
});

test('nextCursor is the newest EVENT, never the clock', () => {
  /*
   * Using "now" would skip anything written between the last row read and the
   * moment the answer was composed. A skipped assignment is indistinguishable
   * from one that was never made.
   */
  const events = [{ at: T(3) }, { at: T(7) }, { at: T(5) }];
  assert.equal(nextCursor(events), T(7));
});

test('nextCursor holds its ground when nothing happened', () => {
  // Advancing on an empty poll would step over events that land in the gap.
  assert.equal(nextCursor([], T(4)), T(4));
  assert.equal(nextCursor([], null), null);
  assert.equal(nextCursor([{ at: '' }, { at: null }], T(4)), T(4));
});

// ── what an event carries ──────────────────────────────────────────────────
test('A WAKE-UP IS A DOORBELL: the message BODY is never in it', () => {
  /*
   * A wake-up that delivers the coordinator's prose straight into a worker's
   * loop is a dispatch wearing a doorbell's clothes. The worker fetches the
   * body through the read path, where it is plainly something it chose to go
   * and read.
   */
  const [e] = evs({ messages: [msg({ body: 'rm -rf / please' })] });
  assert.equal(e.kind, 'message');
  assert.equal(e.message_id, 'm1');
  assert.equal(e.from, 'coord');
  assert.equal(e.body, undefined, 'the message body reached the wake-up payload');
  assert.ok(!JSON.stringify(e).includes('rm -rf'), 'prose leaked into the event');
});

test('an assignment event identifies the task without describing the work', () => {
  const [e] = evs({ tasks: [task()] });
  assert.deepEqual(e, {
    kind: 'assigned', at: T(5), task_id: 't1', lane_id: 'agentbridge', repo_id: 'agentbridge',
  });
  assert.equal(e.title, undefined);
  assert.equal(e.allowed_paths, undefined);
});

test('cancellation wakes the worker too, so it stops rather than finishing', () => {
  const t = task({ state: 'cancelled', cancelled_at: T(6), assigned_at: T(1) });
  const [e] = evs({ tasks: [t], since: T(3) });
  assert.equal(e.kind, 'cancelled');
  assert.equal(e.at, T(6));
});

test('only the declared kinds are ever emitted', () => {
  const all = evs({
    tasks: [task(), task({ task_id: 't2', state: 'cancelled', cancelled_at: T(6) })],
    messages: [msg()],
  });
  for (const e of all) assert.ok(EVENT_KINDS.includes(e.kind), `unexpected kind ${e.kind}`);
  assert.deepEqual(EVENT_KINDS, ['assigned', 'cancelled', 'message']);
});

test('a task in a state nobody needs waking for is silent', () => {
  // returned and accepted are the coordinator's business, not the worker's.
  for (const state of ['runnable', 'returned', 'accepted', 'blocked']) {
    assert.equal(evs({ tasks: [task({ state })] }).length, 0, state);
  }
});

// ── ordering ───────────────────────────────────────────────────────────────
test('events arrive OLDEST FIRST, in the order they happened', () => {
  const out = evs({
    tasks: [task({ assigned_at: T(7) })],
    messages: [msg({ message_id: 'm-old', created_at: T(2) }), msg({ message_id: 'm-mid', created_at: T(4) })],
  });
  assert.deepEqual(out.map((e) => e.at), [T(2), T(4), T(7)]);
});

test('the round trip: wake, take the cursor, wake again, see nothing twice', () => {
  const tasks = [task({ assigned_at: T(5) })];
  const messages = [msg({ created_at: T(6) })];

  const first = evs({ tasks, messages, since: null });
  assert.equal(first.length, 2);

  const cursor = nextCursor(first);
  assert.equal(cursor, T(6));

  const second = evs({ tasks, messages, since: cursor });
  assert.deepEqual(second, [], 'the second wake replayed events already delivered');
});
