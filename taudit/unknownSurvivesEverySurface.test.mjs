/**
 * NULL IS UNKNOWN, ON ALL THREE SURFACES, AND NOTHING MAY QUIETLY ANSWER IT.
 *
 * THE CONTRACT every caller of this server is handed says: "Fields that could
 * not be determined are null — treat null as unknown, never as zero." That
 * sentence was true of the hosted surface and false of the other two.
 *
 *   bridge/httpStore.mjs   `processProbeOk: r.process_probe_ok !== false`
 *                          turned NULL into TRUE — "a probe ran and found
 *                          nothing", the most confident answer the field can
 *                          give, on exactly the rows entitled to it least.
 *                          `locks ?? []` and `processes ?? []` turned "nobody
 *                          looked" into "looked, found none". bridge/worker.mjs
 *                          builds the Cloudflare surface from this store, so
 *                          the guard added downstream in mcp/toolDefs.mjs could
 *                          never see a null: the store had already erased it.
 *
 *   mcp/toolDefs.mjs       `(s.git?.dirty ?? []).length` reported 0 for a
 *                          session nobody measured — indistinguishable from a
 *                          clean tree. One connection answered `running: []`
 *                          from list_agents and `processes: null` from
 *                          list_active_processes about the SAME session.
 *
 * WHY NOTHING CAUGHT IT, which is the part worth keeping. test/toolDefsParity
 * compares DECLARATIONS — descriptions and JSON schemas — and says so in its
 * own header. Two tools contradicting each other about one fact is not
 * something a declaration comparison can ever see, so it was green throughout.
 * This test drives the surfaces and looks at what they ANSWER.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { toolDefs as hostedDefs } from '../supabase/functions/mcp/_shared.js';
import { toolDefs as twinDefs } from '../mcp/toolDefs.mjs';
import { createHttpStore } from '../bridge/httpStore.mjs';

/** A session the collector could not measure: every derived field unknown. */
const UNMEASURED = {
  agentId: 'code-b',
  sessionId: 'danny-win-b1',
  lane: 'agentbridge',
  worktree: null,
  capacity: null,
  git: null,
  locks: null,
  processes: null,
  processProbeOk: null,
  lastSeenAt: '2026-09-18T20:00:00.000Z',
};

/** The same session, fully measured and genuinely empty. */
const MEASURED_EMPTY = {
  ...UNMEASURED,
  git: { branch: 'main', head: 'abc', dirty: [] },
  locks: [],
  processes: [],
  processProbeOk: true,
};

const storeOf = (sessions) => ({
  listSessions: async () => sessions,
  getLanes: async () => ({}),
  listDecisions: async () => [],
  listMessages: async () => [],
});

/**
 * Invoke a tool and unwrap the MCP envelope back to data.
 *
 * `run` returns `{content:[{type:'text', text:'<json>'}]}` — the shape a client
 * actually receives. Parsing it rather than reaching past it means this test
 * exercises the same bytes a caller gets, which is where the contradiction
 * between two tools was visible in the first place.
 */
const call = async (defs, name, store, args = {}) => {
  const def = defs(store).find((d) => d.name === name);
  assert.ok(def, `${name} was not built — the fixture is too thin to test anything`);
  assert.equal(typeof def.run, 'function', `${name} has no run()`);
  const out = await def.run(args);
  const text = out?.content?.[0]?.text;
  assert.equal(typeof text, 'string', `${name} did not return a text result: ${JSON.stringify(out).slice(0, 160)}`);
  return JSON.parse(text);
};

const rowOf = async (defs, name, session) => {
  const out = await call(defs, name, storeOf([session]));
  const rows = Array.isArray(out) ? out : (out.agents ?? out.sessions ?? out.processes ?? out.rows);
  assert.ok(Array.isArray(rows) && rows.length === 1,
    `${name} did not return one row: ${JSON.stringify(out).slice(0, 200)}`);
  return rows[0];
};

