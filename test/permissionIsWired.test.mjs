import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canDecidePermission as srcCanDecide, classifyRequest as srcClassify,
  riskOf as srcRiskOf, pendingRequests as srcPending, pausedTasks as srcPaused,
  DECIDER,
} from '../src/permissionRequest.mjs';
import {
  canDecidePermission as depCanDecide, classifyRequest as depClassify,
  riskOf as depRiskOf, pendingRequests as depPending, pausedTasks as depPaused,
  toolDefs,
} from '../supabase/functions/mcp/_shared.js';

/**
 * THE PERMISSION PATH, WIRED — AND PROVEN TO BE WIRED.
 *
 * src/permissionRequest.mjs was correct, tested, mutation-tested and CALLED BY
 * NOTHING for its whole existence. So was the table under it. Five modules were
 * in that state at once; code-d counted them. A module that is pure, covered and
 * unreachable is not progress, it is a good-looking way of having built nothing
 * — and this project spent a day proving that the difference is invisible from
 * the test output.
 *
 * So this file asserts REACHABILITY, in the three places it can actually break:
 *
 *   1. THE TOOLS EXIST AND RUN. A tool can be listed, documented, scope-gated
 *      and throw on every call — confirm_proposal did, for its entire life,
 *      because toolDefs destructures the store and it used `this`. Presence in
 *      tools/list is not evidence that calling it does anything.
 *
 *   2. SCOPE IS RIGHT IN BOTH DIRECTIONS. Asking must be available at READER
 *      scope, because the thing blocked on a permission is a worker and a worker
 *      holds no coordinator token. Answering must not be.
 *
 *   3. THE SPLICE AGREES. supabase/functions/mcp/_shared.js is a hand copy. The
 *      suite exercises src/. Twice already an edit landed in one and not the
 *      other; the loud failure was the lucky one.
 */

const NOW = '2026-09-15T23:30:00.000Z';
const MIN = 60_000;
const at = (off) => new Date(Date.parse(NOW) + off).toISOString();

// ── 1. the tools exist, and invoking them reaches the store ────────────────

/** A store shaped like the real one: methods that call siblings, as coordinatorStore does. */
function coordinatorLikeStore(calls = []) {
  const store = {
    listSessions: async () => [],
    getLanes: async () => ({}),
    listDecisions: async () => [],
    listMessages: async () => [],
    listTasks: async () => [],
    async assignTask({ task_id }) { return { ok: true, task: { task_id } }; },
    async acceptTask({ task_id }) { return { ok: true, task: { task_id } }; },
    async cancelTask({ task_id }) { return { ok: true, task: { task_id } }; },
    async listProposals() { return []; },
    async confirmProposal({ proposal_id }) { return store.assignTask({ task_id: proposal_id }); },
    async supervisoryReport() { return {}; },
    async sendMessage() { return { ok: true }; },

    async submitPermissionRequest(a) { calls.push(['submit', a]); return { ok: true, filed: true }; },
    async listPermissionRequests(a) { calls.push(['list', a]); return { pending: [] }; },
    async decidePermissionRequest(a) { calls.push(['decide', a]); return { ok: true }; },

    // The settle step is a sibling call on the real store, so the fixture makes
    // one too: this is the exact shape `this` broke on.
    async recordOwnerDecision(d) {
      const settled = await store.listPermissionRequests({});
      return { ok: true, decision: d, settled_requests: settled.pending };
    },
  };
  return store;
}

test('THE PERMISSION TOOLS EXIST AT ALL — the thing five modules did not have', () => {
  const names = toolDefs(coordinatorLikeStore()).map((d) => d.name);
  for (const n of ['request_permission', 'list_permission_requests', 'decide_permission_request']) {
    assert.ok(names.includes(n), `${n} is not in tools/list, so nothing can call it`);
  }
});

