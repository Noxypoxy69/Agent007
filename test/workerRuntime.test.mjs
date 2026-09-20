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

// ── the heartbeat, which is a different clock from the lease ───────────────

test('THE WORKER BEATS EVERY CYCLE, not just when idle', async () => {
  /*
   * THE BUG THIS EXISTS FOR, and it was an hour old when b6 found its mirror
   * image. `agentbridge work` claimed a task, worked up to THIRTY minutes,
   * renewed its LEASE faithfully, and never beat its SESSION. Sessions go stale
   * at ten minutes.
   *
   * So a worker on a normal task vanished from the roster a third of the way
   * through: reported by wentStale as a lost worker, shown offline to every
   * reader, while working perfectly. The lease keeps the TASK; the heartbeat
   * keeps the WORKER VISIBLE. Wiring one and not the other is not half right.
   */
  const beats = [];
  const { deps, calls } = world({ heartbeat: async (a) => { beats.push(a); return { ok: true }; } });
  await run(deps);

  assert.ok(beats.length >= 3, `beat only ${beats.length} times across a full cycle`);
  assert.ok(beats.some((b) => b.capacity === 'busy'), 'never reported busy while holding a task');
  assert.ok(beats.some((b) => b.task_id === 't1'), 'never said WHICH task it was holding');
  assert.equal(calls.returned.length, 1, 'the fixture stopped completing, so the beats prove little');
});

test('a worker holding nothing beats IDLE, not busy', async () => {
  const beats = [];
  const { deps } = world({
    waitForEvents: async () => [],
    heartbeat: async (a) => { beats.push(a); return { ok: true }; },
  });
  await run(deps, 3);
  assert.ok(beats.length > 0);
  assert.ok(beats.every((b) => b.capacity === 'idle'), 'reported busy while holding nothing');
});

test('A FAILING HEARTBEAT IS LOGGED, NEVER SWALLOWED', async () => {
  /*
   * b6 lost a watcher exactly this way: the background process was nominally
   * alive, produced no output, and stopped beating — and it did not know. A
   * worker that cannot tell whether its heartbeat is landing keeps working
   * while the system has already written it off, and its task is reaped out
   * from under it when the lease lapses.
   *
   * A heartbeat that fails silently is worse than none, because none is at
   * least consistent with what the roster says.
   */
  const { deps, calls } = world({
    heartbeat: async () => ({ ok: false, consecutiveFailures: 3, detail: 'refused', goingDark: true }),
  });
  await run(deps);

  const hb = calls.log.filter((l) => l.startsWith('heartbeat:'));
  assert.ok(hb.length > 0, 'a failing heartbeat produced no log line at all');
  assert.match(hb[0], /FAILED/);
  assert.match(hb[0], /GOING DARK/, 'the worker was not told it is about to be written off');
});

test('the worker keeps WORKING through a failed heartbeat', async () => {
  /*
   * Deliberate. A heartbeat failure means the roster is wrong about us, not
   * that our lease is gone — the lease has its own check and its own refusal.
   * Abandoning finished work because a status ping failed would throw away a
   * good result over a reporting problem.
   */
  const { deps, calls } = world({
    heartbeat: async () => ({ ok: false, consecutiveFailures: 5, detail: 'refused', goingDark: true }),
  });
  await run(deps);
  assert.equal(calls.returned.length, 1, 'a heartbeat failure discarded completed work');
});

test('a runtime with NO heartbeat dep still runs — local-only is legitimate', () => {
  // The dep is optional on purpose: a worker with no hosted config is a real
  // setup, and requiring the beat would make local-only impossible.
  assert.doesNotThrow(() => world({ heartbeat: undefined }));
});

// ── THE HOLD BAR, THROUGH THE REAL LOOP ────────────────────────────────────
/*
 * These are a SEPARATE CLAIM from test/builderHold.test.mjs. That file proves
 * the decision is correct and that `nextAction` consults it; none of it proves
 * the WORKER ever hands the bar an observation. A runtime that wires the gate
 * in and then forwards nothing gets `continue` on every cycle for ever, and
 * every unit test stays green while the control never fires once -- rule 17,
 * which on this repository cost a deleted guard and three sessions that scored
 * it as working.
 */

