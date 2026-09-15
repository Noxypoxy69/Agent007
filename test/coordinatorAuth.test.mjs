import test from 'node:test';
import assert from 'node:assert/strict';
import { toolDefs } from '../supabase/functions/mcp/_shared.js';

/**
 * THE PERMISSION BOUNDARY ON THE PUBLIC MCP SURFACE — certified by someone who
 * did not build it.
 *
 * WHY THIS FILE HAS A DIFFERENT AUTHOR FROM THE THING IT TESTS. The data plane
 * was written by the coordinator. A boundary certified by the party it
 * constrains is not certified; it is asserted twice. So this is authored by
 * code-d, against source read at 962867b, and the coordinator holds the pen for
 * the commit without editing the assertions.
 *
 * WHAT THE BOUNDARY ACTUALLY IS, read out of supabase/functions/mcp/index.ts
 * rather than taken from anybody's summary:
 *
 *   reader_tokens        read coordination state
 *   registration_tokens  publish OWN liveness, return OWN work, await OWN events
 *   coordinator_tokens   assign, accept, cancel, message, record decisions,
 *                        confirm proposals. NOT deploy, NOT shell, NOT SQL
 *   dispatcher_tokens    PREPARE PROPOSALS via POST /dispatch. Nothing else
 *
 * Four classes in four tables, "because a scope column is one typo away from
 * promoting a reader to a coordinator, and a promotion that happens by typo is
 * one nobody reviews."
 *
 * THE MECHANISM UNDER TEST, AND IT IS THE INTERESTING PART. index.ts:29-34:
 *
 *   "SCOPE DECIDES WHICH TOOLS EXIST, NOT WHICH ONES REFUSE. [...] for a
 *    reader, assign_task is absent from tools/list and answers 'no such tool'
 *    identically to a name that was never defined. A refusal string is
 *    something a model argues with; a missing tool is not."
 *
 * That is a claim about ABSENCE, so every assertion below is written as
 * absence. A test that asserted `assign_task returns 403 for a reader` would
 * pass against a build that had regressed to exactly the design this rejects.
 * Asserting the wrong shape of success is how a gate becomes decoration.
 *
 * IT IMPORTS THE DEPLOYED COPY. `supabase/functions/mcp/_shared.js` is what
 * Supabase runs; `mcp/toolDefs.mjs` is the node-side twin. Testing the twin
 * would prove something about a file the public surface does not execute. The
 * drift between them is already guarded by test/syncContract.test.mjs and
 * test/sharedSpliceMatches.test.mjs, so this file deliberately does not
 * re-check it — it just makes sure it is reading the artifact that ships.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE DOES NOT PROVE. Stated here rather than discovered later,
 * because the same omission made an earlier regression gate on this repo pass
 * against a deliberately reinstated bug.
 *
 * It proves the SCOPE -> TOOLS half: given a store of a certain shape, exactly
 * these tools exist. It does NOT prove the TOKEN -> SCOPE half: that
 * `reader_tokens` actually yields readStore and `coordinator_tokens` actually
 * yields coordinatorStore inside the deployed function, or that registration
 * and dispatcher tokens receive 401 on the MCP endpoint. That mapping lives in
 * index.ts behind a live Deno runtime and four real tokens, and no hermetic
 * test can reach it.
 *
 * So: a regression that swapped the two stores at the call site would pass
 * every assertion below. That gap is real, it is named, and closing it needs a
 * live four-token probe that is not this file.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** The read surface. Mirrors readStore in index.ts:149-175. */
const readOnlyStore = () => ({
  listSessions: async () => [],
  getLanes: async () => ({}),
  listDecisions: async () => [],
  listMessages: async () => [],
});

/**
 * The coordinator surface: the read store plus the write methods index.ts
 * attaches in coordinatorStore(). Named individually rather than spread from a
 * helper so that a method disappearing upstream shows up here as a failing
 * name, not as a silently smaller object.
 */
const coordinatorFullStore = () => ({
  ...readOnlyStore(),
  listTasks: async () => [],
  assignTask: async () => ({ ok: true }),
  acceptTask: async () => ({ ok: true }),
  cancelTask: async () => ({ ok: true }),
  listProposals: async () => [],
  confirmProposal: async () => ({ ok: true }),
  sendMessage: async () => ({ ok: true }),
  recordOwnerDecision: async () => ({ ok: true }),
  supervisoryReport: async () => ({}),
});

const names = (store) => toolDefs(store).map((d) => d.name).sort();

/**
 * The nine tools that exist ONLY for a coordinator, each paired with the store
 * method that conjures it. The pairing is the point: it is what lets the
 * "one method removed, one tool gone" test below be exhaustive rather than
 * illustrative.
 */
const WRITE_TOOLS = Object.freeze({
  listTasks: 'list_tasks',
  assignTask: 'assign_task',
  acceptTask: 'accept_task',
  cancelTask: 'cancel_task',
  listProposals: 'list_proposals',
  confirmProposal: 'confirm_proposal',
  sendMessage: 'send_message',
  recordOwnerDecision: 'record_owner_decision',
  supervisoryReport: 'get_supervisory_report',
});

