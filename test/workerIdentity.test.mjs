import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLaneRegistry,
  validateRegistry,
  resolveWorker,
  bindDelegation,
  workerRoster,
  sessionsOfAgent,
  lanesForAgent,
  CAPACITIES,
} from '../src/laneRegistry.mjs';

/**
 * ONE WORKER REGISTRY, ACROSS EVERY REPOSITORY.
 *
 * The failure this models away happened on 15 September. Three sessions each
 * believed they were "Code C"; four commits on one branch came from three
 * sessions under one git identity; and one session amended another's commit
 * believing it was its own. Nothing in git could attribute any of it, because
 * the thing that was durable (a worker) and the thing that was ephemeral (a
 * runtime) had been fused into one name.
 *
 * So the model separates what outlives what:
 *
 *   agent_id             durable, repo-independent
 *   session_id           one runtime
 *   repo/worktree/lane   where that runtime is now
 *
 * AND THERE IS EXACTLY ONE NAMESPACE. A worker moving from agentbridge to
 * social-sparks changes an assignment, not an identity. The tests below are
 * written to fail if a second per-repo namespace is ever introduced, because
 * that is the change that would quietly bring the original confusion back with
 * tooling to enforce it.
 */

const REG = parseLaneRegistry(`
agents:
  - agent_id: worker-b
    display_name: B
  - agent_id: worker-c
    display_name: C
  - agent_id: worker-idle
sessions:
  - session_id: s-b-bridge
    agent_id: worker-b
    repo_id: agentbridge
    worktree_id: agentbridge-b
    capacity: busy
  - session_id: s-b-product
    agent_id: worker-b
    repo_id: social-sparks
    worktree_id: social-sparks-code-b
    capacity: idle
  - session_id: s-c
    agent_id: worker-c
    repo_id: agentbridge
    worktree_id: agentbridge
    capacity: idle
  - session_id: s-idle
    agent_id: worker-idle
    repo_id: agentbridge
    worktree_id: agentbridge-x
    capacity: offline
lanes:
  - lane_id: bridge
    owned_paths:
      - "src/**"
  - lane_id: onboarding
    owned_paths:
      - "app/**"
assignments:
  - lane_id: bridge
    agent_id: worker-c
  - lane_id: onboarding
    agent_id: worker-b
    repo_id: social-sparks
`);

test('the fixture registry is valid', () => {
  const v = validateRegistry(REG);
  assert.deepEqual(v.errors, []);
  assert.equal(v.ok, true);
});

/* ── identity is durable and repo-independent ────────────────────────── */

test('ONE agent spans TWO repositories without becoming two identities', () => {
  // The whole federation requirement, in one assertion. worker-b is running in
  // agentbridge and in social-sparks simultaneously, and is one agent.
  const sessions = sessionsOfAgent(REG, 'worker-b');
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map((s) => s.repo_id).sort(), ['agentbridge', 'social-sparks']);
  assert.equal(new Set(sessions.map((s) => s.agent_id)).size, 1);
});

test('repo_id lives on the SESSION, never on the agent', () => {
  /*
   * The structural guard against a second namespace. If somebody ever adds a
   * repo to the agent record, an agent stops being repo-independent and
   * "worker-b in agentbridge" becomes a different worker from "worker-b in
   * social-sparks" — which is the confusion this replaced.
   */
  for (const a of REG.agents) {
    assert.equal('repo_id' in a, false, 'an agent must not carry a repository');
    assert.equal('worktree_id' in a, false, 'an agent must not carry a worktree');
    assert.equal('lane_id' in a, false, 'an agent must not carry a lane');
  }
});

test('a lane is held by the AGENT, so it survives the session that held it', () => {
  assert.deepEqual(lanesForAgent(REG, 'worker-c'), ['bridge']);
  assert.deepEqual(lanesForAgent(REG, 'worker-b'), ['onboarding']);
});

/* ── resolution: durable target to live runtime ──────────────────────── */

