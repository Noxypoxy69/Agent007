import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRequest, riskOf, requestKey, pendingRequests, pausedTasks,
  RISK, DECIDER, OWNER_ONLY_PREFIXES, hasPrefix,
} from '../src/permissionRequest.mjs';

/**
 * NO LOCAL KEYPRESS, AND NOTHING APPROVING ITSELF.
 *
 * chatgpt-work, 21:58:17Z: "interactive Claude permission prompts are a blocking
 * defect, not an owner workflow." A keypress is not a control; it is a person
 * BEING the control, and the person is asleep or on another machine while the
 * agent is stopped.
 *
 * The two properties these tests exist to hold:
 *
 *   UNKNOWN IS NEVER ROUTINE. An action nobody classified must fail toward the
 *   owner, not toward the coordinator. Failing the other way is how a new
 *   capability gets waved through for being unfamiliar.
 *
 *   THIS MODULE NEVER GRANTS. It says WHO DECIDES. The moment the thing asking
 *   for permission can answer itself, every guard downstream is decoration.
 */

const NOW = '2026-09-15T23:30:00.000Z';
const at = (off) => new Date(Date.parse(NOW) + off).toISOString();
const MIN = 60_000;

/*
 * THE `...over` ON THE LAST LINE IS LOAD-BEARING AND THE FIRST DRAFT OMITTED IT.
 *
 * Without it this helper ignored every argument and returned the same ALLOW
 * decision to every caller, so `decision({ effect: 'deny' })` was an allow. Two
 * tests failed and would have looked like bugs in the module; the module was
 * right both times.
 *
 * A fixture that silently discards its parameters is the same failure as a
 * guard reading a column nothing writes: it runs, it reports, and it is
 * describing something other than what was asked. The only reason it surfaced
 * is that the assertions were specific -- `allowed === false` rather than
 * "decided somehow".
 */
const decision = (over = {}) => ({
  decision_id: 'd1', owner_id: 'danny', decision_type: 'policy',
  statement: 'routine staging work is fine', scope_type: 'bridge', scope_id: null,
  effect: 'allow', capabilities: ['deploy.staging'], constraints: {},
  created_at: at(-60 * MIN), created_by: 'danny', supersedes: null,
  revoked_at: null, revoked_by: null, history: [],
  ...over,
});

// ── risk ───────────────────────────────────────────────────────────────────
test('UNKNOWN ACTIONS ARE NOT ROUTINE', () => {
  /*
   * The direction of failure is the whole design. One extra coordinator
   * approval is cheap; a capability nobody reviewed slipping through because it
   * was unfamiliar is not.
   */
  assert.equal(riskOf('something.nobody.classified'), RISK.ELEVATED);
  assert.equal(riskOf(''), RISK.IRREVERSIBLE);
  assert.equal(riskOf(null), RISK.IRREVERSIBLE);
});

test('irreversible, destructive and spending actions are owner-only', () => {
  for (const a of ['deploy.production', 'delete.table', 'drop.schema',
    'truncate.messages', 'spend.cloudflare', 'rotate.service_key',
    'revoke.token', 'customer.message.send', 'merge.main']) {
    assert.equal(riskOf(a), RISK.IRREVERSIBLE, a);
  }
});

test('an explicit reversible:false RAISES — the one direction a caller is believed', () => {
  // A caller that knows its action cannot be undone outranks the prefix table,
  // because that declaration argues against its own interest.
  assert.equal(riskOf('write.file', { reversible: false }), RISK.IRREVERSIBLE);
});

test('reversible:true LOWERS NOTHING, not even an unrecognised action', () => {
  /*
   * THIS ASSERTION IS THE FIX FOR THE ESCALATION BELOW, and it used to say the
   * opposite: riskOf('write.file', { reversible: true }) was asserted to be
   * ROUTINE. That was the bug written down as a requirement.
   *
   * `reversible: true` is self-serving evidence, so it is not believed in the
   * direction that helps the caller. ROUTINE is now reachable only through
   * ROUTINE_PREFIXES, which this module decides.
   */
  assert.equal(riskOf('write.file', { reversible: true }), RISK.ELEVATED,
    'a caller talked its own unrecognised action down to routine');
  assert.equal(riskOf('nobody.classified.this', { reversible: true }), RISK.ELEVATED);

  // And the allow-list still works, so this is a narrowing rather than a wall.
  assert.equal(riskOf('run.tests'), RISK.ROUTINE);
  assert.equal(riskOf('read.file'), RISK.ROUTINE);
});