test('INVOKING THEM REACHES THE STORE, not just the definition', async () => {
  /*
   * confirm_proposal was present, correct in its description, gated to the right
   * scope, and threw "Cannot read properties of undefined" on every call for its
   * whole life. Nothing caught it because every test checked the definition.
   */
  const calls = [];
  const defs = toolDefs(coordinatorLikeStore(calls));
  const run = (name, args) => defs.find((d) => d.name === name).run(args);

  await run('request_permission', { action: 'sql.write', requested_by: 'code-b' });
  await run('list_permission_requests', { decider: 'owner' });
  await run('decide_permission_request', { request_id: 'r1', outcome: 'allowed', decided_by: 'code-c' });
  await run('record_owner_decision', { decision_id: 'd1', owner_id: 'danny' });

  assert.deepEqual(calls.map((c) => c[0]), ['submit', 'list', 'decide', 'list'],
    'a tool was listed but did not reach its store method');
  assert.equal(calls[0][1].action, 'sql.write', 'the arguments did not survive dispatch');
});

// ── 2. scope, in both directions ───────────────────────────────────────────

test('A READER MAY ASK. That is the whole point, and it is easy to get backwards', () => {
  /*
   * The thing blocked on a permission is a WORKER, and a worker holds no
   * coordinator token. If asking required coordinator scope the tool would be
   * unreachable by every process it exists for, and the "permission system"
   * would be a keypress with extra steps -- which is the defect, not the fix.
   */
  const readerish = {
    listSessions: async () => [], getLanes: async () => ({}),
    submitPermissionRequest: async () => ({ ok: true }),
    listPermissionRequests: async () => ({ pending: [] }),
  };
  const names = toolDefs(readerish).map((d) => d.name);

  assert.ok(names.includes('request_permission'), 'a worker cannot ask, so nothing will');
  assert.ok(names.includes('list_permission_requests'), 'an asker cannot see its own answer');
});

test('A READER MAY NOT ANSWER — absent from tools/list, not present-and-refusing', () => {
  /*
   * Scope decides which tools EXIST, not which ones refuse. A refusal string is
   * something a model argues with; a missing tool is not.
   */
  const readerish = {
    listSessions: async () => [], getLanes: async () => ({}),
    submitPermissionRequest: async () => ({ ok: true }),
    listPermissionRequests: async () => ({ pending: [] }),
  };
  const names = toolDefs(readerish).map((d) => d.name);

  assert.ok(!names.includes('decide_permission_request'),
    'a reader was handed the ability to answer permission requests');
  assert.ok(!names.includes('assign_task') && !names.includes('record_owner_decision'),
    'the reader fixture stopped being a reader, so the absence above proves nothing');
});

// ── the refusal that makes the design worth having ─────────────────────────

test('A COORDINATOR MAY NOT ANSWER AN OWNER-ROUTED REQUEST', () => {
  /*
   * If it could, the routing would be advisory and "irreversible actions are
   * the owner's" would be a sentence in a comment rather than a property of the
   * system. Everything downstream would be decoration.
   */
  const row = {
    request_id: 'r1', action: 'deploy.production', decider: DECIDER.OWNER,
    risk: 'irreversible', decided_at: null,
  };
  const out = srcCanDecide(row, { as: DECIDER.COORDINATOR, outcome: 'allowed', decided_by: 'code-c' });

  assert.equal(out.ok, false);
  assert.match(out.errors.join(' '), /may not answer it on their behalf/);
  assert.match(out.errors.join(' '), /recording a standing decision/,
    'the refusal did not say how the owner IS supposed to answer, so it is a dead end');
});

test('a coordinator-routed request IS answerable — the positive control', () => {
  /*
   * Required, and not decoration: a guard that only ever refuses is an outage,
   * and a refusal test alone cannot tell the two apart.
   */
  const row = { request_id: 'r2', action: 'run.tests', decider: DECIDER.COORDINATOR, decided_at: null };
  assert.deepEqual(
    srcCanDecide(row, { as: DECIDER.COORDINATOR, outcome: 'denied', decided_by: 'code-c' }),
    { ok: true, errors: [] },
  );
});

