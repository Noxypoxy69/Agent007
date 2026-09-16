import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  interpretHttp, HOSTED,
  returnWork, waitForEvents, fetchHostedRegistrations, publishRegistration,
} from '../src/hostedRegistry.mjs';

/**
 * ANY HTTP RESPONSE IS AN ANSWER. `UNREACHABLE` MEANS NOBODY ANSWERED.
 *
 * ═══ THE THIRD TIME, AND THE FIRST TIME AS A CLASS ═══
 *
 * b6 ran `return-task` three times over twenty minutes and got "the Bridge is
 * unreachable (d-claims-authz-b6)". It told Danny the Bridge was down. It was
 * not — `wait-for-work` answered throughout. The Bridge had said:
 *
 *     404  {"error":"no-such-task","detail":"d-claims-authz-b6"}
 *
 * b6's tell, which is the best part of the report: UNREACHABLE details are
 * "timeout", "no fetch available", "http 500". A detail that is an IDENTIFIER
 * means the far end answered and formed an opinion about it.
 *
 * ═══ WHY THE SUITE WAS GREEN THROUGH ALL THREE ═══
 *
 * 401 was fixed, then 409, then 400 on a branch — each a new `if (status ===
 * N)` on a ladder whose FALLBACK still said UNREACHABLE. And there were FOUR
 * such ladders, one per call site. Every status nobody had been bitten by kept
 * the bug.
 *
 * The tests matched the fixes exactly: they asserted 401 and 409 and nothing
 * else, so the fallthrough — where the bug actually lived — was never
 * exercised. When the shared classifier landed, all 949 tests stayed green
 * through a behaviour change affecting every 4xx in the file. THAT is the
 * measurement that says the old coverage was shaped like the patches rather
 * than like the risk.
 *
 * So this file does not add 404. It asserts the RULE, over generated statuses,
 * through all four real call paths.
 */

