import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCaller,
  resolveAddress,
  mintSessionToken,
  digestToken,
  SESSION_TOKEN_BYTES,
} from '../src/sessionCredential.mjs';
import { STALE_AFTER_MS } from '../src/liveRegistry.mjs';

/*
 * A gate that only permits is decoration; a gate that only refuses is an
 * outage. Both directions are asserted here, and the positive is established
 * FIRST so that every refusal below is measured against a fixture that is
 * otherwise known-good. A refusal test that passes because its fixture stopped
 * being valid proves nothing about the rule it names.
 */

const NOW = Date.parse('2026-09-17T06:00:00.000Z');
const fresh = new Date(NOW - 1000).toISOString();

/** The one good credential every case below starts from. */
const GOOD = mintSessionToken();

function baseSession(over = {}) {
  return {
    session_id: 'danny-win-b1',
    agent_id: 'code-b',
    credential_digest: GOOD.digest,
    heartbeat_at: fresh,
    revoked_at: null,
    ended_at: null,
    bound_task_id: null,
    bound_attempt_id: null,
    ...over,
  };
}

const AGENTS = [{ agent_id: 'code-b', kind: 'permanent', status: 'active' }];

/* c8 is main's alias; b6 is a retired name for the same seat. Both are real
 * shapes from this repo's own roster, not invented ones. */
const ALIASES = [
  { alias: 'b', canonical_agent_id: 'code-b', historical_only: false },
  { alias: 'b6', canonical_agent_id: 'code-b', historical_only: true },
];

const ok = (over = {}) =>
  resolveCaller({
    token: GOOD.token,
    sessions: [baseSession()],
    agents: AGENTS,
    aliases: ALIASES,
    now: NOW,
    ...over,
  });

/* ---------- THE POSITIVE, FIRST ---------- */

test('a valid credential resolves exactly one agent and one session', () => {
  const r = ok();
  assert.equal(r.ok, true, `expected acceptance, got ${JSON.stringify(r)}`);
  assert.equal(r.agentId, 'code-b');
  assert.equal(r.sessionId, 'danny-win-b1');
});

