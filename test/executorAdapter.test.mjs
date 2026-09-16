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