test('THE BAR FIRES THROUGH THE LOOP: a degraded builder rotates, and hands over', async () => {
  /*
   * Degradation accrues DURING the run, which is both the realistic shape and
   * the only one that can rotate: before a worktree exists there is nothing
   * committed to hand over.
   */
  const { deps, calls } = world({
    pollRun: async () => ({ done: false }),
    observe: async (w) => (w.dir ? { steps: 999 } : {}),
  });
  await run(deps);

  const rotated = calls.log.filter((l) => l.startsWith('rotated:'));
  assert.equal(rotated.length, 1, `the hold bar never fired through the loop: ${calls.log.join(' | ')}`);

  assert.equal(calls.returned.length, 1, 'a rotation handed nothing back, so the task is stranded');
  const body = calls.returned[0];
  assert.equal(body.outcome, 'rotated', 'a rotation was reported as something else');
  assert.equal(body.head_sha, 'c'.repeat(40), 'the checkpoint was not the commit git actually reported');
  assert.equal(body.lease_token, 'tok-1', 'returned without the lease token; /return would refuse this');
  assert.match(body.notes, /ROTATED:/);
  assert.match(body.notes, /steps/, 'the successor is not told which signal stopped its predecessor');

  /* THE HANDOVER ADVANCES THE ATTEMPT, or the successor writes under a stale fence. */
  const handover = JSON.parse(body.notes.slice(body.notes.indexOf('{')));
  assert.equal(handover.task_id, 't1');
  assert.equal(handover.attempt, 1, 'the successor would write under its predecessor\'s attempt');

  assert.ok(calls.cleaned.length > 0, 'the rotated worktree was left behind');
});

test('THE CONTROL: the same world without degradation returns normally', async () => {
  /*
   * Rule 1 and rule 5. The assertion above is worth nothing unless this same
   * harness reaches a DIFFERENT answer when nothing is degraded -- otherwise
   * it could be passing because the loop rotates everything.
   */
  const { deps, calls } = world();
  await run(deps);

  assert.equal(calls.log.filter((l) => l.startsWith('rotated:')).length, 0, 'a healthy builder was rotated');
  assert.equal(calls.returned.length, 1);
  assert.equal(calls.returned[0].outcome, 'completed');
});

test('CHECKPOINTABLE IS ASKED OF GIT: nothing committed means FAIL, never rotate', async () => {
  /*
   * THE EXPENSIVE MISTAKE THIS PREVENTS. `checkpointable` decides between
   * handing work over and destroying it, so the worker must not take the
   * runtime's word for it. Here the agent produced no commit -- HEAD is still
   * the base -- and a rotation would discard the attempt silently, because
   * rotation is the success-shaped verdict.
   */
  const { deps, calls } = world({
    pollRun: async () => ({ done: false }),
    observe: async (w) => (w.dir ? { steps: 999 } : {}),
    headSha: async () => TASK.base_sha,
  });
  await run(deps);

  assert.equal(calls.log.filter((l) => l.startsWith('rotated:')).length, 0,
    'work with no commit was rotated away');
  assert.equal(calls.returned.length, 1, 'a held attempt was not handed back at all');
  assert.equal(calls.returned[0].outcome, 'failed');
  assert.match(calls.returned[0].notes, /^HELD: /);
  assert.match(calls.returned[0].notes, /cannot be checkpointed/);
});

test('THE STEP COUNT IS PER ATTEMPT, not for the life of the process', async () => {
  /*
   * A counter that accumulates across tasks holds the bar against a successor
   * for its predecessor's work, so the second task of any long-lived worker is
   * rotated on arrival.
   *
   * THIS NEEDS TWO TASKS, WHICH THE FIRST VERSION OF IT DID NOT HAVE. With a
   * single never-finishing attempt, per-attempt and per-process counting
   * produce identical numbers and the test cannot fail for the thing it
   * claims to check -- hollow gate 9, in a test written to avoid hollow gates.
   * It went red on a legitimate count of 27 and said so.
   */
  const seen = [];
  let delivered = 0;
  const { deps } = world({
    waitForEvents: async () => {
      delivered += 1;
      if (delivered > 2) return [];
      return [{ kind: 'assigned', task_id: `t${delivered}`, lease_token: 'tok-1', at: iso(NOW0) }];
    },
    readTask: async (a) => ({ ...TASK, task_id: a?.task_id ?? a ?? 't1' }),
    observe: async (w, base) => { seen.push([w.task.task_id, base.steps]); return {}; },
  });
  await run(deps, 30);

  const t1 = seen.filter(([id]) => id === 't1').map(([, s]) => s);
  const t2 = seen.filter(([id]) => id === 't2').map(([, s]) => s);

  /* THE PRECONDITION IS ASSERTED, NOT GUARDED ON (rule 6). Without a second
   * attempt this test proves nothing, so it must fail rather than pass quietly. */
  assert.ok(t1.length > 0, `the first task was never observed: ${JSON.stringify(seen)}`);
  assert.ok(t2.length > 0, `a second attempt never ran, so this cannot distinguish anything: ${JSON.stringify(seen)}`);

  assert.ok(seen.every(([, s]) => typeof s === 'number' && s >= 0),
    `steps was not a number on every cycle: ${JSON.stringify(seen)}`);
  assert.equal(t2[0], 0, `the successor inherited ${t2[0]} steps from its predecessor`);
  assert.ok(Math.min(...t2) <= Math.min(...t1),
    `the second attempt started higher than the first: t1=${JSON.stringify(t1)} t2=${JSON.stringify(t2)}`);
});

