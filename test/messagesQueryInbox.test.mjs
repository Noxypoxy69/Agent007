/**
 * The PULL half: how the query is BUILT.
 *
 * Semantic parity between the push and pull paths lives in
 * test/inboxFoldParity.test.mjs, which is the gate that fails if the two ever
 * disagree again. This file owns the narrower question of whether the query
 * string itself is well formed and safe: escaping, separators, blanks, and the
 * other filters being left alone.
 *
 * THE OPERATOR IS ilike, NOT eq, AND THE REASON IS THE WHOLE BUG. eq and in(...)
 * compare exactly, Postgres comparison is case-sensitive, and a message stored
 * as "B" was therefore delivered by the long poll and invisible here. Half a
 * contract landing green. See e30d0b8.
 *
 * WHY THIS IS A SEPARATE FILE FROM test/listMessages.test.mjs. That one already
 * covers messagesQuery and was present at session start, so it is a baseline
 * test the Stop gate hashes; editing it is drift. Its escaping assertion is
 * re-asserted here against the new operator, so the contract keeps a voice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { messagesQuery } from '../supabase/functions/mcp/_shared.js';
import { inboxNames } from '../src/coordination.mjs';

/** Every ilike pattern the query asks for, raw (still percent-encoded). */
function rawPatterns(q) {
  const out = [];
  const single = /(?:^|[?&])to_agent=ilike\.([^&]*)/.exec(q);
  if (single) out.push(single[1]);
  const group = /(?:^|[?&])or=\(([^)]*)\)/.exec(q);
  if (group) {
    for (const part of group[1].split(',')) {
      const m = /^to_agent\.ilike\.(.*)$/.exec(part);
      if (m) out.push(m[1]);
    }
  }
  return out;
}

const decoded = (q) => rawPatterns(q).map((p) => decodeURIComponent(p).replace(/\\([%_\\])/g, '$1'));

/** Is there any to_agent constraint at all? */
const hasFilter = (q) => /(?:^|[?&])(to_agent=ilike\.|or=\()/.test(q);

test('THE FIX: a seat with more than one name asks for all of them', () => {
  assert.deepEqual(inboxNames('code-b'), ['code-b', 'b'], 'precondition: b is an alias of code-b');
  assert.deepEqual(decoded(messagesQuery({ to_agent: 'code-b' })), ['code-b', 'b']);
});

test('polling by the alias asks the same question as polling by the id', () => {
  /*
   * The symmetry that makes this a fix rather than a second mailbox. Either
   * spelling must reach the whole seat, or the bug has only moved.
   */
  assert.equal(messagesQuery({ to_agent: 'b' }), messagesQuery({ to_agent: 'code-b' }));
  assert.equal(messagesQuery({ to_agent: 'CODE-B' }), messagesQuery({ to_agent: 'code-b' }));
  assert.deepEqual(decoded(messagesQuery({ to_agent: 'b6' })), ['code-a', 'a', 'b6']);
});

test('THE SEPARATORS STAY LITERAL inside the or group', () => {
  /*
   * Encoding the whole group would turn its separators into %2C, PostgREST would
   * read one malformed predicate, and the query would silently match nothing --
   * the same class of failure as the bug being fixed, arriving through the fix.
   */
  const q = messagesQuery({ to_agent: 'code-b' });
  const group = /(?:^|[?&])or=\(([^)]*)\)/.exec(q);
  assert.ok(group, 'a multi-name seat must use an or group');
  assert.ok(group[1].includes(','), 'the separator must survive as a literal comma');
  assert.ok(!group[1].includes('%2C'), 'an encoded comma would be part of one predicate');
  assert.equal(rawPatterns(q).length, 2, 'both names must be asked for');
});

test('A SINGLE NAME USES ilike TOO, and an unknown recipient is one', () => {
  /*
   * The single-name branch used eq, which is case-sensitive, so every unrostered
   * seat -- fixer among them -- stayed divergent from the push path even after
   * the multi-name case was folded. Both branches fold now.
   */
  assert.deepEqual(inboxNames('fixer'), ['fixer']);
  assert.match(messagesQuery({ to_agent: 'fixer' }), /to_agent=ilike\.fixer(&|$)/);
  assert.deepEqual(decoded(messagesQuery({ to_agent: 'nobody' })), ['nobody']);
});

test('THE ESCAPING CONTRACT SURVIVES THE OPERATOR CHANGE', () => {
  /*
   * Re-asserted from the baseline test rather than trusted, because the operator
   * moved out from under it. The concern it protects is unchanged: a value
   * carrying PostgREST operators must not smuggle in another filter.
   */
  const q = messagesQuery({ to_agent: 'code-c&select=*&limit=99999' });
  assert.ok(!q.includes('select=*&limit=99999'), 'an injected operator survived');
  assert.match(q, /to_agent=ilike\.code-c%26select%3D/, 'both & and = must be encoded');
  assert.match(q, /limit=50/, 'the injected limit must not have replaced the real one');
});

test('ilike WILDCARDS ARE ESCAPED, so a name cannot widen into another seat', () => {
  /*
   * The direction that is worse than an empty inbox. AGENT_ID permits _, and
   * ilike reads _ as "any character", so an unescaped seat named code_b would
   * also match code-b. A misrouted blocker reads as ordinary traffic.
   */
  const q = messagesQuery({ to_agent: 'a_b%c' });
  const [raw] = rawPatterns(q);
  const pattern = decodeURIComponent(raw);
  assert.match(pattern, /\\_/, 'the underscore must be escaped');
  assert.match(pattern, /\\%/, 'the percent must be escaped');
  assert.deepEqual(decoded(q), ['a_b%c'], 'and it still means exactly that name');
});

test('no recipient means no clause, not a clause matching nothing', () => {
  for (const blank of [undefined, null, '', '   ', 42, {}]) {
    assert.equal(hasFilter(messagesQuery({ to_agent: blank })), false,
      `${JSON.stringify(blank)} must emit no filter`);
  }
  assert.match(messagesQuery({ from_agent: 'fixer' }), /from_agent=eq\.fixer/);
  assert.match(messagesQuery({ to_agent: 'code-b', type: 'blocker' }), /type=eq\.blocker/);
});

test('the rest of the query is unchanged: select, order, limit and since', () => {
  const q = messagesQuery({ to_agent: 'code-b', limit: 10, since: '2026-09-18T07:00:00Z' });
  assert.match(q, /^messages\?select=\*&order=created_at\.desc&limit=10&/);
  assert.match(q, /created_at=gt\./);
  assert.throws(() => messagesQuery({ to_agent: 'code-b', since: 'not-a-date' }), /not a timestamp/);
});