const res = (status, body = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

// ── the rule, over a generated range rather than the statuses we got bitten by ──

test('EVERY 4xx IS AN ANSWER — generated, not enumerated', async () => {
  /*
   * Enumerating would repeat the mistake: three fixes, three statuses, and the
   * fourth walked past all of them. The only honest version of this assertion
   * covers the whole space.
   */
  const escaped = [];
  for (let status = 400; status < 500; status += 1) {
    const out = await interpretHttp(res(status, { error: 'nope', detail: 'thing-42' }));
    const expected = (status === 401 || status === 403) ? HOSTED.REJECTED : HOSTED.REFUSED;
    if (out.state !== expected) escaped.push(`${status} -> ${out.state}, expected ${expected}`);
  }
  assert.deepEqual(escaped, [], 'a 4xx was filed as something other than an answer');
});

test('every 5xx stays UNREACHABLE — it answered but cannot serve', async () => {
  for (let status = 500; status < 600; status += 1) {
    const out = await interpretHttp(res(status));
    assert.equal(out.state, HOSTED.UNREACHABLE, String(status));
  }
});

test('2xx returns null so the caller proceeds — the positive control', async () => {
  // Without this the rule above could be satisfied by returning REFUSED for
  // everything, which would break every success path in the file.
  assert.equal(await interpretHttp(res(200, { task: {} })), null);
  assert.equal(await interpretHttp(res(204)), null);
});

test("b6's TELL: an UNREACHABLE detail is never a bare identifier", async () => {
  /*
   * This is the property that would have let b6 diagnose it in seconds instead
   * of twenty minutes, so it is worth holding directly rather than inferring it
   * from the state mapping.
   */
  const unreachable = [await interpretHttp(res(500, { detail: 'd-claims-authz-b6' })),
    await interpretHttp(res(503))];

  for (const u of unreachable) {
    assert.equal(u.state, HOSTED.UNREACHABLE);
    assert.match(u.detail, /^http \d{3}/,
      'an unreachable detail did not lead with its status, so it reads like a decision');
  }

  // And the converse: a decision keeps the identifier, unprefixed.
  const refused = await interpretHttp(res(404, { error: 'no-such-task', detail: 'd-claims-authz-b6' }));
  assert.equal(refused.state, HOSTED.REFUSED);
  assert.match(refused.detail, /d-claims-authz-b6/,
    'the refusal dropped the identifier that says WHICH thing was refused');
});

test('a body that cannot be read does not change the STATE', async () => {
  // A 404 with an unparseable body is still a decision. Only the detail degrades.
  const broken = { ok: false, status: 404, json: async () => { throw new Error('not json'); } };
  const out = await interpretHttp(broken);
  assert.equal(out.state, HOSTED.REFUSED);
  assert.equal(out.detail, 'http 404');
});

// ── through all four real call paths ───────────────────────────────────────

const ENV = {
  AGENTBRIDGE_RETURN_URL: 'https://example.invalid/return',
  AGENTBRIDGE_WAIT_URL: 'https://example.invalid/wait',
  AGENTBRIDGE_MCP_URL: 'https://example.invalid/mcp',
  AGENTBRIDGE_READER_TOKEN: 'r'.repeat(40),
  AGENTBRIDGE_REGISTER_URL: 'https://example.invalid/register',
  AGENTBRIDGE_REGISTRATION_TOKEN: 'g'.repeat(40),
};

const stub = (status, body) => async () => res(status, body);

/*
 * NAMED WITH THEIR CALLERS SO A FAILURE POINTS AT ONE. The bug was never in
 * "the mapping" -- it was in four separate copies of it, and a test that only
 * exercised one would have passed while three stayed broken. That is exactly
 * what happened to the 401 fix.
 */
const PATHS = [
  ['returnWork', (f) => returnWork(ENV, { task_id: 't1' }, { fetchImpl: f })],
  ['waitForEvents', (f) => waitForEvents(ENV, { session_id: 's1' }, { fetchImpl: f })],
  ['fetchHostedRegistrations', (f) => fetchHostedRegistrations(ENV, { fetchImpl: f })],
  ['publishRegistration', (f) => publishRegistration(ENV, { agent_id: 'a' }, { fetchImpl: f })],
];

test('ALL FOUR CALL PATHS treat a 404 as an answer, not a transport failure', async () => {
  /*
   * The reported bug, held at every site rather than the one it was found at.
   * Four ladders had the identical hole; fixing the one b6 hit would have left
   * the other three for somebody to find next week.
   */
  for (const [name, call] of PATHS) {
    const out = await call(stub(404, { error: 'no-such-task', detail: 'd-claims-authz-b6' }));
    assert.notEqual(out.state, HOSTED.UNREACHABLE,
      `${name} filed an answered 404 as unreachable`);
    assert.equal(out.state, HOSTED.REFUSED, name);
  }
});

test('ALL FOUR CALL PATHS still call a 401 REJECTED, and a 500 UNREACHABLE', async () => {
  // The specialisations that remain at each site must AGREE with the shared
  // rule, not diverge from it. This is what stops the ladders drifting again.
  for (const [name, call] of PATHS) {
    assert.equal((await call(stub(401, {}))).state, HOSTED.REJECTED, `${name} 401`);
    assert.equal((await call(stub(500, {}))).state, HOSTED.UNREACHABLE, `${name} 500`);
  }
});

test('ALL FOUR CALL PATHS still succeed on a 200 — the positive control', async () => {
  /*
   * Required, and not decoration. Every assertion above is about a failure
   * mapping; a classifier that returned REFUSED unconditionally would satisfy
   * all of them and break the entire module. A guard that only refuses is an
   * outage.
   */
  for (const [name, call] of PATHS) {
    const out = await call(stub(200, { task: { task_id: 't1' }, events: [], registrations: [] }));
    assert.notEqual(out.state, HOSTED.REFUSED, `${name} refused a success`);
    assert.notEqual(out.state, HOSTED.UNREACHABLE, `${name} called a success unreachable`);
  }
});

test('a real transport failure is STILL unreachable', async () => {
  // The whole point is the distinction. If nothing answers, unreachable is
  // correct and must survive this change.
  const boom = async () => { throw new Error('ECONNREFUSED'); };
  for (const [name, call] of PATHS) {
    const out = await call(boom);
    assert.equal(out.state, HOSTED.UNREACHABLE, `${name} stopped reporting a real outage`);
  }
});
