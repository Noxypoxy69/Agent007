import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { codeOnly } from './helpers/codeOnly.mjs';
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
 * THE FIFTH SITE IS NOW COVERED TOO. This file originally named confirmProposal
 * as a known gap: it wrote `state: confirmed` to the proposals table filtered on
 * the proposal id alone, so a proposal the dispatcher superseded between the read
 * and the write could still be flipped to confirmed. 3de0c59 pinned it to
 * `state=eq.open`, and the assertions below keep it pinned.
 */

const INDEX = fileURLToPath(new URL('../supabase/functions/mcp/index.ts', import.meta.url));
const raw = await readFile(INDEX, 'utf8');

/**
 * EVERY ASSERTION BELOW READS CODE. Nothing here may be satisfied by prose.
 *
 * THIS FILE HAD THE HOLE IT WAS WRITTEN TO PREVENT, and it was proved by
 * mutation rather than noticed by reading: strip assign's state predicate, add
 * a COMMENT saying "now routed through claim_task", and the per-site check
 * below went GREEN. The guard accepted the identifier anywhere in the file, and
 * a comment is anywhere.
 *
 * Latent while claim_task appears nowhere in the entrypoint — and it activates
 * exactly when d-lease-wiring lands, because that change introduces both the
 * call AND the comments explaining it. The gate would have started lying at the
 * moment it started mattering.
 */
const source = codeOnly(raw);

test('POSITIVE CONTROL: this is the real entrypoint, and it is not empty', () => {
  /*
   * A negative needs the positive first, and almost everything here is a
   * negative. Without this, "no bare task PATCH found" passes just as happily
   * against an empty string, a moved file, or a stripper that ate the whole
   * file — and the strongest assertions in this suite are the ones that would
   * go quiet first.
   */
  assert.ok(raw.length > 5000, `index.ts is ${raw.length} bytes; that is not the real file`);
  assert.ok(source.includes('coordinatorStore'), 'this is not the coordinator entrypoint');
  assert.ok(
    source.length === raw.length,
    'blanking changed the file length, so every offset-based assertion here is now misaligned',
  );
});

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

/**
 * EACH SITE IS GUARDED IN THE WAY THAT SITE SHOULD BE.
 *
 * WHY THIS IS NOT "there are exactly four guarded writes" ANY MORE, and why the
 * change was made BEFORE the implementation that needs it rather than after.
 *
 * d-lease-wiring moves assign and return onto claim_task and return_with_lease
 * -- the RPCs that do the same job inside one transaction, with a row lock and a
 * fencing token, and which have been the most expensive dead code in this tree
 * all day. When that lands, two of the four writes STOP being predicate-guarded
 * and become RPC calls. A flat count of four would then be unsatisfiable by
 * correct work, which is the definition of a gate that has to be edited to let
 * the truth through.
 *
 * The obvious fix is to narrow it when the change arrives. That is the trap. A
 * guard relaxed to fit an implementation is shaped by the implementation, and
 * the shaping is invisible afterwards because the suite is green either way. So
 * this is written NOW, against the CONTRACT, before the code exists -- which is
 * the only ordering in which the assertion can constrain the work rather than
 * describe it.
 *
 * It is green in both worlds and refuses both wrong ones: guarding the wrong two
 * fails, and an unguarded write fails whichever transport it uses.
 *
 * It deliberately does NOT dictate HOW the RPC is reached -- helper, fetch, or
 * anything else. It requires only that the site names the function that carries
 * the lock. Specifying the transport would be me designing somebody else's
 * change under cover of testing it.
 */
const PERMITTED = Object.freeze({
  accept: { predicate: true, rpc: null },
  cancel: { predicate: true, rpc: null },
  assign: { predicate: true, rpc: 'claim_task' },
  return: { predicate: true, rpc: 'return_with_lease' },
});

/** The text following each `const x = writeLanded(`, where its expectation is named. */
const guardedRegions = () => guardedWrites().map((m) => ({
  name: m[1],
  region: source.slice(m.index, m.index + 600),
}));