test('an agent in one repo resolves to its single live session', () => {
  const r = resolveWorker(REG, { agent_id: 'worker-c' });
  assert.equal(r.ok, true);
  assert.equal(r.session_id, 's-c');
  assert.equal(r.repo_id, 'agentbridge');
});

test('AMBIGUITY REFUSES AND NAMES THE CANDIDATES — this is the 15 Sep failure', () => {
  /*
   * worker-b is live in two repositories, so "which session" has no single
   * answer without more context. Picking the newest would have "worked" that
   * day and sent the work to the wrong runtime, which is precisely what
   * happened when three sessions answered to one name.
   */
  const r = resolveWorker(REG, { agent_id: 'worker-b' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ambiguous-session');
  assert.deepEqual(r.candidates.sort(), ['s-b-bridge', 's-b-product']);
});

test('NEAREST CLEAN: the same agent resolves once a repo is given', () => {
  const r = resolveWorker(REG, { agent_id: 'worker-b', repo_id: 'social-sparks' });
  assert.equal(r.ok, true);
  assert.equal(r.session_id, 's-b-product');
});

test('a worktree narrows it further', () => {
  const r = resolveWorker(REG, { agent_id: 'worker-b', worktree_id: 'agentbridge-b' });
  assert.equal(r.ok, true);
  assert.equal(r.session_id, 's-b-bridge');
});

test('an unknown agent REFUSES rather than being invented', () => {
  const r = resolveWorker(REG, { agent_id: 'worker-nobody' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown-agent');
});

test('an agent with only an offline session has no live runtime', () => {
  const r = resolveWorker(REG, { agent_id: 'worker-idle' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-live-session');
});

test('naming no agent at all refuses', () => {
  assert.equal(resolveWorker(REG, {}).reason, 'no-agent-named');
  assert.equal(resolveWorker(REG).reason, 'no-agent-named');
});

test('a session that has not reported a repo is NOT a match for a specific one', () => {
  /*
   * null means "not reported yet", not "anywhere". Treating it as a wildcard
   * would bind a delegation to a runtime that is not where the work is.
   */
  const reg = parseLaneRegistry(`
agents:
  - agent_id: w
sessions:
  - session_id: s
    agent_id: w
    capacity: idle
`);
  assert.equal(resolveWorker(reg, { agent_id: 'w' }).ok, true, 'with no repo asked for, it resolves');
  assert.equal(resolveWorker(reg, { agent_id: 'w', repo_id: 'agentbridge' }).reason, 'no-live-session');
});

/* ── delegations target the durable id, bind to the live one ─────────── */

test('a delegation names an AGENT and binds to a session', () => {
  const d = { id: 'd-x', to_agent: 'worker-c' };
  const b = bindDelegation(REG, d);
  assert.equal(b.ok, true);
  assert.equal(b.delegation_id, 'd-x');
  assert.equal(b.agent_id, 'worker-c');
  assert.equal(b.session_id, 's-c');
  assert.equal(b.repo_id, 'agentbridge');
});

test('binding does NOT mutate the delegation', () => {
  /*
   * A binding is a fact about right now. Writing it into the durable record
   * would turn it into a claim about for ever, and the next restart would make
   * that claim false while leaving it recorded — the same mistake one layer
   * down from fusing agent and session.
   *
   * NOT FROZEN, DELIBERATELY. The first version of this test used
   * Object.freeze, which makes mutation impossible whatever the code does — so
   * it passed against a bindDelegation that assigned to the delegation on its
   * first line. Mutation caught it: the test was asserting a property of
   * Object.freeze, not of the function. A plain object is the only version of
   * this that can fail.
   */
  const d = { id: 'd-x', to_agent: 'worker-c' };
  const before = JSON.stringify(d);
  bindDelegation(REG, d);
  assert.equal(JSON.stringify(d), before, 'bindDelegation wrote into the durable record');
  assert.deepEqual(Object.keys(d).sort(), ['id', 'to_agent']);
});

test('a delegation to an unknown agent refuses to bind', () => {
  const b = bindDelegation(REG, { id: 'd-y', to_agent: 'ghost' });
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'unknown-agent');
  assert.equal(b.delegation_id, 'd-y');
});

test('an ambiguous delegation refuses and reports both sessions', () => {
  const b = bindDelegation(REG, { id: 'd-z', to_agent: 'worker-b' });
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'ambiguous-session');
  assert.equal(b.candidates.length, 2);
});

test('a BUSY worker still binds — the queue is the point', () => {
  // Refusing here would mean a worker can never be given its next task while
  // finishing the current one.
  const b = bindDelegation(REG, { id: 'd-q', to_agent: 'worker-b' }, { repo_id: 'agentbridge' });
  assert.equal(b.ok, true);
  assert.equal(b.session_id, 's-b-bridge');
});

test('a BLOCKED worker does not bind', () => {
  const reg = parseLaneRegistry(`
agents:
  - agent_id: w
sessions:
  - session_id: s
    agent_id: w
    repo_id: r
    capacity: blocked
`);
  const b = bindDelegation(reg, { id: 'd', to_agent: 'w' });
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'worker-blocked');
});

/* ── validation refuses the shapes that caused the confusion ─────────── */

test('A SESSION WITH NO AGENT IS REJECTED — an unattributable runtime', () => {
  const reg = parseLaneRegistry(`
agents:
  - agent_id: w
sessions:
  - session_id: orphan
`);
  const v = validateRegistry(reg);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /orphan.*names no agent/.test(e)), v.errors.join('; '));
});

test('a session belonging to an unknown agent is rejected', () => {
  const reg = parseLaneRegistry(`
agents:
  - agent_id: w
sessions:
  - session_id: s
    agent_id: someone-else
`);
  assert.ok(validateRegistry(reg).errors.some((e) => /unknown agent/.test(e)));
});

test('an unknown capacity is rejected rather than silently treated as idle', () => {
  const reg = parseLaneRegistry(`
agents:
  - agent_id: w
sessions:
  - session_id: s
    agent_id: w
    capacity: probably-fine
`);
  const v = validateRegistry(reg);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /unknown capacity/.test(e)));
});

