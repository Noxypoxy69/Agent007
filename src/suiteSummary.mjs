/**
 * READ A NODE --test SUMMARY, OR SAY THAT YOU COULD NOT.
 *
 * ═══ THE DEFECT, MEASURED BY A BLIND AUDIT 2026-09-21 ═══
 *
 * `scripts/audit-workspace.mjs` printed this for a run with a NAMED FAILING
 * TEST:
 *
 *     suite exit : 1
 *     tests 2992  pass 2985  fail 0  skipped 6
 *     failing:
 *       NO COMMAND PRINTS A RUNTIME ASSERTION
 *
 * `fail 0` on a red suite. And 2985 + 6 = 2991, one short of 2992 -- the
 * numbers did not even agree with each other, and nothing said so.
 *
 * ═══ WHY, AND IT IS A PROPERTY OF THIS REPOSITORY ═══
 *
 * The old reader took the LAST match of `^ℹ <label> (\d+)` across the
 * whole captured text, per label, independently. That is right for a run that
 * prints one summary. It is wrong here, because:
 *
 *   1. Node prints its summary block and THEN a `failing tests:` section that
 *      reprints each failing test's captured output.
 *   2. Tests in this repository SPAWN CHILD PROCESSES -- the poll supervisor,
 *      the CLI, the guard. A child that runs its own tests prints its own
 *      `ℹ fail 0` block, which is captured as that test's output.
 *
 * So a child's green summary, reprinted inside the parent's failure detail,
 * becomes the last `fail` line in the text and is read as the parent's result.
 * Each label is taken from a potentially DIFFERENT block, which is also how the
 * arithmetic stopped adding up.
 *
 * ═══ WHY THIS IS WORSE THAN AN ORDINARY BUG ═══
 *
 * CLAUDE.md rule 3 says to assert the reported test COUNT rather than the exit
 * code, and rule 20 sends every auditor to a clone made by this very script. So
 * a reader doing exactly what the rules tell them gets `fail 0` from a red run
 * and records a red baseline as green. It is the measuring instrument, and it
 * was lying in the direction of "everything is fine".
 *
 * ═══ THE RULE THIS FOLLOWS ═══
 *
 * A summary is ONE BLOCK. Read it as a block, or refuse. And when the parts do
 * not reconcile, say UNRELIABLE rather than print them: a number that cannot be
 * checked is worse than no number, because it gets quoted.
 *
 * PURE. No fs, no spawn. The caller captures the text; every branch here is
 * reachable from a fixture, which is the point of it not living in the script.
 */

/** Node writes its summary lines prefixed with U+2139 INFORMATION SOURCE. */
const INFO = 'ℹ';

const FIELDS = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];

/**
 * Every contiguous summary block in the text, in order.
 *
 * CONTIGUITY IS THE WHOLE MECHANISM. A block is a run of `ℹ <label> <n>`
 * lines with nothing else between them, which is exactly what node emits and
 * exactly what a child's output cannot splice itself into. Matching labels
 * independently is what let one number come from the parent and the next from a
 * grandchild.
 */
export function summaryBlocks(text) {
  const blocks = [];
  let current = null;

  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const m = /^ℹ ([a-z_]+) ([\d.]+)$/.exec(line);
    if (m && FIELDS.includes(m[1])) {
      current ??= {};
      // A repeated label starts a NEW block: one block never states `fail`
      // twice, so a repeat means two summaries ran together.
      if (Object.hasOwn(current, m[1])) {
        blocks.push(current);
        current = {};
      }
      current[m[1]] = Number(m[2]);
      continue;
    }
    // `duration_ms` closes a block; anything else that is not a summary line
    // also ends it, which is what keeps a child's output from extending ours.
    if (current && !line.startsWith(`${INFO} `)) {
      blocks.push(current);
      current = null;
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

/**
 * The suite's own result, or an explicit refusal to report one.
 *
 * @param text    combined stdout+stderr of a `node --test` run
 * @param status  the process exit status, or null if it was killed
 * @returns {{ok: boolean, tests: number|null, pass: number|null,
 *            fail: number|null, skipped: number|null, why: string}}
 *
 * `ok` is ONLY true when a complete block was found, its parts reconcile, AND
 * it agrees with the exit status. Anything else is `ok: false` with a reason,
 * and the caller must print the reason rather than the numbers.
 */
export function readSuiteSummary(text, status) {
  const complete = summaryBlocks(text).filter((b) => b.tests !== undefined && b.fail !== undefined);

  if (!complete.length) {
    return {
      ok: false, tests: null, pass: null, fail: null, skipped: null,
      why: 'no complete summary block was printed, so the suite did not finish reporting. '
        + 'This is NOT a green run: nothing was counted.',
    };
  }

  /*
   * THE LAST COMPLETE BLOCK IS OURS. A child's summary is printed inside the
   * parent's failure detail, which comes BEFORE the parent's own summary in
   * node's output order -- so last is right, but only once blocks are whole.
   * Taking the last LINE per label is what read a child's number.
   */
  const b = complete[complete.length - 1];
  const n = (k) => (typeof b[k] === 'number' ? b[k] : 0);
  const tests = n('tests');
  const parts = n('pass') + n('fail') + n('cancelled') + n('skipped') + n('todo');

  if (parts !== tests) {
    return {
      ok: false, tests, pass: n('pass'), fail: n('fail'), skipped: n('skipped'),
      why: `the summary does not add up: pass+fail+cancelled+skipped+todo = ${parts}, `
        + `but it reports ${tests} tests. The numbers came from more than one run, so none `
        + 'of them may be quoted.',
    };
  }

  /*
   * AND IT MUST AGREE WITH THE EXIT STATUS. This is the cross-check that would
   * have caught the original defect on its own: `fail 0` alongside a non-zero
   * exit is a contradiction, and the exit code is the half that cannot be
   * forged by captured child output.
   */
  if (status !== 0 && n('fail') === 0) {
    return {
      ok: false, tests, pass: n('pass'), fail: n('fail'), skipped: n('skipped'),
      why: `the suite exited ${status === null ? 'killed' : status} while reporting fail 0. `
        + 'A non-zero exit with no counted failure means the count is not the whole story -- '
        + 'read the failing list and the exit code, not this number.',
    };
  }

  return {
    ok: true, tests, pass: n('pass'), fail: n('fail'), skipped: n('skipped'),
    why: `${tests} test(s), ${n('fail')} failing`,
  };
}
