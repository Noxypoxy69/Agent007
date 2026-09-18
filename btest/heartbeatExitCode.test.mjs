import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agentbridge.mjs');

/**
 * A HEARTBEAT THAT DID NOT LAND MUST NOT EXIT 0.
 *
 * ═══ b6's OWN FINDING, IN A COMMAND NOBODY RE-CHECKED ═══
 *
 * b6 found this on `register-session`: a refused credential printed an error,
 * wrote a local row, and EXITED 0, so anything reading the machine-readable
 * signal saw success. That was fixed. `heartbeat` kept the bug, because the fix
 * went to the command that was REPORTED rather than to every command that
 * publishes.
 *
 * Same instance-not-class mistake that let 404 walk past three separate status
 * fixes in hostedRegistry, arriving here by a different road.
 *
 * ═══ WHY IT MATTERS MORE HERE THAN ANYWHERE ELSE ═══
 *
 * `heartbeat` is the command a WATCHER LOOPS ON. Exiting 0 on a failed publish
 * means a watcher looks healthy forever: nothing to alert on, nothing in the
 * exit code, and the hosted roster going stale behind it while the process sits
 * there reporting success.
 *
 * b6's watcher was "nominally running, producing no output, heartbeat stopped".
 * This is the best available explanation for how that state is reachable
 * without anything noticing — and it is the state that made code-d's roster
 * finding matter, because a worker that has silently stopped beating is exactly
 * the row the roster was describing as idle.
 *
 * Found by auditing the fifth hosted path, which is the item b6 had outstanding
 * and did not get to.
 */

/** A Bridge that answers, understands, and refuses. */
async function bridge(t, status) {
  const calls = [];
  const server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      calls.push(req.url);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status === 200 ? { accepted: true } : { error: 'unauthorized' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return { calls, url: `http://127.0.0.1:${server.address().port}/ingest` };
}

async function home(t, bridgeUrl) {
  const dir = await mkdtemp(join(tmpdir(), 'ab-hb-'));
  const cfgDir = join(dir, '.agentbridge');
  await mkdir(cfgDir, { recursive: true });
  await writeFile(join(cfgDir, 'config.json'), JSON.stringify({
    ...(bridgeUrl ? { bridgeUrl } : {}),
    machineId: 'm1', machineLabel: 'm1', intervalSeconds: 60, secretStore: 'none',
  }));
  await writeFile(join(cfgDir, 'registry.json'), JSON.stringify({ agents: [] }));
  return { AGENTBRIDGE_HOME: cfgDir, USERPROFILE: dir, HOME: dir };
}

const runCli = (env) => new Promise((resolve) => {
  execFile(process.execPath, [CLI, 'heartbeat'],
    { env: { ...process.env, ...env }, timeout: 30000 },
    (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr: stderr ?? '' }));
});

test('A REFUSED HEARTBEAT EXITS NON-ZERO', async (t) => {
  /*
   * THE bug. The English said "publish failed: 401" and the exit code said
   * success, and a watcher reads the exit code.
   */
  const b = await bridge(t, 401);
  const r = await runCli(await home(t, b.url));

  assert.equal(r.code, 1, 'a refused heartbeat reported success to every caller that reads an exit code');
  assert.match(r.stderr, /publish failed: 401/);
  assert.ok(b.calls.length > 0, 'the fixture never reached the bridge, so this proves nothing');
});

test('A HEARTBEAT THAT LANDS STILL EXITS 0 — the positive control', async (t) => {
  /*
   * Required, and load-bearing: "exit 1 whenever publishing was attempted"
   * satisfies the test above and turns every healthy beat into an alarm. A
   * watcher that alerts on success is a watcher that gets muted.
   */
  const b = await bridge(t, 200);
  const r = await runCli(await home(t, b.url));

  assert.equal(r.code, 0, 'a successful heartbeat was reported as a failure');
  assert.match(r.stderr, /published\./);
});

test('LOCAL-ONLY IS NOT A FAILURE', async (t) => {
  /*
   * A machine with no bridgeUrl has nowhere to publish and is working as
   * intended. Exiting non-zero would make every local setup look broken —
   * the same distinction the runtime's heartbeat client makes for
   * HOSTED.NOT_CONFIGURED, and the same mistake that would have made a
   * local-only worker announce it was going dark forever.
   */
  const r = await runCli(await home(t, null));

  assert.equal(r.code, 0, 'a local-only machine was reported as a failing heartbeat');
  assert.match(r.stderr, /local-only/);
});

test('a TRANSPORT failure also exits non-zero', async (t) => {
  // Nobody answered. Different cause from a refusal, same consequence for the
  // caller: the beat did not land, and a watcher must not read that as fine.
  const r = await runCli(await home(t, 'http://127.0.0.1:1/ingest'));
  assert.equal(r.code, 1);
});

test('the payload is still printed, whatever the exit code', async (t) => {
  /*
   * The command's other job is to show what WOULD be published. Failing the
   * exit code must not also remove the diagnostic — that would trade one
   * silent failure for a louder but less useful one.
   */
  const b = await bridge(t, 401);
  const r = await runCli(await home(t, b.url));

  assert.equal(r.code, 1);
  assert.doesNotThrow(() => JSON.parse(r.stdout), 'the payload stopped being printed on failure');
});
