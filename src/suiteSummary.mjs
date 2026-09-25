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

/*
 * Node's spec reporter prefixes its summary lines with U+2139 INFORMATION SOURCE;
 * its TAP reporter uses `#`. Both prefixes live in SUMMARY_LINE below.
 */

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
/*
 * TWO REPORTERS, ONE RULE (T-248). The spec reporter writes `ℹ tests 5`; the TAP
 * reporter writes `# tests 5`, also at column zero.
 *
 * WHICH ONE A SHARD PRINTS, MEASURED (T-295, node v24.19.0): SPEC. This comment used
 * to say TAP is what node --test prints to a pipe. It is not: verifyRunner's shards
 * run `node --test <shard> <glob>` with stdout piped and no reporter flag, and print
 * `ℹ`. `NODE_TEST_REPORTER=tap` did not change that; only `--test-reporter=tap` gave
 * TAP. So the `ℹ` branch is the one real shards depend on
 * (test/verifyShardSummary.test.mjs drives real spawned shards), and `#` covers TAP
 * output from any source, a TAP child printed by a test among them
 * (test/suiteSummaryTapChildAndKill.test.mjs). A block is lines of ONE prefix:
 * a line with the other prefix ends it, exactly as any non-prefixed line does, so
 * a TAP block and a spec block can never merge into one. Everything downstream --
 * one summary or none, reconciliation, agreement with the exit status -- is the
 * same code for both.
 */
