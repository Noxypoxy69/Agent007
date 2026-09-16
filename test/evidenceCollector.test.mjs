import test from 'node:test';
import assert from 'node:assert/strict';
import { collectEvidence, parseTestSummary, pathViolations } from '../src/evidenceCollector.mjs';
import { matchesAny } from '../src/glob.mjs';

const NODE_SUMMARY = `
some test output
# tests 1033
# suites 44
# pass 1029
# fail 0
# cancelled 0
# skipped 4
# todo 0
`;

test('parses a real node:test summary', () => {
  assert.deepEqual(parseTestSummary(NODE_SUMMARY), {
    passed: 1029,
    failed: 0,
    skipped: 4,
    total: 1033,
  });
});

test('ABSENT IS NULL, NOT ZERO: no summary means not run', () => {
  assert.equal(parseTestSummary('the process died before the first test'), null);
  assert.equal(parseTestSummary(''), null);
  assert.equal(parseTestSummary(null), null);
});

test('a half-written summary is not a summary', () => {
  // stream cut after the pass line -- no fail count
  assert.equal(parseTestSummary('# tests 10\n# pass 10\n'), null);
});

test('counts that do not add up are refused rather than partly believed', () => {
  assert.equal(parseTestSummary('# tests 10\n# pass 3\n# fail 1\n# skipped 0\n'), null);
});

test('the SHARED matcher decides scope, and it behaves as the contract assumes', () => {
  // Asserted here because pathViolations depends on these exact semantics; if
  // the lane matcher ever changes, the path contract's meaning changes with it
  // and this is where that shows up.
  assert.equal(matchesAny('src/exec.mjs', ['src/exec.mjs']), true);
  assert.equal(matchesAny('src/exec.mjs', ['src/*.mjs']), true);
  assert.equal(matchesAny('src/deep/exec.mjs', ['src/*.mjs']), false);
  assert.equal(matchesAny('src/deep/exec.mjs', ['src/**']), true);
  assert.equal(matchesAny('srcx/exec.mjs', ['src/**']), false);
  // a Windows worktree reports separators the contract never used
  assert.equal(matchesAny('src\\deep\\exec.mjs', ['src/**']), true);
});

test('an empty allow-list permits nothing', () => {
  // a contract that failed to load must not read as permission
  assert.deepEqual(pathViolations(['src/a.mjs'], { allowed: [] }), ['src/a.mjs']);
});

test('a null allow-list means no restriction', () => {
  assert.deepEqual(pathViolations(['src/a.mjs'], { allowed: null }), []);
});

test('forbidden beats allowed', () => {
  const violations = pathViolations(['src/a.mjs', 'src/secrets.mjs'], {
    allowed: ['src/**'],
    forbidden: ['src/secrets.mjs'],
  });
  assert.deepEqual(violations, ['src/secrets.mjs']);
});

const io = {
  now: () => 1_000,
  git: {
    headSha: async () => 'deadbee',
    changedFiles: async () => ['src/a.mjs'],
  },
};

test('collects a passing envelope from a real execution shape', async () => {
  const envelope = await collectEvidence({
    taskId: 't-1',
    execution: { outcome: 'exited', exitCode: 0, stdout: NODE_SUMMARY, durationMs: 12 },
    contract: { allowed: ['src/**'], forbidden: [] },
    io,
  });
  assert.equal(envelope.commit, 'deadbee');
  assert.deepEqual(envelope.tests, { passed: 1029, failed: 0, skipped: 4, total: 1033 });
  assert.deepEqual(envelope.pathContract.violations, []);
});

test('A KILLED RUN PRODUCES NO COMMIT: git is not asked after a timeout', async () => {
  let asked = false;
  const envelope = await collectEvidence({
    taskId: 't-1',
    execution: { outcome: 'timeout', stdout: NODE_SUMMARY },
    contract: { allowed: ['src/**'], forbidden: [] },
    io: {
      now: () => 1,
      git: {
        headSha: async () => {
          asked = true;
          return 'deadbee';
        },
        changedFiles: async () => [],
      },
    },
  });
  assert.equal(asked, false, "a half-written worktree must not supply 'the commit produced'");
  assert.equal(envelope.commit, null);
});

test("the agent's notes survive into the envelope but not into evidence", async () => {
  const envelope = await collectEvidence({
    taskId: 't-1',
    execution: { outcome: 'exited', exitCode: 0, stdout: NODE_SUMMARY, notes: 'all good!' },
    contract: null,
    io,
  });
  assert.equal(envelope.notes, 'all good!');
});
