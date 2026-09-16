import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * THE SAFE IMPLEMENTATION EXISTED AND WAS UNREACHABLE.
 *
 * claim_task, claim_review, renew_lease, renew_review_lease, return_with_lease,
 * expire_dead_leases and release_review_lease are applied and LIVE in Postgres.
 * They do a row lock, a fencing token, an expiry, an attempt counter and an
 * outbox write in one transaction. Until this change they appeared in three
 * migrations, one document, and NOWHERE ELSE IN THE TREE. Meanwhile the
 * reachable surface did read-decide-write over HTTP, and the state predicate
 * added later closed the double-assignment race and nothing else -- it could
 * refuse a stale decision, but it could not mint a token, could not count an
 * attempt, and could not put the assignment and its event in one transaction.
 *
 * code-d's `wiringIsReal.test.mjs` names that shape as this repository's
 * recurring defect: a pure, correct, well-tested module invoked by nothing.
 * A module's own tests pass whether or not anything calls it. This file is the
 * same question asked of the lease layer.
 *
 * WHY IT READS SOURCE TEXT. index.ts is a Deno edge entrypoint and cannot be
 * imported by this suite -- which is precisely why anything left in it is
 * untested by construction. `theWritesAreWired.test.mjs` reaches the same
 * conclusion for the same reason and says so.
 *
 * WHY EVERY ASSERTION IS SLICE-SCOPED. "The file contains the string
 * claim_task" is satisfied by a comment. Each check below cuts the specific
 * function or route handler out of the file first and asserts INSIDE it, so a
 * mention somewhere else cannot stand in for a call on the live path. The
 * ordering checks compare indices within one slice for the same reason: the
 * announcement being present proves nothing about whether it runs after the
 * claim, and announcing an assignment that did not land is the original defect
 * wearing a different coat.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT ASSERT. Not the transport. A helper, a
 * direct fetch or anything else is the implementer's call; what matters is that
 * the site names the function carrying the lock. Pinning the transport here
 * would be designing the change under cover of testing it.
 *
 * IT ALSO DOES NOT ASSERT attempt > 0 OR AN OUTBOX ROW. Those are properties of
 * a live database after a real assignment, not of source, and manufacturing
 * them by writing to a live ledger to satisfy a test would be worse than the
 * gap. They come free from claim_task's own transaction once this ships.
 */

const INDEX = fileURLToPath(new URL('../supabase/functions/mcp/index.ts', import.meta.url));

const raw = await readFile(INDEX, 'utf8');

/**
 * Blank every comment, keeping the file the same length.
 *
 * THE FIRST VERSION OF THIS FILE PASSED ITS OWN MUTATION. Renaming the call
 * from `claim_task` to something else left the suite green, because the block
 * comment directly above the call EXPLAINS claim_task by name. The test was
 * reading the justification rather than the code, and would have gone on
 * agreeing with itself through the exact regression it exists to catch. Four of
 * the twelve assertions had the same hole; `/return` kept passing with its
 * token requirement deleted for the same reason.
 *
 * Blanking rather than deleting keeps every index and line number aligned with
 * the real file, which the ordering assertions depend on.
 */
function codeOnly(src) {
  const out = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    }
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '"' || ch === "'" || ch === '`') {
      // Skip string bodies, so a quoted "//" is not mistaken for a comment.
      let j = i + 1;
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\') j += 1;
        j += 1;
      }
      i = j + 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? src.length : nl;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close === -1 ? src.length : close + 2;
      blank(i, end);
      i = end;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** Every assertion below reads CODE. Nothing here may be satisfied by prose. */
const source = codeOnly(raw);

/**
 * Cut one region out of the file.
 *
 * Returns null rather than an empty string when an anchor is missing, so a
 * renamed function fails loudly at the anchor check below instead of quietly
 * handing every later assertion an empty haystack to not-find things in.
 */
function slice(from, to) {
  const start = source.indexOf(from);
  if (start === -1) return null;
  const end = to ? source.indexOf(to, start + from.length) : -1;
  return source.slice(start, end === -1 ? source.length : end);
}

const ANCHORS = {
  assign: ['async assignTask({ task_id, agent_id }) {', 'async acceptTask({ task_id, note }) {'],
  accept: ['async acceptTask({ task_id, note }) {', 'async cancelTask({ task_id, reason }) {'],
  cancel: ['async cancelTask({ task_id, reason }) {', '\n    async '],
  ret: ["if (path === '/return') {", "if (path === '/dispatch') {"],
};

