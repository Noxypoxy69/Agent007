import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  workerConfig, parseArgs, worktreePath, taskBrief, runWorker,
  DEFAULT_RUN_TIMEOUT_MS, MIN_RUN_TIMEOUT_MS, MAX_RUN_TIMEOUT_MS,
} from '../src/worker.mjs';

/**
 * THE LOOP ACTUALLY CLOSES — walked end to end, with the world faked.
 *
 * `max_attempt 0`, `outbox 0 rows`, `538 proposals -> 0 confirmed`. Nothing has
 * ever moved through this system, and the reason was that this component did
 * not exist. So the assertion that matters most here is not a refusal: it is
 * that a task goes in one end and a return comes out the other.
 *
 * Every effect is injected. That is what lets the DANGEROUS cycles be exercised
 * -- a lease dying mid-run, a renewal refused -- which is exactly what a runtime
 * built around its own I/O could never test without killing a real lease on a
 * real task.
 *
 * (Named workerRuntime rather than worker because test/worker.test.mjs already
 * exists and covers the edge-side tool adaptation. Two files, two subjects.)
 */

const NOW0 = Date.parse('2026-09-16T03:00:00.000Z');
const iso = (t) => new Date(t).toISOString();

const ENV = {
  AGENTBRIDGE_WORKER_CMD: 'run-the-agent',
  AGENTBRIDGE_WORKTREE_ROOT: 'C:/wt',
  AGENTBRIDGE_WAIT_URL: 'https://x.invalid/wait',
  AGENTBRIDGE_RETURN_URL: 'https://x.invalid/return',
  AGENTBRIDGE_REGISTRATION_TOKEN: 'g'.repeat(40),
};

const TASK = {
  task_id: 't1', state: 'assigned', assigned_session: 's-me',
  title: 'Fix the thing', base_sha: 'b'.repeat(40), repo_id: 'agentbridge',
  allowed_paths: ['src/a.mjs'], lease_token: 'tok-1',
  leased_at: iso(NOW0), lease_expires_at: iso(NOW0 + 15 * 60_000),
};

/** A fake world. Each test overrides only the part it is about. */
function world(over = {}) {
  const calls = { returned: [], started: [], briefs: [], renewed: [], cleaned: [], log: [] };
  const deps = {
    now: () => iso(NOW0),
    // HONOURS `since`, because the real /wait does. A fake that re-delivers
    // forever hides a missing cursor -- which is exactly what it did on the
    // first run of this file, and the end-to-end test caught it by returning
    // the same task three times.
    waitForEvents: async ({ since } = {}) => (since ? [] : [{
      kind: 'assigned', task_id: 't1', lease_token: 'tok-1', at: iso(NOW0),
    }]),
    readTask: async () => ({ ...TASK }),
    prepareWorktree: async () => ({ ok: true }),
    // The BRIEF is captured, not just the command. A mutation building it from
    // the whole worker object put a live lease token into the agent's prompt
    // and every test stayed green, because nothing looked at what was passed.
    startRun: async (a) => { calls.started.push(a.cmd); calls.briefs.push(a.brief); return { done: false }; },
    pollRun: async () => ({ done: true, ok: true, notes: 'all green' }),
    renewLease: async () => { calls.renewed.push(1); return { ok: true, lease_expires_at: iso(NOW0 + 60 * 60_000) }; },
    returnWork: async (b) => { calls.returned.push(b); return { state: 'ok' }; },
    headSha: async () => 'c'.repeat(40),
    cleanupWorktree: async (d) => { calls.cleaned.push(d); },
    pausedTaskIds: async () => [],
    log: (a, r) => calls.log.push(`${a}:${r}`),
    ...over,
  };
  return { deps, calls };
}

/**
 * A clock that AGES FAST ENOUGH TO REACH THE BRANCH UNDER TEST.
 *
 * The first version stepped a minute per read. The fixture lease is 15 minutes
 * and renewal fires at a third remaining, so renewal was never reached inside
 * the cycle budget and three tests failed reporting "renewal was attempted 0
 * times" -- which reads exactly like a driver that never renews. It was the
 * clock.
 *
 * Worth the paragraph: a fixture that cannot reach the branch it is named after
 * is the same defect as a fixture that builds a state the system never
 * produces. Both fail, or pass, for reasons unrelated to the property.
 */
function ageing(deps, stepMs = 5 * 60_000) {
  let t = NOW0;
  deps.now = () => { t += stepMs; return iso(t); };
  return deps;
}

const run = (deps, cycles = 12) =>
  runWorker({ config: workerConfig(ENV).config, session_id: 's-me', agent_id: 'code-b' }, deps,
    { maxCycles: cycles });