test('every declared capacity is accepted', () => {
  for (const c of CAPACITIES) {
    const reg = parseLaneRegistry(`
agents:
  - agent_id: w
sessions:
  - session_id: s
    agent_id: w
    capacity: ${c}
`);
    assert.deepEqual(validateRegistry(reg).errors, [], `capacity ${c} should be valid`);
  }
});

/* ── the roster is global, not per repository ────────────────────────── */

test('the roster lists every worker once, with the repos it is live in', () => {
  const roster = workerRoster(REG);
  assert.deepEqual(roster.map((w) => w.agent_id).sort(), ['worker-b', 'worker-c', 'worker-idle']);
  const b = roster.find((w) => w.agent_id === 'worker-b');
  assert.deepEqual(b.repos.sort(), ['agentbridge', 'social-sparks'], 'one row, two repos');
});

test('a worker whose only session is offline reads as offline, not absent', () => {
  /*
   * "Told us it stopped" and "stopped telling us" are different facts, and the
   * difference is whether reassigning its lane is safe. A worker that vanished
   * from the roster entirely would look like one that was never there.
   */
  const w = workerRoster(REG).find((x) => x.agent_id === 'worker-idle');
  assert.equal(w.capacity, 'offline');
  assert.deepEqual(w.sessions, []);
});

test('the roster is a flat list — a per-repo grouping would invite a second registry', () => {
  const roster = workerRoster(REG);
  assert.ok(Array.isArray(roster));
  for (const w of roster) assert.equal(typeof w.agent_id, 'string');
  // One entry per agent, never one per (agent, repo) pair.
  assert.equal(roster.length, new Set(roster.map((w) => w.agent_id)).size);
});