test('THE ROUTING IS READ FROM THE ROW, NOT RECOMPUTED FROM THE ACTION', () => {
  /*
   * A row that says `coordinator` is answerable by a coordinator even when its
   * action LOOKS owner-only today, and a row that says `owner` is refused even
   * when the action looks routine. Recomputing here would let a later edit to
   * OWNER_ONLY_PREFIXES silently move a question that is already in front of
   * somebody -- in either direction, with nothing recording that it moved.
   */
  const asStored = (decider, action) => srcCanDecide(
    { request_id: 'r', action, decider, decided_at: null },
    { as: DECIDER.COORDINATOR, outcome: 'allowed', decided_by: 'code-c' },
  ).ok;

  assert.equal(asStored(DECIDER.COORDINATOR, 'deploy.production'), true,
    'the stored routing was overridden by re-reading the action');
  assert.equal(asStored(DECIDER.OWNER, 'run.tests'), false,
    'an escalated question became answerable because its action looks harmless');
});

test('an already-answered request is refused, not answered twice', () => {
  const row = {
    request_id: 'r3', action: 'run.tests', decider: DECIDER.COORDINATOR,
    decided_at: at(-MIN), decided_by: 'code-d', outcome: 'denied',
  };
  const out = srcCanDecide(row, { as: DECIDER.COORDINATOR, outcome: 'allowed', decided_by: 'code-c' });
  assert.equal(out.ok, false);
  assert.match(out.errors.join(' '), /already decided "denied" by code-d/);
});

test('an unsigned or malformed answer is refused', () => {
  const row = { request_id: 'r4', action: 'run.tests', decider: DECIDER.COORDINATOR, decided_at: null };
  assert.match(
    srcCanDecide(row, { outcome: 'allowed' }).errors.join(' '),
    /decided_by is required/);
  assert.match(
    srcCanDecide(row, { outcome: 'maybe', decided_by: 'code-c' }).errors.join(' '),
    /outcome must be exactly/);
  assert.equal(srcCanDecide(null, { outcome: 'allowed', decided_by: 'c' }).ok, false);
});

test('EVERY REASON AT ONCE, not the first one', () => {
  // A refusal that names one problem produces a caller that fixes it, retries,
  // and is refused again for the next one.
  const row = {
    request_id: 'r5', action: 'spend.x', decider: DECIDER.OWNER,
    decided_at: at(-MIN), decided_by: 'danny', outcome: 'allowed',
  };
  const out = srcCanDecide(row, { as: DECIDER.COORDINATOR, outcome: 'nope', decided_by: '' });
  assert.ok(out.errors.length >= 4, `expected every reason, got ${out.errors.length}`);
});

// ── 3. the splice agrees with what the tests cover ─────────────────────────

test('THE DEPLOYED COPY AGREES — canDecidePermission', () => {
  const cases = [
    [{ decider: DECIDER.OWNER, action: 'deploy.production', decided_at: null },
      { as: DECIDER.COORDINATOR, outcome: 'allowed', decided_by: 'code-c' }],
    [{ decider: DECIDER.COORDINATOR, action: 'run.tests', decided_at: null },
      { as: DECIDER.COORDINATOR, outcome: 'denied', decided_by: 'code-c' }],
    [{ decider: DECIDER.COORDINATOR, action: 'x', decided_at: at(-MIN), decided_by: 'd', outcome: 'denied' },
      { as: DECIDER.COORDINATOR, outcome: 'allowed', decided_by: 'code-c' }],
    [null, { outcome: 'allowed', decided_by: 'c' }],
  ];
  for (const [row, opts] of cases) {
    assert.deepEqual(depCanDecide(row, opts), srcCanDecide(row, opts), JSON.stringify(row));
  }
  // The fixture must still exercise both directions, or agreement is vacuous.
  assert.equal(srcCanDecide(cases[0][0], cases[0][1]).ok, false);
  assert.equal(srcCanDecide(cases[1][0], cases[1][1]).ok, true);
});

