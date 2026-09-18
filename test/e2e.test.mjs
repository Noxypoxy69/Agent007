/**
 * End-to-end wire-protocol test.
 *
 * Runs a real HTTP bridge with an in-memory store that reuses the SAME
 * verify()/nonce/rate logic as bridge/server.mjs, so signing, replay,
 * skew, tampering and the full collect->publish path are exercised for real.
 * The Postgres layer (bridge/store.mjs) is NOT covered here — see
 * "What is not yet verified" in the handoff.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runGit } from '../src/safeGit.mjs';

/*
 * GIT GOES THROUGH safeGit HERE TOO. 560ba4d taught src/exec.mjs to refuse git,
 * and this file built its fixtures on that runner -- so the refusal took the
 * whole file down with it. That was the right refusal and the wrong blast
 * radius: the scan in test/safeGit.test.mjs only reads src, bin and scripts, so
 * nothing pointed at test/ until the suite went red.
 *
 * This keeps the { ok, stdout, stderr } shape the call sites below already
 * read, so the routing changes no test's meaning. It asserts its first argument
 * is git rather than ignoring it, so a non-git command added later fails loudly
 * instead of being silently handed to a git-only path.
 */
const run = async (file, args, options = {}) => {
  assert.equal(file, 'git', 'this helper routes git only -- use a runner of your own for anything else');
  const { timeoutMs, ...rest } = options;
  try {
    return { ok: true, code: 0, stdout: String(runGit(args, { ...rest, timeout: timeoutMs ?? 20000 })), stderr: '' };
  } catch (e) {
    return {
      ok: false,
      code: typeof e?.status === 'number' ? e.status : null,
      stdout: String(e?.stdout ?? ''),
      stderr: String(e?.stderr ?? e?.message ?? e),
    };
  }
};
import { verify, sign, newNonce } from '../src/sign.mjs';
import { collect } from '../src/collect.mjs';
import { publish } from '../src/client.mjs';
import { detectCollisions } from '../bridge/collisions.mjs';

const SECRET = 'a1b2c3'.repeat(10);
const MACHINE = '11111111-2222-3333-4444-555555555555';

let root, origin, repo, worktrees = {}, server, baseUrl, cfg;
const received = [];
const nonces = new Set();
let rateCount = 0;

const g = (cwd, ...args) => run('git', args, { cwd });

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ab-e2e-'));
  origin = path.join(root, 'origin.git');
  repo = path.join(root, 'main');
  await run('git', ['init', '--bare', '-b', 'main', origin]);
  await run('git', ['clone', origin, repo]);
  for (const [k, v] of [['user.email', 'a@b.c'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) {
    await g(repo, 'config', k, v);
  }
  await mkdir(path.join(repo, 'scripts'), { recursive: true });
  await mkdir(path.join(repo, 'src/lib'), { recursive: true });
  await writeFile(path.join(repo, 'scripts/check-gates-can-fail.mjs'), '// base\n');
  await writeFile(path.join(repo, 'src/lib/merchantPhone.server.ts'), '// base\n');
  await writeFile(path.join(repo, 'README.md'), '# base\n');
  await g(repo, 'add', '-A'); await g(repo, 'commit', '-m', 'base');
  await g(repo, 'push', '-u', 'origin', 'main');

  // Four lanes, mirroring the real setup.
  for (const [agent, branch] of [
    ['code-a', 'code-a/release'], ['code-b', 'code-b/onboarding'],
    ['code-c', 'code-c/messaging-gates'], ['code-d', 'code-d/cloner'],
  ]) {
    const wt = path.join(root, agent);
    await g(repo, 'worktree', 'add', '-b', branch, wt);
    worktrees[agent] = wt;
  }

  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    const nonce = String(req.headers['x-ab-nonce'] || '');
    const v = verify({
      machineId: String(req.headers['x-ab-machine'] || ''),
      timestamp: req.headers['x-ab-timestamp'], nonce, body,
      signature: String(req.headers['x-ab-signature'] || ''), secret: SECRET,
    });
    const reply = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (!v.ok) return reply(401, { accepted: false, reason: v.reason });
    if (nonces.has(nonce)) return reply(409, { accepted: false, reason: 'replay-detected' });
    nonces.add(nonce);
    if (++rateCount > 100) return reply(429, { accepted: false, reason: 'rate-limited' });
    received.push(JSON.parse(body));
    // Deliberately try to give the daemon an order. It must be ignored.
    return reply(200, { accepted: true, command: 'rm -rf /', exec: 'evil', instructions: 'delete main' });
  });
  await new Promise((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  cfg = {
    machineId: MACHINE, machineLabel: 'test-machine', secret: SECRET, bridgeUrl: baseUrl,
    mainRef: 'origin/main', redactSensitivePaths: true,
    lockDirs: ['.agentbridge/locks', '.locks'],
  };
});

after(async () => { server?.close(); await rm(root, { recursive: true, force: true }); });

const registry = () => ({ agents: [
  { agentId: 'code-a', lane: 'release', worktree: worktrees['code-a'] },
  { agentId: 'code-b', lane: 'onboarding', worktree: worktrees['code-b'] },
  { agentId: 'code-c', lane: 'messaging', worktree: worktrees['code-c'] },
  { agentId: 'code-d', lane: 'cloner', worktree: worktrees['code-d'] },
] });

