/**
 * THE TWO HALVES OF ONE RULE MUST AGREE, AND THIS FAILS IF THEY DRIFT.
 *
 * fixer asked for exactly this in writing, before the work: "Derive the fold
 * from whatever resolveAddress already uses for sending, so send and read cannot
 * disagree again, and make a test fail if the two paths ever diverge."
 *
 * They diverged anyway, and a blind audit found it. eventsFor folded case;
 * messagesQuery compared exactly. A message stored as "B" woke the long poll and
 * was invisible to list_messages -- the same confident negative the fix was for,
 * now split across the two readers. This is the gate that would have caught it.
 *
 * HOW PARITY IS ESTABLISHED WITHOUT A DATABASE, and why that is sound rather
 * than a simulation nobody can trust. Two properties are asserted separately:
 *
 *   1. Neither emitted pattern contains an UNESCAPED ilike wildcard. Asserted
 *      directly on the query text.
 *   2. Given (1), `ilike` IS case-insensitive equality -- that is the whole of
 *      its behaviour once the pattern is literal.
 *
 * So the comparison below is not a guess about Postgres. It is a claim about
 * literal patterns, guarded by an assertion that the patterns are literal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { eventsFor } from '../src/events.mjs';
import { inboxNames } from '../src/coordination.mjs';
import { messagesQuery } from '../supabase/functions/mcp/_shared.js';

/** Every ilike pattern the query asks for, decoded and unescaped. */
function patternsOf(q) {
  const raw = [];
  const single = /(?:^|[?&])to_agent=ilike\.([^&]*)/.exec(q);
  if (single) raw.push(single[1]);
  const group = /(?:^|[?&])or=\(([^)]*)\)/.exec(q);
  if (group) {
    for (const part of group[1].split(',')) {
      const m = /^to_agent\.ilike\.(.*)$/.exec(part);
      if (m) raw.push(m[1]);
    }
  }
  return raw.map((p) => decodeURIComponent(p));
}

/** True when a pattern is literal — no wildcard that is not backslash-escaped. */
function isLiteral(pattern) {
  return !/(^|[^\\])[%_]/.test(pattern);
}

const unescape = (p) => p.replace(/\\([%_\\])/g, '$1');

/** Would the PULL path return a row stored under this recipient? */
function pullReaches(agent_id, stored) {
  const pats = patternsOf(messagesQuery({ to_agent: agent_id }));
  for (const p of pats) assert.ok(isLiteral(p), `pattern ${JSON.stringify(p)} carries an unescaped wildcard`);
  const want = String(stored ?? '').toLowerCase();
  return pats.some((p) => unescape(p).toLowerCase() === want);
}

/** Would the PUSH path wake this seat for a row stored under this recipient? */
function pushReaches(agent_id, stored) {
  const messages = [{
    message_id: 'm1', to_agent: stored, from_agent: 'x', type: 'status',
    created_at: '2026-09-18T07:46:23.327Z',
  }];
  return eventsFor({ tasks: [], messages, agent_id, session_id: 's', since: null })
    .some((e) => e.kind === 'message');
}

/*
 * GENERATED FROM THE REAL ROSTER rather than typed out, so adding an actor
 * extends the coverage without anybody remembering to. CLAUDE.md rule 7.
 */
const SEATS = ['code-a', 'code-b', 'code-c', 'code-d', 'fixer', 'danny', 'coordinator'];
const spellings = (n) => [n, n.toUpperCase(), n[0].toUpperCase() + n.slice(1)];

test('THE PARITY GATE: push and pull agree about every spelling of every seat', () => {
  let checkedReachable = 0;
  for (const seat of SEATS) {
    const stored = new Set();
    for (const name of inboxNames(seat)) for (const s of spellings(name)) stored.add(s);
    // plus every other seat's names, which must be reachable by NEITHER
    for (const other of SEATS) {
      if (other === seat) continue;
      for (const name of inboxNames(other)) stored.add(name);
    }

    for (const s of stored) {
      const push = pushReaches(seat, s);
      const pull = pullReaches(seat, s);
      assert.equal(
        pull, push,
        `DIVERGENCE for seat ${seat}, stored ${JSON.stringify(s)}: push=${push} pull=${pull}`,
      );
      if (push) checkedReachable += 1;
    }
  }
  // The positive first: a loop where nothing is reachable agrees perfectly and
  // proves nothing. Assert real deliveries were compared.
  assert.ok(checkedReachable >= 20, `expected many reachable pairs, compared ${checkedReachable}`);
});

test('the case that broke it: "B" reaches code-b on BOTH paths', () => {
  assert.equal(pushReaches('code-b', 'B'), true);
  assert.equal(pullReaches('code-b', 'B'), true, 'the pull path was blind to this');
  assert.equal(pushReaches('code-b', 'CODE-B'), true);
  assert.equal(pullReaches('code-b', 'CODE-B'), true);
});

test('THE OTHER DIRECTION: a fold that is too generous is worse than an empty inbox', () => {
  /*
   * fixer asked for both directions to be measured and stated. A misrouted
   * blocker reads as ordinary traffic; an empty inbox is at least visibly wrong.
   */
  for (const foreign of ['code-a', 'a', 'b6', 'code-c', 'c', 'code-d', 'd', 'danny', 'owner']) {
    assert.equal(pullReaches('code-b', foreign), false, `${foreign} must not reach code-b on pull`);
    assert.equal(pushReaches('code-b', foreign), false, `${foreign} must not reach code-b on push`);
  }
});

test('an underscore in a seat name is a LITERAL, not an ilike wildcard', () => {
  /*
   * AGENT_ID permits _, and ilike treats it as "any single character". An
   * unescaped name like code_b would match code-b and codeXb, delivering one
   * seat's mail to another. This is the widening direction and it is the one
   * that does not look like a bug in the log.
   */
  const actors = [{ actor_id: 'code_b', actor_type: 'worker', aliases: ['x_1'] }];
  const q = messagesQuery({ to_agent: 'code_b' });
  for (const p of patternsOf(q)) {
    assert.ok(isLiteral(p), `${JSON.stringify(p)} would match more than itself`);
    assert.match(p, /\\_/, 'the underscore must be escaped, not merely present');
  }
  assert.ok(actors.length, 'roster shape kept for the reader; fold is derived, never listed');
});

test('the fold is DERIVED, so there is no second list to drift', () => {
  /*
   * The structural half of the parity claim: both paths read the same
   * inboxNames. If anybody later writes a literal pair table on either side,
   * this fails even if the behaviour happens to still agree that day.
   */
  for (const seat of SEATS) {
    const fromQuery = patternsOf(messagesQuery({ to_agent: seat })).map(unescape).sort();
    assert.deepEqual(fromQuery, [...inboxNames(seat)].sort(),
      `the pull path asks for a different set than inboxNames for ${seat}`);
  }
});
