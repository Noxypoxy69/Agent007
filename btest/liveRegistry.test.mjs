import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registryFromSessions, isLive, heartbeatAgeMs, verificationOf, VERIFICATION, STALE_AFTER_MS,
} from '../src/liveRegistry.mjs';
import { resolveWorker } from '../src/laneRegistry.mjs';

/**
 * THE ROSTER IS DERIVED, NOT TYPED. The proofs required of it.
 *
 * The owner's ruling, 2026-09-15: no static production roster, .example.yml
 * stays example-only, and the live registry is built from runtime
 * self-registration. A hand-authored roster is humans typing machine truth --
 * wrong the moment a session restarts, and wrong confidently.
 *
 * These tests drive registryFromSessions into the EXISTING resolveWorker rather
 * than a new resolver, because the rules required here are the ones it already
 * implements. Two implementations of identity would disagree the first time one
 * was fixed.
 */

const NOW = '2026-09-15T12:00:00.000Z';
const ago = (ms) => new Date(Date.parse(NOW) - ms).toISOString();

const reg = (rows, opts) => registryFromSessions(rows, { now: NOW, ...opts });

const worker = (over = {}) => ({
  agent_id: 'code-b',
  session_id: 'danny-win-f1',
  repo_id: 'agentbridge',
  worktree_id: 'agentbridge-b',
  lane_id: 'agentbridge',
  capacity: 'idle',
  head_sha: 'a'.repeat(40),
  heartbeat_at: ago(1000),
  ...over,
});

// ── proof 1 ────────────────────────────────────────────────────────────────
test('a worker APPEARS automatically after registering — no file edited', () => {
  const r = reg([worker()]);
  assert.deepEqual(r.agents.map((a) => a.agent_id), ['code-b']);
  assert.equal(r.sessions.length, 1);

  const resolved = resolveWorker(r, { agent_id: 'code-b' });
  assert.equal(resolved.ok, true, resolved.reason);
  assert.equal(resolved.session_id, 'danny-win-f1');
});

// ── proof 2 ────────────────────────────────────────────────────────────────
test('a heartbeat REFRESHES liveness', () => {
  const stale = worker({ heartbeat_at: ago(STALE_AFTER_MS + 60_000) });
  assert.equal(isLive(stale, { now: NOW }), false);

  // Same worker, same session, new heartbeat.
  const refreshed = { ...stale, heartbeat_at: ago(5_000) };
  assert.equal(isLive(refreshed, { now: NOW }), true);
  assert.equal(resolveWorker(reg([refreshed]), { agent_id: 'code-b' }).ok, true);
});

// ── proof 3 ────────────────────────────────────────────────────────────────
test('a stale worker AGES OFFLINE even though it last said idle', () => {
  const stale = worker({ capacity: 'idle', heartbeat_at: ago(STALE_AFTER_MS + 1) });
  const r = reg([stale]);
  assert.equal(r.sessions[0].capacity, 'offline',
    'a dead worker keeps claiming idle in its last row forever');

  const resolved = resolveWorker(r, { agent_id: 'code-b' });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, 'no-live-session');
});

test('a missing or unreadable heartbeat is OFFLINE, never live', () => {
  // No evidence the worker is there must not resolve as "present".
  for (const hb of [null, undefined, '', 'not-a-date']) {
    assert.equal(isLive(worker({ heartbeat_at: hb }), { now: NOW }), false, `heartbeat ${hb}`);
  }
  assert.equal(heartbeatAgeMs(worker({ heartbeat_at: null }), NOW), null);
});

// ── proof 4 ────────────────────────────────────────────────────────────────
test('a NEW session for the same durable agent resolves — only when unambiguous', () => {
  // The old session is gone (stale); the new one is live. Same agent_id.
  const old = worker({ session_id: 'danny-win-f1', heartbeat_at: ago(STALE_AFTER_MS + 60_000) });
  const fresh = worker({ session_id: 'danny-win-f9', heartbeat_at: ago(2_000) });

  const resolved = resolveWorker(reg([old, fresh]), { agent_id: 'code-b' });
  assert.equal(resolved.ok, true, resolved.reason);
  assert.equal(resolved.session_id, 'danny-win-f9', 'resolved to the dead session');

  // But while BOTH are live it must refuse rather than pick the newer one.
  const bothLive = [{ ...old, heartbeat_at: ago(3_000) }, fresh];
  const ambiguous = resolveWorker(reg(bothLive), { agent_id: 'code-b' });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, 'ambiguous-session');
  assert.deepEqual(ambiguous.candidates.sort(), ['danny-win-f1', 'danny-win-f9']);
});

