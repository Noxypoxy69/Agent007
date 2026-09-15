import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { HOSTED, publishRegistration } from '../src/hostedRegistry.mjs';

/**
 * A REFUSED CREDENTIAL IS NOT AN UNREACHABLE SERVICE, AND IT IS NOT EXIT 0.
 *
 * Found by b6 probing the live deployment rather than reading the source. With
 * a reader token, `register-session` printed "registered", wrote a local roster
 * row, reported the hosted half as "UNREACHABLE (401)", and EXITED 0. Anything
 * scripting the CLI reads exit 0 as success, so the one machine-readable signal
 * said the opposite of what happened.
 *
 * TWO SEPARATE WRONGS, and the second is the one that travels:
 *
 *   The WORD. A 401 means somebody answered and said no. That is a decision,
 *   not a transport failure. Calling it unreachable sends the reader to check a
 *   network they cannot fix instead of a credential they can.
 *
 *   The EXIT CODE. The command's central act was refused and it reported
 *   success to every caller that cannot read English.
 *
 * The comment beside the 401 branch already said "a rejected credential is NOT
 * the same as an unreachable service". The line under it returned UNREACHABLE.
 * Prose describing an intention as though it were a behaviour -- the same shape
 * as the reviewer-lease columns that nothing wrote.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'bin', 'agentbridge.mjs');

/*
 * THE VARIABLE NAME IS LOAD-BEARING AND THE FIRST DRAFT GOT IT WRONG.
 *
 * registrationConfig reads AGENTBRIDGE_REGISTER_URL and DEFAULTS TO PRODUCTION
 * when it is absent. The first version of this file set
 * AGENTBRIDGE_REGISTRATION_URL -- a name nothing reads -- so every request went
 * to the live deployment and came back 401 from a real server. Two assertions
 * "passed" for the wrong reason and two failed in a way that looked like a bug
 * in the fix rather than a bug in the test.
 *
 * A test that silently falls back to production is the same failure as the one
 * it is testing: it reported a result it had not measured. Named here so the
 * next person setting up a fake Bridge checks the spelling first.
 */
/** A Bridge that answers, understands, and says no. */
async function refusingBridge(t, status = 401) {
  const calls = [];
  const server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      calls.push({ url: req.url, auth: req.headers.authorization });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return { calls, base: `http://127.0.0.1:${server.address().port}` };
}

// ── the word ───────────────────────────────────────────────────────────────
test('REJECTED and UNREACHABLE are different states', () => {
  assert.equal(HOSTED.REJECTED, 'rejected');
  assert.notEqual(HOSTED.REJECTED, HOSTED.UNREACHABLE);
});

test('a 401 is REJECTED, not UNREACHABLE', async (t) => {
  const { base } = await refusingBridge(t);
  const r = await publishRegistration(
    { AGENTBRIDGE_REGISTER_URL: `${base}/register`, AGENTBRIDGE_REGISTRATION_TOKEN: 'x'.repeat(24) },
    { session_id: 's1', agent_id: 'a1', machine_id: 'm1' },
  );

  assert.equal(r.state, HOSTED.REJECTED,
    'a credential the Bridge refused was reported as a transport failure');
  assert.match(r.detail, /401/);
});

test('a genuine transport failure is STILL unreachable', async () => {
  /*
   * The positive control. A fix that turned every failure into REJECTED would
   * pass the test above and would send somebody to rotate a perfectly good
   * token while their network was down.
   */
  const r = await publishRegistration(
    { AGENTBRIDGE_REGISTER_URL: 'http://127.0.0.1:1/register',
      AGENTBRIDGE_REGISTRATION_TOKEN: 'x'.repeat(24) },
    { session_id: 's1', agent_id: 'a1', machine_id: 'm1' },
    { timeoutMs: 1500 },
  );
  assert.equal(r.state, HOSTED.UNREACHABLE);
});

test('a 500 is unreachable, not rejected — only auth failures are refusals', async (t) => {
  const { base } = await refusingBridge(t, 500);
  const r = await publishRegistration(
    { AGENTBRIDGE_REGISTER_URL: `${base}/register`, AGENTBRIDGE_REGISTRATION_TOKEN: 'x'.repeat(24) },
    { session_id: 's1', agent_id: 'a1', machine_id: 'm1' },
  );
  assert.equal(r.state, HOSTED.UNREACHABLE);
});

// ── the exit code ──────────────────────────────────────────────────────────
/** Run the CLI in an isolated home so no real roster is touched. */
async function runCli(t, args, env) {
  const home = await mkdtemp(join(tmpdir(), 'ab-exit-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, AGENTBRIDGE_HOME: home, ...env },
      cwd: join(here, '..'),
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('A REFUSED REGISTRATION EXITS NON-ZERO', async (t) => {
  /*
   * THE test, and the one b6's finding is actually about. Everything else here
   * is about wording; this is the line a script reads.
   */
  const { base } = await refusingBridge(t);
  const r = await runCli(t, [
    'register-session', '--agent', 'probe-x', '--session', 'probe-x-1', '--lane', 'probe',
  ], {
    AGENTBRIDGE_REGISTER_URL: `${base}/register`,
    AGENTBRIDGE_REGISTRATION_TOKEN: 'x'.repeat(24),
  });

  assert.notEqual(r.code, 0,
    'a registration the Bridge refused reported success to every caller that cannot read English');
  assert.match(`${r.out}${r.err}`, /REJECTED/,
    'the refusal must be named as a refusal, not as a network problem');
});

test('the refusal says it is not a network problem, in words', async (t) => {
  /*
   * The wording is load-bearing. "Unreachable" sends an operator to restart a
   * router. This has to point at the token instead, or the exit code is right
   * and the hour is still wasted.
   */
  const { base } = await refusingBridge(t);
  const r = await runCli(t, [
    'register-session', '--agent', 'probe-x', '--session', 'probe-x-1', '--lane', 'probe',
  ], {
    AGENTBRIDGE_REGISTER_URL: `${base}/register`,
    AGENTBRIDGE_REGISTRATION_TOKEN: 'x'.repeat(24),
  });

  const all = `${r.out}${r.err}`;
  assert.match(all, /NOT a[\s\S]{0,20}network problem/i);
  assert.match(all, /check the token/i);
  assert.match(all, /LOCAL ONLY/i, 'it must say the session is not visible elsewhere');
});

test('NOT CONFIGURED still exits 0 — local-only is a chosen mode, not a failure', async (t) => {
  /*
   * The positive control for the exit code. A fix that made every non-OK state
   * exit non-zero would break the legitimate case of running with no hosted
   * token at all, and the first person to hit it would add `|| true` to their
   * script and lose the signal permanently.
   */
  const r = await runCli(t, [
    'register-session', '--agent', 'probe-x', '--session', 'probe-x-1', '--lane', 'probe',
  ], { AGENTBRIDGE_REGISTER_URL: '', AGENTBRIDGE_REGISTRATION_TOKEN: '' });

  assert.equal(r.code, 0, 'running without a hosted token is legitimate and must not fail');
  assert.match(`${r.out}${r.err}`, /NOT CONFIGURED/);
});