test('A ROTATED TASK COMING BACK GETS A FRESH STEP BUDGET', async () => {
  /*
   * THE ORDINARY CASE, AND THE ONE THE FIRST VERSION GOT WRONG. A rotated task
   * returns to the pool and can be claimed by the same worker at a higher
   * attempt. When the reset keyed on task_id alone the id matched, the counter
   * was not reset, and the successor inherited its predecessor's step count --
   * so it re-rotated within a few cycles and burned the rotation budget on
   * work nobody had actually done yet.
   *
   * Two different task IDS cannot catch this; it needs the SAME id at a
   * different attempt.
   */
  const seen = [];
  let delivered = 0;
  const { deps } = world({
    waitForEvents: async () => {
      delivered += 1;
      return delivered > 2 ? [] : [{ kind: 'assigned', task_id: 't1', lease_token: 'tok-1', at: iso(NOW0) }];
    },
    /* Same task, second time round at attempt 1 -- exactly what a rotation produces. */
    readTask: async () => ({ ...TASK, attempt: delivered - 1 }),
    observe: async (w, base) => { seen.push([w.task.attempt ?? 0, base.steps]); return {}; },
  });
  await run(deps, 30);

  const first = seen.filter(([a]) => a === 0).map(([, s]) => s);
  const second = seen.filter(([a]) => a === 1).map(([, s]) => s);

  assert.ok(first.length > 0, `attempt 0 was never observed: ${JSON.stringify(seen)}`);
  assert.ok(second.length > 0,
    `the task never came back at a second attempt, so this cannot distinguish anything: ${JSON.stringify(seen)}`);
  assert.equal(second[0], 0,
    `the re-claimed attempt inherited ${second[0]} steps from the attempt that was rotated away`);
});

test('BREADTH IS MEASURED FROM OUTSIDE THE BUILDER, by asking git', async () => {
  /*
   * THE BUILDER IS NOT ONE OF OUR AGENTS. Whatever the platform dispatches
   * into the worktree is a black box: we do not write it, cannot instrument
   * it, and must not require it to report on itself. So breadth is asked of
   * git, which works identically for an agent nobody here has ever seen.
   */
  const asked = [];
  const seen = [];
  const { deps } = world({
    pollRun: async () => ({ done: false }),
    changedPaths: async (dir, base) => { asked.push([dir, base]); return ['src/a.mjs', 'src/b.mjs', 'README.md']; },
    observe: async (_w, base) => { seen.push(base.filesTouched); return {}; },
  });
  await run(deps, 12);

  assert.ok(asked.length > 0, 'git was never asked what changed, so breadth is never measured');
  assert.equal(asked[0][1], TASK.base_sha, 'breadth was measured against something other than the task base');
  assert.ok(seen.includes(3), `the three changed paths did not reach the bar: ${JSON.stringify(seen)}`);
});

test('COULD NOT LOOK IS NULL, NEVER ZERO', async () => {
  /*
   * THE FAIL-OPEN THIS PREVENTS. Zero files touched is a real observation
   * that tells the bar the builder is well inside its breadth limit. Reporting
   * it after a FAILED lookup means the bar stands down on exactly the runs
   * where the measurement broke -- absent is not zero, which this repository
   * has had to relearn in four separate places.
   */
  const seen = [];
  const { deps } = world({
    pollRun: async () => ({ done: false }),
    changedPaths: async () => null,
    observe: async (_w, base) => { seen.push(base.filesTouched); return {}; },
  });
  await run(deps, 12);

  assert.ok(seen.length > 0, 'observe never ran, so this measured nothing');
  assert.ok(seen.every((v) => v === null), `a failed lookup was reported as a count: ${JSON.stringify(seen)}`);
  assert.ok(!seen.includes(0), 'a failed breadth lookup became zero files touched');
});

test('A RUNTIME WITH NO changedPaths DEP STILL RUNS', async () => {
  /* Optional on purpose: an older daemon that does not supply it must not crash. */
  const { deps, calls } = world({ changedPaths: undefined });
  await run(deps);
  assert.equal(calls.returned.length, 1, 'a worker without the breadth dep stopped working');
});

test('AN UNMONITORED WORKER IS NOT STALLED, and the bar says it measured nothing', async () => {
  /*
   * Today's production shape: no `observe` dep at all. The bar must not refuse
   * the work -- that is the rule 19 outage that gets a control switched off --
   * but the two states must stay distinguishable, which is what `measured`
   * is for.
   */
  const { deps, calls } = world({ observe: undefined });
  await run(deps);
  assert.equal(calls.returned.length, 1, 'a worker with no telemetry was stalled by the hold bar');
  assert.equal(calls.returned[0].outcome, 'completed');
});
