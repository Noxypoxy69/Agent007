import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  TASK_WRITE_EXPECTS, ASSIGNABLE_FROM, ACCEPTABLE_FROM, TERMINAL,
} from '../supabase/functions/mcp/_shared.js';

/**
 * THE PREDICATE IS ONLY REAL IF THE CALL SITES USE IT.
 *
 * Written by code-d, verifying 7d908a5 rather than accepting it. The fix there
 * is correct: taskWriteFilter pins each write to the states its guard admits,
 * and writeLanded turns PostgREST's empty-array answer into a refusal instead of
 * `ok: true` with an absent task.
 *
 * THE GAP THIS FILE CLOSES. lostRaceIsNotSuccess.test.mjs tests those two pure
 * functions. It does not, and cannot, assert that index.ts CALLS them. Delete
 * `if (!landed.ok) return` from one site, or revert one filter to the bare
 * `tasks?task_id=eq.` form, and all nine of its tests stay green while the race
 * is back.
 *
 * That is not a hypothetical in this repository. test/wiringIsReal.test.mjs
 * exists because three modules shipped pure, correct, well-tested and invoked by
 * nothing -- resolveWorker/bindDelegation, src/supersession.mjs and
 * src/tokenBudget.mjs -- and its own header says it: "A pure module's own tests
 * can never catch this. They pass whether or not anything calls it."
 *
 * The lease layer is the FOURTH instance: claim_task, claim_review, renew_lease,
 * renew_review_lease, return_with_lease, expire_dead_leases and
 * release_review_lease are applied and live in the database and referenced in
 * three migrations and one document, nowhere else in the tree. The guard written
 * for the race fix was a candidate fifth. This file is why it is not.
 *
 * WHY IT READS SOURCE TEXT. index.ts is a Deno edge entrypoint and cannot be
 * imported by this suite -- which is exactly why anything left in it is untested
 * by construction. Scanning the shipped file is ugly and is the only thing that
 * can see the wiring. It reads the file that deploys, never a copy.
 *
 * KNOWN AND DELIBERATELY NOT ASSERTED: confirmProposal writes `state:
 * confirmed` to the proposals table filtered on the proposal id alone. It is the
 * same shape, lower severity -- the task write now serialises it -- and closing
 * it is a separate change. It is named here so its absence is a decision rather
 * than an oversight.
 */

const INDEX = fileURLToPath(new URL('../supabase/functions/mcp/index.ts', import.meta.url));
const source = await readFile(INDEX, 'utf8');

/** Every `const x = writeLanded(` in the shipped file, with the name bound. */
const guardedWrites = () => [...source.matchAll(/const\s+(\w+)\s*=\s*writeLanded\(/g)];

test('NO TASK WRITE REACHES THE DATABASE WITHOUT A STATE PREDICATE', () => {
  /*
   * The original defect, asserted as absence. A bare `patch(`tasks?...`)` is
   * filtered on the primary key alone: it cannot refuse a stale decision under
   * any interleaving, which is what made the race structural rather than
   * probabilistic.
   */
  const bare = source.match(/patch\(\s*[`'"]tasks\?/g) ?? [];

  assert.deepEqual(
    bare, [],
    'a task PATCH bypasses taskWriteFilter and is filtered on task_id alone. '
    + 'That is the original defect verbatim: the guard judges a snapshot from an '
    + 'earlier request and nothing revalidates at write time.',
  );
});

test('all four lifecycle writes are guarded, and there are exactly four', () => {
  const found = guardedWrites().map((m) => m[1]);

  assert.equal(
    found.length, 4,
    `expected four guarded task writes (assign, accept, cancel, return), found ${found.length}: ${found.join(', ')}. `
    + 'Fewer means a site lost its guard; more means a new write appeared that this file has not been taught about.',
  );

  // Each expectation is named at its site, twice: once building the filter and
  // once telling the refusal what state it expected.
  for (const key of Object.keys(TASK_WRITE_EXPECTS)) {
    const uses = source.match(new RegExp(`TASK_WRITE_EXPECTS\\.${key}\\b`, 'g')) ?? [];
    assert.ok(
      uses.length >= 2,
      `TASK_WRITE_EXPECTS.${key} is referenced ${uses.length} time(s); the filter and the refusal each need it, `
      + 'and a refusal that cannot name the expected state cannot tell a caller what to re-read.',
    );
  }
});

test('EVERY GUARDED WRITE REFUSES, AND REFUSES BEFORE IT ANNOUNCES', () => {
  /*
   * The ordering is the half that would otherwise rot quietly. A site that
   * computes `landed` and then announces the assignment anyway has published a
   * message asserting work was handed out when nothing was written -- the same
   * defect wearing a different coat, and harder to see because the row simply
   * did not change.
   */
  for (const match of guardedWrites()) {
    const name = match[1];
    const after = source.slice(match.index);

    const refusal = after.search(
      new RegExp(`if\\s*\\(\\s*!${name}\\.ok\\s*\\)\\s*\\{?\\s*return`),
    );
    assert.notEqual(
      refusal, -1,
      `the result of writeLanded is bound to "${name}" and never acted on. An unread refusal is a lost race `
      + 'reported as success -- quieter than the bug it replaced, not safer.',
    );

    const announce = after.search(/write\(\s*['"`]messages['"`]/);
    if (announce !== -1) {
      assert.ok(
        refusal < announce,
        `"${name}" announces on the message log before it checks whether the write landed. `
        + 'The announcement must be unreachable when the write was refused.',
      );
    }
  }
});

test('the expectations are DERIVED from the guards, not copied beside them', () => {
  /*
   * lostRaceIsNotSuccess asserts these against hard-coded lists, so a change to
   * ASSIGNABLE_FROM or TERMINAL upstream would leave the predicate stale and
   * that file green while claiming to have checked. Comparing against the
   * constants themselves is what makes the claim true.
   */
  assert.deepEqual(
    TASK_WRITE_EXPECTS.assign, ASSIGNABLE_FROM,
    'the assign predicate no longer matches ASSIGNABLE_FROM: it will refuse work canAssign admits, or admit work it does not',
  );
  assert.deepEqual(
    TASK_WRITE_EXPECTS.accept, ACCEPTABLE_FROM,
    'the accept predicate no longer matches ACCEPTABLE_FROM',
  );

  // canReturn admits exactly one state, and says so in one line.
  assert.deepEqual(TASK_WRITE_EXPECTS.return, ['assigned']);

  // canCancel refuses only the terminal states; everything else may be withdrawn.
  assert.deepEqual(
    [...TASK_WRITE_EXPECTS.cancel].sort(), ['assigned', 'blocked', 'returned', 'runnable'],
    'the cancel predicate no longer matches the non-terminal states canCancel admits',
  );

  for (const [name, states] of Object.entries(TASK_WRITE_EXPECTS)) {
    for (const terminal of TERMINAL) {
      assert.equal(
        states.includes(terminal), false,
        `${name} admits the terminal state "${terminal}", so a finished task could be written again`,
      );
    }
  }
});
