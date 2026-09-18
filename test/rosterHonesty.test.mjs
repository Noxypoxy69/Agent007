/**
 * THE READ SURFACE MUST NOT REPORT UNKNOWNS AS CONFIDENT ZEROS.
 *
 * The MCP server tells every client two things:
 *
 *   "Every field is observed from git plumbing and the process table on the
 *    developer machine, not reported by the agents themselves."
 *   "Fields that could not be determined are null -- treat null as unknown,
 *    never as zero."
 *
 * The hosted projection did the opposite of both. It hardcoded `locks: []`,
 * `processes: []`, `processProbeOk: true` -- a literal that was never false --
 * and `git.ok: true`, which meant only that a column had a value. A hosted
 * registration carries no process table and no lock list, so those were not
 * observations at all.
 *
 * Measured 2026-09-18: list_active_processes reported processProbeOk true and an
 * empty process list for all ten agents, two of which were running. Its own
 * documentation says a FALSE probe flag makes an empty list inconclusive, which
 * is precisely why a hardcoded true is worse than no field at all.
 *
 * All of it sat in index.ts, which the suite cannot import -- rule 10, untested
 * by construction. These tests exist because the projection moved somewhere they
 * could reach it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { sessionProjection, selectAgentSession } from '../supabase/functions/mcp/_shared.js';

const NOW = '2026-09-18T09:00:00.000Z';
const ago = (ms) => new Date(Date.parse(NOW) - ms).toISOString();
const MIN = 60_000;

const row = (over = {}) => ({
  agent_id: 'code-b',
  session_id: 'danny-win-b2',
  lane_id: 'agentbridge',
  machine_id: 'm1',
  worktree_id: 'Agent007',
  head_sha: 'd8eb230f511d173c2009d0d49df25671dd0bf973',
  heartbeat_at: ago(30_000),
  capacity: 'busy',
  ...over,
});

test('WHAT IT CANNOT KNOW IS NULL, never an empty list and never a true flag', () => {
  const p = sessionProjection(row(), { now: NOW });
  assert.equal(p.processes, null, 'a hosted row carries no process table');
  assert.equal(p.locks, null, 'a hosted row carries no lock list');
  assert.equal(p.processProbeOk, false, 'no probe ran, so it must not claim one did');
});

test('the git sha is reported as PUBLISHED, without claiming a read succeeded', () => {
  const p = sessionProjection(row(), { now: NOW });
  assert.equal(p.git.head, 'd8eb230f511d173c2009d0d49df25671dd0bf973');
  assert.equal(p.git.publishedAt, ago(30_000), 'the age of the sha must be visible');
  assert.equal(p.git.ok, undefined, 'ok asserted a read nobody performed here');

  assert.equal(sessionProjection(row({ head_sha: null }), { now: NOW }).git, null);
});

test('capacity is still DERIVED, so a dead worker stops claiming idle forever', () => {
  // The property the original comment was written for, preserved through the move.
  assert.equal(sessionProjection(row({ capacity: 'busy' }), { now: NOW }).capacity, 'busy');
  const dead = sessionProjection(
    row({ capacity: 'idle', heartbeat_at: ago(90 * MIN) }), { now: NOW },
  );
  assert.equal(dead.capacity, 'offline', 'staleness overrides what the row claimed');
});

test('the identifying fields survive the move unchanged', () => {
  const p = sessionProjection(row(), { now: NOW });
  assert.equal(p.agentId, 'code-b');
  assert.equal(p.sessionId, 'danny-win-b2');
  assert.equal(p.lane, 'agentbridge');
  assert.equal(p.machineLabel, 'm1');
  assert.equal(p.worktree, 'Agent007');
  assert.equal(p.repoId, null, 'an absent column is null, not undefined');
});

/* ─────────────────────────── selectAgentSession ─────────────────────────── */

const live = (over = {}) => ({ agentId: 'code-b', sessionId: 's-live', capacity: 'busy', lastSeenAt: ago(MIN), ...over });
const dead = (over = {}) => ({ agentId: 'code-b', sessionId: 's-dead', capacity: 'offline', lastSeenAt: ago(60 * MIN), ...over });

test('THE POSITIVE FIRST: one live session resolves to itself', () => {
  const r = selectAgentSession([live()], 'code-b');
  assert.equal(r.ok, true);
  assert.equal(r.session.sessionId, 's-live');
});

test('THE ALIAS: asking by the name people actually use finds the agent', () => {
  /*
   * Measured on the live bridge: get_agent_state('b') answered "no such agent"
   * while code-b was running. b is a REGISTERED alias.
   */
  const r = selectAgentSession([live()], 'b');
  assert.equal(r.ok, true, 'b is an alias of code-b');
  assert.equal(r.session.sessionId, 's-live');
  assert.equal(selectAgentSession([live()], 'CODE-B').ok, true, 'and case does not hide it');
  // and a row registered UNDER the alias is found by the canonical name too
  assert.equal(selectAgentSession([live({ agentId: 'b' })], 'code-b').ok, true);
});

test('THE FIRST-MATCH BUG: a dead row ahead of a live one must not win', () => {
  /*
   * The exact measured shape. code-b held four rows and the call returned a dead
   * throwaway seat carrying a reverted commit, because it was first in the list.
   */
  const r = selectAgentSession([dead(), live()], 'code-b');
  assert.equal(r.ok, true);
  assert.equal(r.session.sessionId, 's-live', 'position must not decide identity');

  // and the other order, so this is not passing by luck of the fixture
  assert.equal(selectAgentSession([live(), dead()], 'code-b').session.sessionId, 's-live');
});

test('AMBIGUITY IS REPORTED, not resolved by position', () => {
  /*
   * b/session-credentials already refuses first-match for identity: "a digest
   * matching two rows resolves NEITHER -- first-match would have silently handed
   * over the first identity it found." Same reasoning, carried to this reader.
   */
  const r = selectAgentSession([live(), live({ sessionId: 's-live-2' })], 'code-b');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ambiguous-session');
  assert.deepEqual(r.candidates, ['s-live', 's-live-2'], 'and it names them');
});

test('A DEAD ANSWER IS LABELLED, and it is the FRESHEST dead one', () => {
  const older = dead({ sessionId: 's-older', lastSeenAt: ago(600 * MIN) });
  const r = selectAgentSession([older, dead()], 'code-b');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-live-session');
  assert.equal(r.stale.sessionId, 's-dead', 'the most recent registration, not the first row');
});

test('unknown, nobody-home and ambiguous are THREE different answers', () => {
  /*
   * A reader has to tell a typo from an agent that has gone away from an agent
   * with two runtimes. Collapsing any two of them is how "no such agent" gets
   * reported for a worker that is simply asleep.
   */
  assert.equal(selectAgentSession([live()], 'code-q').reason, 'unknown-agent');
  assert.equal(selectAgentSession([dead()], 'code-b').reason, 'no-live-session');
  assert.equal(selectAgentSession([live(), live({ sessionId: 'x' })], 'code-b').reason, 'ambiguous-session');
  assert.equal(selectAgentSession([live()], '').reason, 'no-agent-named');
  assert.equal(selectAgentSession([live()], null).reason, 'no-agent-named');
});

test('one agent never answers for another', () => {
  const others = [live({ agentId: 'code-a', sessionId: 'a-live' }), live({ agentId: 'code-c', sessionId: 'c-live' })];
  assert.equal(selectAgentSession(others, 'code-b').reason, 'unknown-agent');
  // b6 belongs to code-a now, so it must resolve there and nowhere else
  assert.equal(selectAgentSession(others, 'b6').session.sessionId, 'a-live');
});
