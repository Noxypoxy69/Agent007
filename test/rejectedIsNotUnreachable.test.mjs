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

/*
 * ═══ WHAT THIS FILE CANNOT CATCH, STATED SO NOBODY INFERS OTHERWISE ═══
 *
 * These tests point at a LOOPBACK bridge. The libuv assertion that turns a
 * refusal into exit 127 --
 *
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\winsync.c:94
 *
 * -- was measured in this repo as reproducing against a REAL REMOTE endpoint
 * and NOT against loopback, TLS-to-localhost, or a local server. See the note
 * on the Done class in bin/agentbridge.mjs.
 *
 * So the assertions below catch the sentinel LEAKING (`error: done:`) and the
 * wrong exit code, both of which reproduce anywhere. They cannot catch a
 * regression that reintroduces process.exit() while still converting Done:
 * mutating the boundary to `process.exit(e.exitCode)` leaves this file GREEN,
 * because loopback does not trip the assertion.
 *
 * That gap is real and it is why b6's live probe is load-bearing rather than a
 * duplicate of this file. A hermetic suite cannot reach it. Anyone changing the
 * exit discipline must re-probe against the live Bridge, not trust this.
 *
 * ── HOW TO RUN THAT PROBE, because "re-probe live" is not an instruction ──
 *
 * b6 asked for this and was right to. The paragraph above told the next person
 * the hermetic suite was insufficient and gave them no way to do anything about
 * it, which is how a caveat turns into a shrug.
 *
 *   WHO:    a session holding a REGISTRATION token. Not a reader, not a
 *           coordinator: register-session and unregister-session are the
 *           registration surface, and those two commands are the only ones
 *           whose refusal path reaches the boundary under test.
 *   WHERE:  agentbridge-secrets/registration-token.txt, PIPED into the command.
 *           Never printed, never pasted, never echoed into a transcript.
 *   WHAT:   four cases, and the last two are not optional. A rejected token must
 *           exit EXACTLY 1. A VALID token must still exit 0 -- the outer catch
 *           is on every command's path, so a fix here can break exits that were
 *           already correct, and probing the refusal alone would not see it.
 *           b6 ran the success cases unasked; that is the standard.
 *
 *             refused register-session     exit 1, no "error: done:", no Assertion
 *             refused unregister-session   exit 1, same
 *             valid register-session       exit 0, clean stderr
 *             valid unregister-session     exit 0, clean stderr
 *
 *   AFTER:  remove every probe row. A liveness probe left registered is a
 *           phantom worker in the roster, and the collision detector believed
 *           two of them for most of one day.
 *
 * Measured this way at 83cd087, against the live deployment: all four as above.
 * The measurement is recorded here rather than in a message because a message is
 * gone by the time the next person needs it.
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
/**
 * Run the CLI in an isolated home so no real roster is touched.
 *
 * `home` IS A PARAMETER AND THAT MATTERS. The first version minted a fresh
 * temp home per call, so a test that registered and then deregistered used two
 * different rosters -- the second command found no local row, skipped the
 * hosted call entirely, and the assertions guarded on it never ran. The suite
 * was green and proving nothing, and the mutation table is what exposed it:
 * reverting the fix under test left every assertion passing.
 */