// ── THE THING THAT HAS NEVER HAPPENED ──────────────────────────────────────

test('A TASK GOES IN AND A RETURN COMES OUT — the whole point', async () => {
  /*
   * The positive control, and here it is the headline rather than the
   * afterthought. Every refusal below is worthless if this does not hold: a
   * runtime that only ever declines to act is the state the system was already
   * in, with more code in it.
   */
  const { deps, calls } = world();
  const out = await run(deps);

  assert.equal(calls.returned.length, 1, 'nothing was ever returned');
  assert.deepEqual(calls.returned[0], {
    task_id: 't1',
    session_id: 's-me',
    lease_token: 'tok-1',
    head_sha: 'c'.repeat(40),
    outcome: 'completed',
    notes: 'all green',
  });
  assert.equal(out.done[0].outcome, 'completed');
  assert.deepEqual(calls.cleaned, ['C:/wt/t1'], 'the worktree was left behind');
});

test('THE COMMIT IS READ FROM THE WORKTREE, never from the run or the task', async () => {
  /*
   * A return carries the commit that holds the work. Taking it from anywhere
   * but git makes the return a claim about work rather than evidence of it --
   * which is why the CLI already refuses a typed --head-sha.
   */
  const { deps, calls } = world({ headSha: async () => 'f'.repeat(40) });
  await run(deps);
  assert.equal(calls.returned[0].head_sha, 'f'.repeat(40));
  assert.notEqual(calls.returned[0].head_sha, TASK.base_sha, 'it returned the BASE commit as the result');
});

// ── the dangerous cycles, which exist only because the world is injected ───

test('A LEASE THAT DIES MID-RUN DISCARDS THE WORK — nothing is returned', async () => {
  /*
   * THE test for this file. The run completes successfully and must be thrown
   * away, because the task may have been reaped and re-claimed while we worked.
   * Returning it would overwrite live work with the output of a run nobody is
   * waiting for.
   *
   * A runtime built around its own I/O could not test this without killing a
   * real lease on a real task.
   */
  /*
   * THE LEASE IS LONG ENOUGH THAT WORK ACTUALLY STARTS. With the fixture's
   * 15-minute lease the renewal window opened before START was ever reached,
   * so the first version of this test abandoned a task it had never begun --
   * passing the "nothing was returned" assertion for the wrong reason entirely.
   * A fixture that cannot reach the state in its own name proves nothing.
   */
  const { deps, calls } = world({
    readTask: async () => ({ ...TASK, lease_expires_at: iso(NOW0 + 25 * 60_000) }),
    renewLease: async () => ({ ok: false, detail: 'stale-lease' }),
    pollRun: async () => ({ done: true, ok: true, notes: 'work that is now worthless' }),
  });
  ageing(deps);

  const out = await run(deps);

  assert.deepEqual(calls.returned, [], 'a dead lease still submitted its result');
  assert.ok(out.done.some((d) => d.outcome === 'abandoned'), 'the task was not abandoned');
  assert.deepEqual(calls.started, ['run-the-agent'], 'the run never started, so this is not the mid-run case');
  assert.deepEqual(calls.cleaned, ['C:/wt/t1'], 'the worktree survived the abandon');
});

test('A REFUSED RENEWAL IS NOT RETRIED', async () => {
  /*
   * ISOLATED FROM THE EXPIRY GUARD ON PURPOSE. The first version used the
   * fixture's 15-minute lease, which EXPIRED two cycles after the refusal — so
   * the worker stopped because of expiry, not because of the refusal, and a
   * mutation deleting the refusal handling stayed GREEN. The test named one
   * property and measured another.
   *
   * The lease here is six hours, so expiry cannot be what stops it, and the
   * only thing left that can is the property this test is about.
   */
  let attempts = 0;
  const { deps } = world({
    readTask: async () => ({ ...TASK, lease_expires_at: iso(NOW0 + 6 * 60 * 60_000) }),
    renewLease: async () => { attempts += 1; return { ok: false, detail: 'stale-lease' }; },
    pollRun: async () => ({ done: false }),
  });
  ageing(deps, 60 * 60_000);

  await run(deps, 8);
  assert.equal(attempts, 1, `renewal was attempted ${attempts} times after being refused`);
});

test('A FAILED RUN IS RETURNED WITH ITS FAILURE, not swallowed', async () => {
  const { deps, calls } = world({
    pollRun: async () => ({ done: true, ok: false, error: 'exit 1', notes: 'tsc: 3 errors' }),
  });
  await run(deps);

  assert.equal(calls.returned.length, 1, 'a failure was held instead of handed back');
  assert.equal(calls.returned[0].outcome, 'failed');
  assert.match(calls.returned[0].notes, /tsc: 3 errors/);
});