test('THE CONTROL: this gate can actually refuse — the positive is not unconditional', () => {
  const r = ok({ token: 'not-the-token' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown-credential');
});

test('ONE PERMANENT AGENT MAY HOLD TWO INDEPENDENT SESSIONS', () => {
  const second = mintSessionToken();
  const sessions = [
    baseSession(),
    baseSession({ session_id: 'danny-win-b2', credential_digest: second.digest }),
  ];
  const a = ok({ sessions });
  const b = ok({ sessions, token: second.token });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.agentId, b.agentId, 'same agent');
  assert.notEqual(a.sessionId, b.sessionId, 'different sessions');
});

test('a CURRENTLY VALID alias may be used as self-description', () => {
  const r = ok({ claimedAgentId: 'b' });
  assert.equal(r.ok, true, `expected acceptance, got ${JSON.stringify(r)}`);
  assert.equal(r.agentId, 'code-b', 'resolved to the canonical id, not the alias');
});

/* ---------- THE CREDENTIAL ITSELF ---------- */

test('the token is never the stored value — the digest is', () => {
  const { token, digest } = mintSessionToken();
  assert.equal(token.length, SESSION_TOKEN_BYTES * 2, 'hex of 32 bytes');
  assert.notEqual(token, digest);
  assert.equal(digest, digestToken(token));
  assert.match(digest, /^[a-f0-9]{64}$/);
});

test('two mints never collide', () => {
  assert.notEqual(mintSessionToken().token, mintSessionToken().token);
});

/* ---------- THE REFUSALS THE SPEC NAMES ---------- */

test('REFUSAL: body impersonation — a valid credential does not let you speak as someone else', () => {
  const r = ok({ claimedAgentId: 'code-d' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'impersonation');
});

test('REFUSAL: ALIAS AUTHENTICATION — a name with no credential proves nothing', () => {
  /*
   * Every name this system knows, tried as if it were a credential. Generated
   * from the real alias list plus the canonical ids, so adding an alias extends
   * this coverage without anybody remembering to.
   */
  const everyName = [...ALIASES.map((a) => a.alias), ...AGENTS.map((a) => a.agent_id)];
  assert.ok(everyName.length >= 3, 'the generated name list is not empty');
  for (const name of everyName) {
    const r = ok({ token: null, claimedAgentId: name });
    assert.equal(r.ok, false, `${name} authenticated with no credential`);
    assert.equal(r.reason, 'no-credential', `${name} refused for the wrong reason`);
  }
});

test('REFUSAL: a RETIRED alias does not identify even its own agent', () => {
  const r = ok({ claimedAgentId: 'b6' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'alias-not-authenticating');
});

test('REFUSAL: an alias outside its validity window is equally powerless', () => {
  const aliases = [
    { alias: 'b', canonical_agent_id: 'code-b', valid_until: '2026-09-16T00:00:00.000Z' },
  ];
  const r = ok({ claimedAgentId: 'b', aliases });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'alias-not-authenticating');
});

test('REFUSAL: a revoked credential', () => {
  const r = ok({ sessions: [baseSession({ revoked_at: fresh })] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'credential-revoked');
});

test('REFUSAL: a stale session, measured against the SHARED constant', () => {
  const old = new Date(NOW - STALE_AFTER_MS - 1).toISOString();
  const r = ok({ sessions: [baseSession({ heartbeat_at: old })] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'session-stale');

  /* The boundary is inclusive on the live side, so the constant is the rule
   * rather than roughly the rule. */
  const edge = new Date(NOW - STALE_AFTER_MS).toISOString();
  assert.equal(ok({ sessions: [baseSession({ heartbeat_at: edge })] }).ok, true);
});

test('REFUSAL: a heartbeat that cannot be read is STALE, not fine', () => {
  for (const bad of [null, '', 'whenever']) {
    const r = ok({ sessions: [baseSession({ heartbeat_at: bad })] });
    assert.equal(r.ok, false, `heartbeat ${JSON.stringify(bad)} was accepted`);
    assert.equal(r.reason, 'session-heartbeat-unreadable');
  }
});

/* ---------- DISPOSABLE CREDENTIALS ARE BOUND TO ONE PIECE OF WORK ---------- */

test('a task-bound credential works for ITS task', () => {
  const r = ok({ sessions: [baseSession({ bound_task_id: 't-1' })], taskId: 't-1' });
  assert.equal(r.ok, true, `expected acceptance, got ${JSON.stringify(r)}`);
});

test('REFUSAL: a task-bound credential used on ANOTHER task', () => {
  const r = ok({ sessions: [baseSession({ bound_task_id: 't-1' })], taskId: 't-2' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'wrong-task-binding');
});

test('REFUSAL: a binding that cannot be CHECKED is refused, not waved through', () => {
  const r = ok({ sessions: [baseSession({ bound_task_id: 't-1' })], taskId: null });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'task-binding-uncheckable');
});

test('REFUSAL: the same rule holds for an attempt binding', () => {
  const s = [baseSession({ bound_attempt_id: 'a-1' })];
  assert.equal(ok({ sessions: s, attemptId: 'a-1' }).ok, true);
  assert.equal(ok({ sessions: s, attemptId: 'a-2' }).reason, 'wrong-attempt-binding');
  assert.equal(ok({ sessions: s, attemptId: null }).reason, 'attempt-binding-uncheckable');
});

/* ---------- A CREDENTIAL THAT RESOLVES TWO IDENTITIES RESOLVES NONE ---------- */

test('REFUSAL: two sessions sharing a digest is AMBIGUOUS, not first-match', () => {
  const sessions = [
    baseSession(),
    baseSession({ session_id: 'danny-win-b2', agent_id: 'code-d' }),
  ];
  const r = ok({ sessions });
  assert.equal(r.ok, false);
  assert.equal(
    r.reason,
    'ambiguous-credential',
    'first-match would have silently picked code-b and handed over its identity',
  );
});

test('REFUSAL: a session row with no agent identifies nobody', () => {
  const r = ok({ sessions: [baseSession({ agent_id: null })] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'session-without-agent');
});

test('REFUSAL: a retired agent, even holding a live credential', () => {
  const r = ok({ agents: [{ agent_id: 'code-b', kind: 'permanent', status: 'retired' }] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'agent-retired');
});

test('REFUSAL: no session store at all is not an empty store', () => {
  assert.equal(ok({ sessions: null }).reason, 'no-session-store');
});

/* ---------- ADDRESSING IS A DIFFERENT QUESTION AND STAYS OPEN ---------- */

test('ADDRESSING: a historical alias still ROUTES, which is why it exists', () => {
  assert.equal(resolveAddress('b6', { aliases: ALIASES }), 'code-b');
  assert.equal(resolveAddress('b', { aliases: ALIASES }), 'code-b');
  assert.equal(resolveAddress('code-b', { aliases: ALIASES }), 'code-b');
});

test('THE CONTROL: routing a name never grants anything — the two paths disagree on purpose', () => {
  assert.equal(resolveAddress('b6', { aliases: ALIASES }), 'code-b', 'b6 routes');
  assert.equal(ok({ claimedAgentId: 'b6' }).ok, false, 'and b6 still cannot authenticate');
});
