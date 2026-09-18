/**
 * The PULL half: how the query is BUILT.
 *
 * Semantic parity between the push and pull paths lives in
 * test/inboxFoldParity.test.mjs, which fails if the two ever disagree. This file
 * owns the narrower question of whether the query string itself is well formed
 * and safe: the operator chosen, escaping, quoting, blanks, and the other
 * filters being left alone.
 *
 * TWO OPERATORS, CHOSEN BY THE SHAPE OF THE NAME. A real seat matches AGENT_ID
 * and can carry no ilike metacharacter except `_`, which is escaped, so it is
 * matched with ilike and folds case. Anything that cannot be a seat name is
 * matched with eq, where no pattern language exists.
 *
 * That split exists because the first version escaped the characters I thought
 * of -- backslash, percent, underscore -- and PostgREST also treats `*` as an
 * alias for `%`. `to_agent=ilike.*` was the pattern `%` and matched every row.
 * Escaping one more character would have been rule 8; routing on the shape is
 * the repair.
 *
 * WHY THIS IS A SEPARATE FILE FROM test/listMessages.test.mjs. That one covers
 * messagesQuery and was present at session start, so it is a baseline test the
 * Stop gate hashes; editing it is drift. Its escaping assertion is re-asserted
 * here against the current operator so the contract keeps a voice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { messagesQuery } from '../supabase/functions/mcp/_shared.js';
import { inboxNames } from '../src/coordination.mjs';

/**
 * Each to_agent constraint as {op, raw}. Group values are quoted; the quotes are
 * part of the wire format and are stripped here, not by the caller.
 *
 * IT REFUSES TO INVENT A CLAUSE. An earlier version let callers destructure an
 * empty result and hand `undefined` to decodeURIComponent, which returns the
 * STRING 'undefined' rather than throwing -- so a test asserting on an absent
 * pattern failed on a regex mismatch instead of reporting the absence. Found by
 * audit. Callers use `only()` when they mean "exactly one".
 */
function clausesOf(q) {
  const out = [];
  const single = /(?:^|[?&])to_agent=(eq|ilike)\.([^&]*)/.exec(q);
  if (single) out.push({ op: single[1], raw: single[2] });
  const group = /(?:^|[?&])or=\(([^)]*)\)/.exec(q);
  if (group) {
    for (const part of group[1].split(',')) {
      const m = /^to_agent\.(eq|ilike)\."(.*)"$/.exec(part);
      if (m) out.push({ op: m[1], raw: m[2] });
    }
  }
  return out;
}

function only(q) {
  const cs = clausesOf(q);
  assert.equal(cs.length, 1, `expected exactly one to_agent clause, got ${cs.length} in ${q}`);
  return cs[0];
}

/** The names asked for, decoded and unescaped. */
const asked = (q) => clausesOf(q).map((c) => decodeURIComponent(c.raw).replace(/\\_/g, '_'));

const hasFilter = (q) => clausesOf(q).length > 0;

test('THE FIX: a seat with more than one name asks for all of them', () => {
  assert.deepEqual(inboxNames('code-b'), ['code-b', 'b'], 'precondition: b is an alias of code-b');
  assert.deepEqual(asked(messagesQuery({ to_agent: 'code-b' })), ['code-b', 'b']);
});

test('polling by the alias asks the same question as polling by the id', () => {
  assert.equal(messagesQuery({ to_agent: 'b' }), messagesQuery({ to_agent: 'code-b' }));
  assert.equal(messagesQuery({ to_agent: 'CODE-B' }), messagesQuery({ to_agent: 'code-b' }));
  assert.deepEqual(asked(messagesQuery({ to_agent: 'b6' })), ['code-a', 'a', 'b6']);
});

test('THE SEPARATORS STAY LITERAL, and every group value is QUOTED', () => {
  /*
   * Encoding the whole group would turn its separators into %2C and PostgREST
   * would read one malformed predicate, matching nothing silently.
   *
   * The quoting is the other half: AGENT_ID permits `.`, and PostgREST needs a
   * value containing a reserved character quoted inside an or group. The
   * in.(...) branch this replaced did quote, so dropping it would have been a
   * silent regression waiting for the first seat named code.b.
   */
  const q = messagesQuery({ to_agent: 'code-b' });
  const group = /(?:^|[?&])or=\(([^)]*)\)/.exec(q);
  assert.ok(group, 'a multi-name seat must use an or group');
  assert.ok(group[1].includes(','), 'the separator must survive as a literal comma');
  assert.ok(!group[1].includes('%2C'), 'an encoded comma would be part of one predicate');
  for (const part of group[1].split(',')) {
    assert.match(part, /^to_agent\.(eq|ilike)\."[^"]*"$/, `group value must be quoted: ${part}`);
  }
});