test('EACH WRITE IS GUARDED IN THE SPECIFIC WAY THAT WRITE SHOULD BE', () => {
  const regions = guardedRegions();

  for (const [key, allowed] of Object.entries(PERMITTED)) {
    const byPredicate = regions.some((r) => r.region.includes(`TASK_WRITE_EXPECTS.${key}`));
    /*
     * THE CALL SHAPE, NOT THE NAME. `\bclaim_task\b` is satisfied by the
     * identifier appearing anywhere — and with comments now blanked that is a
     * far smaller surface, but it would still accept a string constant, a table
     * name or a key in an unrelated object. Requiring `rpc('claim_task'` means
     * only an actual invocation can satisfy it.
     *
     * Deliberately file-wide rather than scoped to the function: slicing by
     * anchor buys precision and costs a rename becoming a silent pass, which
     * needs its own anchor-existence control to be safe. leaseWiring.test.mjs
     * carries that machinery; duplicating it here would be a second copy of the
     * thing most likely to drift. The comment-blanking above is what closes the
     * hole that was actually demonstrated.
     */
    const byRpc = allowed.rpc
      ? new RegExp(`rpc\\(\\s*['"\`]${allowed.rpc}['"\`]`).test(source)
      : false;

    if (allowed.rpc) {
      assert.ok(
        byPredicate || byRpc,
        `the ${key} write is neither predicate-guarded nor routed through ${allowed.rpc}. `
        + 'Those are the only two ways this write may be made safe; having neither is the original race.',
      );
    } else {
      assert.ok(
        byPredicate,
        `the ${key} write is not predicate-guarded. accept and cancel have no RPC counterpart, `
        + 'so a predicate is the only thing standing between them and a stale decision.',
      );
    }
  }

  assert.ok(
    regions.length >= 2,
    `only ${regions.length} predicate-guarded write(s) remain. accept and cancel must always be among them; `
    + 'if this has dropped below two, a site lost its guard rather than gaining a better one.',
  );

  // Each surviving expectation is named at its site twice: once building the
  // filter, once telling the refusal what state it expected.
  for (const [key, allowed] of Object.entries(PERMITTED)) {
    const uses = source.match(new RegExp(`TASK_WRITE_EXPECTS\\.${key}\\b`, 'g')) ?? [];
    if (uses.length === 0 && allowed.rpc) continue; // moved to the RPC; nothing to name
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

test('EVERY PROPOSALS WRITE CARRIES A STATE PREDICATE TOO', () => {
  /*
   * The fifth site. Same shape as the task writes and lower severity -- the task
   * write serialises the real damage, so a second confirmer is refused at the
   * apply stage and never reaches the proposal row. What was left was a RECORD
   * that could disagree with what happened: superseded, then confirmed, a
   * transition no guard admits.
   */
  const paths = [...source.matchAll(/patch\(\s*[`'"](proposals\?[^`'"]*)[`'"]/g)].map((m) => m[1]);

  assert.ok(paths.length > 0, 'no proposals write found at all — this assertion has stopped reading the file it guards');

  for (const p of paths) {
    assert.match(
      p, /state=eq\./,
      `the proposals write "${p}" is filtered without a state predicate, so it cannot refuse a stale decision`,
    );
  }

  const confirm = paths.filter((p) => p.includes('proposal_id=eq.'));
  assert.equal(confirm.length, 1, `expected exactly one confirm write, found ${confirm.length}`);
  assert.match(confirm[0], /state=eq\.open/,
    'the confirm write must be pinned to open, or a superseded proposal can still be flipped to confirmed');
});

test('A LOST RACE ON THE PROPOSAL ROW IS NAMED, NOT REPORTED AS A FAILURE', () => {
  /*
   * THIS ONE PINS A JUDGEMENT CALL RATHER THAN A DEFECT, deliberately.
   *
   * By the time the proposal row is written, the assignment or acceptance has
   * ALREADY LANDED. Returning ok:false there would report failure for work that
   * completed, and the caller's retry is what would corrupt the picture -- the
   * same defect as the 204 empty-body bug in write(). So the action is reported
   * as the success it was, with the bookkeeping discrepancy named beside it.
   *
   * I agree with that call. It is also the kind of decision that gets quietly
   * "corrected" later by somebody pattern-matching it to the task writes, where
   * ok:false IS right. So it is asserted: flipping it must be an argument, not
   * an edit. If the reasoning ever stops holding, change this test on purpose.
   */
  const start = source.indexOf('const marked = await patch(');
  assert.notEqual(start, -1, 'the pinned confirm write is gone; this test is no longer reading what it claims to');

  const region = source.slice(start, start + 1200);

  assert.match(region, /\bok:\s*true\b/,
    'the confirm now reports failure for work that already landed — the caller will retry an assignment that happened');
  assert.match(region, /proposal_record/,
    'the lost race is no longer NAMED: ok:true with no marker is the divergence hidden rather than reported');
  assert.match(region, /Array\.isArray\(marked\)|marked\.length/,
    'the result of the pinned write is never inspected, so the stale case cannot be detected at all');
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

test('THE REGISTRY REFUSES A BORROWED SESSION ID, AND THE ENTRYPOINT ACTUALLY CALLS IT', () => {
  /*
   * validateSessionId shipped in the artifact with ZERO production callers --
   * correct, tested, and reachable from nothing, which is the shape this repo
   * keeps rediscovering. Wiring it is only half; this asserts the SHIPPED
   * entrypoint calls it, because a guard that exists and is not invoked reads
   * identically to one that is, from anywhere except here.
   *
   * What it prevents is measured, not imagined: social-sparks-app-c8 registered
   * as code-b, so t-loop-proof -- the first end-to-end loop this system ran --
   * is stored with returned_by "social-sparks-app-c8" and reads as c8's work.
   */
  assert.ok(
    /validateSessionId/.test(source),
    'validateSessionId is not referenced by the entrypoint at all -- it is dead code again',
  );

  const reg = source.indexOf('function validateRegistration');
  assert.notEqual(reg, -1, 'validateRegistration is gone from the entrypoint');
  const body = source.slice(reg, reg + 2400);

  assert.ok(
    /validateSessionId\s*\(/.test(body),
    'validateRegistration does not CALL validateSessionId: a session may register under another actor name',
  );
  assert.ok(
    /errors\.push\(\s*borrowed\s*\)|errors\.push\(borrowed\)/.test(body),
    'the result of validateSessionId is computed and then thrown away, which refuses nothing',
  );
});

test('THE DISPATCHER CONFIRMS WITH A STORE THAT EXISTS AT THAT POINT IN THE FILE', () => {
  /*
   * THIS IS WHY THE LOOP DID NOT RUN, AND IT WAS INVISIBLE FROM EVERY SIDE.
   *
   * The /dispatch handler confirmed through `store`, which is declared at the
   * coordinator entrypoint hundreds of lines BELOW it. `const` is not hoisted,
   * so every confirmation threw "Cannot access 'store' before initialization",
   * on every proposal, on every tick, once a minute. The throw was caught and
   * recorded in `refused`, the handler returned ok:true, and pg_cron logged
   * SUCCEEDED -- so the dispatcher looked healthy while confirming nothing, and
   * 1,227 proposals accumulated with 2 ever confirmed.
   *
   * A type checker would have caught it. There is no type checker on a Deno
   * entrypoint this suite cannot import, which is why the rule is asserted
   * against the shipped source instead.
   */
  const dispatch = source.indexOf("path === '/dispatch'");
  assert.notEqual(dispatch, -1, 'the /dispatch route is gone');

  /*
   * Scoped by POSITION rather than by guessing where the handler ends: the
   * property that matters is that whatever the dispatcher confirms through is
   * declared after /dispatch begins and before the call, which is exactly what
   * the temporal dead zone turns on.
   */
  const useAt = source.indexOf('.confirmProposal(', dispatch);
  assert.notEqual(useAt, -1, 'the dispatcher no longer confirms anything at all');

  const name = /(\w+)\.confirmProposal\($/.exec(source.slice(dispatch, useAt + 17))?.[1];
  assert.ok(name, 'could not read what the dispatcher confirms through');

  const declAt = source.slice(dispatch, useAt).search(new RegExp(`const\\s+${name}\\s*=`));
  assert.notEqual(
    declAt,
    -1,
    `/dispatch confirms through "${name}", which is not declared between the route and the call. `
      + 'That is the temporal-dead-zone bug: it resolves to a const declared later in the file and '
      + 'throws "Cannot access before initialization" on every proposal, every tick.',
  );
});
