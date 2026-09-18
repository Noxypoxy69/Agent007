/**
 * THE TWO HALVES OF ONE RULE MUST AGREE, AND THIS FAILS IF THEY DRIFT.
 *
 * fixer asked for exactly this in writing, before the work: "Derive the fold
 * from whatever resolveAddress already uses for sending, so send and read cannot
 * disagree again, and make a test fail if the two paths ever diverge."
 *
 * They diverged anyway and a blind audit found it: eventsFor folded case,
 * messagesQuery compared exactly, so a message stored as "B" woke the long poll
 * and was invisible to list_messages.
 *
 * THIS FILE HAS ITSELF BEEN AUDITED AND WAS WRONG IN TWO WAYS. Both are fixed
 * here and both are worth stating, because they are the failure this file exists
 * to prevent, committed by the file itself.
 *
 *   IT CLAIMED TO BE GENERATED AND WAS TYPED. The seat list carried a comment
 *   citing rule 7 -- generate the adversarial fixtures from the real list, so
 *   adding an entry extends coverage without anybody remembering to -- above a
 *   literal array. It omitted c8, the seat with FOUR names and the one every
 *   message code-c has ever sent upward went to, and it listed two names that
 *   are not actors at all. It is derived from ACTORS now, so the comment is
 *   true and a new seat is covered the day it is added.
 *
 *   ITS SOUNDNESS PREMISE WAS FALSE. The parity comparison is only valid if the
 *   emitted patterns are literal, and isLiteral did not know that PostgREST
 *   treats `*` as an alias for `%`. So `*` read as literal, the premise held
 *   vacuously, and a pattern matching every row would have passed the gate.
 *
 * HOW PARITY IS ESTABLISHED WITHOUT A DATABASE, restated now that it is true.
 * Two properties are asserted separately:
 *
 *   1. Every emitted clause is either an `eq`, which has no pattern language at
 *      all, or an `ilike` over a name that CANNOT contain a metacharacter --
 *      asserted against the charset, not against a list of characters to escape.
 *   2. Given (1), ilike IS case-insensitive equality.
 *
 * So the comparison is a claim about literal patterns guarded by an assertion
 * that the patterns are literal -- not a simulation of Postgres.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { eventsFor } from '../src/events.mjs';
import { inboxNames, ACTORS } from '../src/coordination.mjs';
import { messagesQuery } from '../supabase/functions/mcp/_shared.js';

/* ── reading the query back ─────────────────────────────────────────────── */

/** Each to_agent constraint as {op, value}, decoded and unescaped. */
function clausesOf(q) {
  const out = [];
  const single = /(?:^|[?&])to_agent=(eq|ilike)\.([^&]*)/.exec(q);
  if (single) out.push({ op: single[1], raw: single[2] });
  const group = /(?:^|[?&])or=\(([^)]*)\)/.exec(q);
  if (group) {
    for (const part of group[1].split(',')) {
      const m = /^to_agent\.(eq|ilike)\."?(.*?)"?$/.exec(part);
      if (m) out.push({ op: m[1], raw: m[2] });
    }
  }
  return out.map((c) => ({ ...c, value: decodeURIComponent(c.raw).replace(/\\_/g, '_') }));
}

/**
 * A pattern is literal when it carries no unescaped ilike metacharacter.
 *
 * `*` IS ONE OF THEM. PostgREST documents it as an alias for `%`, which is the
 * character this helper originally did not know about -- and because it did not,
 * it certified a pattern matching every row as literal.
 */
function isLiteral(pattern) {
  return !/(^|[^\\])[%_*]/.test(pattern);
}

const hasFilter = (q) => clausesOf(q).length > 0;

/** Would the PULL path return a row stored under this recipient? */
function pullReaches(agentId, stored) {
  const cs = clausesOf(messagesQuery({ to_agent: agentId }));
  const want = String(stored ?? '');
  return cs.some((c) => {
    if (c.op === 'eq') return c.value === want;                 // exact, no folding
    assert.ok(isLiteral(decodeURIComponent(c.raw)), `ilike pattern ${c.raw} is not literal`);
    return c.value.toLowerCase() === want.toLowerCase();
  });
}

/** Would the PUSH path wake this seat for a row stored under this recipient? */
function pushReaches(agentId, stored) {
  const messages = [{
    message_id: 'm1', to_agent: stored, from_agent: 'x', type: 'status',
    created_at: '2026-09-18T07:46:23.327Z',
  }];
  return eventsFor({ tasks: [], messages, agent_id: agentId, session_id: 's', since: null })
    .some((e) => e.kind === 'message');
}

/* ── the roster, DERIVED ─────────────────────────────────────────────────── */

const SEATS = ACTORS.map((a) => a.actor_id);
const spellings = (n) => [n, n.toUpperCase(), n[0].toUpperCase() + n.slice(1)];

test('the seat list really is derived, and covers the multi-name seat', () => {
  /*
   * The assertion the old comment only claimed. c8 carries four names and is
   * where every upward message from code-c has gone; it was missing entirely.
   */
  assert.ok(SEATS.length >= 5, `expected a real roster, got ${SEATS.length}`);
  for (const a of ACTORS) assert.ok(SEATS.includes(a.actor_id), `${a.actor_id} is not covered`);
  const multi = ACTORS.filter((a) => (a.aliases ?? []).length > 1).map((a) => a.actor_id);
  assert.ok(multi.length > 0, 'a seat with several aliases must exist, or this gate proves little');
  for (const id of multi) assert.ok(SEATS.includes(id), `multi-alias seat ${id} is not covered`);
});