for (const [surface, defs] of [['hosted', hostedDefs], ['twin', twinDefs]]) {
  test(`${surface}: THE POSITIVE FIRST — a MEASURED empty session really does report empty`, async () => {
    /*
     * Rule 5. Every "must be null" assertion below is satisfied by a surface
     * that returns null for everything, which would destroy the field's meaning
     * in the opposite direction. This is what makes the nulls meaningful.
     */
    const row = await rowOf(defs, 'list_agents', MEASURED_EMPTY);
    assert.equal(row.dirtyFiles, 0, `${surface}: a measured clean tree must report 0, not unknown`);
    assert.deepEqual(row.locksHeld, [], `${surface}: measured, no locks — that is [], not unknown`);
    assert.deepEqual(row.running, [], `${surface}: measured, nothing running — that is [], not unknown`);
  });

  test(`${surface}: AN UNMEASURED SESSION REPORTS UNKNOWN, NEVER ZERO`, async () => {
    const row = await rowOf(defs, 'list_agents', UNMEASURED);
    assert.equal(row.dirtyFiles, null,
      `${surface}: dirtyFiles is ${JSON.stringify(row.dirtyFiles)} for a session nobody measured — `
      + 'a reader cannot tell that from a clean tree');
    assert.equal(row.locksHeld, null,
      `${surface}: locksHeld is ${JSON.stringify(row.locksHeld)} — "nobody looked" reported as "no locks"`);
    assert.equal(row.running, null,
      `${surface}: running is ${JSON.stringify(row.running)} — "nobody looked" reported as "nothing running"`);
  });
}

test('THE TWO TOOL SURFACES ANSWER IDENTICALLY, which the parity gate cannot check', async () => {
  /*
   * toolDefsParity compares declarations. This compares ANSWERS, which is where
   * the drift actually was: identical descriptions over stores that disagreed.
   */
  for (const session of [UNMEASURED, MEASURED_EMPTY]) {
    const a = await rowOf(hostedDefs, 'list_agents', session);
    const b = await rowOf(twinDefs, 'list_agents', session);
    for (const field of ['dirtyFiles', 'locksHeld', 'running']) {
      assert.deepEqual(a[field], b[field],
        `the two surfaces disagree about ${field}: hosted ${JSON.stringify(a[field])} `
        + `vs twin ${JSON.stringify(b[field])}`);
    }
  }
});

test('ONE CONNECTION DOES NOT CONTRADICT ITSELF ABOUT ONE SESSION', async () => {
  /*
   * The concrete symptom: list_agents said `running: []` while
   * list_active_processes said `processes: null` for the same session on the
   * same server. Both cannot be true.
   */
  for (const [surface, defs] of [['hosted', hostedDefs], ['twin', twinDefs]]) {
    const store = storeOf([UNMEASURED]);
    const agents = await call(defs, 'list_agents', store);
    const procs = await call(defs, 'list_active_processes', store);
    const agentRow = (Array.isArray(agents) ? agents : agents.agents ?? agents.rows)[0];
    const procRow = (Array.isArray(procs) ? procs : procs.agents ?? procs.rows)[0];

    const agentSaysUnknown = agentRow.running === null;
    const procSaysUnknown = (procRow.processes ?? null) === null;
    assert.equal(agentSaysUnknown, procSaysUnknown,
      `${surface}: list_agents says running=${JSON.stringify(agentRow.running)} while `
      + `list_active_processes says processes=${JSON.stringify(procRow.processes)} — `
      + 'two tools, one server, one session, two different answers');
  }
});

/* ── the third surface: the store the Cloudflare worker is built from ────── */

const httpStoreReturning = (row) => createHttpStore(
  { SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_KEY: 'k' },
  {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => [row],
      text: async () => JSON.stringify([row]),
    }),
  },
);

