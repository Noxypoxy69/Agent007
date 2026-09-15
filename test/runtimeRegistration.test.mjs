import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THE LOOP CLOSED: registration writes, delegation resolves against it.
 *
 * liveRegistry.test.mjs proves the DERIVATION is right. This proves the write
 * path exists and that `delegate --to` actually consults it -- the difference
 * between a correct rule and an applied one, which is the distinction this
 * project keeps rediscovering.
 *
 * WHAT A WORKER MAY DECLARE. Its durable agent_id and its own session_id, since
 * only it knows those. Everything locating it -- repo_id, worktree_id, head_sha
 * -- is derived from git in the registering process and cannot be passed as a
 * flag. That is what stops an agent claiming to work in a repository it is not
 * in and thereby making itself the resolution target for work there.
 */

const CLI = fileURLToPath(new URL('../bin/agentbridge.mjs', import.meta.url));

function run(args, env, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env }, cwd, windowsHide: true, timeout: 120000,
    }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const git = (cwd, a) => new Promise((r) =>
  execFile('git', a, { cwd, windowsHide: true, timeout: 60000 }, (e, o) => r({ ok: !e, out: String(o).trim() })));

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'ab-reg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'agentbridge-b');
  await git(root, ['init', '-q', 'agentbridge-b']);
  await git(repo, ['config', 'user.email', 't@e.com']);
  await git(repo, ['config', 'user.name', 'T']);
  await writeFile(path.join(repo, 'f.txt'), 'x\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'first']);
  return { root, repo, env: { AGENTBRIDGE_HOME: path.join(root, 'home') } };
}

const regs = async (env) => {
  try {
    return JSON.parse(await readFile(path.join(env.AGENTBRIDGE_HOME, 'registrations.json'), 'utf8'));
  } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
};

const dels = async (env) => {
  try {
    return JSON.parse(await readFile(path.join(env.AGENTBRIDGE_HOME, 'delegations.json'), 'utf8'));
  } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
};

const delegate = (to, extra = []) =>
  ['delegate', '--id', `d-${to}`, '--from', 'lead', '--to', to, '--task', 'a bounded task', ...extra];

test('a worker registers and APPEARS — no file was edited', async (t) => {
  const { repo, env } = await fixture(t);
  const r = await run(['register-session', '--agent', 'code-b', '--session', 'sess-1'], env, repo);
  assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);

  const rows = await regs(env);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agent_id, 'code-b');
  assert.equal(rows[0].session_id, 'sess-1');
  assert.equal(rows[0].verification, 'runtime-self-registration');
  assert.ok(rows[0].heartbeat_at, 'no heartbeat was stamped');
  assert.match(rows[0].head_sha, /^[0-9a-f]{40}$/, 'head_sha was not derived from git');
  assert.equal(rows[0].repo_id, 'agentbridge-b', 'repo_id was not derived from the worktree');
});

test('repo, worktree and head are DERIVED — flags cannot override them', async (t) => {
  // The teeth. If a worker could pass --repo-id it could make itself the
  // resolution target for work in a repository it is not in.
  const { repo, env } = await fixture(t);
  await run(['register-session', '--agent', 'code-b', '--session', 'sess-1',
    '--repo-id', 'some-other-repo', '--head-sha', 'f'.repeat(40)], env, repo);

  const row = (await regs(env))[0];
  assert.equal(row.repo_id, 'agentbridge-b', 'a flag overrode the derived repo');
  assert.notEqual(row.head_sha, 'f'.repeat(40), 'a flag overrode the derived head');
});

test('registering from a non-git directory REFUSES', async (t) => {
  const { root, env } = await fixture(t);
  const bare = path.join(root, 'not-a-repo');
  await mkdir(bare, { recursive: true });
  const r = await run(['register-session', '--agent', 'code-b', '--session', 's'], env, bare);
  assert.equal(r.code, 2);
  assert.deepEqual(await regs(env), []);
});

test('session_id is required and is NOT derived from agent_id', async (t) => {
  const { repo, env } = await fixture(t);
  const r = await run(['register-session', '--agent', 'code-b'], env, repo);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /NOT derived/);
  assert.deepEqual(await regs(env), []);
});

test('a heartbeat REPLACES that session and touches no other', async (t) => {
  const { repo, env } = await fixture(t);
  await run(['register-session', '--agent', 'code-b', '--session', 'sess-1'], env, repo);
  await run(['register-session', '--agent', 'code-c', '--session', 'sess-2'], env, repo);
  const first = await regs(env);

  await run(['register-session', '--agent', 'code-b', '--session', 'sess-1', '--capacity', 'busy'], env, repo);
  const after = await regs(env);

  assert.equal(after.length, 2, 'a heartbeat created a duplicate row');
  assert.equal(after.find((r) => r.session_id === 'sess-1').capacity, 'busy');
  // The other worker's row is untouched.
  assert.deepEqual(
    after.find((r) => r.session_id === 'sess-2'),
    first.find((r) => r.session_id === 'sess-2'),
  );
});

