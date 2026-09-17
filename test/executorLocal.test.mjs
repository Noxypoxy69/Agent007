import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalExecutor } from '../src/executorLocal.mjs';
import { normaliseResult } from '../src/executorAdapter.mjs';

/**
 * THIS FILE TESTS A TRANSLATION, NOT A PROCESS RUNNER.
 *
 * src/exec.mjs owns spawning, and its own coverage owns the shell being off and
 * secrets travelling on stdin. Re-asserting those here would be a second copy of
 * someone else's contract, green whether or not this adapter is correct.
 *
 * What is only true here is the mapping from the runner's answer to an outcome,
 * and it has exactly one way to be catastrophically wrong: reporting a process
 * the runner killed as a clean exit. Every case below exists to make that
 * impossible, and the conditions are unreachable without injection -- a real
 * timeout takes a real wall-clock minute and a signal death cannot be arranged
 * on demand.
 */

const spec = { taskId: 't', cwd: '/w', argv: ['node', '--test'], timeoutMs: 50, env: { PATH: '/b' } };
const runnerReturning = (answer, seen = {}) => async (file, args, options) => {
  Object.assign(seen, { file, args, options });
  return answer;
};

test('a normal exit reports its real code', async () => {
  const exec = createLocalExecutor({ run: runnerReturning({ ok: true, code: 0, stdout: 'out', stderr: '' }) });
  const r = await exec.run(spec, { now: () => 0 });
  assert.equal(r.outcome, 'exited');
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, 'out');
});

test('a non-zero exit travels intact', async () => {
  const exec = createLocalExecutor({ run: runnerReturning({ ok: false, code: 3, stdout: '', stderr: 'boom' }) });
  const r = await exec.run(spec, { now: () => 0 });
  assert.equal(r.outcome, 'exited');
  assert.equal(r.exitCode, 3);
});

test('A KILLED PROCESS IS A TIMEOUT AND CARRIES NO EXIT CODE', async () => {
  // The platform reports a code for the kill. It describes the kill.
  const exec = createLocalExecutor({
    run: runnerReturning({ ok: false, code: null, killed: true, signal: 'SIGTERM', stdout: 'partial', stderr: '' }),
  });
  const r = await exec.run(spec, { now: () => 0 });
  assert.equal(r.outcome, 'timeout');
  assert.equal(r.exitCode, undefined, 'a killed run must not present an exit code');
  assert.equal(r.stdout, 'partial', 'what it managed to say is still evidence');
  // and the envelope layer agrees, rather than this being a local opinion
  assert.equal(normaliseResult(r).exitCode, null);
});

test('EVEN IF THE RUNNER STILL REPORTS A NUMERIC CODE, killed wins', async () => {
  /*
   * The regression this pins: exec.mjs used to default a killed run's code to
   * 0, which is the shape of success. If that ever comes back, `killed` is the
   * field that still tells the truth, and it is checked first.
   */
  const exec = createLocalExecutor({
    run: runnerReturning({ ok: false, code: 0, killed: true, signal: 'SIGKILL', stdout: '', stderr: '' }),
  });
  const r = await exec.run(spec, { now: () => 0 });
  assert.equal(r.outcome, 'timeout');
  assert.equal(r.exitCode, undefined);
});

test('a death with no code and no kill is crashed, not exited', async () => {
  const exec = createLocalExecutor({
    run: runnerReturning({ ok: false, code: null, killed: false, signal: 'SIGSEGV', stdout: '', stderr: '' }),
  });
  const r = await exec.run(spec, { now: () => 0 });
  assert.equal(r.outcome, 'crashed');
  assert.equal(r.signal, 'SIGSEGV');
  assert.equal(normaliseResult(r).exitCode, null);
});

test('THE CHILD GETS AN ALLOW-LIST, NOT THE PARENT ENVIRONMENT', async () => {
  const seen = {};
  process.env.LANE_TEST_SECRET = 'must-not-travel';
  const exec = createLocalExecutor({ run: runnerReturning({ ok: true, code: 0, stdout: '', stderr: '' }, seen) });
  await exec.run(spec, { now: () => 0 });
  delete process.env.LANE_TEST_SECRET;
  assert.deepEqual(Object.keys(seen.options.env).sort(), ['PATH']);
  assert.equal(seen.options.env.LANE_TEST_SECRET, undefined);
});

test('argv is passed as file and args, never joined into one string', async () => {
  const seen = {};
  const exec = createLocalExecutor({ run: runnerReturning({ ok: true, code: 0, stdout: '', stderr: '' }, seen) });
  await exec.run({ ...spec, argv: ['node', '-e', 'a b; rm -rf /'] }, { now: () => 0 });
  assert.equal(seen.file, 'node');
  assert.deepEqual(seen.args, ['-e', 'a b; rm -rf /']);
});

test('a prompt travels on stdin, never in argv', async () => {
  const seen = {};
  const exec = createLocalExecutor({ run: runnerReturning({ ok: true, code: 0, stdout: '', stderr: '' }, seen) });
  await exec.run({ ...spec, prompt: 'sk-secret-value' }, { now: () => 0 });
  assert.equal(seen.options.input, 'sk-secret-value');
  assert.equal(seen.args.join(' ').includes('sk-secret'), false);
});

test("the spec's deadline is the runner's deadline", async () => {
  const seen = {};
  const exec = createLocalExecutor({ run: runnerReturning({ ok: true, code: 0, stdout: '', stderr: '' }, seen) });
  await exec.run({ ...spec, timeoutMs: 1234 }, { now: () => 0 });
  assert.equal(seen.options.timeoutMs, 1234);
});

/*
 * WHY THE SPAWN FAILED, not just that it did.
 *
 * This is the case Loop B dies on. The environment here is an ALLOW-LIST -- an
 * agent that inherits the daemon's environment inherits its credentials -- so
 * PATH defaults to empty, and a bare executable name cannot resolve. agentLaunch
 * produces exactly that when a task names an engine with no binary configured:
 * `file: binary ?? engine`. The runner answers with no exit code, this maps it
 * to `crashed`, and the reason -- which exec.mjs already hands back as `error`
 * -- was dropped on the floor.
 *
 * A missing binary is DETERMINISTIC. Retrying it spends the attempt budget on
 * something that cannot succeed, and nothing downstream could tell that from a
 * transient fault.
 */
test('a failed spawn carries its reason, so a retry decision can see it is permanent', async () => {
  const runner = async () => ({ ok: false, code: null, error: 'spawn claude ENOENT', stderr: '' });
  const ex = createLocalExecutor({ run: runner });

  const r = await ex.run({ taskId: 't1', cwd: '/w', argv: ['claude'], timeoutMs: 1000 });

  assert.equal(r.outcome, 'crashed');
  assert.equal(r.failure?.kind, 'spawn-failed');
  assert.match(r.failure?.message ?? '', /ENOENT/);
});

test('a crash with no reason from the runner records none, rather than an empty one', async () => {
  const runner = async () => ({ ok: false, code: null, signal: 'SIGKILL', error: null });
  const ex = createLocalExecutor({ run: runner });

  const r = await ex.run({ taskId: 't1', cwd: '/w', argv: ['x'], timeoutMs: 1000 });
  assert.equal(r.outcome, 'crashed');
  assert.equal(r.signal, 'SIGKILL');
  assert.equal(r.failure ?? null, null, 'absent is unknown, not a blank reason');
});