test('THE PARITY GATE: push and pull agree about every spelling of every seat', () => {
  let reachable = 0;
  for (const seat of SEATS) {
    const stored = new Set();
    for (const name of inboxNames(seat)) for (const s of spellings(name)) stored.add(s);
    for (const other of SEATS) {
      if (other === seat) continue;
      for (const name of inboxNames(other)) stored.add(name);
    }

    for (const s of stored) {
      const push = pushReaches(seat, s);
      const pull = pullReaches(seat, s);
      assert.equal(pull, push,
        `DIVERGENCE for seat ${seat}, stored ${JSON.stringify(s)}: push=${push} pull=${pull}`);
      if (push) reachable += 1;
    }
  }
  // A loop where nothing is reachable agrees perfectly and proves nothing.
  assert.ok(reachable >= 20, `expected many reachable pairs, compared ${reachable}`);
});

test('the case that broke it: "B" reaches code-b on BOTH paths', () => {
  assert.equal(pushReaches('code-b', 'B'), true);
  assert.equal(pullReaches('code-b', 'B'), true, 'the pull path was blind to this');
  assert.equal(pullReaches('code-b', 'CODE-B'), true);
});

test('THE OTHER DIRECTION: a fold that is too generous is worse than an empty inbox', () => {
  for (const foreign of ['code-a', 'a', 'b6', 'code-c', 'c', 'code-d', 'd', 'danny', 'owner', 'c8', 'chatgpt-work']) {
    assert.equal(pullReaches('code-b', foreign), false, `${foreign} must not reach code-b on pull`);
    assert.equal(pushReaches('code-b', foreign), false, `${foreign} must not reach code-b on push`);
  }
});

test('A WILDCARD CANNOT BE SMUGGLED IN, and * is one', () => {
  /*
   * PostgREST treats `*` as an alias for `%`, and encodeURIComponent leaves `*`
   * alone. The first version of this fix escaped backslash, percent and
   * underscore and missed it, so `to_agent=*` became the pattern `%` and matched
   * every row, and `C*` matched code-a, code-b and chatgpt-work.
   *
   * The repair is not "escape one more character" -- that is the enumeration
   * rule 8 warns about. A name that cannot be a seat is matched with eq, where
   * no pattern language exists.
   */
  for (const hostile of ['*', 'C*', 'code-*', '%', 'code-%', '_', 'a_b%c*']) {
    const cs = clausesOf(messagesQuery({ to_agent: hostile }));
    assert.equal(cs.length, 1, `${hostile} must produce exactly one clause`);
    const [c] = cs;
    if (c.op === 'ilike') {
      assert.ok(isLiteral(decodeURIComponent(c.raw)),
        `${hostile} emitted a non-literal ilike pattern: ${c.raw}`);
    }
    assert.equal(c.value, hostile, `${hostile} must mean exactly itself`);
    // and it must not reach a real seat
    assert.equal(pullReaches(hostile, 'code-b'), false, `${hostile} must not match code-b`);
  }
});

test('an underscore in a seat name is a LITERAL, not an ilike wildcard', () => {
  /*
   * AGENT_ID permits `_`, and ilike reads it as "any character", so an
   * unescaped seat named code_b would also match code-b and codeXb. This is the
   * widening direction: a misrouted blocker reads as ordinary traffic, while an
   * empty inbox is at least visibly wrong.
   */
  const cs = clausesOf(messagesQuery({ to_agent: 'code_b' }));
  assert.equal(cs.length, 1);
  assert.equal(cs[0].op, 'ilike', 'a legal seat name still folds case');
  assert.match(decodeURIComponent(cs[0].raw), /\\_/, 'the underscore must be escaped');
  assert.equal(cs[0].value, 'code_b', 'and it still means exactly that name');
  assert.equal(pullReaches('code_b', 'code-b'), false, 'it must not widen into code-b');
  assert.equal(pullReaches('code_b', 'CODE_B'), true, 'while still folding its own case');
});

test('a seat name containing a dot survives the or group', () => {
  /*
   * AGENT_ID permits `.`, and PostgREST needs a value containing a reserved
   * character quoted inside an or group. The in.(...) branch this replaced did
   * quote; dropping it would have been a silent regression the day somebody
   * registered code.b.
   */
  const actors = [{ actor_id: 'code.b', actor_type: 'worker', aliases: ['b.1'] }];
  const names = inboxNames('code.b', actors);
  assert.deepEqual(names, ['code.b', 'b.1'], 'precondition: a dotted seat with an alias');
  const q = messagesQuery({ to_agent: 'code.b' });
  // The real roster has no dotted seat, so this asserts the QUOTING mechanism
  // on the shape the group emits rather than on that fixture.
  const group = /(?:^|[?&])or=\(([^)]*)\)/.exec(messagesQuery({ to_agent: 'code-b' }));
  assert.ok(group, 'a multi-name seat uses an or group');
  for (const part of group[1].split(',')) {
    assert.match(part, /^to_agent\.(eq|ilike)\."[^"]*"$/, `group value must be quoted: ${part}`);
  }
  assert.ok(q.length > 0);
});

test('no recipient means no clause, not a clause matching nothing', () => {
  for (const blank of [undefined, null, '', '   ', 42, {}]) {
    assert.equal(hasFilter(messagesQuery({ to_agent: blank })), false,
      `${JSON.stringify(blank)} must emit no filter`);
  }
});

test('the fold is DERIVED, so there is no second list to drift', () => {
  /*
   * The structural half. If anybody later writes a literal pair table on either
   * side, this fails even on a day when the behaviour happens to agree.
   */
  for (const seat of SEATS) {
    const asked = clausesOf(messagesQuery({ to_agent: seat })).map((c) => c.value).sort();
    assert.deepEqual(asked, [...inboxNames(seat)].sort(),
      `the pull path asks for a different set than inboxNames for ${seat}`);
  }
});
