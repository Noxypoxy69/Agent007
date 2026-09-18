/**
 * eventsFor and the seat that has more than one name.
 *
 * THE BUG: `m.to_agent !== agent_id` was a strict inequality, and the send path
 * stores the recipient VERBATIM. So a message addressed to a registered alias
 * was stored under the alias and the long poll never woke for it. Measured
 * 2026-09-18 -- fixer addressed code-b as "b" and the message was invisible to
 * a poller identifying as code-b.
 *
 * THE RISK IN THE FIX IS THE OPPOSITE ONE, and it is the reason this file leans
 * on refusals rather than on the happy path. Widening a recipient match is one
 * bad expression away from delivering every seat's mail to everybody, and that
 * failure would look like success: more events, all arriving, nobody short of
 * information. So the negatives below are the real subject.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { eventsFor } from '../src/events.mjs';
import { inboxNames } from '../src/coordination.mjs';
import { eventsFor as deployedEventsFor } from '../supabase/functions/mcp/_shared.js';

const AT = '2026-09-18T07:46:23.327Z';

const msg = (to, id = 'm1') => ({
  message_id: id, to_agent: to, from_agent: 'fixer', type: 'assignment', created_at: AT,
});

const kinds = (events) => events.filter((e) => e.kind === 'message').map((e) => e.message_id);

function run(agent_id, messages, extra = {}) {
  return eventsFor({
    tasks: [], messages, agent_id, session_id: 'danny-win-b2', since: null, ...extra,
  });
}

test('THE POSITIVE FIRST: a canonical recipient still wakes its seat', () => {
  /*
   * Asserted before any alias case. A negative proved against a fixture that had
   * stopped working for some unrelated reason proves nothing -- rule 5.
   */
  assert.deepEqual(kinds(run('code-b', [msg('code-b')])), ['m1']);
});

test('THE FIX: a registered alias wakes the seat', () => {
  // src/coordination.mjs registers 'b' as an alias of code-b. This is the exact
  // shape of the message that went unread on 2026-09-18.
  assert.deepEqual(inboxNames('code-b'), ['code-b', 'b'], 'precondition: b is still an alias of code-b');
  assert.deepEqual(kinds(run('code-b', [msg('b')])), ['m1']);
});

test('THE RISK: one seat never receives another seat\'s mail', () => {
  /*
   * The floodgate test. If the name set were empty, wrongly built, or compared
   * with the wrong operator, this is what would break -- and it would break
   * SILENTLY in the direction that looks like the feature working.
   */
  const others = [
    msg('code-a', 'a-canonical'),
    msg('a', 'a-alias'),
    msg('code-c', 'c-canonical'),
    msg('c', 'c-alias'),
    msg('code-d', 'd-canonical'),
    msg('danny', 'owner'),
    msg('coordinator', 'coord'),
  ];
  assert.deepEqual(kinds(run('code-b', others)), [], 'code-b must receive none of these');

  // And the mirror: code-a does receive its own, so the emptiness above is not
  // the fixture simply failing to produce events at all.
  assert.deepEqual(kinds(run('code-a', others)), ['a-canonical', 'a-alias']);
});

test('b6 belongs to code-a now, and the seat it used to name does NOT get it', () => {
  /*
   * The sharpest case available: b6 was B's and was reassigned to code-a.
   * A fix that hardcoded history, or that matched on a substring, or that let
   * an alias resolve to more than one seat, fails exactly here.
   */
  assert.deepEqual(kinds(run('code-a', [msg('b6')])), ['m1'], 'b6 reaches code-a');
  assert.deepEqual(kinds(run('code-b', [msg('b6')])), [], 'b6 must NOT reach code-b');
});

test('A SEAT ABSENT FROM THE ROSTER KEEPS ITS OWN MAIL', () => {
  /*
   * THE REGRESSION THIS CHANGE COULD MOST EASILY HAVE SHIPPED, and it would have
   * been invisible from the seat that shipped it. inboxNames leans on
   * canonicalActor, which returns an unrecognised name UNCHANGED rather than
   * null. Had it returned null the name set would be empty and every unrostered
   * seat -- fixer among them, which is not in ACTORS at all -- would have gone
   * silently deaf while every test about aliases stayed green.
   */
  assert.deepEqual(inboxNames('fixer'), ['fixer'], 'precondition: an unknown name polls itself');
  assert.deepEqual(kinds(run('fixer', [msg('fixer')])), ['m1']);
  assert.deepEqual(kinds(run('fixer', [msg('code-b')])), [], 'and still gets nobody else\'s');
});

