import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fingerprintAttempt,
  fingerprintFailure,
  normaliseForFingerprint,
} from '../src/fingerprint.mjs';

const failure = (dir, ms, ts, pid, file = 'a.mjs', line = 12) =>
  `AssertionError at /tmp/${dir}/${file}:${line}:8\n  expected true got false\n  took ${ms}ms at ${ts} pid=${pid}`;

test('STABLE ACROSS RUN NOISE: same failure, different run', () => {
  const a = fingerprintAttempt({
    taskId: 't-1',
    failureText: failure('build-8f2a1c', 341, '2026-09-16T03:00:00Z', 771),
  });
  const b = fingerprintAttempt({
    taskId: 't-1',
    failureText: failure('build-99zzqq', 12, '2026-09-16T05:41:07.221Z', 40213),
  });
  assert.equal(a, b);
});

test('DIFFERENT ENOUGH: a different file is a different fingerprint', () => {
  const a = fingerprintAttempt({ taskId: 't-1', failureText: failure('d', 1, 'x', 1, 'a.mjs') });
  const b = fingerprintAttempt({ taskId: 't-1', failureText: failure('d', 1, 'x', 1, 'b.mjs') });
  assert.notEqual(a, b);
});

test('a different line in the same file is a different fingerprint', () => {
  const a = fingerprintAttempt({
    taskId: 't-1',
    failureText: failure('d', 1, 'x', 1, 'a.mjs', 12),
  });
  const b = fingerprintAttempt({
    taskId: 't-1',
    failureText: failure('d', 1, 'x', 1, 'a.mjs', 99),
  });
  assert.notEqual(a, b);
});

test('the base sha is NOT scrubbed as hex: a rebase is progress', () => {
  const a = fingerprintAttempt({ taskId: 't-1', baseSha: 'aaaaaaa', failureText: 'same' });
  const b = fingerprintAttempt({ taskId: 't-1', baseSha: 'bbbbbbb', failureText: 'same' });
  assert.notEqual(a, b);
});

test('different files changed is a different attempt', () => {
  const a = fingerprintAttempt({ taskId: 't', filesChanged: ['a.mjs'], failureText: 'x' });
  const b = fingerprintAttempt({ taskId: 't', filesChanged: ['b.mjs'], failureText: 'x' });
  assert.notEqual(a, b);
});

test('file order does not matter', () => {
  const a = fingerprintAttempt({ taskId: 't', filesChanged: ['a.mjs', 'b.mjs'] });
  const b = fingerprintAttempt({ taskId: 't', filesChanged: ['b.mjs', 'a.mjs', 'a.mjs'] });
  assert.equal(a, b);
});

test('a different exit code is a different attempt', () => {
  const a = fingerprintAttempt({ taskId: 't', exitCode: 1 });
  const b = fingerprintAttempt({ taskId: 't', exitCode: 2 });
  assert.notEqual(a, b);
});

test('different test counts are different attempts', () => {
  const a = fingerprintAttempt({ taskId: 't', testSummary: { passed: 9, failed: 1, skipped: 0 } });
  const b = fingerprintAttempt({ taskId: 't', testSummary: { passed: 8, failed: 2, skipped: 0 } });
  assert.notEqual(a, b);
});

test('scrubbing keeps the file name and drops the run-unique directory', () => {
  assert.equal(normaliseForFingerprint('/tmp/abc123/x/y.mjs:4'), '<tmp>/y.mjs:4');
  // a temp DIRECTORY with no file has nothing worth keeping
  assert.equal(normaliseForFingerprint('/tmp/abc123'), '<tmp>');
});

test('timestamps, durations, pids and addresses are scrubbed', () => {
  assert.equal(normaliseForFingerprint('at 2026-09-16T03:00:00.123Z'), 'at <ts>');
  assert.equal(normaliseForFingerprint('took 1234ms'), 'took <ms>');
  assert.equal(normaliseForFingerprint('pid=9912'), 'pid=<pid>');
  assert.equal(normaliseForFingerprint('at 0xdeadbeef'), 'at <addr>');
  assert.equal(normaliseForFingerprint('sha 1a2b3c4d5e6f'), 'sha <hex>');
});

test('a taskId is required -- an unnamed attempt cannot be tracked', () => {
  assert.throws(() => fingerprintAttempt({}), /taskId required/);
});

test('fingerprintFailure ignores what varies and keeps what does not', () => {
  assert.equal(fingerprintFailure('boom at 12ms'), fingerprintFailure('boom at 9999ms'));
  assert.notEqual(fingerprintFailure('boom'), fingerprintFailure('bang'));
});