async function runCli(t, args, env, home = null) {
  if (!home) {
    home = await mkdtemp(join(tmpdir(), 'ab-exit-'));
    t.after(() => rm(home, { recursive: true, force: true }));
  }

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

test('A REFUSED REGISTRATION EXITS EXACTLY 1, CLEANLY', async (t) => {
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

  /*
   * EXACTLY 1, AND CLEANLY. `notEqual(0)` is what this asserted first, and it
   * passed on 127 -- which is what the process actually returned, because the
   * Done sentinel escaped to the outer catch, got printed as `error: done:1`,
   * and then hit process.exit() after a fetch and died on the libuv assertion.
   *
   * 127 is the shell's conventional "command not found". A caller branching on
   * the exit code could not tell a refused credential from a missing binary,
   * and the operator this path prints a careful message for would be sent to
   * check their PATH. Found by b6 probing live; the weaker assertion is why my
   * own suite did not.
   */
  assert.equal(r.code, 1,
    `a refused registration must exit exactly 1, got ${r.code} (127 means it crashed)`);
  assert.doesNotMatch(r.err, /error: done:/,
    'the Done sentinel leaked to the user as a fault message');
  assert.doesNotMatch(r.err, /Assertion failed/,
    'the process died on the libuv assertion instead of exiting cleanly');
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
  assert.doesNotMatch(r.err, /error: done:|Assertion failed/,
    'the success path must exit cleanly too, or the refusal assertions prove nothing specific');
  assert.match(`${r.out}${r.err}`, /NOT CONFIGURED/);
});

// ── the audit b6's finding prompted ────────────────────────────────────────
/*
 * b6 probed register-session. I audited the other three hosted commands
 * afterwards rather than declaring them clean, and unregister-session had the
 * identical bug in the worse place: its own comment said the consequence was "a
 * session other machines still believe is alive, which is what gets work
 * addressed to nobody", and it exited 0 anyway.
 *
 * return-task and wait-for-work already exited non-zero; only their WORDING
 * called a refusal unreachable. Those are covered by the wording assertions
 * below rather than by exit codes, because their exit codes were never wrong.
 */
async function registerThenDeregister(t, base, session) {
  // ONE home across both commands, or the second finds no row to remove.
  const home = await mkdtemp(join(tmpdir(), 'ab-exit-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  const reg = await runCli(t, [
    'register-session', '--agent', 'probe-y', '--session', session, '--lane', 'probe',
  ], { AGENTBRIDGE_REGISTER_URL: '', AGENTBRIDGE_REGISTRATION_TOKEN: '' }, home);

  // The precondition, asserted rather than assumed: if this did not register
  // locally there is nothing to deregister and the test below proves nothing.
  assert.equal(reg.code, 0, 'local registration failed, so the deregistration test is vacuous');

  const un = await runCli(t, ['unregister-session', '--session', session], {
    AGENTBRIDGE_REGISTER_URL: `${base}/register`,
    AGENTBRIDGE_REGISTRATION_TOKEN: 'x'.repeat(24),
  }, home);

  const all = `${un.out}${un.err}`;
  // The hosted half MUST have been attempted, or the assertions are decoration.
  assert.match(all, /hosted/i, 'the hosted deregistration was never attempted');
  return { ...un, all };
}

test('A REFUSED DEREGISTRATION EXITS EXACTLY 1, CLEANLY', async (t) => {
  const { base } = await refusingBridge(t);
  const r = await registerThenDeregister(t, base, 'probe-y-1');

  assert.equal(r.code, 1,
    `a refused deregistration must exit exactly 1, got ${r.code} (127 means it crashed)`);
  assert.doesNotMatch(r.err, /error: done:|Assertion failed/,
    'the refusal path crashed rather than exiting');
  assert.match(r.all, /REJECTED/i);
});

test('the deregistration failure says the session may still look alive', async (t) => {
  /*
   * The wording carries the consequence. "Unreachable" tells an operator a
   * request failed; it does not tell them work may now be routed to a worker
   * that has gone home, which is the thing they need to act on.
   */
  const { base } = await refusingBridge(t);
  const r = await registerThenDeregister(t, base, 'probe-z-1');

  assert.match(r.all, /STILL APPEAR LIVE/i,
    'the operator was not told the consequence, only that a request failed');
});

test('return-task names a refusal a refusal, not a network problem', async (t) => {
  const { base } = await refusingBridge(t);
  const r = await runCli(t, [
    // --lease is required now that /return is fenced. Without it the CLI
    // refuses locally and never reaches the credential check this asserts on,
    // which would make this test green for a reason that has nothing to do
    // with 401 handling.
    'return-task', '--task', 't-probe', '--session', 'probe-r-1', '--lease', 'lease-probe',
  ], {
    AGENTBRIDGE_REGISTER_URL: `${base}/register`,
    AGENTBRIDGE_REGISTRATION_TOKEN: 'x'.repeat(24),
  });

  const all = `${r.out}${r.err}`;
  assert.notEqual(r.code, 0, 'a refused return reported success');
  assert.match(all, /REFUSED this credential/i,
    'a rejected credential was reported as an unreachable network');
});