test('delegate --to RESOLVES through the live registry and stamps verified', async (t) => {
  const { repo, env } = await fixture(t);
  await run(['register-session', '--agent', 'code-b', '--session', 'sess-1'], env, repo);

  const r = await run(delegate('code-b'), env, repo);
  assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /target verified/);

  const d = (await dels(env))[0];
  assert.equal(d.assigned_session, 'sess-1', 'the durable agent id was stored instead of the runtime session');
  assert.equal(d.target_verification, 'verified');
});

test('an UNKNOWN agent is refused once anything is registered', async (t) => {
  const { repo, env } = await fixture(t);
  await run(['register-session', '--agent', 'code-b', '--session', 'sess-1'], env, repo);

  const r = await run(delegate('nobody-at-all'), env, repo);
  assert.equal(r.code, 2, `an unknown agent was accepted: ${r.stdout}`);
  assert.match(r.stderr, /LIVE registry/);
  assert.deepEqual(await dels(env), []);
});

test('AMBIGUOUS live sessions refuse and name both', async (t) => {
  const { repo, env } = await fixture(t);
  await run(['register-session', '--agent', 'code-b', '--session', 'sess-1'], env, repo);
  await run(['register-session', '--agent', 'code-b', '--session', 'sess-2'], env, repo);

  const r = await run(delegate('code-b'), env, repo);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /ambiguous-session/);
  assert.match(r.stderr, /sess-1/);
  assert.match(r.stderr, /sess-2/);
  assert.deepEqual(await dels(env), []);
});

test('a DECLARED-OFFLINE worker is refused', async (t) => {
  /*
   * ASSERTS THE REFUSAL, NOT ONE LAYER'S WORDING.
   *
   * Three independent protections can refuse this, and which one speaks first
   * depends on which is intact:
   *
   *   isLive          marks a declared-offline session offline
   *   resolveWorker   filters capacity 'offline' out of the candidates
   *   the CLI         re-checks isLive against the registration row
   *
   * An earlier version matched /no-live-session/ specifically, which is
   * resolveWorker's wording. Breaking resolveWorker alone then read as "the
   * system let it through" when the CLI had in fact refused it in different
   * words -- a measurement that conflated "refused" with "refused by the layer
   * I happened to name". The redundancy harness depends on this test, so it
   * asserts the OUTCOME: refused, and nothing recorded.
   */
  const { repo, env } = await fixture(t);
  await run(['register-session', '--agent', 'code-b', '--session', 'sess-1',
    '--capacity', 'offline'], env, repo);

  const r = await run(delegate('code-b'), env, repo);
  assert.equal(r.code, 2, `a worker that declined work was given some: ${r.stdout}`);
  assert.match(r.stderr, /no-live-session|not live/,
    'refused, but for a reason unrelated to liveness');
  assert.deepEqual(await dels(env), [], 'a contract was recorded for an offline worker');
});

test('a STALE registration ages offline and is refused', async (t) => {
  const { repo, env } = await fixture(t);
  await run(['register-session', '--agent', 'code-b', '--session', 'sess-1'], env, repo);

  // Age the heartbeat past the window by editing the store directly — the CLI
  // stamps the clock itself and deliberately offers no way to backdate it.
  const file = path.join(env.AGENTBRIDGE_HOME, 'registrations.json');
  const rows = JSON.parse(await readFile(file, 'utf8'));
  rows[0].heartbeat_at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await writeFile(file, JSON.stringify(rows, null, 2), 'utf8');

  const r = await run(delegate('code-b'), env, repo);
  assert.equal(r.code, 2, `a dead session accepted a contract: ${r.stdout}`);
  assert.match(r.stderr, /no-live-session/);
});

test('with NOTHING registered the target is legacy-unverified, never verified', async (t) => {
  /*
   * The path must survive -- refusing here would break every machine on its
   * first run, before anything has registered. What changes is that it no
   * longer pretends: the contract is stamped, and says so on the way past.
   */
  const { repo, env } = await fixture(t);
  const r = await run(delegate('whoever'), env, repo);
  assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /NOT verified/);
  assert.match(r.stderr, /legacy-unverified/);

  const d = (await dels(env))[0];
  assert.equal(d.target_verification, 'legacy-unverified');
  assert.equal(d.assigned_session, 'whoever');
});

test('a legacy contract is NOT promoted when registration later arrives', async (t) => {
  // The provenance rule. Recording a verified contract afterwards must not
  // retroactively bless the one recorded while nothing was registered.
  const { repo, env } = await fixture(t);
  await run(delegate('code-b'), env, repo);
  assert.equal((await dels(env))[0].target_verification, 'legacy-unverified');

  await run(['register-session', '--agent', 'code-b', '--session', 'sess-1'], env, repo);
  await run(['delegate', '--id', 'd-second', '--from', 'lead', '--to', 'code-b',
    '--task', 'another bounded task'], env, repo);

  const rows = await dels(env);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].target_verification, 'legacy-unverified',
    'the earlier contract was silently upgraded');
  assert.equal(rows[1].target_verification, 'verified');
});

