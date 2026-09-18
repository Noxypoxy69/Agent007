/*
 * EVIDENCE COLLECTOR. It gathers what can be observed, and refuses to guess.
 *
 * Every effect is injected: the clock, the git reader, the test-output parser.
 * A collector with no effects is a pure function of its inputs, which is what
 * makes the interesting cases testable -- "the summary line was missing" and
 * "the worktree had uncommitted changes" are one fixture each, not a repo.
 *
 * THE RULE THAT SHAPES THIS FILE: a thing that could not be observed is
 * reported as null, never as a zero. `parseTestSummary` returning null means
 * nobody found a summary; if it returned {failed: 0} instead, an executor that
 * crashed before the first test would look identical to one that passed
 * everything. That single substitution is the hollow gate in its purest form,
 * and it is the mutation the test file plants.
 */

import { createResultEnvelope } from './resultEnvelope.mjs';
import { matchesAny } from './glob.mjs';

/*
 * node:test / TAP summary. Deliberately anchored on the real shape node emits:
 *
 *   # tests 1033
 *   # pass 1029
 *   # fail 0
 *   # skipped 4
 *
 * Returns null when the block is absent or incomplete. A partial summary is a
 * truncated stream, and half a summary is not evidence.
 */
export function parseTestSummary(text) {
  if (typeof text !== 'string' || text === '') return null;
  const read = (label) => {
    const match = text.match(new RegExp(`^# ${label}[ \\t]+(\\d+)[ \\t]*$`, 'm'));
    return match ? Number(match[1]) : null;
  };
  const total = read('tests');
  const passed = read('pass');
  const failed = read('fail');
  if (total === null || passed === null || failed === null) return null;
  // `skipped` is genuinely optional in node's output; absent means none.
  const skipped = read('skipped') ?? 0;
  if (passed + failed + skipped !== total) {
    /*
     * The counts disagreeing means we matched lines from two different runs, or
     * the stream was cut mid-summary. Either way this is not a summary we may
     * report, and reporting the pieces we did find would be worse than nothing.
     */
    return null;
  }
  return { passed, failed, skipped, total };
}

/*
 * PATH CONTRACT MATCHING IS NOT REIMPLEMENTED HERE.
 *
 * This module shipped with its own three-form matcher. `src/glob.mjs` already
 * existed, already handled `**`, `*` and `?`, already normalised the backslashes
 * a Windows worktree produces, and was already the matcher lane ownership is
 * decided with. Two matchers means two answers to "is this file in scope", and
 * the one that decides a path violation must be the same one that decided who
 * owned the path in the first place.
 */
/*
 * A file violates the contract when it is forbidden, or when an allow-list
 * exists and it is not on it. An EMPTY allow-list means "nothing is allowed",
 * not "everything is" -- a contract that failed to load must not read as
 * permission. Callers that mean "no restriction" pass null.
 */
export function pathViolations(filesChanged, { allowed = null, forbidden = [] } = {}) {
  const violations = [];
  for (const file of filesChanged) {
    if (matchesAny(file, forbidden)) {
      violations.push(file);
      continue;
    }
    if (allowed !== null && !matchesAny(file, allowed)) {
      violations.push(file);
    }
  }
  return [...new Set(violations)].sort();
}

/*
 * Collect an envelope from one execution.
 *
 * `execution` is the normalised result from an executor adapter -- outcome and
 * exit code, nothing interpreted. `io.git` answers two questions about the
 * workspace afterwards, and both are asked of git rather than of the agent:
 * what commit exists now, and what files differ from the base.
 */
export async function collectEvidence({ taskId, attempt = 0, execution, contract = null, io }) {
  if (!io || typeof io.now !== 'function') throw new TypeError('collectEvidence: io.now required');
  const git = io.git ?? {};

  /*
   * Ask git only when the process actually exited. After a timeout or a crash
   * the workspace is a half-written state, and a sha read out of it describes
   * nothing anybody chose. Reporting it as "the commit produced" is how a
   * killed run acquires a plausible-looking result.
   */
  let commit = null;
  let filesChanged = [];
  if (execution.outcome === 'exited' && typeof git.headSha === 'function') {
    commit = (await git.headSha()) ?? null;
    if (typeof git.changedFiles === 'function') {
      filesChanged = (await git.changedFiles()) ?? [];
    }
  }

  const tests = execution.stdout === undefined ? null : parseTestSummary(execution.stdout);

  const pathContract =
    contract === null
      ? null
      : {
          allowed: contract.allowed ?? [],
          forbidden: contract.forbidden ?? [],
          violations: pathViolations(filesChanged, contract),
        };

  return createResultEnvelope({
    taskId,
    attempt,
    outcome: execution.outcome,
    exitCode: execution.exitCode ?? null,
    tests,
    commit,
    filesChanged,
    pathContract,
    durationMs: execution.durationMs ?? null,
    artifacts: execution.artifacts ?? [],
    // Whatever the agent said. Carried for a human, read by no decision.
    notes: execution.notes ?? '',
  });
}