test('A LEGAL SEAT NAME USES ilike, so a single-session seat still folds case', () => {
  /*
   * The single-name branch used eq at first, which is case-sensitive, so every
   * unrostered seat -- fixer among them -- stayed divergent from the push path.
   */
  assert.deepEqual(inboxNames('fixer'), ['fixer']);
  assert.equal(only(messagesQuery({ to_agent: 'fixer' })).op, 'ilike');
  assert.deepEqual(asked(messagesQuery({ to_agent: 'nobody' })), ['nobody']);
});

test('A NAME THAT CANNOT BE A SEAT USES eq, where there is no pattern language', () => {
  /*
   * The repair for the `*` wildcard. Rather than escaping one more character,
   * anything outside AGENT_ID's charset is matched exactly. `*` therefore means
   * the literal string `*`, which addresses nobody.
   */
  for (const hostile of ['*', 'C*', 'code-*', '%', 'a_b%c*', 'code-c&select=*&limit=99999']) {
    const c = only(messagesQuery({ to_agent: hostile }));
    assert.equal(c.op, 'eq', `${hostile} must not reach the pattern operator`);
    assert.equal(decodeURIComponent(c.raw), hostile, `${hostile} must mean exactly itself`);
  }
});

test('THE ESCAPING CONTRACT SURVIVES, whichever operator is chosen', () => {
  /*
   * Re-asserted from the baseline test rather than trusted, because the operator
   * moved out from under it. The concern is unchanged: a value carrying
   * PostgREST operators must not smuggle in another filter.
   */
  const q = messagesQuery({ to_agent: 'code-c&select=*&limit=99999' });
  assert.ok(!q.includes('select=*&limit=99999'), 'an injected operator survived');
  assert.match(q, /to_agent=eq\.code-c%26select%3D/, 'both & and = must be encoded');
  assert.match(q, /limit=50/, 'the injected limit must not have replaced the real one');
});

test('AN UNDERSCORE IS A LITERAL, not an ilike wildcard', () => {
  /*
   * AGENT_ID permits `_`, so code_b IS a legal seat name and does take the
   * pattern operator -- which is exactly why it must be escaped. ilike reads an
   * unescaped `_` as "any character", so it would also match code-b and codeXb.
   * That is the widening direction: a misrouted blocker reads as ordinary
   * traffic, while an empty inbox is visibly wrong.
   */
  const c = only(messagesQuery({ to_agent: 'code_b' }));
  assert.equal(c.op, 'ilike', 'a legal seat name still folds case');
  assert.match(decodeURIComponent(c.raw), /\\_/, 'the underscore must be escaped');
  assert.deepEqual(asked(messagesQuery({ to_agent: 'code_b' })), ['code_b'], 'and means that name');
});

test('ABSENT means no filter; SUPPLIED-AND-UNUSABLE is refused', () => {
  /*
   * The distinction the first version of this missed. Omitting to_agent is a
   * legitimate read -- the whole log is what a reader without an inbox wants --
   * so undefined and null still pass through unfiltered.
   *
   * But a recipient that was SUPPLIED and cannot be parsed used to produce a
   * query with no recipient clause at all, which means list_messages answered
   * with the newest 50 messages on the bridge. Measured live: to_agent of three
   * spaces returned other agents' mail. A caller polling its own inbox with a
   * malformed id got a populated, plausible, WRONG answer.
   */
  for (const absent of [undefined, null]) {
    assert.equal(hasFilter(messagesQuery({ to_agent: absent })), false,
      `${JSON.stringify(absent)} means no inbox was asked for`);
  }
  for (const unusable of ['', '   ', 42, {}, [], true]) {
    assert.throws(
      () => messagesQuery({ to_agent: unusable }),
      /not a usable recipient/,
      `${JSON.stringify(unusable)} must be refused, not silently unfiltered`,
    );
  }
  assert.match(messagesQuery({ from_agent: 'fixer' }), /from_agent=eq\.fixer/);
  assert.match(messagesQuery({ to_agent: 'code-b', type: 'blocker' }), /type=eq\.blocker/);
});

test('THE CONTROL: the refusal is about the RECIPIENT, not about blank filters generally', () => {
  /*
   * from_agent and task_id keep the old "blank means omit" behaviour, because
   * omitting them is not dangerous: they narrow a read that is already scoped.
   * Only to_agent carries the "this is MY mail" meaning that makes an unfiltered
   * answer a wrong one rather than a broad one.
   */
  const q = messagesQuery({ from_agent: '', task_id: null, type: '' });
  assert.ok(!q.includes('from_agent=eq.'), q);
  assert.ok(!q.includes('task_id=eq.'), q);
  assert.ok(!q.includes('type=eq.'), q);
});

test('the rest of the query is unchanged: select, order, limit and since', () => {
  const q = messagesQuery({ to_agent: 'code-b', limit: 10, since: '2026-09-18T07:00:00Z' });
  assert.match(q, /^messages\?select=\*&order=created_at\.desc&limit=10&/);
  assert.match(q, /created_at=gt\./);
  assert.throws(() => messagesQuery({ to_agent: 'code-b', since: 'not-a-date' }), /not a timestamp/);
});