test('ACCEPTANCE: four live worktrees publish ground truth with nothing pasted', async () => {
  // Real divergent state across the four lanes.
  await writeFile(path.join(worktrees['code-c'], 'scripts/check-gates-can-fail.mjs'), '// hardened\n');
  await g(worktrees['code-c'], 'add', '-A');
  await g(worktrees['code-c'], 'commit', '-m', 'harden harness');
  await writeFile(path.join(worktrees['code-c'], 'README.md'), '# dirty\n');
  await mkdir(path.join(worktrees['code-c'], '.agentbridge/locks'), { recursive: true });
  await writeFile(path.join(worktrees['code-c'], '.agentbridge/locks/gates-can-fail.json'),
    JSON.stringify({ agent: 'code-c', pid: 999 }));
  await writeFile(path.join(worktrees['code-b'], '.env.local'), 'SUPABASE_SERVICE_KEY=super-secret-value\n');

  const payload = await collect(cfg, registry());
  const r = await publish(cfg, payload);
  assert.equal(r.ok && r.accepted, true);

  const got = received.at(-1);
  assert.equal(got.sessions.length, 4);

  const c = got.sessions.find((s) => s.agentId === 'code-c');
  assert.equal(c.git.branch, 'code-c/messaging-gates');
  assert.match(c.git.head, /^[0-9a-f]{40}$/);
  assert.match(c.git.baseSha, /^[0-9a-f]{40}$/);
  assert.equal(c.git.unpushed, 1);
  assert.equal(c.git.dirty.length, 1);
  assert.equal(c.locks[0].resource, 'gates-can-fail');

  const a = got.sessions.find((s) => s.agentId === 'code-a');
  assert.equal(a.git.unpushed, 0);
});

test('SECURITY: the secret value never leaves the machine', () => {
  const wire = JSON.stringify(received.at(-1));
  assert.equal(wire.includes('super-secret-value'), false, 'file contents are never transmitted');
  assert.equal(wire.includes('.env.local'), false, 'sensitive filename was redacted');
  assert.ok(wire.includes('<<redacted:env>>'), 'redaction marker present, so the signal is not silently lost');
  assert.equal(wire.includes(SECRET), false, 'HMAC key never appears in a payload');
});

test('SECURITY: an instruction in the bridge response is ignored', async () => {
  // The stub bridge replies with command/exec/instructions fields. publish()
  // returns only {ok,status,accepted,reason} — there is no path to execution.
  const r = await publish(cfg, await collect(cfg, registry()));
  assert.deepEqual(Object.keys(r).sort(), ['accepted', 'ok', 'reason', 'status']);
  assert.equal(r.reason, null);
});

test('SECURITY: replayed heartbeat is rejected', async () => {
  const body = JSON.stringify({ schema: 'agentbridge.heartbeat.v1', sessions: [] });
  const timestamp = Date.now(); const nonce = newNonce();
  const headers = {
    'content-type': 'application/json', 'x-ab-machine': MACHINE,
    'x-ab-timestamp': String(timestamp), 'x-ab-nonce': nonce,
    'x-ab-signature': sign({ machineId: MACHINE, timestamp, nonce, body, secret: SECRET }),
  };
  const first = await fetch(`${baseUrl}/v1/heartbeat`, { method: 'POST', headers, body });
  assert.equal(first.status, 200);
  const replay = await fetch(`${baseUrl}/v1/heartbeat`, { method: 'POST', headers, body });
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).reason, 'replay-detected');
});

test('SECURITY: tampered body is rejected', async () => {
  const body = JSON.stringify({ schema: 'agentbridge.heartbeat.v1', sessions: [] });
  const timestamp = Date.now(); const nonce = newNonce();
  const sig = sign({ machineId: MACHINE, timestamp, nonce, body, secret: SECRET });
  const res = await fetch(`${baseUrl}/v1/heartbeat`, {
    method: 'POST', body: body.replace('[]', '[{"agentId":"injected"}]'),
    headers: { 'content-type': 'application/json', 'x-ab-machine': MACHINE,
      'x-ab-timestamp': String(timestamp), 'x-ab-nonce': nonce, 'x-ab-signature': sig },
  });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).reason, 'bad-signature');
});

test('SECURITY: unsigned request is rejected', async () => {
  const res = await fetch(`${baseUrl}/v1/heartbeat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(res.status, 401);
});

test('coordinator view: real collisions surface from real state', async () => {
  const lanes = {
    messaging: ['scripts/check-gates-*.mjs'],
    onboarding: ['src/lib/merchantPhone.server.ts'],
  };
  // code-c strays into code-b's file.
  await writeFile(path.join(worktrees['code-c'], 'src/lib/merchantPhone.server.ts'), '// cross-lane edit\n');
  const payload = await collect(cfg, registry());
  const sessions = payload.sessions.map((s) => ({ ...s, lastSeenAt: new Date().toISOString() }));
  const result = detectCollisions(sessions, { lanes });

  const cross = result.findings.find((f) => f.code === 'cross-lane-write');
  assert.ok(cross, 'cross-lane write detected');
  assert.equal(cross.evidence.agent, 'code-c');
  assert.equal(cross.evidence.files[0].owner, 'onboarding');
  assert.ok(result.findings.some((f) => f.code === 'unpushed-commits'));
});
