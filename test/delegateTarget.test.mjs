import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermeticEnv } from './helpers/hermeticEnv.mjs';

/**
 * A DELEGATION MAY NOT NAME A WORKER THE MACHINE CANNOT FIND.
 *
 * The companion to delegateBase: that one stopped a fabricated commit, this one
 * stops a fabricated recipient. `--to danny-win-f1` was accepted as a free
 * string for days. It happens to be real -- the registry maps it to code-b --
 * but nothing checked, and a typo records a contract addressed to nobody, which
 * looks exactly like one nobody has picked up yet.
 *
 * resolveWorker and bindDelegation existed and NOTHING CALLED THEM. That is the
 * third time in this project a guard shipped with no call site; these tests
 * exist so the fourth is caught by CI rather than by reading.
 */

const CLI = fileURLToPath(new URL('../bin/agentbridge.mjs', import.meta.url));

function run(args, env, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], {
      env: hermeticEnv(env), cwd, windowsHide: true, timeout: 120000,
    }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const git = (cwd, a) => new Promise((r) =>
  execFile('git', a, { cwd, windowsHide: true, timeout: 60000 }, (e, o) => r({ ok: !e, out: String(o).trim() })));

/** A registry with one agent that has a live session, and one that has none. */
const REGISTRY = `
lanes:
  - lane_id: agentbridge
    display_name: Bridge
    branch_patterns:
      - "b/*"
    worktrees:
      - "agentbridge-b"
    owned_paths:
      - "src/**"
    shared_paths:
      - "package.json"
    capabilities: []
    status: active

agents:
  - agent_id: code-b
    display_name: Worker B
  - agent_id: code-z
    display_name: Offline worker

sessions:
  - session_id: danny-win-f1
    agent_id: code-b
    repo_id: agentbridge
    worktree_id: agentbridge-b
    capacity: idle

assignments:
  - lane_id: agentbridge
    agent_id: code-b
`;

/** Registry where one agent has TWO live sessions — the ambiguity case. */
const AMBIGUOUS = REGISTRY.replace(
  '\nassignments:',
  `  - session_id: danny-win-f2
    agent_id: code-b
    repo_id: agentbridge
    worktree_id: agentbridge-b2
    capacity: idle

assignments:`,
);

