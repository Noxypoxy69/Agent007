import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolDefs } from '../supabase/functions/mcp/_shared.js';

/**
 * A TOOL CAN BE LISTED, DOCUMENTED, SCOPE-GATED AND COMPLETELY BROKEN.
 *
 * confirm_proposal threw on every call it ever received:
 *
 *   { "error": "Cannot read properties of undefined (reading 'assignTask')" }
 *
 * It had to call assignTask, and it used `this`. But toolDefs DESTRUCTURES the
 * store --
 *
 *     const { listProposals, confirmProposal, ... } = store;
 *     run: async (a) => jsonResult(await confirmProposal(a))
 *
 * -- which detaches every method from its object, so `this` was undefined at
 * the moment it ran. Not sometimes. Every time, since the day it shipped.
 *
 * THE COST: 393 proposals prepared, ZERO ever confirmed, over six hours. It was
 * read all day as the coordinator failing to do its job, and reported to the
 * owner as a supervision-model question for him to decide. It was a bug.
 *
 * WHY NOTHING CAUGHT IT. Every existing test checked the DEFINITION -- that the
 * tool appears for a coordinator and not a reader, that its description says
 * the right thing, that the store method gates it. coordinatorAuth.test.mjs
 * asserts presence and absence; wiringIsReal asserts the writes are reached.
 * None of them ever CALLED one. index.ts cannot be imported by the suite, so
 * the store that carries the bug is untestable by construction -- but toolDefs
 * CAN be handed a store shaped like it, and that is enough to catch this.
 *
 * SO THIS FILE INVOKES. It builds a store whose methods call their siblings,
 * exactly as coordinatorStore does, runs every tool through the path the edge
 * function uses, and requires that none of them throws.
 */

/** A store shaped like coordinatorStore: methods that call sibling methods. */
function storeWithSiblingCalls() {
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

    // THE SHAPE THAT BROKE. A method that reaches a sibling.
    async confirmProposal({ proposal_id }) {
      const done = await store.assignTask({ task_id: proposal_id });
      return { ok: true, task: done.task };
    },

    async supervisoryReport() { return {}; },
    async sendMessage() { return { ok: true }; },
    async recordOwnerDecision() { return { ok: true }; },
  };
  return store;
}

const run = (defs, name, args = {}) => defs.find((d) => d.name === name).run(args);

test('EVERY COORDINATOR TOOL CAN ACTUALLY BE INVOKED', async () => {
  /*
   * The whole point. Presence in tools/list is not evidence that calling it
   * does anything, and for six hours the difference between those two was the
   * difference between a working production line and a stalled one.
   */
  const defs = toolDefs(storeWithSiblingCalls());
  assert.ok(defs.length >= 19, `expected the full coordinator surface, got ${defs.length}`);

  const failures = [];
  for (const d of defs) {
    try {
      // Minimal plausible arguments; the guards are not under test here, only
      // that dispatch reaches the method without throwing on `this`.
      await d.run({
        proposal_id: 'p1', task_id: 't1', agent_id: 'code-b', reason: 'because',
        to_agent: 'code-b', from_agent: 'code-c', type: 'status', body: 'hello',
        decision_id: 'd1', owner_id: 'danny', statement: 'x', scope_type: 'bridge',
        effect: 'allow', capabilities: ['x'], action: 'x', agentId: 'code-c', id: 'x',
      });
    } catch (e) {
      failures.push(`${d.name}: ${e?.message ?? e}`);
    }
  }

  assert.deepEqual(failures, [],
    'a tool that appears in tools/list threw when invoked through the dispatch path');
});

test('CONFIRM_PROPOSAL REACHES ITS SIBLING — the exact bug', async () => {
  /*
   * Named separately from the sweep above so the regression has its own line in
   * the output. A sweep that goes red tells you something broke; this tells you
   * which thing, and it is the one that cost six hours.
   */
  const defs = toolDefs(storeWithSiblingCalls());
  const out = await run(defs, 'confirm_proposal', { proposal_id: 'p1' });

  const body = JSON.parse(out.content[0].text);
  assert.equal(body.ok, true, 'confirm_proposal did not reach assignTask');
  assert.equal(body.task.task_id, 'p1');
});

test('A STORE RELYING ON `this` IS THE FAILURE, and this file would catch it', async () => {
  /*
   * The positive control, and it has to be here or the tests above prove only
   * that a correct store works -- which was never in doubt.
   *
   * This builds the BROKEN shape deliberately: a method reaching a sibling
   * through `this`. toolDefs destructures it, `this` is undefined, and the call
   * throws exactly as production did. If a future refactor made toolDefs stop
   * destructuring, this test would go green for the wrong reason -- so it
   * asserts the specific TypeError rather than merely "it threw".
   */
  const broken = {
    listSessions: async () => [],
    getLanes: async () => ({}),
    listProposals: async () => [],
    async assignTask() { return { ok: true, task: {} }; },
    async confirmProposal() {
      // eslint-disable-next-line no-invalid-this
      return this.assignTask({});
    },
  };

  const defs = toolDefs(broken);
  await assert.rejects(
    () => run(defs, 'confirm_proposal', { proposal_id: 'p1' }),
    /Cannot read propert.* of undefined|undefined is not an object/,
    'the `this`-dependent store did not fail, so this file cannot catch the real bug',
  );
});

test('a read-only store still invokes cleanly', async () => {
  // The reader surface has no sibling calls, but it goes through the same
  // dispatch and a regression there would be just as invisible.
  const defs = toolDefs({
    listSessions: async () => [],
    getLanes: async () => ({}),
    listDecisions: async () => [],
    listMessages: async () => [],
  });

  for (const d of defs) {
    await d.run({ agentId: 'code-c', action: 'x', id: 'x' });
  }
});
