import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermeticEnv } from './helpers/hermeticEnv.mjs';

/**
 * A COMMAND THAT PRINTS THE RIGHT ANSWER AND THEN DIES IS A FAILED COMMAND.
 *
 * register-session published its row, printed "hosted published", and then
 * called process.exit(0) -- which, after a fetch, trips a libuv assertion on
 * Windows:
 *
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:94
 *
 * The process died with 127. Every caller checking an exit code saw a failure
 * that had not happened, and the --watch shutdown path -- whose entire job is
 * to deregister -- crashed before it could finish doing so, which is what made
 * clean shutdown untestable. src/hostedRegistry.mjs has documented this exact
 * assertion since the day `workers` hit it; register-session simply never got
 * the same treatment, because nothing checked its exit code.
 *
 * 655 tests were green through the whole of it. They had to be: every one of
 * them asserts on stdout or on a file, and the output was CORRECT. The bug
 * lived entirely in what the process did on its way out.
 *
 * READ THIS BEFORE TRUSTING THE BEHAVIOURAL TESTS BELOW.
 *
 * They do NOT reproduce the crash, and it would be easy to believe they do.
 * The first version of this file asserted an exit code against a local HTTP
 * server and went green -- then went green again with the bug deliberately put
 * back. It was decoration. Measured, on the machine that had just produced a
 * real 127:
 *
 *   register-session -> real remote endpoint          exit 127, assertion fires
 *   register-session -> http://127.0.0.1:PORT         exit 0
 *   register-session -> https://127.0.0.1:PORT (TLS)  exit 0
 *   register-session -> http://localhost:PORT         exit 0
 *
 * So neither a real fetch, nor pooled sockets, nor TLS is sufficient. The
 * assertion lives in src\win\async.c -- libuv's threadpool signalling -- and
 * only a genuinely remote lookup and connection gets there. A hermetic test
 * cannot have one, and a test that reached the live Supabase function would be
 * a credentialed network call pretending to be a unit test.
 *
 * THEREFORE the regression is guarded STRUCTURALLY, by the last test in this
 * file, which reads the shipped source and asserts the exit discipline. That is
 * weaker than watching it crash and it is stated as such -- but it is the
 * assertion that actually goes red when the bug returns, which is the only
 * property that matters in a gate.
 *
 * The behavioural tests stay because they guard the OTHER ways this block can
 * break -- falling through to the help text, or publishing before validating --
 * and because the contrast is the point: they are the shape of test that was
 * already here, and this bug walked straight past 655 of them.
 *
 * `posts.length` is asserted before every exit code: a test that checked only
 * the code would pass vacuously the moment the fetch stopped happening, and the
 * negative needs the positive first.
 */

const CLI = fileURLToPath(new URL('../bin/agentbridge.mjs', import.meta.url));

const git = (cwd, a) => new Promise((r) =>
  execFile('git', a, { cwd, windowsHide: true, timeout: 60000 }, (e, o) => r({ ok: !e, out: String(o).trim() })));

function run(args, env, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], {
      env: hermeticEnv(env), cwd, windowsHide: true, timeout: 120000,
    }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** A stand-in for the Edge Function: records what arrived, answers 200. */
async function registrar(t) {
  const posts = [];
  const waiters = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      posts.push({ method: req.method, auth: req.headers.authorization, body });
      /*
       * ANSWER ONLY AFTER THE BODY IS READ. Ending the response outside this
       * handler sends it before the request has been consumed, and 'end' may
       * then never fire -- so nothing is ever recorded and every waiter hangs.
       * That was a self-inflicted hang during this file's refactor, and it is
       * the same shape as the bugs being tested here: the observable part
       * (a 200 went out) looked right while the part that mattered never ran.
       */
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      // Wake anything waiting for an Nth publish, so a --watch test reacts to
      // the beat rather than sleeping for a guessed interval.
      for (const w of waiters.splice(0)) w();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));

  const waitFor = (n, ms = 30000) => new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`only ${posts.length} publish(es) after ${ms}ms`)), ms);
    const check = () => {
      if (posts.length >= n) { clearTimeout(deadline); resolve(); }
      else waiters.push(check);
    };
    check();
  });

  return { posts, waitFor, url: `http://127.0.0.1:${server.address().port}/register` };
}