async function fixture(t, registryText) {
  const root = await mkdtemp(path.join(tmpdir(), 'ab-to-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await git(root, ['init', '-q', 'repo']);
  await git(repo, ['config', 'user.email', 't@e.com']);
  await git(repo, ['config', 'user.name', 'T']);
  await writeFile(path.join(repo, 'f.txt'), 'x\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'first']);
  const regFile = path.join(root, 'registry.yml');
  if (registryText) await writeFile(regFile, registryText, 'utf8');
  return { root, repo, regFile, env: { AGENTBRIDGE_HOME: path.join(root, 'home') } };
}

const argsFor = (id, to, extra = []) => [
  'delegate', '--id', id, '--from', 'lead', '--to', to, '--task', 'a bounded task', ...extra,
];

async function stored(env) {
  try { return JSON.parse(await readFile(path.join(env.AGENTBRIDGE_HOME, 'delegations.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

test('delegate: an unknown agent is REFUSED and nothing is stored', async (t) => {
  const { repo, regFile, env } = await fixture(t, REGISTRY);
  const r = await run(argsFor('d-x', 'nobody-at-all', ['--registry-file', regFile]), env, repo);
  assert.equal(r.code, 2, `expected refusal: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /unknown-agent/);
  assert.deepEqual(await stored(env), []);
});

test('delegate: a known agent with NO live session is refused', async (t) => {
  // code-z exists but is not running. "Exists" is not "reachable".
  const { repo, regFile, env } = await fixture(t, REGISTRY);
  const r = await run(argsFor('d-x', 'code-z', ['--registry-file', regFile]), env, repo);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no-live-session/);
  assert.deepEqual(await stored(env), []);
});

test('delegate: an OFFLINE session is not a live one', async (t) => {
  // Distinct from code-z, which has no session at all. This is a registered
  // runtime that is explicitly down, and it must not be a delegation target.
  //
  // Written because the mutation "let an offline session count as live" came
  // back GREEN: every case in this file used an absent session, so nothing
  // exercised the capacity filter. A suite that cannot fail on a guard is not
  // testing it.
  const offline = REGISTRY.replace('    capacity: idle', '    capacity: offline');
  const { repo, root, env } = await fixture(t, null);
  const regFile = path.join(root, 'offline.yml');
  await writeFile(regFile, offline, 'utf8');
  const r = await run(argsFor('d-off', 'code-b', ['--registry-file', regFile]), env, repo);
  assert.equal(r.code, 2, `an offline session accepted a delegation: ${r.stdout}`);
  assert.match(r.stderr, /no-live-session/);
  assert.deepEqual(await stored(env), []);
});

test('delegate: a resolvable agent IS accepted — the guard is not refusing everything', async (t) => {
  const { repo, regFile, env } = await fixture(t, REGISTRY);
  const r = await run(argsFor('d-ok', 'code-b', ['--registry-file', regFile]), env, repo);
  assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
  const rows = await stored(env);
  assert.equal(rows.length, 1);
  // A person names the durable agent; the ledger records the runtime.
  assert.equal(rows[0].assigned_session, 'danny-win-f1');
});

test('delegate: naming the live session directly also resolves', async (t) => {
  const { repo, regFile, env } = await fixture(t, REGISTRY);
  const r = await run(argsFor('d-sess', 'danny-win-f1', ['--registry-file', regFile]), env, repo);
  assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
  assert.equal((await stored(env))[0].assigned_session, 'danny-win-f1');
});

test('delegate: two live sessions for one agent refuse AND name the candidates', async (t) => {
  // Silently picking the newest would "work" and send the contract to the
  // wrong runtime — the exact failure the registry exists to prevent.
  const { repo, regFile, env } = await fixture(t, AMBIGUOUS);
  const r = await run(argsFor('d-amb', 'code-b', ['--registry-file', regFile]), env, repo);
  assert.equal(r.code, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /ambiguous-session/);
  assert.match(r.stderr, /danny-win-f1/);
  assert.match(r.stderr, /danny-win-f2/);
  assert.deepEqual(await stored(env), []);
});

test('delegate: NO registry warns loudly but does not silently verify nothing', async (t) => {
  // Refusing outright would break every machine without a registry; accepting
  // in silence would make the check vanish exactly where none is configured.
  // The wording moved when runtime self-registration landed: the message now
  // names BOTH sources it tried (live registrations, then a lane file) and
  // states the provenance it recorded. The behaviour under test is unchanged --
  // accept, but loudly, and never silently as if verified.
  const { repo, env } = await fixture(t, null);
  const r = await run(argsFor('d-nowarn', 'whoever'), env, repo);
  assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /no live registrations and no lane registry/);
  assert.match(r.stderr, /NOT verified/);
  assert.match(r.stderr, /legacy-unverified/);
  const row = (await stored(env))[0];
  assert.equal(row.assigned_session, 'whoever');
  // And the contract must carry that provenance, not merely mention it.
  assert.equal(row.target_verification, 'legacy-unverified');
});

test('delegate: a MALFORMED registry refuses — it is not treated as absent', async (t) => {
  // A typo must not disable identity checking wholesale.
  const { repo, root, env } = await fixture(t, null);
  const bad = path.join(root, 'bad.yml');
  await writeFile(bad, 'lanes: [ this is not valid\n', 'utf8');
  const r = await run(argsFor('d-bad', 'code-b', ['--registry-file', bad]), env, repo);
  assert.equal(r.code, 2, `a broken registry was treated as no registry: ${r.stdout}`);
  assert.deepEqual(await stored(env), []);
});

test('workers: prints the pool, so capacity is read from state not from folders', async (t) => {
  const { repo, regFile, env } = await fixture(t, REGISTRY);
  const r = await run(['workers', '--registry-file', regFile, '--json'], env, repo);
  assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
  const roster = JSON.parse(r.stdout);
  const b = roster.find((w) => w.agent_id === 'code-b');
  assert.equal(b.sessions[0].session_id, 'danny-win-f1');
  assert.equal(b.sessions[0].capacity, 'idle');
  // code-z is offline/sessionless and must show as having none, not be hidden.
  const z = roster.find((w) => w.agent_id === 'code-z');
  assert.deepEqual(z.sessions, []);
});

test('workers: an empty LIVE registry is a real answer, not a blind one', async (t) => {
  /*
   * THE SOURCE OF TRUTH CHANGED, SO THIS TEST'S MEANING DID.
   *
   * It used to assert that `workers` refuses when no lane FILE is configured,
   * because a missing file meant the command could not see anything. Now the
   * pool comes from runtime self-registration, and an empty registry is a
   * genuine, checkable fact: nobody has registered.
   *
   * The original intent -- "no workers" and "I cannot see the workers" must not
   * render the same -- is unchanged and now lives where the blindness actually
   * occurs: a hosted registry that is configured and failing still exits 2
   * rather than printing a partial pool. That is asserted in
   * test/hostedRegistry.test.mjs and in the delegate path.
   */
  const { repo, env } = await fixture(t, null);
  const r = await run(['workers'], env, repo);
  assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /no workers registered/);
  // And it must say how to fix that, rather than leaving an empty pool to be
  // read as a broken tool.
  assert.match(r.stdout, /register-session/);
});
