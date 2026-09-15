import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchHostedRegistrations, mergeRegistrations, readerConfig, registrationConfig, HOSTED,
} from '../src/hostedRegistry.mjs';
import { registryFromSessions, isLive } from '../src/liveRegistry.mjs';
import { resolveWorker } from '../src/laneRegistry.mjs';
import { createLeadWork, appendLeadWork, leadWorkFor } from '../src/leadWork.mjs';

/**
 * CROSS-MACHINE LIVENESS, AND THE OUTAGE BEHAVIOUR THAT MATTERS MORE.
 *
 * The interesting case is not the happy one. It is what happens when the hosted
 * registry is configured and FAILING, because the tempting behaviour -- carry
 * on with local state and record the target as unverified -- turns a broken
 * dependency into a permissive one at exactly the moment nobody is watching.
 */

const NOW = '2026-09-15T12:00:00.000Z';
const ago = (ms) => new Date(Date.parse(NOW) - ms).toISOString();

/*
 * The hosted roster is now read through the MCP surface with a READER token,
 * not from PostgREST with a service key. That change is the point: a machine no
 * longer needs a full database credential to see who is running.
 */
const ENV = { AGENTBRIDGE_READER_TOKEN: 'abr_' + 'k'.repeat(40) };

/** A row exactly as the `list_agents` tool returns it. */
const hostedRow = (over = {}) => ({
  agentId: 'code-d',
  sessionId: 'sess-remote',
  machine: '22222222-2222-4222-8222-222222222222',
  repoId: 'agentbridge-d',
  worktree: 'agentbridge-d',
  lane: 'agentbridge',
  capacity: 'idle',
  head: 'b'.repeat(40),
  lastSeenAt: ago(30_000),
  ...over,
});

/** Wrap rows in the MCP tool-result envelope the endpoint actually returns. */
const mcpEnvelope = (rows) => ({
  jsonrpc: '2.0',
  id: 1,
  result: { content: [{ type: 'text', text: JSON.stringify(rows) }] },
});

const stubFetch = (impl) => impl;
const okFetch = (rows) => stubFetch(async () => ({
  ok: true, status: 200, json: async () => mcpEnvelope(rows),
}));

test('NO WORKER CREDENTIAL IS A DATABASE KEY', async () => {
  /*
   * The two things a worker may hold, and neither is a Supabase key.
   *
   * Written after a worker read an error message naming AGENTBRIDGE_SUPABASE_KEY
   * and correctly refused to go and find one. The variable was read by an
   * orphaned hostedConfig() that nothing called any more, so its only remaining
   * effect was to tell people to install a production credential. Deleted; this
   * asserts it stays deleted.
   */
  const src = await (await import('node:fs/promises'))
    .readFile(new URL('../src/hostedRegistry.mjs', import.meta.url), 'utf8');

  // Named only inside the comment explaining the deletion, never read.
  assert.doesNotMatch(src, /env\.AGENTBRIDGE_SUPABASE_KEY/,
    'a worker credential path is reading a database key again');
  assert.doesNotMatch(src, /env\.AGENTBRIDGE_SUPABASE_URL/,
    'a worker credential path is reading a database URL again');

  assert.equal(registrationConfig({}), null);
  assert.ok(registrationConfig({ AGENTBRIDGE_REGISTRATION_TOKEN: 'abw_x'.repeat(8) }));
  assert.ok(readerConfig({ AGENTBRIDGE_READER_TOKEN: 'abr_x'.repeat(8) }));
});

test('not configured is NOT the same as unreachable', async () => {
  // The distinction the whole module turns on. Local-only operation is honest;
  // a configured-and-failing registry is a refusal.
  assert.equal(readerConfig({}), null);
  const r = await fetchHostedRegistrations({}, { fetchImpl: okFetch([]) });
  assert.equal(r.state, HOSTED.NOT_CONFIGURED);
});

test('one machine SEES another machine\'s hosted registration', async () => {
  const r = await fetchHostedRegistrations(ENV, { fetchImpl: okFetch([hostedRow()]) });
  assert.equal(r.state, HOSTED.OK);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].session_id, 'sess-remote');
  assert.equal(r.rows[0].origin, 'hosted');
});