test('NO .example.yml is needed for normal operation', async (t) => {
  // The ruling in one assertion: register, delegate, resolve — no file anywhere.
  const { repo, env } = await fixture(t);
  await run(['register-session', '--agent', 'code-b', '--session', 'sess-1'], env, repo);
  const r = await run(delegate('code-b'), env, repo);
  assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
  assert.doesNotMatch(r.stderr, /registry-file|lanesFile/);
});

test('a corrupt registration store STOPS, rather than falling back to unverified', async (t) => {
  // A broken machine must not become a permissive one.
  const { repo, env } = await fixture(t);
  await mkdir(env.AGENTBRIDGE_HOME, { recursive: true });
  await writeFile(path.join(env.AGENTBRIDGE_HOME, 'registrations.json'), '{"not":"an array"}', 'utf8');

  const r = await run(delegate('code-b'), env, repo);
  assert.equal(r.code, 2, `a corrupt registry downgraded to the unverified path: ${r.stdout}`);
  assert.match(r.stderr, /registration store/);
});

test('--watch KEEPS RUNNING and actually refreshes the heartbeat', async (t) => {
  /*
   * THE ONLY TEST HERE THAT HAD TO BE RUN RATHER THAN REASONED ABOUT.
   *
   * --watch failed three separate ways on 2026-09-15, and every one of them
   * looked like success for the first interval:
   *
   *   1. the interval was unref'd, so node exited at once with "Detected
   *      unsettled top-level await". The command printed "refreshing every
   *      120s" and was already dead.
   *   2. replacing the parking await with `return` is a syntax error at module
   *      top level -- Illegal return statement.
   *   3. dropping the await entirely let execution fall THROUGH the block into
   *      the rest of the dispatch, reaching the unknown-command handler, which
   *      printed the help text and exited 2. After registering, so the store
   *      looked right.
   *
   * None is visible in under one interval, and all three leave a registration
   * on disk. A worker whose heartbeat silently stops ages offline in ten
   * minutes and its contracts start resolving to nobody, which is the exact
   * failure this flag exists to prevent.
   *
   * So this spawns the real binary and watches a real clock.
   */
  const { repo, env } = await fixture(t);
  const { spawn } = await import('node:child_process');

  const child = spawn(process.execPath, [
    CLI, 'register-session', '--agent', 'code-w', '--session', 'watch-probe',
    '--watch', '--interval', '5',
  ], { env: { ...process.env, ...env }, cwd: repo, windowsHide: true });

  let out = '';
  child.stdout.on('data', (d) => { out += String(d); });
  child.stderr.on('data', (d) => { out += String(d); });

  /*
   * SIGKILL, and release the pipes.
   *
   * A graceful kill() is SIGTERM, which this CLI handles by deregistering and
   * exiting -- correct in production and wrong here, because Windows does not
   * deliver it the way POSIX does and the runner then waits forever on a child
   * that never left. The piped stdio are themselves live handles, so they are
   * destroyed too; otherwise the test process stays open on a dead child's
   * streams. An earlier version of this test hung for five minutes for exactly
   * that reason.
   */
  t.after(() => {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    try { child.stdout.destroy(); child.stderr.destroy(); } catch { /* already closed */ }
    child.unref();
  });

  const readBeat = async () => {
    const rows = await regs(env);
    return rows[0]?.heartbeat_at ?? null;
  };
  const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

  await wait(3000);
  const first = await readBeat();
  assert.ok(first, `nothing was registered: ${out}`);

  // Past one interval. If the process died, this is unchanged.
  await wait(8000);
  const second = await readBeat();

  assert.ok(child.exitCode === null, `the watcher exited early (code ${child.exitCode}): ${out}`);
  assert.notEqual(second, first, `the heartbeat never refreshed — the watcher is not alive: ${out}`);
  assert.ok(Date.parse(second) > Date.parse(first), 'the heartbeat went backwards');

  // And the failure mode that printed help instead of watching.
  assert.doesNotMatch(out, /unknown command/, 'execution fell through the watch block');
  assert.doesNotMatch(out, /unsettled top-level await/, 'the event loop was not held open');

  /*
   * STOP THE CHILD AND WAIT FOR IT, HERE, BEFORE THE FIXTURE CLEANS UP.
   *
   * The watcher's cwd is the temp repo, and Windows refuses to rmdir a
   * directory that is any live process's working directory. Leaving this to
   * t.after raced the fixture's own cleanup and failed the test with EBUSY
   * after every assertion had already passed -- a green test reported red by
   * its teardown.
   */
  await new Promise((resolve) => {
    if (child.exitCode !== null) { resolve(); return; }
    child.once('exit', resolve);
    child.kill('SIGKILL');
  });
});

test('unregister removes only that session', async (t) => {
  const { repo, env } = await fixture(t);
  await run(['register-session', '--agent', 'code-b', '--session', 'sess-1'], env, repo);
  await run(['register-session', '--agent', 'code-c', '--session', 'sess-2'], env, repo);

  await run(['unregister-session', '--session', 'sess-1'], env, repo);
  const rows = await regs(env);
  assert.deepEqual(rows.map((r) => r.session_id), ['sess-2']);

  // And the departed worker can no longer be delegated to.
  const r = await run(delegate('code-b'), env, repo);
  assert.equal(r.code, 2);
});