test('A WORKTREE THAT CANNOT BE PREPARED IS RETURNED AS A FAILURE', async () => {
  // Sitting on a task it cannot even set up is the silent stall again.
  const { deps, calls } = world({
    prepareWorktree: async () => ({ ok: false, error: 'branch exists' }),
  });
  await run(deps);
  assert.equal(calls.returned.length, 1);
  assert.equal(calls.returned[0].outcome, 'failed');
  assert.match(calls.returned[0].notes, /worktree setup failed: branch exists/);
});

test('AN EVENT FOR A TASK THAT VANISHED IS NOT ACTED ON', async () => {
  /*
   * The outbox is at-least-once by construction, so an event can name a task
   * that has since been cancelled. The authority is the row, not the event.
   */
  const { deps, calls } = world({ readTask: async () => null });
  await run(deps, 4);
  assert.deepEqual(calls.returned, []);
  assert.deepEqual(calls.started, []);
});

test('A TASK ARRIVING WITH NO TOKEN IS NEVER STARTED', async () => {
  /*
   * The shape the system had before delivery existed: assigned, with no
   * credential to return under. Starting would produce work that cannot be
   * handed back.
   */
  const { deps, calls } = world({
    waitForEvents: async () => [{ kind: 'assigned', task_id: 't1', lease_token: null }],
    readTask: async () => ({ ...TASK, lease_token: null }),
  });
  await run(deps, 4);
  assert.deepEqual(calls.started, [], 'work began with no lease token');
  assert.deepEqual(calls.returned, []);
});

test('A PAUSED TASK IS NOT WORKED, AND ITS LEASE IS STILL RENEWED', async () => {
  const { deps, calls } = world({
    pausedTaskIds: async () => ['t1'],
    startRun: async () => { throw new Error('a paused task must not start work'); },
  });
  ageing(deps);

  await run(deps, 6);
  assert.ok(calls.renewed.length >= 1, 'a paused task stopped renewing and would be reaped');
  assert.deepEqual(calls.returned, []);
});

// ── config refuses rather than guesses ─────────────────────────────────────

test('A WORKER WITH NO COMMAND REFUSES TO START', () => {
  /*
   * No default and no vendor name anywhere. A worker that guesses runs whatever
   * happens to be on PATH under that name, or silently does nothing where it is
   * absent.
   */
  const out = workerConfig({ ...ENV, AGENTBRIDGE_WORKER_CMD: '' });
  assert.equal(out.ok, false);
  assert.match(out.errors.join(' '), /AGENTBRIDGE_WORKER_CMD is required/);
  assert.match(out.errors.join(' '), /no default/);
});

test('every missing piece is named AT ONCE', () => {
  // A refusal naming one problem produces four restarts to learn four facts
  // that were all knowable on the first.
  const out = workerConfig({});
  assert.equal(out.ok, false);
  assert.ok(out.errors.length >= 5, `expected every reason, got ${out.errors.length}`);
});

test('a complete config is accepted — the positive control', () => {
  const out = workerConfig(ENV);
  assert.equal(out.ok, true);
  assert.equal(out.config.cmd, 'run-the-agent');
  assert.equal(out.config.runTimeoutMs, DEFAULT_RUN_TIMEOUT_MS);
});

test('the run timeout is bounded at BOTH ends', () => {
  /*
   * Unbounded, a wedged agent holds a lease forever by renewing it, and the
   * reaper cannot help -- from outside, stuck and busy are identical. A floor
   * stops a mistyped value making every task an instant timeout.
   */
  assert.equal(workerConfig({ ...ENV, AGENTBRIDGE_RUN_TIMEOUT_MS: '1000' }).ok, false);
  assert.equal(workerConfig({ ...ENV, AGENTBRIDGE_RUN_TIMEOUT_MS: String(MAX_RUN_TIMEOUT_MS + 1) }).ok, false);
  assert.equal(workerConfig({ ...ENV, AGENTBRIDGE_RUN_TIMEOUT_MS: String(MIN_RUN_TIMEOUT_MS) }).ok, true);
});

test('arguments are argv entries, never a command line', () => {
  // exec runs with shell:false, so punctuation is punctuation.
  assert.deepEqual(parseArgs('--headless --no-color'), ['--headless', '--no-color']);
  assert.deepEqual(parseArgs('a; rm -rf /'), ['a;', 'rm', '-rf', '/']);
  assert.deepEqual(parseArgs(''), []);
});

// ── the brief ──────────────────────────────────────────────────────────────