test('a cross-machine delegation RESOLVES against hosted registrations', async () => {
  const { rows } = await fetchHostedRegistrations(ENV, { fetchImpl: okFetch([hostedRow()]) });
  const reg = registryFromSessions(mergeRegistrations([], rows), { now: NOW });
  const resolved = resolveWorker(reg, { agent_id: 'code-d' });
  assert.equal(resolved.ok, true, resolved.reason);
  assert.equal(resolved.session_id, 'sess-remote');
});

test('a STALE remote registration refuses', async () => {
  const stale = hostedRow({ lastSeenAt: ago(60 * 60 * 1000) });
  const { rows } = await fetchHostedRegistrations(ENV, { fetchImpl: okFetch([stale]) });
  assert.equal(isLive(rows[0], { now: NOW }), false);

  const reg = registryFromSessions(rows, { now: NOW });
  const r = resolveWorker(reg, { agent_id: 'code-d' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-live-session');
});

test('DUPLICATE live sessions for one agent refuse as ambiguous, across machines', async () => {
  const a = hostedRow({ sessionId: 'sess-a' });
  const b = hostedRow({ sessionId: 'sess-b', machine: '33333333-3333-4333-8333-333333333333' });
  const { rows } = await fetchHostedRegistrations(ENV, { fetchImpl: okFetch([a, b]) });

  const r = resolveWorker(registryFromSessions(rows, { now: NOW }), { agent_id: 'code-d' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ambiguous-session');
  assert.deepEqual(r.candidates.sort(), ['sess-a', 'sess-b']);
});

test('a repo mismatch refuses rather than resolving to the wrong worktree', async () => {
  const { rows } = await fetchHostedRegistrations(ENV, { fetchImpl: okFetch([hostedRow()]) });
  const reg = registryFromSessions(rows, { now: NOW });
  const r = resolveWorker(reg, { agent_id: 'code-d', repo_id: 'some-other-repo' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-live-session');
});

test('an OUTAGE fails closed and is NOT reported as absent', async () => {
  /*
   * The central property. Each of these is a configured registry that failed,
   * and none may read as "not configured" -- that is what would silently
   * downgrade a verified target to accepted-on-trust.
   */
  const cases = [
    ['http 500', async () => ({ ok: false, status: 500, json: async () => ({}) })],
    ['http 401', async () => ({ ok: false, status: 401, json: async () => ({}) })],
    ['network', async () => { throw new Error('ECONNREFUSED'); }],
  ];
  for (const [label, fetchImpl] of cases) {
    const r = await fetchHostedRegistrations(ENV, { fetchImpl });
    assert.equal(r.state, HOSTED.UNREACHABLE, `${label} did not report unreachable`);
    assert.notEqual(r.state, HOSTED.NOT_CONFIGURED, `${label} read as "no hosted registry"`);
    assert.equal(r.rows, undefined, `${label} returned rows anyway`);
  }
});

test('a MALFORMED hosted response is not an empty registry', async () => {
  // "No workers are registered" is calm and plausible and completely wrong when
  // the body was garbage.
  for (const body of [{ error: 'nope' }, 'a string', null, 42]) {
    const r = await fetchHostedRegistrations(ENV, { fetchImpl: okFetch(body) });
    assert.equal(r.state, HOSTED.MALFORMED, `body ${JSON.stringify(body)} was accepted`);
    assert.equal(r.rows, undefined);
  }
});

test('a timeout is unreachable, not empty', async () => {
  const hang = async (_url, { signal }) => new Promise((_res, rej) => {
    signal.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
    });
  });
  const r = await fetchHostedRegistrations(ENV, { fetchImpl: hang, timeoutMs: 20 });
  assert.equal(r.state, HOSTED.UNREACHABLE);
  assert.equal(r.detail, 'timeout');
});

test('local-only and hosted-verified registrations stay DISTINGUISHABLE', async () => {
  // A local registration is a claim this machine makes about itself. A hosted
  // one is a claim another machine can check. Flattening them would make the
  // weaker indistinguishable from the stronger.
  const local = [{ session_id: 'sess-local', agent_id: 'code-b', capacity: 'idle', heartbeat_at: ago(1000) }];
  const { rows } = await fetchHostedRegistrations(ENV, { fetchImpl: okFetch([hostedRow()]) });

  const merged = mergeRegistrations(local, rows);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((r) => r.session_id === 'sess-local').origin, 'local');
  assert.equal(merged.find((r) => r.session_id === 'sess-remote').origin, 'hosted');
});

test('the same session seen twice is ONE worker, and hosted wins on liveness', async () => {
  // The hosted heartbeat is server-stamped, so it is the one another machine
  // can trust. The local row is the same worker seen from closer up.
  const local = [{ session_id: 'sess-remote', agent_id: 'code-d', capacity: 'busy', heartbeat_at: ago(9e6) }];
  const { rows } = await fetchHostedRegistrations(ENV, { fetchImpl: okFetch([hostedRow()]) });

  const merged = mergeRegistrations(local, rows);
  assert.equal(merged.length, 1, 'one worker was counted twice');
  assert.equal(merged[0].origin, 'hosted');
  assert.equal(merged[0].heartbeat_at, ago(30_000), 'the stale local heartbeat won');
  assert.equal(isLive(merged[0], { now: NOW }), true);
});

test('no absolute path or operator name is carried in a hosted row', async () => {
  const { rows } = await fetchHostedRegistrations(ENV, { fetchImpl: okFetch([hostedRow()]) });
  const text = JSON.stringify(rows);
  assert.doesNotMatch(text, /[A-Za-z]:[\\/]/, 'a windows absolute path reached the registry');
  assert.doesNotMatch(text, /\/home\/|\/Users\//, 'a posix home path reached the registry');
  assert.doesNotMatch(text, /DANNY|danny garcia/i, 'an operator name reached the registry');
  // machine_id is an opaque uuid, never a hostname.
  assert.match(rows[0].machine_id, /^[0-9a-f-]{36}$/);
});

// ── lead work ──────────────────────────────────────────────────────────────
test('lead_work records self-work as first-class provenance', () => {
  const r = createLeadWork({
    work_id: 'lw-1', agent_id: 'code-c', session_id: 'danny-win-10',
    repo_id: 'agentbridge', base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40),
    scope: 'wire supersession and tokenBudget', files_changed: ['bin/agentbridge.mjs'],
    tests: '563 pass', created_at: NOW,
  });
  assert.equal(r.ok, true, r.errors?.join('; '));
  assert.equal(r.record.kind, 'lead_work');
});

test('lead_work REFUSES to impersonate a handoff', () => {
  // The workaround the ruling forbids: expressing a delegation through the
  // wrong record type to dodge the self-delegation guard.
  const r = createLeadWork({
    work_id: 'lw-2', agent_id: 'code-c', session_id: 's', repo_id: 'r',
    base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40), scope: 'x',
    files_changed: ['f'], created_at: NOW,
    assigning_session: 'lead', assigned_session: 'worker',
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /not a handoff/);
});

test('lead_work refuses an empty diff and a typed sha', () => {
  const sha = 'a'.repeat(40);
  const base = {
    work_id: 'lw-3', agent_id: 'a', session_id: 's', repo_id: 'r',
    scope: 'x', files_changed: ['f'], created_at: NOW,
  };
  // head == base means nothing was committed.
  assert.equal(createLeadWork({ ...base, base_sha: sha, head_sha: sha }).ok, false);
  // A short sha is a sha somebody typed rather than resolved.
  assert.equal(createLeadWork({ ...base, base_sha: 'e38ebd9', head_sha: sha }).ok, false);
  // No files named means nothing auditable.
  assert.equal(createLeadWork({ ...base, base_sha: sha, head_sha: 'b'.repeat(40), files_changed: [] }).ok, false);
});

test('lead_work is append-only and queryable per session', () => {
  const mk = (id, at) => ({
    work_id: id, agent_id: 'code-c', session_id: 'danny-win-10', repo_id: 'agentbridge',
    base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40), scope: 's',
    files_changed: ['f'], created_at: at,
  });
  const first = appendLeadWork([], mk('lw-1', '2026-09-15T10:00:00.000Z'));
  assert.equal(first.ok, true);
  const second = appendLeadWork(first.rows, mk('lw-2', '2026-09-15T11:00:00.000Z'));
  assert.equal(second.rows.length, 2);

  // The same id twice is refused; these are append-only.
  assert.equal(appendLeadWork(second.rows, mk('lw-1', NOW)).ok, false);

  assert.deepEqual(leadWorkFor(second.rows, 'danny-win-10').map((r) => r.work_id), ['lw-2', 'lw-1']);
  assert.deepEqual(leadWorkFor(second.rows, 'somebody-else'), []);
});
