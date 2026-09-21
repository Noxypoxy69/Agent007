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
 * ═══ WHAT IS ACTUALLY KNOWN, WHICH IS LESS THAN THIS USED TO SAY ═══
 *
 * The old reader took the LAST match of `^ℹ <label> (\d+)` across the
 * whole captured text, per label, independently. That is right for a run that
 * prints one summary. The observed output proves there was more than one: the
 * labels disagreed with each other (2985 pass + 6 skipped against 2992 tests),
 * which can only happen if they came from different blocks.
 *
 * WHERE THE SECOND BLOCK CAME FROM IS STILL UNKNOWN, and this header used to
 * assert it confidently: a child `node --test` summary reprinted inside the
 * `failing tests:` detail of `NO COMMAND PRINTS A RUNTIME ASSERTION`. That test
 * spawns nothing at all --
 *
 *     grep -acn spawn test/probe.test.mjs   ->  0
 *
 * -- and its assertion payload is one stderr line truncated to 120 characters,
 * structurally incapable of carrying a summary block.
 *
 * THE RETRACTION TOOK TWO GOES, WHICH IS THE PART WORTH KEEPING. The commit
 * that retracted the story removed it from an inner comment and left it here,
 * stated in the present tense as the module's reason for existing -- and the
 * NEXT commit, whose entire subject was deleting the last copy of that story,
 * claimed in its message that this file had already been cleaned. It had not.
 * A blind auditor measured that. A retracted explanation left standing anywhere
 * is the one the next reader will act on, and three successive wrong fixes came
 * from acting on this one.
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
    /*
     * Any line that is not `ℹ `-prefixed ends the block.
     *
     * The comment here used to claim `duration_ms` closes a block. It does not:
     * `duration_ms` is absent from FIELDS, so it falls through to this test --
     * and it DOES start with the prefix, so the block stays open. Harmless (a
     * repeated label splits, an incomplete block is filtered) but false, in the
     * one file whose entire subject is a mechanism nobody checked. Caught by a
     * blind auditor reading the comment against the code.
     */
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
  /*
   * ONE SUMMARY OR NONE. NEVER A CHOICE BETWEEN TWO.
   *
   * ═══ THIRD ATTEMPT, AND THE FIRST TWO WERE GUESSES ═══
   *
   * v1 took the last MATCHING LINE per label. v2 took the last complete BLOCK.
   * v3 split at the first `✖ failing tests:` and took the last block before
   * it. All three are the same move -- a rule for picking one summary out of
   * several -- and a blind audit broke v3 the same way my own mutation broke
   * v2: `String.search` returns the FIRST match, so a marker arriving from
   * captured child output truncates the text before the parent's own summary,
   * and the reader then confidently reports the CHILD's numbers.
   *
   * ═══ AND THE STORY ALL THREE WERE BUILT ON WAS NEVER VERIFIED ═══
   *
   * I wrote, in the module header, in the script, and in three commit messages,
   * that the stray `ℹ fail 0` came from a child `node --test` summary
   * reprinted inside the detail of `NO COMMAND PRINTS A RUNTIME ASSERTION`.
   * That test spawns the CLI and not a test runner:
   *
   *     grep -acn spawnSync test/probe.test.mjs   ->  0
   *
   * so it cannot produce a summary block at all. The mechanism was an
   * assumption I repeated until it sounded measured, and each successive
   * "boundary" was chosen from it. I still do not know what produced that line.
   *
   * ═══ SO STOP PICKING, AND REFUSE INSTEAD ═══
   *
   * A rule for choosing between two summaries can only be as good as a story
   * about where the second one came from, and I do not have one. What is
   * certain is this: if the text contains more than one complete summary, then
   * SOME of those numbers are not this run's, and nothing here can say which.
   * That is precisely the state `ok: false` exists for.
   *
   * This is strictly safer than all three previous versions -- it cannot report
   * a wrong number, only refuse to report -- and it needs no theory about node's
   * output order, which is the part I kept getting wrong. The failing-test names
   * and the exit status still print either way, so a refusal is not a blackout.
   *
   * ONE MORE UNVERIFIED MECHANISM WENT IN HERE AND CAME STRAIGHT BACK OUT.
   * This said: "Node indents captured output beneath a failing test, so an
   * indented block never parses as a summary in the first place. That may well
   * be why no producer has been found." I retracted one guess and wrote another
   * in the same comment, without measuring either.
   *
   * A blind auditor measured it and the reachable half is the opposite. A
   * PASSING test's stdout is printed at COLUMN ZERO:
   *
   *     node --test test/guardToolRoster.test.mjs
   *     === GUARD TOOL ROSTER @ 61bbeb2 (83 rows) ===      <- flush left
   *     ...
   *     ✖ tests 10
   *
   * So column-zero injection is open through any passing test that prints a
   * summary-shaped block, which is the reachable route rather than the failing
   * one I was reasoning about. Whether node indents a FAILING test's captured
   * stdout is still unmeasured -- no test fails at HEAD and the auditor could
   * not author one.
   *
   * The refusal above does not depend on any of this, which is the whole reason
   * it was chosen. Recorded so nobody rebuilds a boundary on the guess.
   */
  const complete = summaryBlocks(text).filter((b) => b.tests !== undefined && b.fail !== undefined);

  if (complete.length > 1) {
    /*
     * A REFUSAL MUST CARRY ITS EVIDENCE, because for a GREEN run it is the only
     * thing the reader gets.
     *
     * The first version said "Read the exit status and the failing list below"
     * and the caller's comment claimed "a refusal is not a blackout". Both
     * wrong, and a blind auditor traced it: the failing list is built from `✖`
     * names, so on a green run with two summaries there are none. The auditor
     * would have seen exit 0, COUNTS UNRELIABLE, and nothing else -- while rule
     * 3 forbids falling back to the exit code. That is a blackout, invented by
     * the commit that added the refusal.
     *
     * So name the blocks. A reader who can see `tests 2992/fail 1` beside
     * `tests 7/fail 0` can tell at a glance which is plausibly this run, which
     * is exactly the judgement this module refuses to make on its behalf.
     */
    /*
     * No `?? '?'` fallback: `complete` is filtered on both fields being
     * defined, so neither arm was reachable. Dead code inside a message added
     * to carry evidence, found by blind audit (L-4).
     */
    const shown = complete.map((x) => `tests ${x.tests}/fail ${x.fail}`).join(' and ');
    return {
      ok: false, tests: null, pass: null, fail: null, skipped: null,
      why: `${complete.length} complete summaries are present in this output (${shown}), so some `
        + 'of these numbers belong to another run and nothing here can tell which. Refusing '
        + 'rather than picking one.',
    };
  }

  if (!complete.length) {
    return {
      ok: false, tests: null, pass: null, fail: null, skipped: null,
      why: 'no complete summary block was printed, so the suite did not finish reporting. '
        + 'This is NOT a green run: nothing was counted.',
    };
  }

  /* Exactly one, established above. */
  const b = complete[0];
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

  /*
   * AND THE OTHER DIRECTION, which the first version left out.
   *
   * `exit 0 with fail > 0` is exactly as impossible as its mirror, and I
   * checked only the half that had bitten me. A one-directional consistency
   * check is the shape that agrees with the truth until something unusual
   * happens, which is when a gate is supposed to speak (rule 4). Cheap to close
   * and there is no argument for leaving it open.
   */
  if (status === 0 && n('fail') > 0) {
    return {
      ok: false, tests, pass: n('pass'), fail: n('fail'), skipped: n('skipped'),
      why: `the suite exited 0 while reporting ${n('fail')} failing. Node does not do that, `
        + 'so either the exit status or the count is not this run\'s. Refusing both.',
    };
  }

  return {
    ok: true, tests, pass: n('pass'), fail: n('fail'), skipped: n('skipped'),
    why: `${tests} test(s), ${n('fail')} failing`,
  };
}