test('httpStore: A NULL COLUMN STAYS NULL — the Cloudflare surface', async () => {
  /*
   * bridge/schema.sql derives process_probe_ok from
   * (s.state ->> 'processProbeOk')::boolean, which is NULL whenever the key is
   * absent. That is the row this store used to answer `true` about.
   */
  const store = httpStoreReturning({
    agent_id: 'code-b', session_id: 'danny-win-b1', lane: 'agentbridge',
    machine_label: null, worktree: null, git: null,
    locks: null, processes: null, process_probe_ok: null,
    last_seen_at: '2026-09-18T20:00:00.000Z',
  });
  const [s] = await store.listSessions();

  assert.equal(s.processProbeOk, null,
    `processProbeOk is ${JSON.stringify(s.processProbeOk)} for a NULL column — `
    + '"a probe ran and found nothing" is the most confident thing this field can say '
    + 'and this is the case least entitled to it');
  assert.equal(s.locks, null, `locks is ${JSON.stringify(s.locks)} — "nobody looked" became "none"`);
  assert.equal(s.processes, null, `processes is ${JSON.stringify(s.processes)} — "nobody looked" became "none"`);
});

test('httpStore: THE POSITIVE — a measured FALSE and a measured empty survive too', async () => {
  /*
   * The dangerous fix here is one that maps everything to null. `false` is a
   * real measurement — the probe ran and FAILED — and must not be flattened
   * into "unknown", or a genuinely broken probe stops being reportable.
   */
  const store = httpStoreReturning({
    agent_id: 'code-b', session_id: 'danny-win-b1', lane: 'agentbridge',
    machine_label: null, worktree: null, git: null,
    locks: [], processes: [], process_probe_ok: false,
    last_seen_at: '2026-09-18T20:00:00.000Z',
  });
  const [s] = await store.listSessions();

  assert.equal(s.processProbeOk, false, 'a measured probe FAILURE was flattened into unknown');
  assert.deepEqual(s.locks, [], 'a measured empty lock list became unknown');
  assert.deepEqual(s.processes, [], 'a measured empty process list became unknown');
});

test('list_locks: THE THIRD TOOL THAT READS s.locks, and the one nothing watched', async () => {
  /*
   * THE GATE WAS POINTED AT TWO OF THREE TOOLS, and an audit proved it by
   * mutation: reverting `list_agents.locksHeld` to `(s.locks ?? [])` is caught
   * by two named assertions here, while the IDENTICAL flattening in
   * `list_locks` sat uncaught in the same commit, same field, same store.
   *
   * On the hosted surface it is not a corner case: index.ts hardcodes
   * `locks: null` for every session, so list_locks answered `[]` on every call
   * while list_agents answered `null` about the same session — verbatim the
   * self-contradiction this file was written to remove.
   *
   * A session whose locks were never measured contributes NOTHING to the flat
   * list, rather than contributing "no locks". The flat shape has no per-row
   * slot for unknown, so absence is the only honest answer available.
   */
  for (const [surface, defs] of [['hosted', hostedDefs], ['twin', twinDefs]]) {
    const unmeasured = await call(defs, 'list_locks', storeOf([UNMEASURED]));
    const measured = await call(defs, 'list_locks', storeOf([MEASURED_EMPTY]));
    const holding = await call(defs, 'list_locks', storeOf([{ ...MEASURED_EMPTY, locks: [{ resource: 'voice_' }] }]));

    assert.deepEqual(unmeasured, [],
      `${surface}: a session nobody measured contributed rows to list_locks`);
    assert.deepEqual(measured, [],
      `${surface}: a measured empty lock list produced rows`);
    assert.equal(holding.length, 1,
      `${surface}: a genuinely held lock is missing — the fix suppressed real data`);
    assert.equal(holding[0].resource, 'voice_', `${surface}: the lock lost its resource`);
  }
});

test('THE CONTROL: these assertions can actually fail', () => {
  /*
   * Rule 1. Pins that the distinction under test is expressible at all — that
   * null, [] and 0 are being compared as different things rather than through
   * a comparison that treats them alike.
   */
  assert.notDeepEqual(null, [], 'null and [] compare equal here — every assertion above is inert');
  assert.notEqual(null, 0, 'null and 0 compare equal here — every assertion above is inert');
  assert.notEqual(null, false, 'null and false compare equal here — the probe assertions are inert');
});