// ── proofs 5 and 6 ─────────────────────────────────────────────────────────
test('an UNKNOWN agent refuses', () => {
  const r = resolveWorker(reg([worker()]), { agent_id: 'nobody-at-all' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown-agent');
});

test('an agent that declared itself OFFLINE refuses', () => {
  /*
   * Asserted at BOTH levels on purpose. A declared-offline worker is caught
   * twice -- isLive refuses it, and resolveWorker filters capacity 'offline'
   * -- so going only through the registry cannot tell which guard is doing the
   * work. Removing the check inside isLive came back GREEN against an earlier
   * draft of this test for exactly that reason: the second guard covered for
   * the missing first one, and defence in depth had quietly become a single
   * point of failure nobody was testing.
   *
   * It matters because a fresh heartbeat with capacity 'offline' is a worker
   * that is RUNNING and saying "do not send me work". That is a different fact
   * from "I have not heard from it", and isLive must know it on its own.
   */
  const declaredOffline = worker({ capacity: 'offline', heartbeat_at: ago(1000) });
  assert.equal(isLive(declaredOffline, { now: NOW }), false,
    'a live process that declared itself offline was treated as available');

  const r = resolveWorker(reg([declaredOffline]), { agent_id: 'code-b' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-live-session');
});

// ── proof 7 ────────────────────────────────────────────────────────────────
test('two live sessions for the same target REFUSE and name both', () => {
  const a = worker({ session_id: 's1' });
  const b = worker({ session_id: 's2', worktree_id: 'agentbridge-b2' });
  const r = resolveWorker(reg([a, b]), { agent_id: 'code-b' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ambiguous-session');
  assert.deepEqual(r.candidates.sort(), ['s1', 's2']);
});

test('a repo conflict refuses rather than resolving to the wrong worktree', () => {
  const here = worker({ session_id: 's1', repo_id: 'agentbridge' });
  const elsewhere = worker({ session_id: 's2', repo_id: 'social-sparks-app' });
  const r = reg([here, elsewhere]);

  // Narrowing by repo disambiguates...
  assert.equal(resolveWorker(r, { agent_id: 'code-b', repo_id: 'agentbridge' }).session_id, 's1');
  // ...and a repo nobody is in refuses rather than falling back to "any".
  const none = resolveWorker(r, { agent_id: 'code-b', repo_id: 'some-other-repo' });
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'no-live-session');
});

// ── proof 8 ────────────────────────────────────────────────────────────────
test('NO static yml is required — the registry comes from rows alone', () => {
  // The whole ruling in one assertion: nothing here reads a file.
  const r = reg([worker(), worker({ agent_id: 'code-c', session_id: 's-c' })]);
  assert.deepEqual(r.agents.map((a) => a.agent_id), ['code-b', 'code-c']);
  assert.equal(resolveWorker(r, { agent_id: 'code-c' }).session_id, 's-c');

  // An empty machine is an empty registry, not an error and not a stale file.
  assert.deepEqual(reg([]).agents, []);
  assert.equal(resolveWorker(reg([]), { agent_id: 'code-b' }).reason, 'unknown-agent');
});

// ── no agent may invent another's session ──────────────────────────────────
test('a row without its OWN session_id is dropped, never defaulted', () => {
  // Defaulting session_id to agent_id would manufacture precisely the identity
  // the registry exists to verify, and it would look like it worked.
  for (const bad of [{ session_id: null }, { session_id: '' }, { session_id: '   ' }]) {
    const r = reg([worker(bad)]);
    assert.deepEqual(r.sessions, [], `a row with session_id ${JSON.stringify(bad)} was admitted`);
    assert.deepEqual(r.agents, [], 'an agent was invented from a row that names no session');
  }
  // And the mirror: no agent_id is equally unusable.
  assert.deepEqual(reg([worker({ agent_id: null })]).sessions, []);
});

// ── provenance ─────────────────────────────────────────────────────────────
test('a delegation with no verification marker is LEGACY, never verified', () => {
  // Every contract recorded before runtime registration took the warn-and-accept
  // path. Reading an absent marker as verified would rewrite the provenance of
  // all of them at once.
  assert.equal(verificationOf({}), VERIFICATION.LEGACY);
  assert.equal(verificationOf({ target_verification: null }), VERIFICATION.LEGACY);
  assert.equal(verificationOf(undefined), VERIFICATION.LEGACY);

  // Only the explicit marker counts, and only that exact value.
  assert.equal(verificationOf({ target_verification: 'verified' }), VERIFICATION.VERIFIED);
  assert.equal(verificationOf({ target_verification: 'VERIFIED' }), VERIFICATION.LEGACY);
  assert.equal(verificationOf({ target_verification: true }), VERIFICATION.LEGACY);
  assert.equal(verificationOf({ target_verification: 'legacy-unverified' }), VERIFICATION.LEGACY);
});

test('the clock is a parameter — liveness is never read from the wall', () => {
  // A wall-clock read inside the module would make every test above a race.
  assert.throws(() => registryFromSessions([worker()], {}), /requires a `now`/);
  assert.throws(() => registryFromSessions('not an array', { now: NOW }), /requires an array/);
});
