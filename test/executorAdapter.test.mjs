import test from 'node:test';
import assert from 'node:assert/strict';
import { defineExecutor, execute, normaliseResult, validateSpec } from '../src/executorAdapter.mjs';

const adapter = defineExecutor({
  id: 'fake',
  capabilities: ['shell', 'write'],
  run: async () => ({ outcome: 'exited', exitCode: 0, stdout: 'ok' }),
});

const spec = { taskId: 't-1', cwd: '/w/t-1', argv: ['node', '--test'], timeoutMs: 1000 };

test('a well formed spec passes', () => {
  assert.equal(validateSpec(spec, adapter), spec);
});

test('THERE IS NO EXECUTION WITHOUT A DEADLINE', () => {
  const { timeoutMs, ...noTimeout } = spec;
  void timeoutMs;
  assert.throws(() => validateSpec(noTimeout, adapter), /timeoutMs/);
  assert.throws(() => validateSpec({ ...spec, timeoutMs: 0 }, adapter), /timeoutMs/);
});

test('argv needs the shell capability', () => {
  const noShell = defineExecutor({ id: 'n', capabilities: [], run: async () => ({}) });
  assert.throws(() => validateSpec(spec, noShell), /no shell capability/);
});

test('an unknown spec field is refused', () => {
  assert.throws(() => validateSpec({ ...spec, sudo: true }, adapter), /unknown spec field/);
});

test('AN ADAPTER MAY NOT REPORT ITS OWN TEST COUNTS', () => {
  assert.throws(
    () => normaliseResult({ outcome: 'exited', exitCode: 0, tests: { passed: 9 } }),
    /may not report tests/,
  );
});

test('an adapter may not report the commit it claims to have made', () => {
  assert.throws(
    () => normaliseResult({ outcome: 'exited', exitCode: 0, commit: 'abc1234' }),
    /may not report commit/,
  );
});

test('an adapter may not declare its own success', () => {
  assert.throws(
    () => normaliseResult({ outcome: 'exited', exitCode: 0, success: true }),
    /success/,
  );
  assert.throws(
    () => normaliseResult({ outcome: 'exited', exitCode: 0, verdict: 'accept' }),
    /verdict/,
  );
});

test("NO INVENTED EXIT CODE: 'it exited' without a code is refused", () => {
  assert.throws(() => normaliseResult({ outcome: 'exited' }), /without an integer exitCode/);
  assert.throws(() => normaliseResult({ outcome: 'exited', exitCode: null }), /without an integer/);
});

test('a non-exit outcome may not carry an exit code', () => {
  assert.throws(
    () => normaliseResult({ outcome: 'timeout', exitCode: 0 }),
    /cannot carry an exit code/,
  );
  assert.equal(normaliseResult({ outcome: 'timeout' }).exitCode, null);
});

test('a throwing adapter becomes an outcome, not a crash of the loop', async () => {
  const boom = defineExecutor({
    id: 'boom',
    capabilities: ['shell'],
    run: async () => {
      throw new Error('adapter exploded');
    },
  });
  const result = await execute(boom, spec, { now: () => 5 });
  assert.equal(result.outcome, 'crashed');
  assert.equal(result.exitCode, null);
  assert.match(result.notes, /adapter exploded/);
});

test('execute fills a duration when the adapter did not', async () => {
  let t = 0;
  const result = await execute(adapter, spec, { now: () => (t += 100) });
  assert.equal(result.durationMs, 100);
});

test('defineExecutor refuses an unknown capability', () => {
  assert.throws(
    () => defineExecutor({ id: 'x', capabilities: ['root'], run: async () => ({}) }),
    /unknown capability/,
  );
});

/*
 * WHY A CRASH CRASHED, in a field a decision is allowed to read.
 *
 * `execute` catches a throw from an adapter and records it, which is right: the
 * loop above must be able to note "this blew up" and move on rather than
 * unwinding and losing the attempt. But the reason went into `notes`, and notes
 * is AGENT PROSE -- resultEnvelope's own comment calls it "carried for a human,
 * read by no decision", and evidenceOf deliberately omits it.
 *
 * So the one thing that distinguishes a PERMANENT crash from a transient one
 * was filed in the single field guaranteed to be ignored. `spawn ENOENT` -- the
 * shape produced by executorLocal's empty-PATH launch, which is why Loop B has
 * never run -- is deterministic: retrying it three times is three attempts
 * spent on something that cannot succeed. The retry decision could not tell.
 *
 * The exception text is SYSTEM evidence, not a claim by the work, so it travels
 * in its own field. And precisely because a decision reads it, an adapter must
 * not be able to supply it: that would be the work grading its own failure,
 * which is what USURPED exists to stop.
 */
test('a crashed adapter reports WHY, in a field decisions can read', async () => {
  const boom = defineExecutor({
    id: 'boom',
    capabilities: ['shell'],
    run() { throw new Error('spawn ENOENT'); },
  });

  const r = await execute(boom, { taskId: 't1', cwd: '/w', argv: ['x'], timeoutMs: 1000 });

  assert.equal(r.outcome, 'crashed');
  assert.equal(r.failure?.kind, 'adapter-threw');
  assert.match(r.failure?.message ?? '', /spawn ENOENT/);
  assert.equal(r.failure?.adapter, 'boom');
});

test('an adapter may NOT forge its own failure reason', async () => {
  const liar = defineExecutor({
    id: 'liar',
    capabilities: ['shell'],
    run() {
      return { outcome: 'crashed', failure: { kind: 'transient', message: 'try me again' } };
    },
  });

  await assert.rejects(
    () => execute(liar, { taskId: 't1', cwd: '/w', argv: ['x'], timeoutMs: 1000 }),
    /may not report failure/,
    'an adapter that grades its own crash is the work judging itself',
  );
});