test('reversible:true CANNOT downgrade an owner-only action', () => {
  /*
   * The important asymmetry. A caller may raise its own risk classification and
   * may never lower it past the owner-only list -- otherwise any component
   * could self-declare its way out of the owner's gate, which is the whole
   * escalation this design exists to prevent.
   */
  for (const a of ['deploy.production', 'spend.anything', 'delete.everything']) {
    assert.equal(riskOf(a, { reversible: true }), RISK.IRREVERSIBLE,
      `${a} was downgraded by a caller declaring it reversible`);
  }
});

test('AND IT CANNOT BE DOWNGRADED BY CAPITALISING A LETTER', () => {
  /*
   * ═══ THE TEST ABOVE PASSED WHILE THE PROPERTY IT NAMES WAS FALSE ═══
   *
   * It tried three actions, all in exact lower case, and concluded that a
   * caller could not self-declare past the owner's gate. code-d probed the real
   * module and found six spellings that did exactly that:
   *
   *     Deploy.Production  reversible:true  ->  routine   COORDINATOR
   *     DEPLOY.PRODUCTION  reversible:true  ->  routine   COORDINATOR
   *     deploy.Production  reversible:true  ->  elevated  COORDINATOR
   *     Delete.everything  reversible:true  ->  routine   COORDINATOR
   *     DROP.table_users   reversible:true  ->  routine   COORDINATOR
   *     Merge.main         reversible:true  ->  routine   COORDINATOR
   *
   * Every one is a production deploy, a destructive action or a merge to main
   * arriving at the coordinator instead of at Danny. The owner decision ledger
   * records him as final authority for exactly these, so this was the confused
   * deputy the module was written to prevent -- shipped inside a commit whose
   * message was about a module finally not being a good-looking nothing.
   *
   * WHY THE OLD TEST COULD NOT SEE IT. It asserted the property using only
   * inputs that already worked. Same family as every other hollow gate today:
   * the assertion and the risk were about different things. A property about
   * what a HOSTILE caller can do has to be tested with inputs a hostile caller
   * would pick, and "the same string with a capital letter" is the first thing
   * anyone would try.
   *
   * So this test carries the adversarial spellings, permanently.
   */
  const RESPELLINGS = [
    'Deploy.Production', 'DEPLOY.PRODUCTION', 'deploy.Production', 'dEpLoY.pRoDuCtIoN',
    'Delete.everything', 'DELETE.EVERYTHING', 'DROP.table_users', 'Drop.Schema',
    'Merge.main', 'MERGE.MAIN', 'Spend.cloudflare', 'SPEND.anything',
    'Rotate.service_key', 'REVOKE.token', 'Truncate.messages', 'Customer.Message.send',
  ];

  for (const a of RESPELLINGS) {
    assert.equal(riskOf(a, { reversible: true }), RISK.IRREVERSIBLE,
      `"${a}" escaped the owner-only list by respelling`);
    assert.equal(
      classifyRequest({ action: a, reversible: true }, [], { now: NOW }).decider,
      DECIDER.OWNER,
      `"${a}" was routed to the coordinator instead of the owner`);
  }

  // Leading and trailing whitespace must not be a way out either.
  assert.equal(riskOf('  DEPLOY.production  ', { reversible: true }), RISK.IRREVERSIBLE);
});

test('a mixed-case entry in the LIST would still match too', () => {
  /*
   * Both sides are lowered, not just the action. Lowering only the action would
   * leave a trap for the next person who adds "Deploy.Production" to the
   * owner-only list and finds it silently matches nothing.
   */
  assert.ok(OWNER_ONLY_PREFIXES.every((p) => p === p.toLowerCase()),
    'the list drifted out of lower case; hasPrefix lowers both sides, so this is belt-and-braces');
});

test('deploy.staging is elevated but deploy.production is not merely elevated', () => {
  assert.equal(riskOf('deploy.staging'), RISK.ELEVATED);
  assert.equal(riskOf('deploy.production'), RISK.IRREVERSIBLE);
});

// ── routing ────────────────────────────────────────────────────────────────
test('POLICY FIRST: a decided action is not asked again', () => {
  /*
   * Asking again is not caution, it is failing to remember -- and it teaches
   * the owner that approvals are noise to click through, which is how a real
   * one gets clicked through too.
   */
  const r = classifyRequest({ action: 'deploy.staging', reversible: true },
    [decision()], { now: NOW });

  assert.equal(r.decider, DECIDER.POLICY);
  assert.equal(r.allowed, true);
  assert.equal(r.decision_id, 'd1');
});