/**
 * Stop a spawned watcher AND WAIT FOR IT TO BE GONE.
 *
 * On Windows a running process holds a lock on its own cwd, so removing the
 * fixture repo while the child is still dying fails with EBUSY:
 *
 *   EBUSY: resource busy or locked, rmdir '...\ab-exit-XXXX\agentbridge-x'
 *
 * kill() only ASKS. This waits for the answer, and each watcher test awaits it
 * in the body so the child is confirmed gone before any cleanup hook runs --
 * which is what actually fixes it, because fixture() registers its rm first and
 * hooks do not run in the order that would save us.
 *
 * It is also registered as an after-hook, for the case where an assertion
 * throws before the body reaches the await and the child would otherwise be
 * left running.
 */
const stopper = (child) => () => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve();
  child.once('exit', () => resolve());
  try { child.kill(); } catch { resolve(); }
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'ab-exit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'agentbridge-x');
  await git(root, ['init', '-q', 'agentbridge-x']);
  await git(repo, ['config', 'user.email', 't@e.com']);
  await git(repo, ['config', 'user.name', 'T']);
  await writeFile(path.join(repo, 'f.txt'), 'x\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'first']);
  return { root, repo, home: path.join(root, 'home') };
}

test('THE GATE: register-session must not call process.exit() after it has published', async () => {
  /*
   * The structural guard, and the only assertion here that goes red when the
   * real bug comes back. It reads the SHIPPED file rather than restating the
   * rule: a check that reconstructs what it is checking agrees with itself
   * through the exact regression it exists to catch.
   *
   * The rule: once hostedRegistry is imported, this command may have published,
   * so from that line to the end of the block there is no process.exit(). It
   * leaves through closeHttp() and a natural exit instead. Everything before
   * that import is pre-flight validation, which has published nothing and may
   * still exit however it likes.
   */
  const src = await readFile(CLI, 'utf8');

  // The anchor moved once already, when unregister-session was split out into
  // its own command. The gate refused to pass rather than quietly matching
  // nothing, which is the only reason that was noticed.
  const start = src.indexOf("if (cmd === 'register-session') {");
  assert.notEqual(start, -1, 'cannot find the register-session block — this gate needs rewriting, not deleting');
  const end = src.indexOf('\n  if (cmd === ', start + 10);
  assert.notEqual(end, -1, 'cannot find the end of the register-session block');
  const block = src.slice(start, end);

  const publishPoint = block.indexOf("await import('../src/hostedRegistry.mjs')");
  assert.notEqual(publishPoint, -1, 'register-session no longer imports hostedRegistry — has the write path moved?');

  const afterPublish = block.slice(publishPoint);
  const offenders = afterPublish
    .split('\n')
    .map((line, i) => [i, line])
    .filter(([, line]) => /process\.exit\s*\(/.test(line) && !/^\s*\*/.test(line));

  assert.deepEqual(offenders.map(([, l]) => l.trim()), [],
    'process.exit() after the publish point trips the libuv assertion on Windows '
    + '(src\\win\\async.c:94) and the command dies nonzero having done its job correctly. '
    + 'Use `await H.closeHttp(); handled = true;` and let node exit naturally.');

  // The positive: the discipline is actually present, not merely un-violated by
  // a block this gate failed to locate.
  assert.match(afterPublish, /await H\.closeHttp\(\);/);
  assert.match(afterPublish, /handled = true;/);

  /*
   * AND THE SHUTDOWN ORDER, for the same reason: nothing can execute it here.
   *
   * SIGINT cannot be delivered to a node process on Windows from outside its
   * console -- an external kill terminates it without ever running the handler,
   * which is measured and is itself one of the findings that produced this fix.
   * So stop() is unreachable from a test on this platform and its ordering is
   * asserted structurally or not at all.
   *
   * The order matters: a heartbeat landing between removeRegistration() and the
   * exit re-registers the session that was just removed, and the worker then
   * ages out ten minutes later looking as though it died rather than stopped.
   */
  const stopStart = block.indexOf('const stop = async () => {');
  assert.notEqual(stopStart, -1, 'the --watch shutdown handler has moved or gone');
  const stopBody = block.slice(stopStart, block.indexOf('};', stopStart));

  const cleared = stopBody.indexOf('clearInterval(timer)');
  const removed = stopBody.indexOf('removeRegistration');
  assert.notEqual(cleared, -1, 'stop() must clear the heartbeat timer');
  assert.ok(cleared < removed,
    'stop() must clear the heartbeat timer BEFORE deregistering, or a beat can re-register the row it just removed');
  assert.doesNotMatch(stopBody, /process\.exit\s*\(/,
    'stop() ends in a fetch; exiting explicitly there is the crash that made clean shutdown untestable');
});

test('register-session EXITS 0 after publishing, rather than crashing on the way out', async (t) => {
  const { repo, home } = await fixture(t);
  const { posts, url } = await registrar(t);

  const r = await run(
    ['register-session', '--agent', 'code-x', '--session', 'sess-x', '--lane', 'probe'],
    { AGENTBRIDGE_HOME: home, AGENTBRIDGE_REGISTRATION_TOKEN: 'test-token', AGENTBRIDGE_REGISTER_URL: url },
    repo,
  );

  // THE POSITIVE FIRST. Without a real request there are no pooled handles and
  // the exit-code assertion below proves nothing at all.
  assert.equal(posts.length, 1, `expected one publish, got ${posts.length}`);
  assert.equal(posts[0].method, 'POST');
  assert.equal(posts[0].auth, 'Bearer test-token');
  assert.match(r.stdout, /hosted\s+published/);

  // THE BUG. Correct output, nonzero exit.
  assert.equal(r.code, 0, `exited ${r.code} after a successful publish\n${r.stdout}\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /Assertion failed/);
});

test('the same command with no token takes the un-fetched path and still exits 0', async (t) => {
  /*
   * The control. This is the shape every other CLI test already runs, and it
   * passes with the bug present -- which is precisely why the bug survived a
   * suite this size. Keeping it here makes the difference between the two
   * visible rather than something a reader has to reconstruct.
   */
  const { repo, home } = await fixture(t);

  const r = await run(
    ['register-session', '--agent', 'code-x', '--session', 'sess-x'],
    { AGENTBRIDGE_HOME: home },
    repo,
  );

  assert.equal(r.code, 0);
  assert.match(r.stdout, /hosted\s+NOT CONFIGURED/);
});

test('a refusal still exits 2, and refusals happen before anything is published', async (t) => {
  /*
   * The exit path changed; the exit CODES must not have. A validation failure
   * is rejected before the registrar is contacted, so moving the successful
   * exit must not have moved a refusal onto the success path -- which would
   * report a rejected registration as a completed one.
   */
  const { repo, home } = await fixture(t);
  const { posts, url } = await registrar(t);

  const r = await run(
    ['register-session', '--agent', 'code-x'],
    { AGENTBRIDGE_HOME: home, AGENTBRIDGE_REGISTRATION_TOKEN: 'test-token', AGENTBRIDGE_REGISTER_URL: url },
    repo,
  );

  assert.equal(r.code, 2);
  assert.match(r.stderr, /--session <session_id> is required/);
  assert.equal(posts.length, 0, 'a refused registration must not have published anything');
});

test('unregister-session tells the HOSTED registry too, not just the local file', async (t) => {
  /*
   * It removed the local row and stopped. Hosted kept the session, so a worker
   * that deregistered deliberately went on looking idle to every other machine
   * until it aged out ten minutes later -- and a worker machine has no reader
   * token, so `workers` cannot see hosted state and nobody could notice.
   *
   * Observed on a real agent: code-d ran this, reported itself gone, and was
   * still in the hosted roster 36 minutes later. It was telling the truth about
   * what it had done; the command was not doing all of it.
   */
  const { repo, home } = await fixture(t);
  const { posts, url } = await registrar(t);
  const env = { AGENTBRIDGE_HOME: home, AGENTBRIDGE_REGISTRATION_TOKEN: 'test-token', AGENTBRIDGE_REGISTER_URL: url };

  const reg = await run(
    ['register-session', '--agent', 'code-x', '--session', 'sess-x', '--lane', 'probe'], env, repo);
  assert.equal(reg.code, 0);
  assert.equal(posts.length, 1, 'the registration must have published');

  const un = await run(['unregister-session', '--session', 'sess-x'], env, repo);

  assert.equal(un.code, 0, `unregister exited ${un.code}\n${un.stdout}\n${un.stderr}`);
  assert.match(un.stdout, /unregistered sess-x/);
  assert.equal(posts.length, 2, 'deregistering published nothing to the hosted registry');
  assert.equal(JSON.parse(posts[1].body).capacity, 'offline',
    'the hosted row must be marked offline, or other machines still see a live worker');
  assert.match(un.stdout, /hosted\s+marked offline/);
  // It must not have fallen through into the registration path looking for an
  // --agent the caller had no reason to pass.
  assert.doesNotMatch(un.stderr, /--agent/);
});

test('unregister-session with no local row publishes nothing and still exits 0', async (t) => {
  // Nothing to say and nobody to say it about. Publishing a fabricated offline
  // row for a session this machine never held would be inventing state.
  const { repo, home } = await fixture(t);
  const { posts, url } = await registrar(t);

  const r = await run(['unregister-session', '--session', 'never-existed'],
    { AGENTBRIDGE_HOME: home, AGENTBRIDGE_REGISTRATION_TOKEN: 'test-token', AGENTBRIDGE_REGISTER_URL: url }, repo);

  assert.equal(r.code, 0);
  assert.match(r.stdout, /no registration for never-existed/);
  assert.equal(posts.length, 0);
});

test('every heartbeat re-resolves HEAD, so the published sha follows the tree', async (t) => {
  /*
   * --watch republished the ORIGINAL row with nothing but a fresh timestamp, so
   * head_sha froze at whatever the tree was when the watcher started. Measured
   * live: the registry advertised code-c at d564569 while its worktree was
   * thirteen commits further on, and had been for hours. The heartbeat said "I
   * am alive" -- true -- and the head said "I am at d564569" -- false -- and
   * nothing in the row distinguished them.
   *
   * It matters beyond tidiness: canAssign compares a task's base_sha against
   * the tree it is going to, so a frozen head is an input to whether work may
   * be handed out at all.
   *
   * This test commits BETWEEN two beats, which is the only way to tell a sha
   * that is re-read from one that merely happens to still be correct.
   */
  const { repo, home } = await fixture(t);
  const { posts, waitFor, url } = await registrar(t);

  const before = (await git(repo, ['rev-parse', 'HEAD'])).out;

  const child = spawn(process.execPath, [
    CLI, 'register-session', '--agent', 'code-x', '--session', 'sess-x',
    '--watch', '--interval', '5',
  ], {
    env: hermeticEnv({
      AGENTBRIDGE_HOME: home,
      AGENTBRIDGE_REGISTRATION_TOKEN: 'test-token',
      AGENTBRIDGE_REGISTER_URL: url,
    }),
    cwd: repo,
    windowsHide: true,
    // 'ignore', not the default 'pipe'. An unread pipe to a child that never
    // exits keeps the test runner alive after the assertions are done, which
    // looks exactly like a hung test and is not one.
    stdio: 'ignore',
  });
  const stop = stopper(child);
  t.after(stop);

  await waitFor(1);
  assert.equal(JSON.parse(posts[0].body).head_sha, before, 'the first publish should carry the tree as it was');

  // Move the tree while the watcher is running.
  await writeFile(path.join(repo, 'second.txt'), 'moved\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'second']);
  const after = (await git(repo, ['rev-parse', 'HEAD'])).out;
  assert.notEqual(after, before, 'the fixture must actually have moved, or this test proves nothing');

  await waitFor(2);
  await stop();

  assert.equal(JSON.parse(posts[1].body).head_sha, after,
    'the second heartbeat published a stale head: --watch is re-sending the sha it started with');
});

test('when git cannot answer, the heartbeat publishes NULL rather than the last known sha', async (t) => {
  /*
   * The other half of the same fix, and the one that is easy to get wrong in a
   * way that looks careful: on failure, re-sending the sha from startup is
   * "keeping the last known good value", which is precisely the frozen head
   * being fixed -- reintroduced at the exact moment the tree is least knowable.
   *
   * null reads as unknown, which is what the server instructions already tell
   * every client to do with a null, and the worker is still plainly alive so
   * the beat itself must continue.
   */
  const { repo, home } = await fixture(t);
  const { posts, waitFor, url } = await registrar(t);

  const child = spawn(process.execPath, [
    CLI, 'register-session', '--agent', 'code-x', '--session', 'sess-x',
    '--watch', '--interval', '5',
  ], {
    env: hermeticEnv({
      AGENTBRIDGE_HOME: home,
      AGENTBRIDGE_REGISTRATION_TOKEN: 'test-token',
      AGENTBRIDGE_REGISTER_URL: url,
    }),
    cwd: repo,
    windowsHide: true,
    // stderr is PIPED here, unlike the other watcher tests: the warning is half
    // of the behaviour under test, not incidental output.
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const stop = stopper(child);
  t.after(stop);

  let errors = '';
  child.stderr.on('data', (c) => { errors += c; });

  await waitFor(1);
  assert.ok(JSON.parse(posts[0].body).head_sha, 'the first publish must carry a real sha, or this proves nothing');

  // Take git away underneath the running watcher.
  await rm(path.join(repo, '.git'), { recursive: true, force: true });

  await waitFor(2);
  await stop();

  assert.equal(JSON.parse(posts[1].body).head_sha, null,
    'a heartbeat that cannot read HEAD re-sent the startup sha instead of admitting it does not know');

  // AND IT MUST SAY SO. Publishing null silently leaves the operator with a
  // registry that has quietly stopped knowing where a worker is, and no moment
  // at which anyone could have noticed.
  assert.match(errors, /cannot read HEAD/);
  assert.match(errors, /rather than a stale one/);
});

test('--repo decides which tree is published, not the directory the CLI was run from', async (t) => {
  /*
   * NOT HYPOTHETICAL. code-d runs the CLI out of code-c's worktree with --repo
   * pointing at social-sparks-app, which is what --repo is for. If the
   * heartbeat re-resolved process.cwd() instead of the registered repo, its row
   * would advertise the sha of a repository it is not working in -- and it
   * would look perfectly healthy while doing it.
   *
   * The two-repo fixture is the point: with one repo, cwd and --repo are the
   * same directory and the bug is invisible.
   */
  const { root, repo, home } = await fixture(t);
  const { posts, waitFor, url } = await registrar(t);

  // A second, DIFFERENT repository to run the command from.
  const elsewhere = path.join(root, 'somewhere-else');
  await git(root, ['init', '-q', 'somewhere-else']);
  await git(elsewhere, ['config', 'user.email', 't@e.com']);
  await git(elsewhere, ['config', 'user.name', 'T']);
  await writeFile(path.join(elsewhere, 'other.txt'), 'different\n');
  await git(elsewhere, ['add', '-A']);
  await git(elsewhere, ['commit', '-q', '-m', 'elsewhere']);

  const wanted = (await git(repo, ['rev-parse', 'HEAD'])).out;
  const notWanted = (await git(elsewhere, ['rev-parse', 'HEAD'])).out;
  assert.notEqual(wanted, notWanted, 'the two fixtures must differ, or this proves nothing');

  const child = spawn(process.execPath, [
    CLI, 'register-session', '--agent', 'code-x', '--session', 'sess-x',
    '--repo', repo, '--watch', '--interval', '5',
  ], {
    env: hermeticEnv({
      AGENTBRIDGE_HOME: home,
      AGENTBRIDGE_REGISTRATION_TOKEN: 'test-token',
      AGENTBRIDGE_REGISTER_URL: url,
    }),
    cwd: elsewhere,          // run from the OTHER repository
    windowsHide: true,
    stdio: 'ignore',
  });
  const stop = stopper(child);
  t.after(stop);

  // Both the first publish and a later heartbeat must name the registered repo.
  await waitFor(2);
  await stop();

  for (const [i, p] of posts.slice(0, 2).entries()) {
    assert.equal(JSON.parse(p.body).head_sha, wanted,
      `publish ${i} carried the sha of the directory the CLI was run from, not --repo`);
  }
});

test('a bad --interval is refused BEFORE the row is published, not after', async (t) => {
  /*
   * The second instance of the same bug, found by the structural gate above.
   *
   * --interval was validated inside the watch block, which runs after the first
   * beat() has already posted. So this command published the registration,
   * THEN refused -- exiting nonzero from a process that had just fetched, and
   * leaving behind a published row that nothing would ever refresh. A worker
   * that was told its arguments were wrong was nevertheless in the roster,
   * looking idle, for the full ten minutes until it aged out.
   *
   * Both halves are asserted: the refusal, and the silence.
   */
  const { repo, home } = await fixture(t);
  const { posts, url } = await registrar(t);

  const r = await run(
    ['register-session', '--agent', 'code-x', '--session', 'sess-x', '--watch', '--interval', '1'],
    { AGENTBRIDGE_HOME: home, AGENTBRIDGE_REGISTRATION_TOKEN: 'test-token', AGENTBRIDGE_REGISTER_URL: url },
    repo,
  );

  assert.equal(r.code, 2);
  assert.match(r.stderr, /--interval must be at least 5 seconds/);
  assert.equal(posts.length, 0, 'the row was published before the interval was checked');
  assert.doesNotMatch(r.stdout, /registered/);
});
