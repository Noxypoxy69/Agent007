/**
 * The PULL half of the same bug the push half had.
 *
 * eventsFor compared one string and so did messagesQuery. Measured 2026-09-18 on
 * the live bridge, two calls seconds apart:
 *
 *   list_messages to_agent "code-b"  ->  []
 *   list_messages to_agent "b"       ->  the message, sitting unread
 *
 * A confident negative is worse than no answer: it is indistinguishable from an
 * empty inbox, so a reader doing exactly the right thing stops looking.
 *
 * WHY THIS IS A NEW FILE. test/listMessages.test.mjs already covers
 * messagesQuery and is a BASELINE test -- present at session start, hashed into
 * the session snapshot, and compared by the Stop gate. Editing it would be
 * drift. Its existing assertions are preserved by this change rather than
 * rewritten, which is the point of the single-name branch, and two of them are
 * re-asserted here so that if anyone DOES relax them later this file still says
 * what the contract was.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { messagesQuery } from '../supabase/functions/mcp/_shared.js';
import { inboxNames } from '../src/coordination.mjs';

/** The to_agent clause, or null when none was emitted. */
function clause(q) {
  const m = /(?:^|[?&])to_agent=([^&]*)/.exec(q);
  return m ? m[1] : null;
}

/** The names a to_agent=in.(...) clause actually asks for, decoded. */
function namesIn(q) {
  const c = clause(q);
  const m = /^in\.\((.*)\)$/.exec(c ?? '');
  if (!m) return null;
  return m[1].split(',').map((v) => decodeURIComponent(v).replace(/^"|"$/g, '').replace(/\\(["\\])/g, '$1'));
}

test('THE FIX: a seat with more than one name asks for all of them', () => {
  assert.deepEqual(inboxNames('code-b'), ['code-b', 'b'], 'precondition: b is an alias of code-b');
  assert.deepEqual(namesIn(messagesQuery({ to_agent: 'code-b' })), ['code-b', 'b']);
});

test('polling by the alias asks the same question as polling by the id', () => {
  /*
   * The symmetry that makes this a fix rather than a second mailbox. Either
   * spelling must reach the whole seat, or the bug simply moves.
   */
  assert.equal(messagesQuery({ to_agent: 'b' }), messagesQuery({ to_agent: 'code-b' }));
  assert.equal(messagesQuery({ to_agent: 'CODE-B' }), messagesQuery({ to_agent: 'code-b' }));
  assert.deepEqual(namesIn(messagesQuery({ to_agent: 'b6' })), ['code-a', 'a', 'b6']);
});

test('THE SEPARATORS STAY LITERAL, or PostgREST reads one value with commas in it', () => {
  /*
   * The whole-list encodeURIComponent mistake. It looks correct, produces a
   * well-formed URL, and silently matches nothing -- the same class of failure
   * as the bug being fixed, arriving through the fix.
   */
  const c = clause(messagesQuery({ to_agent: 'code-b' }));
  assert.match(c, /^in\.\(/);
  assert.ok(c.includes(','), 'the value separator must survive as a literal comma');
  assert.ok(!c.includes('%2C'), 'an encoded comma would be part of one value, not a separator');
});

test('A SINGLE NAME STILL USES eq, and an unknown recipient is one', () => {
  // canonicalActor returns an unrecognised name unchanged, so this is one name.
  assert.deepEqual(inboxNames('fixer'), ['fixer']);
  assert.equal(clause(messagesQuery({ to_agent: 'fixer' })), 'eq.fixer');
  assert.equal(clause(messagesQuery({ to_agent: 'nobody' })), 'eq.nobody');
});

test('THE ESCAPING CONTRACT IS UNCHANGED for a hostile value', () => {
  /*
   * Re-asserted from the baseline test rather than trusted. A value carrying
   * PostgREST operators matches no actor, so it is a single name and takes the
   * eq branch -- the same path, with the same escaping, it always took. If a
   * later change routed it through the in.(...) branch instead, the injection
   * would be re-opened somewhere nobody is looking.
   */
  const q = messagesQuery({ to_agent: 'code-c&select=*&limit=99999' });
  assert.ok(!q.includes('to_agent=eq.code-c&select='), 'an injected operator survived');
  assert.match(q, /to_agent=eq\.code-c%26select/);
  assert.equal(namesIn(q), null, 'a hostile value must not reach the list branch');
});

test('no recipient means no clause, not a clause matching nothing', () => {
  for (const blank of [undefined, null, '', '   ', 42, {}]) {
    assert.equal(clause(messagesQuery({ to_agent: blank })), null, `${JSON.stringify(blank)} must emit no filter`);
  }
  // And the other filters are untouched by any of this.
  assert.match(messagesQuery({ from_agent: 'fixer' }), /from_agent=eq\.fixer/);
  assert.match(messagesQuery({ to_agent: 'code-b', type: 'blocker' }), /type=eq\.blocker/);
});

test('the rest of the query is unchanged: select, order, limit and since', () => {
  const q = messagesQuery({ to_agent: 'code-b', limit: 10, since: '2026-09-18T07:00:00Z' });
  assert.match(q, /^messages\?select=\*&order=created_at\.desc&limit=10&/);
  assert.match(q, /created_at=gt\./);
  assert.throws(() => messagesQuery({ to_agent: 'code-b', since: 'not-a-date' }), /not a timestamp/);
});