test('a DENIED policy is also a decision — it does not fall through to a human', () => {
  const denied = decision({ decision_id: 'd2', effect: 'deny', capabilities: ['deploy.staging'] });
  const r = classifyRequest({ action: 'deploy.staging' }, [denied], { now: NOW });

  assert.equal(r.decider, DECIDER.POLICY);
  assert.equal(r.allowed, false, 'a denial was not carried as a decision');
});

test('AN EXPLICIT owner_required OUTRANKS THIS MODULE\'S RISK OPINION', () => {
  /*
   * A standing instruction from the owner beats the prefix table. If they said
   * "ask me about this", a classification of ROUTINE must not route around it.
   */
  const gate = decision({
    decision_id: 'd3', effect: 'require_owner', capabilities: ['commit'],
  });
  const r = classifyRequest({ action: 'commit', reversible: true }, [gate], { now: NOW });

  assert.equal(r.decider, DECIDER.OWNER);
  assert.equal(r.risk, RISK.ROUTINE, 'the risk class was correct and still did not decide');
  assert.match(r.reason, /standing decision requires them personally/);
});

test('undecided routine work goes to the coordinator, not the owner', () => {
  const r = classifyRequest({ action: 'run.tests', reversible: true }, [], { now: NOW });
  assert.equal(r.decider, DECIDER.COORDINATOR);
});

test('undecided IRREVERSIBLE work goes to the owner and nowhere else', () => {
  const r = classifyRequest({ action: 'deploy.production' }, [], { now: NOW });
  assert.equal(r.decider, DECIDER.OWNER);
  assert.match(r.reason, /may not approve it on the owner/);
});

test('a request naming no action is the owner\'s, not a retryable error', () => {
  const r = classifyRequest({}, [], { now: NOW });
  assert.equal(r.decider, DECIDER.OWNER);
  assert.equal(r.risk, RISK.IRREVERSIBLE);
});

test('the clock is required and never guessed', () => {
  assert.throws(() => classifyRequest({ action: 'x' }, []), /requires a `now` timestamp/);
  assert.throws(() => pendingRequests([], {}), /requires a `now` timestamp/);
  assert.throws(() => pausedTasks([], {}), /requires a `now` timestamp/);
});

// ── deduplication ──────────────────────────────────────────────────────────
test('THE SAME QUESTION ASKED SIXTY TIMES IS ONE OUTSTANDING ASK', () => {
  /*
   * A worker in a retry loop asks identically every attempt. The decision is
   * unchanged; only the count is news. Sixty prompts is how an approval channel
   * becomes one people mute.
   */
  const key = requestKey({ action: 'deploy.staging', task_id: 't1' });
  const many = Array.from({ length: 60 }, (_, i) => ({
    key, action: 'deploy.staging', task_id: 't1', decider: DECIDER.COORDINATOR,
    requested_at: at(-i * MIN),
  }));

  const out = pendingRequests(many, { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].occurrences, 60, 'the repetition was hidden rather than counted');
});

test('THE KEY IGNORES ATTEMPT AND TIME, so a retry is the same question', () => {
  /*
   * If the attempt number or a clock reading were in the key, a crash-looping
   * worker would ask the owner the same thing three times and it would look
   * like three decisions.
   *
   * ASSERTED AS AN EXACT STRING, not as "two calls agree". The first version
   * compared two calls made in the same millisecond, so a Date.now() component
   * would have matched itself and the mutation adding one came back GREEN. Two
   * calls agreeing proves determinism only if enough time passes between them,
   * which a test cannot guarantee; pinning the value proves composition.
   */
  assert.equal(requestKey({ action: 'deploy.staging', task_id: 't1' }),
    'deploy.staging::t1::-');
  assert.equal(requestKey({ action: 'deploy.staging' }), 'deploy.staging::-::-');
  assert.equal(requestKey({ action: 'x', task_id: 't1', scope_id: 's1' }), 'x::t1::s1');
});

test('the same action on a DIFFERENT task is a different decision', () => {
  assert.notEqual(
    requestKey({ action: 'deploy.staging', task_id: 't1' }),
    requestKey({ action: 'deploy.staging', task_id: 't2' }),
  );
});

