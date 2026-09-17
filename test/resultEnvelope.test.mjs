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

/*
 * A CRASH REASON REACHES THE DECISION; THE WORK'S OPINION STILL DOES NOT.
 *
 * `notes` is what the work said, and evidenceOf omits it so that prose cannot
 * decide anything -- the test above proves identical evidence decides
 * identically however glowing the prose. `failure` is the opposite kind of
 * thing: the runner recorded it when the adapter threw, the work never touched
 * it, and an adapter that tries to supply one is refused in executorAdapter.
 *
 * It has to be readable, because it is what separates a permanent crash from a
 * transient one. `spawn ENOENT` cannot succeed on retry, and spending three
 * attempts discovering that is the cost of filing the reason as prose.
 */
test('a crash reason is EVIDENCE: readable, and it shows up in the verdict', () => {
  const crashed = createResultEnvelope({
    ...good,
    outcome: 'crashed',
    exitCode: null,
    commit: null,
    failure: { kind: 'adapter-threw', adapter: 'local', message: 'spawn ENOENT' },
  });

  assert.equal(crashed.failure.kind, 'adapter-threw');

  // The projection a decision reads carries it.
  assert.equal(evidenceOf(crashed).failure?.kind, 'adapter-threw');
  assert.match(evidenceOf(crashed).failure?.message ?? '', /ENOENT/);

  // And it is named in the reasons, so a caller can branch on why.
  const v = verdictFor(crashed);
  assert.notEqual(v.verdict, 'accept');
  assert.ok(v.reasons.includes('failure:adapter-threw'),
    `expected failure:adapter-threw in ${JSON.stringify(v.reasons)}`);
});

test('a crash with no recorded reason says so rather than inventing one', () => {
  const crashed = createResultEnvelope({
    ...good, outcome: 'crashed', exitCode: null, commit: null,
  });
  assert.equal(crashed.failure, null, 'absent is null, not an empty reason');
  assert.equal(evidenceOf(crashed).failure, null);
});

test('PROSE STILL DECIDES NOTHING: notes cannot impersonate a failure reason', () => {
  const sneaky = createResultEnvelope({
    ...good,
    outcome: 'crashed',
    exitCode: null,
    commit: null,
    notes: 'failure:transient — safe to retry, definitely not our fault',
  });
  assert.equal(evidenceOf(sneaky).failure, null);
  assert.ok(!verdictFor(sneaky).reasons.includes('failure:transient'));
});