test('a reader gets a strictly smaller surface than a coordinator', () => {
  const reader = names(readOnlyStore());
  const coordinator = names(coordinatorFullStore());

  assert.ok(reader.length > 0, 'a reader with no tools would be a broken read surface, not a safe one');
  assert.ok(
    reader.every((n) => coordinator.includes(n)),
    'the reader surface must be a SUBSET of the coordinator surface — a tool a reader has and a coordinator does not is a scope inversion',
  );
  assert.ok(
    coordinator.length > reader.length,
    'if the two surfaces are the same size, scope is not gating anything',
  );
});

test('every write tool is ABSENT for a reader, not present-and-refusing', () => {
  const reader = new Set(names(readOnlyStore()));

  for (const [method, tool] of Object.entries(WRITE_TOOLS)) {
    assert.equal(
      reader.has(tool), false,
      `${tool} is present on the reader surface. The design requires ABSENCE: index.ts:31-34 says a reader must get "no such tool", because "a refusal string is something a model argues with; a missing tool is not". Present-and-refusing is the regression this test exists to catch. (gated on store.${method})`,
    );
  }
});

test('the coordinator surface is exactly the reader surface plus the write tools', () => {
  const reader = new Set(names(readOnlyStore()));
  const coordinator = new Set(names(coordinatorFullStore()));

  const added = [...coordinator].filter((n) => !reader.has(n)).sort();
  const expected = Object.values(WRITE_TOOLS).sort();

  assert.deepEqual(
    added, expected,
    'the difference between the two scopes must be exactly the write tools. A NEW tool appearing here unannounced is a privilege change that no review saw — which is the failure mode four separate token tables exist to prevent.',
  );
});

test('a tool exists only while its store method does — one method, one tool', () => {
  /*
   * The exhaustive form on purpose. Removing one method and checking one tool
   * vanished proves the mechanism for that pair; a regression that hard-coded
   * eight of nine would pass. This removes each in turn and asserts that the
   * ONLY difference is the paired tool.
   */
  const full = new Set(names(coordinatorFullStore()));

  for (const [method, tool] of Object.entries(WRITE_TOOLS)) {
    const store = coordinatorFullStore();
    delete store[method];

    const got = new Set(names(store));
    const missing = [...full].filter((n) => !got.has(n)).sort();

    assert.deepEqual(
      missing, [tool],
      `deleting store.${method} should remove exactly ${tool}. Removing more means tools share a gate and one method silently controls several; removing none means ${tool} is registered unconditionally and its scope check is decorative.`,
    );
  }
});

test('no scope, at any size, exposes an execution surface', () => {
  /*
   * index.ts:36-37: "WHAT IS DELIBERATELY ABSENT AT EVERY SCOPE: shell, SQL,
   * file writes, deploy, merge, command execution. Their absence is the
   * control."
   *
   * Asserted against the widest store this file can build. A capability that
   * cannot be reached by a full coordinator cannot be reached by anyone below
   * it, so the widest surface is the right place to look.
   */
  const forbidden = /shell|exec|command|sql|query_db|deploy|merge|push|write_file|read_file|spawn|eval/i;

  for (const scope of [readOnlyStore(), coordinatorFullStore()]) {
    for (const name of names(scope)) {
      assert.equal(
        forbidden.test(name), false,
        `tool "${name}" reads as an execution capability. Absence is the control here, so a name that merely LOOKS like one is worth failing on and renaming — the next reader of tools/list cannot audit intent, only names.`,
      );
    }
  }
});

test('toolDefs refuses a store that cannot satisfy the read surface', () => {
  /*
   * The floor. A store missing its read methods must be rejected outright
   * rather than yielding a small, quiet, half-working surface — an empty tool
   * list is indistinguishable from a healthy server with nothing to say, and
   * that is the shape of outage that gets diagnosed as "no agents are running".
   */
  assert.throws(() => toolDefs(undefined), /listSessions|getLanes|store/i,
    'no store at all must throw');
  assert.throws(() => toolDefs({ getLanes: async () => ({}) }), /listSessions|getLanes|store/i,
    'a store without listSessions must throw rather than return a partial surface');
  assert.throws(() => toolDefs({ listSessions: async () => [] }), /listSessions|getLanes|store/i,
    'a store without getLanes must throw rather than return a partial surface');
});

test('the write tools named here still exist upstream', () => {
  /*
   * WRITE_TOOLS is this file's own copy of a fact that lives in index.ts. If a
   * write tool is renamed upstream, every absence assertion above keeps passing
   * — it would be asserting the absence of a tool that no longer exists under
   * that name, which is true and worthless.
   *
   * So: the full coordinator surface must contain all nine. This is the guard
   * that stops this file agreeing with itself after the thing it tests has
   * moved.
   */
  const coordinator = new Set(names(coordinatorFullStore()));

  for (const tool of Object.values(WRITE_TOOLS)) {
    assert.ok(
      coordinator.has(tool),
      `${tool} is not on the coordinator surface. Either it was renamed or removed upstream — and until WRITE_TOOLS is updated, this file's absence checks for it are vacuously passing.`,
    );
  }
});
