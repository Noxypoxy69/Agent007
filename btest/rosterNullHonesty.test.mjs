/**
 * UNKNOWN MUST SURVIVE ALL THE WAY TO THE CALLER.
 *
 * The hosted roster hardcoded `locks: []`, `processes: []`, `processProbeOk:
 * true` and `git.ok: true` while INSTRUCTIONS told every client that "every
 * field is observed from git plumbing and the process table" and that "fields
 * that could not be determined are null -- treat null as unknown, never as
 * zero". Nothing there observes anything: session_registrations is filled from
 * the POST /register body and the row is stamped
 * verification_state 'runtime-self-registration'.
 *
 * THE FIX WAS NOT TO REWORD THE PROMISE. The clause about null already existed
 * and already described the correct behaviour, so the store now emits null. That
 * is fixer's call over the two options I had framed, and it is better than
 * either: it needs no schema change or migration, and -- unlike forking the
 * prose per transport -- it leaves one sentence that is TRUE on both surfaces,
 * which is what test/toolDefsParity.test.mjs pins.
 *
 * WHY THIS FILE TESTS THE READERS AND NOT JUST THE STORE. I shipped this fix
 * once before and it was reverted, because making the projection honest while
 * `list_agents` and `list_locks` coerced the nulls straight back with `?? []` is
 * a partial fix that LOOKS complete: honest underneath, lying at the surface the
 * caller actually reads. fixer named that trap in advance. So these drive
 * toolDefs with a store that reports unknown and assert on what a client
 * receives.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { toolDefs } from '../supabase/functions/mcp/_shared.js';

/** A session from a surface that never looked: the hosted shape after the fix. */
const UNKNOWN = {
  agentId: 'code-b',
  sessionId: 'danny-win-b2',
  lane: 'agentbridge',
  machineLabel: 'm1',
  worktree: 'Agent007',
  git: { head: 'd1430a7fb453379f73f91a3789facba3066aedbc' },
  locks: null,
  processes: null,
  processProbeOk: null,
  lastSeenAt: new Date().toISOString(),
  repoId: 'Agent007',
  capacity: 'busy',
};

/** A session from the node collector, which really does observe. */
const OBSERVED = {
  ...UNKNOWN,
  agentId: 'code-a',
  sessionId: 'danny-win-a2',
  git: { ok: true, head: 'a'.repeat(40), dirty: ['src/x.mjs'], unpushed: 2, branch: 'main' },
  locks: [{ resource: 'deploy' }],
  processes: [{ kind: 'test' }],
  processProbeOk: true,
};

const store = (sessions) => ({
  listSessions: async () => sessions,
  getLanes: async () => ({}),
});

const tool = (defs, name) => defs.find((d) => d.name === name);
const payload = async (defs, name, args = {}) =>
  JSON.parse((await tool(defs, name).run(args)).content[0].text);

test('THE POSITIVE FIRST: a store that DID observe still reports what it saw', () => {
  /*
   * Asserted before every unknown case. A test that only checks nulls passes
   * against a reader that returns null unconditionally, which would be a worse
   * bug than the one being fixed.
   */
  return (async () => {
    const defs = toolDefs(store([OBSERVED]));
    const [row] = await payload(defs, 'list_agents');
    assert.equal(row.dirtyFiles, 1);
    assert.deepEqual(row.locksHeld, ['deploy']);
    assert.deepEqual(row.running, ['test']);
    assert.equal(row.unpushed, 2);

    const [proc] = await payload(defs, 'list_active_processes');
    assert.equal(proc.processProbeOk, true);
    assert.deepEqual(proc.processes, [{ kind: 'test' }]);
  })();
});

test('list_agents passes UNKNOWN through as null, never as zero', async () => {
  const defs = toolDefs(store([UNKNOWN]));
  const [row] = await payload(defs, 'list_agents');
  assert.equal(row.dirtyFiles, null, 'a count of 0 asserts a clean tree nobody checked');
  assert.equal(row.locksHeld, null, 'an empty list asserts no locks are held');
  assert.equal(row.running, null, 'an empty list asserts nothing is running');
  // and the fields it genuinely knows still arrive
  assert.equal(row.agentId, 'code-b');
  assert.equal(row.head, 'd1430a7fb453379f73f91a3789facba3066aedbc');
  assert.equal(row.capacity, 'busy');
});

