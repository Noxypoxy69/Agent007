import test from 'node:test';
import assert from 'node:assert/strict';
import { createResultEnvelope } from '../src/resultEnvelope.mjs';
import { assertNoProse, buildReviewerPacket } from '../src/reviewerPacket.mjs';
import { createFakeReviewer } from './fakeReviewer.mjs';

const passing = createResultEnvelope({
  taskId: 't-1',
  outcome: 'exited',
  exitCode: 0,
  tests: { passed: 12, failed: 0, skipped: 0, total: 12 },
  commit: 'abc1234',
  filesChanged: ['src/a.mjs'],
  pathContract: { allowed: ['src/**'], forbidden: [], violations: [] },
  notes: 'I refactored the retry logic and I am confident this is correct.',
});

const failing = createResultEnvelope({
  taskId: 't-1',
  outcome: 'exited',
  exitCode: 1,
  tests: { passed: 9, failed: 3, skipped: 0, total: 12 },
  commit: 'abc1234',
  filesChanged: ['src/a.mjs'],
  pathContract: { allowed: ['src/**'], forbidden: [], violations: [] },
  notes: 'All green. The three failures are pre-existing and unrelated to this change.',
});

test("THE WORKER'S PROSE IS NOT IN THE PACKET", () => {
  const packet = buildReviewerPacket({ envelope: passing, diffRef: 'diff://1' });
  const serialised = JSON.stringify(packet);
  assert.equal(serialised.includes('confident'), false);
  assert.equal(serialised.includes('refactored'), false);
  assert.equal('notes' in packet, false);
  assert.equal('notes' in packet.evidence, false);
});

const LONG_NOTES =
  'I rewrote the retry decision so it no longer double counts. ' +
  'The three remaining failures are pre-existing and unrelated to this change.';

test('assertNoProse catches prose arriving by a route nobody predicted', () => {
  const smuggled = { version: 1, evidence: {}, extra: LONG_NOTES };
  assert.throws(
    () => assertNoProse(smuggled, LONG_NOTES),
    /worker prose reached the reviewer packet/,
  );
});

test('A LEAK IS NOT ALWAYS AT THE START: a middle fragment is still a leak', () => {
  /*
   * The route that actually happens: a field with its own cap, or a wrapped log
   * line, carries the MIDDLE of the summary. A check that compares a fixed
   * prefix is green through exactly this and proves nothing.
   */
  const fragment = LONG_NOTES.slice(70, 110);
  assert.ok(fragment.length >= 24);
  assert.equal(LONG_NOTES.startsWith(fragment), false, 'the fixture must not be a prefix');
  assert.throws(
    () => assertNoProse({ version: 1, evidence: {}, tail: fragment }, LONG_NOTES),
    /worker prose reached the reviewer packet/,
  );
});

test('a leak at the very end is caught too', () => {
  const fragment = LONG_NOTES.slice(-30);
  assert.throws(
    () => assertNoProse({ version: 1, evidence: {}, tail: fragment }, LONG_NOTES),
    /worker prose reached the reviewer packet/,
  );
});

test('a note too short to be prose does not fail every build', () => {
  assert.doesNotThrow(() => assertNoProse({ taskId: 'ok' }, 'ok'));
});

test('the packet carries the machine verdict so the reviewer need not re-derive it', () => {
  const packet = buildReviewerPacket({ envelope: failing, diffRef: 'diff://1' });
  assert.equal(packet.machineVerdict.verdict, 'reject');
  assert.ok(packet.machineVerdict.reasons.includes('tests:failed:3'));
});

test('BOTH DIRECTIONS: the fake reviewer genuinely accepts a good packet', async () => {
  const reviewer = createFakeReviewer();
  const result = await reviewer.review(
    buildReviewerPacket({ envelope: passing, diffRef: 'd://1' }),
  );
  assert.equal(result.decision, 'accept');
  assert.deepEqual(result.findings, []);
});

test('BOTH DIRECTIONS: and rejects a failing one, unmoved by the summary', async () => {
  const reviewer = createFakeReviewer();
  const result = await reviewer.review(
    buildReviewerPacket({ envelope: failing, diffRef: 'd://1' }),
  );
  assert.equal(result.decision, 'request-changes');
  assert.ok(result.findings.includes('machine:tests:failed:3'));
  assert.ok(result.findings.includes('machine:exit-code:1'));
});

test('identical evidence with opposite notes reviews identically', async () => {
  const reviewer = createFakeReviewer();
  const honest = createResultEnvelope({ ...structuredClone(rawOf(failing)), notes: 'I broke it.' });
  const a = await reviewer.review(buildReviewerPacket({ envelope: failing, diffRef: 'd://1' }));
  const b = await reviewer.review(buildReviewerPacket({ envelope: honest, diffRef: 'd://1' }));
  assert.deepEqual(a, b);
});

test('A CLEAN EXIT THAT CHANGED NOTHING IS NOT SUCCESS', async () => {
  const didNothing = createResultEnvelope({
    taskId: 't-1',
    outcome: 'exited',
    exitCode: 0,
    tests: { passed: 12, failed: 0, skipped: 0, total: 12 },
    commit: 'abc1234',
    filesChanged: [],
    pathContract: { allowed: ['src/**'], forbidden: [], violations: [] },
  });
  const reviewer = createFakeReviewer();
  const result = await reviewer.review(
    buildReviewerPacket({ envelope: didNothing, diffRef: 'd://1' }),
  );
  assert.equal(result.decision, 'request-changes');
  assert.ok(result.findings.includes('policy:no-change'));
});

test('a packet with no diff to read cannot be accepted', async () => {
  const reviewer = createFakeReviewer();
  const result = await reviewer.review(buildReviewerPacket({ envelope: passing }));
  assert.ok(result.findings.includes('policy:no-diff-to-read'));
});

test('policy is configurable and actually applied', async () => {
  const reviewer = createFakeReviewer({ maxFilesChanged: 0 });
  const result = await reviewer.review(
    buildReviewerPacket({ envelope: passing, diffRef: 'd://1' }),
  );
  assert.ok(result.findings.includes('policy:too-many-files:1'));
});

// Rebuild the constructor input from an envelope, so a variant can be made
// that differs in notes ALONE.
function rawOf(envelope) {
  return {
    taskId: envelope.taskId,
    attempt: envelope.attempt,
    outcome: envelope.outcome,
    exitCode: envelope.exitCode,
    tests: envelope.tests === null ? null : { ...envelope.tests },
    commit: envelope.commit,
    filesChanged: [...envelope.filesChanged],
    pathContract:
      envelope.pathContract === null
        ? null
        : {
            allowed: [...envelope.pathContract.allowed],
            forbidden: [...envelope.pathContract.forbidden],
            violations: [...envelope.pathContract.violations],
          },
  };
}