const SUMMARY_LINE = /^(ℹ|#) ([a-z_]+) ([\d.]+)$/;

const splitLines = (text) => String(text ?? '').split('\n').map((l) => l.replace(/\r$/, ''));

/*
 * Each block is `{ fields, start, end }`: the parsed labels, and the index of its
 * first and last line in splitLines(text).
 *
 * EXPORTED BECAUSE readSuiteSummary CALLS IT (T-310, B-29). T-288 moved
 * readSuiteSummary onto this function and left a `summaryBlocks` projection
 * (`.map((b) => b.fields)`) exported for the tests alone -- "correct, proven, and
 * called by nothing", which test/deadExports.test.mjs counted (test-only 83 -> 84).
 * The projection is gone; the tests read `.fields` off the function production
 * actually runs, so what they pin is the parse that decides the result.
 */
export function locatedBlocks(text) {
  const lines = splitLines(text);
  const blocks = [];
  let current = null;
  let prefix = null;
  const close = (at) => { blocks.push({ fields: current.fields, start: current.start, end: at }); current = null; };

  for (const [i, line] of lines.entries()) {
    const m = SUMMARY_LINE.exec(line);
    if (m && FIELDS.includes(m[2])) {
      if (current && m[1] !== prefix) close(i - 1);
      current ??= { fields: {}, start: i };
      prefix = m[1];
      // A repeated label starts a NEW block: one block never states `fail`
      // twice, so a repeat means two summaries ran together.
      if (Object.hasOwn(current.fields, m[2])) {
        close(i - 1);
        current = { fields: {}, start: i };
      }
      current.fields[m[2]] = Number(m[3]);
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
    if (current && !line.startsWith(`${prefix} `)) close(i - 1);
  }
  if (current) close(lines.length - 1);
  return blocks;
}

/*
 * ═══ WHERE A RUN'S OWN SUMMARY SITS, MEASURED (T-288, node v24.19.0) ═══
 *
 * v4 refused two complete summaries but accepted ONE without asking whose it
 * was. So when the run's own (parent) summary was truncated or never printed,
 * a single CHILD block -- a test's column-zero stdout carrying another
 * `node --test` run -- was reported as this run's result: `tests 7, fail 1`
 * for a 2992-test run (T-276 F1). v3 had refused that shape.
 *
 * Measured with a real parent/child pair (live/T-288/work/realorder*.mjs):
 *
 *   - a test file's stdout and stderr are printed at COLUMN ZERO, BEFORE that
 *     file's result lines. So a child block is always followed by at least the
 *     result line of the test that printed it (`✔ x (1ms)` / `✖ x (1ms)`).
 *   - the parent's summary comes after EVERY result line; after it there is
 *     only `✖ failing tests:` and the failing detail, whose column-zero lines
 *     are `test at <loc>` followed by one `✖ <name>` line. All else is indented.
 *   - an assertion message carrying a child's output is INDENTED in the detail,
 *     so it never parses as a block at all.
 *
 * So the block that is this run's own sits in one position, and a complete
 * block anywhere else means the parent's is missing or truncated:
 *
 *   A. no summary line follows it (a later partial block is the parent's,
 *      truncated);
 *   B. it is not inside failing detail (the nearest column-zero line before it
 *      is not the marker, a `test at` line, or the `✖` line that follows one);
 *   C. no result line follows it outside failing detail.
 *
 * Returns null when the block is in that position, else the reason.
 *
 * BOUND, stated so nobody trusts this too far: a child's output that is the
 * LAST thing in the text, with no parent line of any kind after it, is
 * byte-identical to a real run of that child. Nothing here can tell them apart;
 * test/suiteSummaryParent.test.mjs pins that limit.
 */
const MARKER = /^✖ failing tests:$/;
const TEST_AT = /^test at /;
const RESULT_LINE = /^[✔✖﹣▶] /;
const indentedOrBlank = (line) => line === '' || /^\s/.test(line);

/*
 * ═══ A LINE CUT BEFORE ITS SPACE IS STILL A LINE (T-299, F3; T-290 measured) ═══
 *
 * RESULT_LINE needs the glyph AND the space. A capture cut 1-3 bytes into the
 * first parent line after a child block leaves either a split glyph -- every
 * glyph above is three UTF-8 bytes, and an incomplete sequence at the end of
 * the text decodes to ONE U+FFFD -- or the whole glyph with no space. Neither
 * matched, so nothing followed the child's block and it was read as this run's
 * (336 wrong readings in T-290's real-output sweep).
 *
 * So an UNTERMINATED last line that is only a glyph, or only U+FFFD, counts as
 * something after the block. Which glyph a U+FFFD was cannot be told from the
 * text (a split `✔` and a split `ℹ` are both E2 ..), so ONE position is carved
 * out: the line DIRECTLY after a block that has not yet printed its
 * `duration_ms`. Node prints that line next, so the cut is the block's own last
 * line being written, not a line after the block.
 *
 * THE COST, MEASURED (T-299 real-output sweep, 831,788 cuts): a red run cut 1-3
 * bytes into its OWN `✖ failing tests:` is refused -- 12 right readings became
 * refusals. A second carve-out for "one blank line after `duration_ms`" was
 * built and measured: it kept those 12, and let 54 wrong readings back in (a red
 * CHILD cut into its marker). A refusal is recoverable and a wrong number is
 * quoted, so it was withdrawn.
 */
const PARTIAL_TAIL = /^(?:\uFFFD|[✔✖﹣▶ℹ])$/;
const DURATION_LINE = /^(ℹ|#) duration_ms /;

function parentProblem(lines, block) {
  /* B: look back to the nearest column-zero line. */
  for (let k = block.start - 1; k >= 0; k -= 1) {
    const line = lines[k];
    if (indentedOrBlank(line)) continue;
    const detailHeader = RESULT_LINE.test(line) && k > 0 && TEST_AT.test(lines[k - 1]);
    if (MARKER.test(line) || TEST_AT.test(line) || detailHeader) {
      return `it sits inside failing-test detail (after "${line}" at line ${k + 1}), where node prints `
        + 'another run\'s output, never its own summary';
    }
    break;
  }
  /* A and C: look forward over everything after it. */
  let afterTestAt = false;
  for (let k = block.end + 1; k < lines.length; k += 1) {
    const line = lines[k];
    const m = SUMMARY_LINE.exec(line);
    if (m && FIELDS.includes(m[2])) {
      return `an incomplete summary follows it at line ${k + 1} ("${line}"): that is the run's own summary, truncated`;
    }
    if (!indentedOrBlank(line) && RESULT_LINE.test(line) && !MARKER.test(line) && !afterTestAt) {
      return `a test result ("${line}", line ${k + 1}) is printed after it, and node prints a run's own `
        + 'summary after every result';
    }
    /* T-299 F3: the text ends partway into a line, before its space. */
    const ownDurationBeingWritten = k === block.end + 1 && !DURATION_LINE.test(lines[block.end]);
    if (k === lines.length - 1 && PARTIAL_TAIL.test(line) && !afterTestAt && !ownDurationBeingWritten) {
      return `the text ends partway into a line after it (${JSON.stringify(line)}, line ${k + 1}), cut before `
        + 'the line could say what it was: output continued after this block, so it is not the run\'s own summary';
    }
    afterTestAt = TEST_AT.test(line);
  }
  return null;
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
   * THAT CLAIM WAS FALSE (T-276 F1): with the parent's summary truncated or
   * absent, ONE child block was reported as this run's. v3 refused it. The
   * position check in parentProblem, above, closes it (T-288), and it depends on
   * node's output order -- measured, not assumed, this time.
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
  const lines = splitLines(text);
  const located = locatedBlocks(text).filter((b) => b.fields.tests !== undefined && b.fields.fail !== undefined);
  const complete = located.map((b) => b.fields);
  /* T-288: is the LAST complete block where node prints a run's own summary? */
  const misplaced = located.length ? parentProblem(lines, located[located.length - 1]) : null;
  /*
   * A KILL IS NAMED ON EVERY REFUSAL, NOT ONLY THE LAST ONE (T-307, B-27; T-303 F2). A non-integer
   * status was refused on every path, but only the one-well-placed-block path below said the run was
   * killed. With 0 blocks, 2+ or a misplaced one, the reason named something else, and the fact that
   * makes every number in the text untrustworthy went unsaid. Appended, so each path's own reason stays.
   */
  const killNote = Number.isInteger(status) ? ''
    : ` The run was also killed (exit status ${status === null ? 'null' : String(status)}): it did not finish, `
      + 'so no summary in this text is its own result.';

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
    const shown = complete
      .map((x) => `tests ${x.tests ?? '?'}/fail ${x.fail ?? '?'}`)
      .join(' and ');
    return {
      ok: false, tests: null, pass: null, fail: null, skipped: null,
      why: `${complete.length} complete summaries are present in this output (${shown}), so some `
        + 'of these numbers belong to another run and nothing here can tell which. Refusing '
        + 'rather than picking one.'
        + (misplaced ? ` And the parent summary is missing or truncated: the last of them is not in its position -- ${misplaced}.` : '')
        + killNote,
    };
  }

  if (!complete.length) {
    return {
      ok: false, tests: null, pass: null, fail: null, skipped: null,
      why: 'no complete summary block was printed, so the suite did not finish reporting. '
        + 'This is NOT a green run: nothing was counted. The parent summary is missing or truncated.'
        + killNote,
    };
  }

  /*
   * ONE COMPLETE BLOCK IS NOT NECESSARILY THIS RUN'S (T-288). When the parent's
   * own summary is truncated or absent, the one block left is a child's, and
   * reporting it quotes another run's numbers. Refuse, and name the parent.
   */
  if (misplaced) {
    const b0 = complete[0];
    return {
      ok: false, tests: null, pass: null, fail: null, skipped: null,
      why: `the parent summary is missing or truncated. The only complete summary here (tests ${b0.tests}/fail ${b0.fail}) `
        + `is not this run's own: ${misplaced}. Refusing rather than quoting another run's numbers.`
        + killNote,
    };
  }

  /*
   * ═══ A KILLED RUN HAS NO SUMMARY OF ITS OWN TO TRUST (T-299, F2) ═══
   *
   * `status` null is node's word for "ended by a signal": spawnSync's timeout and
   * maxBuffer kills, child.kill, the OOM killer. The exit cross-checks below
   * could not see it: `fail 0` was refused, but `fail > 0` passed both, because
   * null is not 0. So a run killed after a test printed a red child's output --
   * measured: spawnSync with maxBuffer, node v24.19.0, signal SIGTERM -- read
   * ok:true with the CHILD's `tests 3, fail 1`. T-290 counted 23,458 such wrong
   * readings in its real-output sweep.
   *
   * A killed run stopped at a point nobody chose, so whatever block is last in
   * its text is where the capture stopped, not where the run finished. Refuse.
   * A non-integer status of any kind is refused the same way: without node's
   * own exit code there is no cross-check left, only the text.
   *
   * NOT EVERY CALLER DELIVERS THE NULL. verifyRunner maps a signal-killed shard
   * to exit 1 before calling this (pinned by verifyRunnerCancellation), and a
   * Windows `taskkill /F` from outside reports status 1, not null (measured,
   * T-299 killprobe). Those kills arrive here as an ordinary red exit.
   */
  if (!Number.isInteger(status)) {
    const b0 = complete[0];
    return {
      ok: false, tests: null, pass: null, fail: null, skipped: null,
      why: `the run was killed (exit status ${status === null ? 'null' : String(status)}): it did not finish, so the `
        + `summary here (tests ${b0.tests}/fail ${b0.fail}) is wherever the capture stopped, not this run's own result. `
        + 'Refusing rather than quoting it.',
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
