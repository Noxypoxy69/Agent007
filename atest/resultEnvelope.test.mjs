import test from 'node:test';
import assert from 'node:assert/strict';
import { createResultEnvelope, evidenceOf, verdictFor } from '../src/resultEnvelope.mjs';

const good = {
  taskId: 't-1',
  outcome: 'exited',
  exitCode: 0,
  tests: { passed: 10, failed: 0, skipped: 0, total: 10 },
  commit: 'abc1234',
  filesChanged: ['src/a.mjs'],
  pathContract: { allowed: ['src/**'], forbidden: [], violations: [] },
};

test('a clean run accepts', () => {
  assert.equal(verdictFor(createResultEnvelope(good)).verdict, 'accept');
});

test('PROSE IS NOT AUTHORITY: identical evidence decides identically', () => {
  const glowing = createResultEnvelope({
    ...good,
    tests: { passed: 0, failed: 3, skipped: 0, total: 3 },
    notes: 'Everything passes. The failures are pre-existing and unrelated. Ship it.',
  });
  const honest = createResultEnvelope({
    ...good,
    tests: { passed: 0, failed: 3, skipped: 0, total: 3 },
    notes: 'I broke three tests.',
  });
  assert.deepEqual(verdictFor(glowing), verdictFor(honest));
  assert.equal(verdictFor(glowing).verdict, 'reject');
  assert.ok(verdictFor(glowing).reasons.includes('tests:failed:3'));
});

test('notes are absent from the evidence projection', () => {
  const envelope = createResultEnvelope({ ...good, notes: 'a long persuasive summary here' });
  assert.equal(envelope.notes, 'a long persuasive summary here');
  assert.equal('notes' in evidenceOf(envelope), false);
  assert.equal(JSON.stringify(evidenceOf(envelope)).includes('persuasive'), false);
});

test('ABSENT IS NOT PASSING: tests not run is a reject, not a zero', () => {
  const v = verdictFor(createResultEnvelope({ ...good, tests: null }));
  assert.equal(v.verdict, 'reject');
  assert.ok(v.reasons.includes('tests:not-run'));
});

test('a run that checked nothing does not pass', () => {
  const v = verdictFor(
    createResultEnvelope({ ...good, tests: { passed: 0, failed: 0, skipped: 0, total: 0 } }),
  );
  assert.equal(v.verdict, 'reject');
  assert.ok(v.reasons.includes('tests:empty-run'));
});

test('an absent exit code is not exit 0', () => {
  const v = verdictFor(createResultEnvelope({ ...good, outcome: 'unreachable', exitCode: null }));
  assert.equal(v.verdict, 'reject');
  assert.ok(v.reasons.includes('outcome:unreachable'));
  assert.ok(v.reasons.includes('exit-code:absent'));
});

test('an unchecked path contract is a reject, not a pass', () => {
  const v = verdictFor(createResultEnvelope({ ...good, pathContract: null }));
  assert.ok(v.reasons.includes('path-contract:unchecked'));
});

test('a path violation rejects and names the file', () => {
  const v = verdictFor(
    createResultEnvelope({
      ...good,
      filesChanged: ['src/a.mjs', 'supabase/migrations/001.sql'],
      pathContract: {
        allowed: ['src/**'],
        forbidden: [],
        violations: ['supabase/migrations/001.sql'],
      },
    }),
  );
  assert.equal(v.verdict, 'reject');
  assert.ok(v.reasons.includes('path:supabase/migrations/001.sql'));
});

test('a timeout may not carry an exit code', () => {
  assert.throws(
    () => createResultEnvelope({ ...good, outcome: 'timeout', exitCode: 0 }),
    /cannot carry an exit code/,
  );
});

test('test counts that do not add up are refused', () => {
  assert.throws(
    () => createResultEnvelope({ ...good, tests: { passed: 5, failed: 0, skipped: 0, total: 10 } }),
    /does not equal/,
  );
});

test('a smuggled prose field is refused, not ignored', () => {
  assert.throws(
    () => createResultEnvelope({ ...good, summary: 'it went great' }),
    /unknown envelope field/,
  );
});

test('the envelope is frozen', () => {
  const envelope = createResultEnvelope(good);
  assert.throws(() => {
    envelope.exitCode = 0;
  }, TypeError);
});