test('THE BRIEF CANNOT CONTAIN A CREDENTIAL, BY CONSTRUCTION', () => {
  /*
   * taskBrief takes a task and nothing else -- the lease token is not a
   * parameter, so it cannot reach a prompt, a log or a transcript by accident.
   * A structural guarantee rather than a careful habit.
   */
  const brief = taskBrief({ ...TASK, lease_token: 'tok-SECRET' });
  assert.ok(!brief.includes('tok-SECRET'), 'the lease token reached the agent prompt');
  /*
   * THE STRUCTURAL HALF, and my first version of it was wrong about the
   * language: a DEFAULT PARAMETER does not count toward Function.length, so
   * `taskBrief.length` is 0 and asserting 1 failed for a reason that had
   * nothing to do with credentials.
   *
   * Asserting on the SOURCE is the honest version -- it fails if anyone
   * teaches this function about a token at all, which is the property, rather
   * than counting parameters as a proxy for it.
   */
  const src = taskBrief.toString();
  assert.ok(!/lease_token|token|credential/i.test(src),
    'taskBrief learned about a credential; it can now put one in a prompt');

  // And it ignores anything smuggled in as a second argument.
  assert.equal(taskBrief(TASK, { lease_token: 'tok-SMUGGLED' }).includes('tok-SMUGGLED'), false);
});

test('the brief states the contract: paths, base, and commit-your-work', () => {
  const brief = taskBrief(TASK);
  assert.match(brief, /src\/a\.mjs/);
  assert.match(brief, /Base commit: b{40}/);
  assert.match(brief, /COMMIT YOUR WORK/);
  assert.match(brief, /worse than a refusal/);
});

test('a task with NO path contract is told to change only what it names', () => {
  // Silence would read as "anything goes", which is the wrong default for a
  // process about to edit a shared repository.
  const brief = taskBrief({ task_id: 't9' });
  assert.match(brief, /No path contract was given/);
});

// ── worktree isolation ─────────────────────────────────────────────────────

test('ONE WORKTREE PER TASK, not per session', () => {
  /*
   * A session handling two tasks in a row must not inherit the first one's
   * working tree: an uncommitted file would ride along into the next task's
   * commit, which is the shared-clone failure this project already documents
   * between agents.
   */
  assert.equal(worktreePath('C:/wt', 't1'), 'C:/wt/t1');
  assert.notEqual(worktreePath('C:/wt', 't1'), worktreePath('C:/wt', 't2'));
});

test('a hostile task id cannot escape the worktree root', () => {
  assert.ok(!worktreePath('C:/wt', '../../etc/passwd').includes('..'), 'a traversal survived');
  assert.equal(worktreePath('C:/wt/', 'a/b'), 'C:/wt/a-b');
  assert.throws(() => worktreePath('C:/wt', ''), /requires a task_id/);
});

test('THE BRIEF HANDED TO THE AGENT CARRIES NO CREDENTIAL', async () => {
  /*
   * FOUND BY MUTATION, NOT BY READING. Replacing `taskBrief(w.task)` with the
   * whole worker object left every test in this file green — and that object
   * holds the lease token, so the mutation put a live credential into the
   * agent's prompt and nothing noticed.
   *
   * taskBrief being pure and credential-free is necessary and was not
   * sufficient: the DRIVER still chooses what to pass it. So this asserts on
   * what actually reached the child, which is the only thing that matters.
   */
  const { deps, calls } = world();
  await run(deps);

  assert.equal(calls.briefs.length, 1, 'the run started without a brief, or not at all');
  assert.ok(!calls.briefs[0].includes('tok-1'), 'the lease token reached the agent prompt');
  assert.ok(!/lease|token|session/i.test(calls.briefs[0]),
    'credential-shaped state reached the prompt');
  assert.match(calls.briefs[0], /^TASK t1/, 'the brief was not built from the task');
});

test('CLEANUP IS NEVER CALLED WITH NO DIRECTORY', async () => {
  /*
   * Abandoning before the run starts leaves no worktree. Handing `undefined` to
   * a real cleanup is how the wrong directory gets removed — and the abandon
   * path is exactly where it happens, because it is reached before START.
   */
  const { deps, calls } = world({
    waitForEvents: async ({ since } = {}) => (since ? [] : [{
      kind: 'assigned', task_id: 't1', lease_token: null, at: iso(NOW0),
    }]),
    readTask: async () => ({ ...TASK, lease_token: null }),
  });
  await run(deps, 4);

  assert.deepEqual(calls.started, [], 'the fixture started work, so this is not the pre-start abandon');
  assert.deepEqual(calls.cleaned, [], 'cleanup ran for a worktree that was never created');
});