test('THE DEPLOYED COPY AGREES — classification and routing', () => {
  const decisions = [{
    decision_id: 'd1', owner_id: 'danny', decision_type: 'policy', statement: 'ok',
    scope_type: 'bridge', scope_id: null, effect: 'allow', capabilities: ['deploy.staging'],
    constraints: {}, created_at: at(-60 * MIN), created_by: 'danny', supersedes: null,
    revoked_at: null, revoked_by: null, history: [],
  }];

  const requests = [
    { action: 'deploy.production' },                       // owner
    { action: 'run.tests', reversible: true },             // coordinator
    { action: 'deploy.staging' },                          // policy
    { action: 'nobody.classified.this' },                  // elevated -> coordinator
    {},                                                    // unclassifiable -> owner
  ];

  const seen = new Set();
  for (const r of requests) {
    const out = srcClassify(r, decisions, { now: NOW });
    assert.deepEqual(depClassify(r, decisions, { now: NOW }), out, JSON.stringify(r));
    seen.add(out.decider);
  }
  assert.deepEqual([...seen].sort(), ['coordinator', 'owner', 'policy'],
    'the fixture stopped exercising all three routes, so agreement proves less than it looks');

  /*
   * THE RESPELLINGS ARE IN THIS FIXTURE ON PURPOSE, AND THEY WERE NOT.
   *
   * This loop used to carry only lower-case actions, so a drift where the
   * DEPLOYED copy alone went back to case-sensitive matching was invisible to
   * it -- proven by mutation: that change left this file green. Which is the
   * exact defect the escalation itself was, reappearing one level up in the
   * thing meant to catch it.
   *
   * A splice-agreement fixture has to exercise the branch most likely to
   * diverge, and after today that branch is case handling.
   */
  for (const a of [
    'deploy.production', 'deploy.staging', 'run.tests', 'commit', 'push', '', 'x.y',
    'Deploy.Production', 'DEPLOY.PRODUCTION', 'deploy.Production',
    'DROP.table_users', 'Merge.main', '  DEPLOY.production  ',
  ]) {
    for (const reversible of [true, false, undefined]) {
      assert.equal(depRiskOf(a, { reversible }), srcRiskOf(a, { reversible }),
        `${JSON.stringify(a)} reversible=${reversible}`);
    }
  }

  // And the fixture must still contain a case that a case-sensitive match gets
  // WRONG, or the loop above is agreeing about nothing again.
  assert.equal(srcRiskOf('Deploy.Production', { reversible: true }), 'irreversible',
    'the respelling fixture stopped exercising the escalation it exists to pin');
});

test('THE DEPLOYED COPY AGREES — what is outstanding and what is paused', () => {
  const rows = [
    { key: 'a', action: 'spend.x', decider: DECIDER.OWNER, task_id: 't1', requested_at: at(-5 * MIN) },
    { key: 'a', action: 'spend.x', decider: DECIDER.OWNER, task_id: 't1', requested_at: at(-4 * MIN) },
    { key: 'b', action: 'run.tests', decider: DECIDER.COORDINATOR, task_id: 't2', requested_at: at(-3 * MIN) },
    { key: 'c', action: 'x', decider: DECIDER.COORDINATOR, task_id: 't3', requested_at: at(-2 * MIN),
      decided_at: at(-MIN), decided_by: 'code-c', outcome: 'allowed' },
    { key: 'd', action: 'y', decider: DECIDER.OWNER, requested_at: at(-48 * 60 * MIN) },
  ];

  const out = srcPending(rows, { now: NOW });
  assert.deepEqual(depPending(rows, { now: NOW }), out);
  assert.deepEqual(depPaused(rows, { now: NOW }), srcPaused(rows, { now: NOW }));

  // The fixture must keep exercising collapse, settlement and the window.
  assert.equal(out.length, 2, 'the fixture stopped exercising dedupe or settlement');
  assert.equal(out[0].decider, DECIDER.OWNER, 'the owner stopped sorting first');
  assert.equal(out[0].occurrences, 2, 'repeats stopped collapsing');
  assert.deepEqual(srcPaused(rows, { now: NOW }), ['t1', 't2'],
    'an answered request held its task, or a task with no request was paused');
});