test('list_active_processes stops claiming a probe ran', async () => {
  /*
   * THE SHARPEST OF THE SIX. The tool's own description says a probe flag that
   * is not true makes an empty list inconclusive -- and `s.processProbeOk !==
   * false` rendered null as TRUE, which made that disclaimer unreachable and
   * turned "we never looked" into "we looked and found nothing".
   */
  const defs = toolDefs(store([UNKNOWN]));
  const [row] = await payload(defs, 'list_active_processes');
  assert.equal(row.processProbeOk, null, 'null must not be coerced to true');
  assert.equal(row.processes, null);
});

test('false still means the probe RAN and failed, which is not the same as null', async () => {
  /*
   * The three-state distinction is the whole point, and it is why null rather
   * than false was the right value for the hosted store: bridge/collisions
   * raises a finding on `processProbeOk === false`, so hardcoding false would
   * have produced a permanent per-agent alert that can never clear.
   */
  const defs = toolDefs(store([{ ...UNKNOWN, processProbeOk: false, processes: [] }]));
  const [row] = await payload(defs, 'list_active_processes');
  assert.equal(row.processProbeOk, false, 'a real failed probe must stay false');
  assert.deepEqual(row.processes, []);
});

test('git.ok is no longer asserted for a sha nobody read', async () => {
  const defs = toolDefs(store([UNKNOWN]));
  const [row] = await payload(defs, 'get_git_state');
  assert.equal(row.ok, undefined, 'ok asserted a successful read that never happened');
  assert.equal(row.head, 'd1430a7fb453379f73f91a3789facba3066aedbc', 'the published sha is kept');
});

test('THE RESIDUAL I AM NOT CLOSING, named rather than hidden', async () => {
  /*
   * list_locks returns a FLAT ARRAY across the fleet, so it has no per-session
   * slot in which to say "unknown". With every hosted row reporting null locks
   * it returns [], which is the same confident zero this change exists to
   * remove -- a reader cannot tell "no locks are held" from "nobody looked".
   *
   * Fixing it means changing the tool's return SHAPE, which is a different
   * decision from obeying the null clause, and it would have to change in both
   * toolDefs at once. Asserted here so the gap is a recorded fact with a test
   * behind it rather than something a later reader has to rediscover.
   */
  const defs = toolDefs(store([UNKNOWN]));
  const locks = await payload(defs, 'list_locks');
  assert.deepEqual(locks, [], 'documented residual: an empty fleet-wide array cannot express unknown');

  // The observed case still works, so the tool is not broken -- only silent.
  const observedDefs = toolDefs(store([OBSERVED]));
  const observedLocks = await payload(observedDefs, 'list_locks');
  assert.equal(observedLocks.length, 1);
  assert.equal(observedLocks[0].resource, 'deploy');
});

test('THE WIRING: the hosted projection emits null rather than empty-and-true', () => {
  /*
   * index.ts is Deno-only and cannot be imported, so this reads it as text --
   * the technique edgeSourceGuards already uses on the same file, and the one I
   * learned the hard way after moving code out of it broke that gate. Comments
   * are blanked first: the fix explains itself by quoting the values it
   * replaced, so an unblanked grep would match its own prose.
   */
  return (async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../supabase/functions/mcp/index.ts', import.meta.url)), 'utf8',
    );
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + m.slice(p.length).replace(/./g, ' '));

    assert.match(code, /locks:\s*null/, 'locks must be null in the hosted projection');
    assert.match(code, /processes:\s*null/, 'processes must be null');
    assert.match(code, /processProbeOk:\s*null/, 'processProbeOk must be null');
    assert.ok(!/processProbeOk:\s*true/.test(code), 'processProbeOk must not be hardcoded true');
    assert.ok(!/\{\s*ok:\s*true,\s*head:/.test(code), 'git.ok must not be asserted');

    // Controls: the matchers can fail.
    assert.ok(/processProbeOk:\s*true/.test('const x = { processProbeOk: true };'));
    assert.ok(!/locks:\s*null/.test('const x = { locks: [] };'));
  })();
});
