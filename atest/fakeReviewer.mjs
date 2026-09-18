/*
 * A LOCAL FAKE REVIEWER.
 *
 * Deterministic, offline, no model. Its job is not to review well -- it is to
 * let the closed loop run end to end today, and to be the fixture that proves
 * the review STAGE is wired correctly before a real reviewer is attached.
 *
 * IT DECIDES FROM EVIDENCE ONLY. Same contract as a real one, so swapping it
 * for a model is a change of implementation and not of interface. If this fake
 * can reach a decision from the packet, a real reviewer has everything it
 * needs; if it cannot, the packet is missing something and that is worth
 * knowing now rather than after the model is in the loop.
 *
 * BOTH DIRECTIONS ARE REAL. A reviewer that only ever rejects is an outage
 * dressed as rigour, and one that only ever accepts is decoration. The test
 * file asserts a genuine accept and a genuine reject, because a gate proven in
 * one direction is not proven.
 */

const DEFAULT_POLICY = Object.freeze({
  maxFilesChanged: 40,
  requireTests: true,
  minTestsRun: 1,
});

export function createFakeReviewer(policy = {}) {
  const rules = { ...DEFAULT_POLICY, ...policy };

  return {
    id: 'fake-local',
    async review(packet) {
      const findings = [];
      const { evidence, machineVerdict } = packet;

      /*
       * The machine verdict is carried forward as findings rather than being
       * re-derived here. Two implementations of "is this acceptable" is how the
       * booking sheet and the phone agent disagreed for a fortnight.
       */
      for (const reason of machineVerdict.reasons) findings.push(`machine:${reason}`);

      if (rules.requireTests && evidence.tests === null) findings.push('policy:tests-not-run');
      if (evidence.tests !== null && evidence.tests.total < rules.minTestsRun) {
        findings.push(`policy:tests-below-minimum:${evidence.tests.total}`);
      }
      if (evidence.filesChanged.length > rules.maxFilesChanged) {
        findings.push(`policy:too-many-files:${evidence.filesChanged.length}`);
      }
      if (evidence.filesChanged.length === 0) {
        // A clean exit that changed nothing is a worker that did not do the
        // work, and it is the single easiest thing to mistake for success.
        findings.push('policy:no-change');
      }
      if (packet.diffRef === null) findings.push('policy:no-diff-to-read');

      return Object.freeze({
        reviewer: 'fake-local',
        decision: findings.length === 0 ? 'accept' : 'request-changes',
        findings: Object.freeze(findings),
      });
    },
  };
}