/* ── the file can be read, and the anchors still exist ────────────────── */

test('POSITIVE CONTROL: the shipped file is readable and non-trivial', () => {
  /*
   * Without this, every "X appears in slice Y" below passes vacuously the
   * moment the path is wrong or the file is empty -- a negative needs the
   * positive first, and this suite is almost all negatives.
   */
  assert.ok(source.length > 5000, `index.ts is ${source.length} bytes; that is not the real file`);
  assert.ok(source.includes('coordinatorStore'), 'this is not the coordinator entrypoint');
});

test('POSITIVE CONTROL: every anchor this file slices on still exists', () => {
  /*
   * A rename is the way a source-scanning suite dies quietly: the slice comes
   * back empty, nothing is found, and "no forbidden pattern present" reads as
   * a pass. Fail on the rename instead, and say which one.
   */
  const missing = [];
  for (const [name, [from]] of Object.entries(ANCHORS)) {
    if (!source.includes(from)) missing.push(`${name}: ${from}`);
  }
  assert.deepEqual(missing, [], `anchors gone -- re-point this file rather than deleting it:\n  ${missing.join('\n  ')}`);
});

/* ── the claim is reached on the live assign path ─────────────────────── */

test('assignTask reaches claim_task', () => {
  const body = slice(...ANCHORS.assign);
  assert.ok(body, 'assignTask not found');
  assert.match(
    body,
    /rpc\(\s*'claim_task'/,
    'assignTask does not name claim_task. The atomic claim exists in Postgres and is '
      + 'reached by nothing -- which is the defect this change exists to close.',
  );
});

test('assignTask no longer writes the assignment through a state predicate', () => {
  /*
   * The predicate was the patch over the race, not the answer. Leaving it in
   * place beside the claim would mean two writers for one transition, and the
   * one that ran first would decide -- with no way to tell from outside which
   * of them did.
   */
  const body = slice(...ANCHORS.assign);
  assert.doesNotMatch(
    body,
    /TASK_WRITE_EXPECTS\.assign/,
    'assignTask still performs the predicate PATCH as well as the claim',
  );
});

test('a refused claim surfaces its reason AND its detail', () => {
  const body = slice(...ANCHORS.assign);
  assert.match(body, /reason:\s*claim\.reason/, 'the refusal does not carry the reason code');
  assert.match(
    body,
    /detail:\s*claim\.detail/,
    'the refusal drops `detail`. The reason codes are deliberately coarse -- not-claimable '
      + 'merges "no such task" with "another transaction holds it" -- so detail is where the '
      + 'actionable part lives, and without it the caller is staring at a slug.',
  );
});

test('THE LEASE TOKEN REACHES THE CALLER', () => {
  /*
   * The whole fencing property rests on this one field. renew_lease and
   * return_with_lease accept nothing else, so a worker never told its token can
   * neither renew nor return: it is either reaped mid-flight or refused at
   * submission after doing all the work. An atomic claim whose token is
   * discarded is a lock with the key thrown away.
   */
  const body = slice(...ANCHORS.assign);
  assert.match(
    body,
    /claim\.lease_token/,
    'assignTask never reads lease_token off the claim',
  );
  /*
   * Scoped to the RETURNED OBJECT, not the function. The first version of this
   * line just searched the whole slice for `token: claim.lease_token`, which is
   * the same thing the assertion above already checks -- so it could only fail
   * when that one had failed first, and it guarded nothing of its own. Reading
   * the token and then not handing it back is precisely the failure mode worth
   * catching here.
   */
  // `[\s,{]` before the key is load-bearing: a bare `lease:` also matches the
  // tail of `unused_lease:`, and `\b` does not help because `_` is a word
  // character. Without the delimiter, renaming the field away still passed.
  const returnsIt =
    /return\s*\{[\s\S]{0,400}?[\s,{]lease:\s*\{[\s\S]{0,200}?token:\s*claim\.lease_token/
      .test(body);
  assert.ok(returnsIt, 'assignTask reads the lease token but does not return it to the caller');
});

test('the announcement runs AFTER the claim, and not at all if it was refused', () => {
  /*
   * Announcing an assignment that did not land is the same defect as reporting
   * success for a lost race -- the caller believes a worker was told, and the
   * worker was not. Ordering is the assertion; presence is not.
   */
  const body = slice(...ANCHORS.assign);
  const refusal = body.indexOf('if (!claim.ok)');
  const announce = body.indexOf("type: 'assignment'");
  assert.notEqual(refusal, -1, 'there is no early return on a refused claim');
  assert.notEqual(announce, -1, 'the assignment announcement is gone');
  assert.ok(
    refusal < announce,
    'the announcement is not behind the refusal check -- a refused claim would still announce',
  );
});

/* ── the return is fenced by the token ────────────────────────────────── */

test('/return reaches return_with_lease', () => {
  const body = slice(...ANCHORS.ret);
  assert.ok(body, '/return handler not found');
  assert.match(body, /rpc\(\s*'return_with_lease'/, '/return does not reach return_with_lease');
});

test('/return REQUIRES a lease token and offers no way around it', () => {
  /*
   * The token comparison IS the zombie catch: a worker whose lease expired
   * while it kept working is stopped here, before its commit is recorded as the
   * answer to a task somebody else now holds. A fallback to the old predicate
   * write when the token is absent would be a path every zombie can take by
   * simply not sending one -- a control that can be skipped by omitting a field
   * cannot be distinguished from its own absence.
   */
  const body = slice(...ANCHORS.ret);
  assert.match(body, /body\?\.lease_token/, '/return never reads a lease token from the body');
  assert.doesNotMatch(
    body,
    /TASK_WRITE_EXPECTS\.return/,
    '/return still has the predicate write available as a fallback, so a return with no '
      + 'lease token can still land and the fencing property is optional',
  );
});

/* ── the two sites with no RPC counterpart keep their predicates ──────── */

test('acceptTask keeps its state predicate', () => {
  /*
   * There is no accept_with_lease. Removing the predicate here because the
   * other sites lost theirs would take a guard away and replace it with
   * nothing -- the predicate is still the only thing standing between accept
   * and a stale decision.
   */
  const body = slice(...ANCHORS.accept);
  assert.ok(body, 'acceptTask not found');
  // The FILTER, not the bare constant: `TASK_WRITE_EXPECTS.accept` also appears
  // in the writeLanded call beside it, so asserting the name alone stays green
  // while the predicate is stripped off the query that actually writes.
  assert.match(
    body,
    /taskWriteFilter\(\s*task_id,\s*TASK_WRITE_EXPECTS\.accept\s*\)/,
    'acceptTask lost its state predicate',
  );
  assert.match(body, /writeLanded/, 'acceptTask no longer treats an empty result as a lost race');
});

test('cancelTask keeps its state predicate', () => {
  const body = slice(...ANCHORS.cancel);
  assert.ok(body, 'cancelTask not found');
  assert.match(
    body,
    /taskWriteFilter\(\s*task_id,\s*TASK_WRITE_EXPECTS\.cancel\s*\)/,
    'cancelTask lost its state predicate',
  );
  assert.match(body, /writeLanded/, 'cancelTask no longer treats an empty result as a lost race');
});

/* ── the reviewer eviction this change must not make reachable ────────── */

test('WIRING claim_review WITHOUT GATING claim_task ON THE REVIEW LEASE', async () => {
  /*
   * THE DEFECT, found by code-d and confirmed independently here by reading the
   * shipped definitions:
   *
   *   claim_task contains the string "review" ZERO times. It gates on the work
   *   lease, on state in (runnable, returned), and on dependencies.
   *
   *   release_review_lease is a BEFORE UPDATE trigger that nulls `reviewer`,
   *   `review_lease_token` and `review_lease_expires_at` whenever a row leaves
   *   the `returned` state.
   *
   * claim_task admits `returned` and sets `assigned`. So a worker claiming a
   * task a reviewer is holding SUCCEEDS -- no refusal, no reason -- and the
   * trigger destroys the reviewer's live lease as a side effect. Reviewers are
   * protected from each other by claim_review's `under-review` refusal and not
   * at all from workers, and the design reads as though they are protected from
   * both. Worse, nothing is addressed to the evicted reviewer: the reaper emits
   * review_lease_expired on a timeout, this path emits an ordinary `assigned`
   * row. The reviewer finds out at submission, when fencing refuses a token
   * that was superseded half an hour earlier.
   *
   * THE RULING, so this is a regression gate and not a placeholder. Danny has
   * since decided it: claim_task must REFUSE while a live review lease exists,
   * mirroring the `under-review` check claim_review already carries, with a
   * detail naming the reviewer and the expiry. The implementation is a
   * migration and is deliberately NOT part of d-lease-wiring -- that change
   * carries enough already. So what this assertion guards is a decided design
   * awaiting implementation, not an open question.
   *
   * WHY IT WAS STILL A TEST AND NOT A FIX WHEN IT WAS WRITTEN. Whether a worker
   * may ever evict a live reviewer was a design decision, and it should not
   * arrive as a side effect of a trigger nobody was thinking about. Inventing
   * an answer inside the wiring is exactly what would have buried it.
   *
   * WHY IT IS NOT REACHABLE TODAY, and why this file says so rather than
   * printing a green tick over it: `claim_review` and `renew_review_lease` have
   * NO CALLER anywhere outside migrations and tests, and nothing writes
   * `review_lease_token` -- src/hostedRegistry.mjs calls it "the reviewer lease
   * whose columns nothing wrote". A lease that cannot be taken cannot be
   * evicted. Routing assign through claim_task does not change that.
   *
   * So this assertion is VACUOUS TODAY BY CONSTRUCTION, and it fires the moment
   * somebody wires claim_review while claim_task still ignores the review
   * lease. That pairing is the release where the eviction goes live, and it is
   * the one thing about this that must not happen quietly.
   */
  const root = fileURLToPath(new URL('..', import.meta.url));
  const { readdir } = await import('node:fs/promises');

  const files = [];
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'test') continue;
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) await walk(p);
      else if (/\.(ts|mjs|js)$/.test(e.name)) files.push(p);
    }
  };
  await walk(root.replace(/[/\\]$/, ''));

  /*
   * POSITIVE CONTROL FOR THE SEARCH ITSELF. Found by code-d, and it is this
   * file's own class one turn further out:
   *
   *     a match is not evidence the code does it
   *     a non-zero exit is not evidence a test ran
   *     A NON-MATCH IS NOT EVIDENCE THE SEARCH RAN
   *
   * Everything below rests on `callers` being empty, and `callers` is built
   * from `files`. If `root` ever resolves wrongly -- this file moves, the URL
   * changes, a directory is renamed -- `files` is empty, `callers` is empty,
   * and the early return reports "claim_review has no callers" having read not
   * one byte. The assertion whose entire job is to fire the moment somebody
   * wires claim_review would be permanently, silently green.
   *
   * A COUNT ALONE IS NOT ENOUGH, because scanning the WRONG tree also yields a
   * count. So name a file the walk must have reached and something in it only
   * the real file contains.
   */
  assert.ok(files.length > 10, `the walk found ${files.length} files; it is scanning the wrong tree`);
  const entrypoint = files.find((p) => p.replace(/\\/g, '/').endsWith('supabase/functions/mcp/index.ts'));
  assert.ok(entrypoint, 'the walk never reached the edge entrypoint; the root is wrong');
  assert.match(
    await readFile(entrypoint, 'utf8'),
    /coordinatorStore/,
    'the file the walk found is not the coordinator entrypoint',
  );

  const callers = [];
  for (const p of files) {
    const text = codeOnly(await readFile(p, 'utf8'));
    if (/claim_review/.test(text)) callers.push(p.slice(root.length));
  }

  if (callers.length === 0) return; // vacuous, and now honestly so

  // claim_review is now reachable. The only thing that makes that safe is
  // claim_task refusing, or deliberately permitting, a live review lease --
  // and today it does not mention one.
  const migrations = fileURLToPath(new URL('../supabase/migrations', import.meta.url));
  const { readdir: listDir } = await import('node:fs/promises');
  let claimTaskBody = '';
  for (const name of await listDir(migrations)) {
    const text = await readFile(`${migrations}/${name}`, 'utf8');
    const at = text.indexOf('create or replace function public.claim_task');
    if (at === -1) continue;
    const end = text.indexOf('$fn$;', at);
    claimTaskBody = text.slice(at, end === -1 ? text.length : end);
  }

  assert.notEqual(claimTaskBody, '', 'claim_task is not defined in any migration');

  /*
   * SQL COMMENTS, STRIPPED SEPARATELY. codeOnly understands `//` and block
   * comments; SQL uses `--`, so it would not have touched them. code-d
   * measured the margin here and it was thin: claim_task is redefined in the
   * review migration and this loop takes the LAST definition, which is the
   * right behaviour -- but that later body happens not to contain the word
   * "review". Had it mentioned it in a comment, this gate would have been
   * permanently green while the eviction stayed live. It held by luck, which
   * is not a property worth keeping.
   */
  const claimTaskCode = claimTaskBody
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');

  assert.match(
    claimTaskCode,
    /review/,
    `claim_review is now reached from ${callers.join(', ')}, but claim_task still does not `
      + 'mention the review lease. In that combination a worker claiming returned work '
      + 'silently destroys a live reviewer lease through the release_review_lease trigger, '
      + 'and nothing is addressed to the reviewer -- it finds out when submission refuses a '
      + 'token superseded half an hour earlier. Decide whether a worker may evict a live '
      + 'reviewer before shipping both halves.',
  );
});

/* ── the seam: the handler's demand and the client's payload ──────────── */

test('THE CLIENT THAT RETURNS WORK SENDS THE TOKEN THE HANDLER DEMANDS', async () => {
  /*
   * THIS TEST IS EXPECTED TO BE RED, AND IT IS RED ON PURPOSE.
   *
   * It is not a discovered flake and it is not something to skip. It records a
   * real, deploy-blocking gap that d-lease-wiring opened and cannot close from
   * inside its own allowed paths. Turning it green is the acceptance criterion
   * for the follow-up contract named in the failure message below.
   *
   * THE GAP. /return now requires `lease_token` and offers no fallback, which
   * is the correct design -- the token comparison IS the zombie catch, and a
   * path that accepts a return without one is a path every zombie takes by
   * omitting a field. But the only client that posts to /return is
   * `bin/agentbridge.mjs return-task`, and its body is
   *
   *     { task_id, session_id, head_sha, notes }
   *
   * with no token, because until this change there was none to send. So a
   * worker can CLAIM work and cannot HAND IT BACK: every return answers 400.
   *
   * WHY 930 GREEN TESTS SAID NOTHING ABOUT IT, which is the part worth keeping.
   * test/returnTaskCli.test.mjs asserts the client's payload against a STUBBED
   * endpoint. The rest of this file asserts the handler's requirements against
   * SOURCE. Both are correct, both are green, and neither can see the other.
   * Two halves, each internally right, disagreeing across a seam nothing spans
   * -- the same shape as the booking sheet and the phone agent reading
   * different sources for a fortnight. This assertion exists because it is the
   * only one in the suite that reads both halves and compares them.
   *
   * IT IS CONDITIONAL, DELIBERATELY. If the handler ever stops requiring a
   * token, this stops demanding one rather than nagging forever about a rule
   * that no longer exists. A test that outlives its premise gets deleted along
   * with whatever it was protecting.
   */
  const handler = slice(...ANCHORS.ret);
  assert.ok(handler, '/return handler not found');

  const handlerRequires = /body\?\.lease_token/.test(handler)
    && /lease_token is required/.test(raw.slice(source.indexOf(ANCHORS.ret[0])));
  if (!handlerRequires) return; // premise gone; nothing to couple

  const cli = codeOnly(
    await readFile(fileURLToPath(new URL('../bin/agentbridge.mjs', import.meta.url)), 'utf8'),
  );
  const start = cli.indexOf("if (cmd === 'return-task') {");
  assert.notEqual(start, -1, 'the return-task command is gone from the CLI');
  const end = cli.indexOf("if (cmd === '", start + 30);
  const block = cli.slice(start, end === -1 ? cli.length : end);

  /*
   * THE PAYLOAD FIELD, not the word. A bare /lease_token/ also matches the
   * `--lease is required` message the command prints, so deleting the field
   * from the request body left this limb green -- the check was reading help
   * text. Caught by the control that removes the field and requires THIS limb
   * to be the one that fails.
   */
  assert.match(
    block,
    /lease_token:\s*args\.lease/,
    'The handler requires lease_token and `agentbridge return-task` does not send it '
      + 'in the request body. Every return answers 400 and a worker that claimed work '
      + 'cannot hand it back.',
  );

  /*
   * THE SECOND LIMB, AND THE REASON THIS TEST DID NOT GO GREEN WHEN THE CLIENT
   * LEARNED TO SEND A TOKEN.
   *
   * Sending a credential you cannot obtain is not a closed loop. A worker holds
   * a REGISTRATION token, and that reaches exactly three endpoints: /register,
   * /wait and /return. None of them hands it a lease token --
   *
   *   /wait      eventsFor filters to the worker's own session (correct) and
   *              emits { kind, at, task_id, lane_id, repo_id }. Its own comment
   *              says "enough to know WHICH task, never enough to act without
   *              reading it". No token.
   *   /register  answers with registration state, not tasks.
   *   /return    is the thing demanding the token.
   *
   * and the MCP read surface that could show the row needs a coordinator or
   * reader token, so a worker gets 401 there. The announcement is
   * `Assigned <id>: <title>` and carries nothing either.
   *
   * So the token is minted in the COORDINATOR's assign response, and the
   * coordinator and the worker are different processes. Nothing carries it
   * across. Persisting it on the coordinator's side would only work while both
   * happen to be the same machine, which is precisely the assumption the
   * session registry, heartbeats and repo/worktree ids exist to remove -- it
   * would work today and break silently the first time the system did what it
   * was built for.
   *
   * WHERE THE FIX GOES, and it is small: the `assigned` event in
   * src/events.mjs. It already filters to `t.assigned_session === session_id`,
   * which is exactly the fencing scope -- only the session that holds the lease
   * would receive the token -- and /wait already fetches `tasks?select=*`, so
   * the value is in hand and is being dropped. Both that file and
   * supabase/functions/** are outside the client-half contract's allowed paths.
   */
  const events = codeOnly(
    await readFile(fileURLToPath(new URL('../src/events.mjs', import.meta.url)), 'utf8'),
  );
  const assignedEvent = events.slice(
    events.indexOf("kind: 'assigned'"),
    events.indexOf("kind: 'cancelled'"),
  );

  assert.match(
    assignedEvent,
    /lease/,
    'THE LOOP STILL DOES NOT CLOSE, and the missing half is now DELIVERY, not the '
      + 'client. `agentbridge return-task` sends lease_token, but nothing ever tells a '
      + 'worker what its token is: a registration token reaches only /register, /wait '
      + 'and /return, the MCP read surface 401s it, and the `assigned` event carries '
      + 'task_id, lane_id and repo_id with no lease.\n\n'
      + 'WHAT CLOSES THIS: the `assigned` event in src/events.mjs carries the lease '
      + 'token for the task it names. eventsFor already filters to the worker\'s own '
      + 'session, so that is the correct scope -- only the lease holder is told -- and '
      + '/wait already selects the column and discards it.\n\n'
      + 'DO NOT SOLVE THIS BY PERSISTING THE TOKEN CLIENT-SIDE AT ASSIGN TIME. The '
      + 'coordinator assigns and the worker returns; they are different processes, and '
      + 'a local store only works while they share a machine -- which is the assumption '
      + 'the session registry exists to remove.\n\n'
      + 'DO NOT SOLVE IT BY LETTING /return ACCEPT A MISSING TOKEN. That path is the '
      + 'one every zombie takes by omitting a field.\n\n'
      + 'DO NOT SKIP OR DELETE THIS. It is the only assertion in the suite that reads '
      + 'the handler, the client AND the delivery; returnTaskCli.test.mjs checks the '
      + 'client against a stub and cannot see any of the others.',
  );
});

/* ── the RPC answer is checked before it is believed ──────────────────── */

test('an RPC answer that is not the documented shape is refused, not believed', () => {
  /*
   * A `revoke` binds to a signature, and any migration that drops one of these
   * functions and recreates it with different arguments gets a brand-new
   * function. PostgREST then answers 404 -- or worse, resolves a different
   * overload and returns something that is not the { ok } object. Without an
   * explicit shape check a null body reads as falsy and every claim silently
   * "fails", or an unexpected object reads as truthy and every claim silently
   * "succeeds". The second hands out work nobody holds.
   */
  assert.match(
    source,
    /typeof\s+\w+\.ok\s*!==\s*'boolean'/,
    'nothing verifies that an RPC answer actually carries a boolean `ok`',
  );
});