test('AN ANSWERED REQUEST IS NOT OUTSTANDING', () => {
  /*
   * Otherwise the owner's "waiting on you" list fills with things that are not,
   * and the one that matters is buried among them.
   */
  const key = requestKey({ action: 'spend.cloudflare' });
  const out = pendingRequests([
    { key, action: 'spend.cloudflare', decider: DECIDER.OWNER, requested_at: at(-5 * MIN) },
    { key, action: 'spend.cloudflare', decider: DECIDER.OWNER, requested_at: at(-2 * MIN),
      decided_at: at(-MIN), outcome: 'denied' },
  ], { now: NOW });

  assert.deepEqual(out, [], 'an answered question was still shown as waiting');
});

test('the OWNER\'S list sorts first — a person is waiting at the end of it', () => {
  const out = pendingRequests([
    { key: 'a', decider: DECIDER.COORDINATOR, requested_at: at(-MIN) },
    { key: 'b', decider: DECIDER.OWNER, requested_at: at(-30 * MIN) },
  ], { now: NOW });
  assert.equal(out[0].decider, DECIDER.OWNER,
    'a coordinator request sorted above the owner because it was more recent');
});

test('requests older than the window are dropped, not counted forever', () => {
  const out = pendingRequests([
    { key: 'a', decider: DECIDER.OWNER, requested_at: at(-48 * 60 * MIN) },
  ], { now: NOW, windowMs: 24 * 60 * MIN });
  assert.deepEqual(out, []);
});

// ── pausing ────────────────────────────────────────────────────────────────
test('ONLY THE TASK WITH THE OUTSTANDING REQUEST IS PAUSED', () => {
  /*
   * "Pauses only that task while awaiting a decision" was explicit, and it is
   * the difference between a permission system and a stop button. A worker
   * blocked on task A is still a live worker for task B.
   */
  const paused = pausedTasks([
    { key: 'a', task_id: 't1', requested_at: at(-MIN) },
    { key: 'b', task_id: 't2', requested_at: at(-MIN), decided_at: at(0) },
  ], { now: NOW });

  assert.deepEqual(paused, ['t1'], 'an answered request was still holding its task');
});

test('a request with NO task pauses nothing', () => {
  // A question about the environment has no task to hold, and inventing one
  // would stop work that was never involved.
  assert.deepEqual(pausedTasks([{ key: 'a', requested_at: at(-MIN) }], { now: NOW }), []);
});

// ── the line this module must never cross ──────────────────────────────────
test('NOTHING HERE GRANTS ANYTHING', () => {
  /*
   * classifyRequest returns WHO DECIDES. It has no approve(), no grant(), and
   * no path that turns an undecided owner-only request into an allowed one.
   * The moment the component asking for permission can answer itself, every
   * guard downstream is decoration.
   */
  const r = classifyRequest({ action: 'deploy.production' }, [], { now: NOW });
  assert.equal(r.allowed, undefined,
    'an undecided request carried an allowed flag, which is a grant by another name');
  assert.equal(r.decider, DECIDER.OWNER);

  // And the owner-only list cannot be emptied by a caller.
  assert.ok(OWNER_ONLY_PREFIXES.includes('deploy.production'));
  assert.ok(Object.isFrozen(OWNER_ONLY_PREFIXES));
});

test('hasPrefix LOWERS BOTH SIDES, so a mixed-case list entry still matches', () => {
  /*
   * WHY THIS TEST EXISTS RATHER THAN A COMMENT SAYING "BELT AND BRACES".
   *
   * The mutation "stop lowering the LIST side" came back GREEN. It was a
   * genuine no-op, because OWNER_ONLY_PREFIXES is entirely lower case today --
   * so the mutation changed no behaviour and green was the honest answer.
   *
   * But "untested because currently redundant" is how a protection quietly
   * stops being one. The redundancy holds only while every list stays lower
   * case, and the first person to add "Deploy.Production" to the deny-list
   * would otherwise find it silently matches NOTHING -- a deny-list entry that
   * denies nothing, which is the worst possible failure for this file.
   *
   * So the matcher is exercised directly with a mixed-case list, where the
   * mutation is no longer a no-op and goes red.
   */
  assert.equal(hasPrefix('deploy.production', ['Deploy.Production']), true,
    'a mixed-case DENY-LIST entry matched nothing, so adding one would silently disarm it');
  assert.equal(hasPrefix('DEPLOY.PRODUCTION', ['deploy.production']), true);
  assert.equal(hasPrefix('Delete.Everything', ['DELETE.']), true);

  // The positive control: it must still be capable of NOT matching.
  assert.equal(hasPrefix('deploy.staging', ['deploy.production']), false,
    'the matcher matches everything, so the assertions above prove nothing');
});