test('case is folded, because the display name is B and the alias is b', () => {
  assert.deepEqual(kinds(run('code-b', [msg('B')])), ['m1']);
  assert.deepEqual(kinds(run('code-b', [msg('CODE-B')])), ['m1']);
  assert.deepEqual(kinds(run('CODE-B', [msg('b')])), ['m1'], 'folded on the polling side too');
});

test('a malformed or absent recipient is not an event, and never matches an empty poller', () => {
  for (const bad of [null, undefined, '', '   ', 42, {}]) {
    assert.deepEqual(kinds(run('code-b', [msg(bad)])), [], `${JSON.stringify(bad)} must not deliver`);
  }
  // An empty agent_id yields nothing rather than everything.
  assert.deepEqual(kinds(run('', [msg('code-b'), msg('b', 'm2')])), []);
  assert.deepEqual(kinds(run(null, [msg('code-b')])), []);
});

test('the roster is injectable, so this does not silently depend on the shipped table', () => {
  const actors = [{ actor_id: 'seat-1', actor_type: 'worker', aliases: ['s1', 'ONE'] }];
  assert.deepEqual(kinds(run('seat-1', [msg('s1')], { actors })), ['m1']);
  assert.deepEqual(kinds(run('seat-1', [msg('one')], { actors })), ['m1'], 'alias case folded');
  assert.deepEqual(kinds(run('seat-1', [msg('s2')], { actors })), [], 'an unrelated name is refused');
});

test('THE DEPLOYED SPLICE AGREES ABOUT THE ALIAS BRANCH', () => {
  /*
   * HOLLOW GATE 10, WHICH THIS ALMOST WALKED INTO.
   *
   * test/sharedSpliceMatches.test.mjs passed the moment this change was made,
   * and it proved nothing about it: its fixtures exercise detectCollisions,
   * wentStale and supervisoryReport, and NONE of them reach eventsFor. The
   * splice copy of this function could have been left at the strict inequality,
   * or edited wrongly, and every test in the suite would have stayed green while
   * production kept the bug. That file's own header says these comparisons must
   * use "inputs that exercise the branches most recently changed"; this is that
   * input for this change.
   *
   * The splice is compared BEHAVIOURALLY, not textually -- it legitimately
   * differs, declaring fold inside the function rather than beside nonEmpty.
   */
  const cases = [
    ['code-b', [msg('b')]],
    ['code-b', [msg('code-b')]],
    ['code-b', [msg('B')]],
    ['code-b', [msg('b6')]],
    ['code-a', [msg('b6')]],
    ['fixer', [msg('fixer')]],
    ['fixer', [msg('code-b')]],
    ['code-b', [msg('code-a'), msg('a', 'x2'), msg('danny', 'x3')]],
    ['', [msg('code-b')]],
  ];

  for (const [agent_id, messages] of cases) {
    const mine = eventsFor({ tasks: [], messages, agent_id, session_id: 's', since: null });
    const theirs = deployedEventsFor({ tasks: [], messages, agent_id, session_id: 's', since: null });
    assert.deepEqual(theirs, mine, `splice disagrees for ${JSON.stringify(agent_id)} on ${messages.map((m) => m.to_agent)}`);
  }

  // The positive first, so the loop above is not agreeing by both returning [].
  assert.deepEqual(
    kinds(deployedEventsFor({ tasks: [], messages: [msg('b')], agent_id: 'code-b', session_id: 's', since: null })),
    ['m1'],
    'the deployed copy must actually deliver the alias, not merely agree about nothing',
  );
});

test('since still filters alias-matched messages, so a wake-up is not replayed', () => {
  /*
   * The alias path must not become a hole in the cursor. A replayed history
   * reads as a burst of new work.
   */
  const m = msg('b');
  assert.deepEqual(kinds(run('code-b', [m], { since: '2026-09-18T07:00:00.000Z' })), ['m1']);
  assert.deepEqual(kinds(run('code-b', [m], { since: AT })), [], 'exclusive: not newer than itself');
  assert.deepEqual(kinds(run('code-b', [m], { since: '2026-09-18T08:00:00.000Z' })), []);
});
