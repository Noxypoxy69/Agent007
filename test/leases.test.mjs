import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  leaseState, isLeaseLive, canClaim, canRenew, canReturnWithLease,
  shouldActOnEvent, expiredLeases, dedupeEscalations,
  DEFAULT_LEASE_MS, MIN_LEASE_MS, MAX_LEASE_MS, CLAIMABLE_FROM,
} from '../src/leases.mjs';

/**
 * THE SIX FAILURE MODES, EACH PROVED RATHER THAN ASSERTED.
 *
 *   1. duplicate delivery
 *   2. two schedulers racing
 *   3. lost publish after DB commit
 *   4. zombie late result
 *   5. reviewer death
 *   6. deduplicated owner escalation
 *
 * Five are provable here, against the pure guards. The third is structural --
 * the outbox row is written in the same transaction as the claim, so it cannot
 * be lost -- and what IS provable here is the consequence: delivery becomes
 * at-least-once, so no consumer may trust an event body. That is the test.
 */

const NOW = '2026-09-15T22:00:00.000Z';
const at = (offsetMs) => new Date(Date.parse(NOW) + offsetMs).toISOString();
const MIN = 60_000;

const TOKEN = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SHA = 'a'.repeat(40);

const task = (over = {}) => ({
  task_id: 't1',
  state: 'assigned',
  assigned_agent: 'code-b',
  assigned_session: 'danny-win-f1',
  lease_token: TOKEN,
  lease_expires_at: at(10 * MIN),
  attempt: 1,
  depends_on: [],
  ...over,
});

const worker = (over = {}) => ({ agent_id: 'code-b', session_id: 'danny-win-f1', ...over });

// ── lease state ────────────────────────────────────────────────────────────
test('EXPIRED IS NOT NONE, because the attempt history matters', () => {
  /*
   * Collapsing them would make a crash-loop indistinguishable from fresh work:
   * the same task claimed for the fifth time would look like the first.
   */
  assert.equal(leaseState(task(), { now: NOW }), 'live');
  assert.equal(leaseState(task({ lease_expires_at: at(-1) }), { now: NOW }), 'expired');
  assert.equal(leaseState(task({ lease_token: null }), { now: NOW }), 'none');
  assert.equal(leaseState(task({ lease_expires_at: null }), { now: NOW }), 'none');
  assert.equal(isLeaseLive(task(), { now: NOW }), true);
});

test('the clock is required and never guessed', () => {
  assert.throws(() => leaseState(task(), {}), /requires a `now` timestamp/);
  assert.throws(() => expiredLeases([], {}), /requires a `now` timestamp/);
});

// ── 2. TWO SCHEDULERS RACING ───────────────────────────────────────────────
test('PROOF 2: a live lease held by another session blocks a second claimer', () => {
  /*
   * The database stops the simultaneous case with FOR UPDATE SKIP LOCKED. This
   * is the sequential case it cannot see: the second claimer arrives a moment
   * later, reads a perfectly valid row, and must still be refused.
   */
  const held = task({ state: 'runnable', assigned_session: 'danny-win-10' });
  const r = canClaim(held, worker({ session_id: 'danny-win-f1' }), { now: NOW });

  assert.equal(r.ok, false, 'a second worker claimed work somebody else holds');
  assert.match(r.errors.join(' '), /held by danny-win-10/);
});

test('PROOF 2b: the SAME session may re-claim its own live lease', () => {
  // A worker retrying after a lost response is not a second claimer. Refusing
  // it would strand the work until the lease expired, for no safety gained.
  const mine = task({ state: 'runnable', assigned_session: 'danny-win-f1' });
  assert.equal(canClaim(mine, worker(), { now: NOW }).ok, true);
});

test('an EXPIRED lease does not block ONCE THE REAPER HAS RUN', () => {
  /*
   * READ THE STATE IN THIS FIXTURE BEFORE BELIEVING THE TITLE. It is `runnable`,
   * which is the POST-REAPER shape: the sweep has already returned the row to
   * the pool. This test says nothing whatever about the moment the holder dies.
   *
   * The original title was "an EXPIRED lease does not block: that is what an
   * expiry is for", and it was over-promising in a way that mattered. code-d
   * found the gap by probing the database: an expired lease does NOT make work
   * claimable on its own, because claim_task admits only runnable and returned
   * and an expiry leaves the row in `assigned`. Its first fencing probe failed
   * at the second claim with reason `state` for exactly this reason.
   *
   * So the pre-reaper case was untestable here by construction -- the fixture
   * could not express it -- and a reader would have taken this as proof of
   * automatic recovery, which is precisely what did not exist while the reaper
   * sat unscheduled. The next test expresses it.
   */
  const swept = task({ state: 'runnable', assigned_session: 'danny-win-10', lease_expires_at: at(-1) });
  assert.equal(canClaim(swept, worker(), { now: NOW }).ok, true,
    'work whose holder died stayed locked to the grave even after the sweep');
});

test('PRE-REAPER: an expired lease on an ASSIGNED row is NOT claimable — and that is the SQL too', () => {
  /*
   * THE SHAPE THE OTHER TEST COULD NOT EXPRESS, pinned so the two
   * implementations are visibly the same rather than accidentally the same.
   *
   * The instant a worker dies its row is `assigned` with an expired lease.
   * Nothing recovers it. canClaim refuses on state; claim_task refuses on state,
   * with reason `state`. They AGREE -- which is the good news, and which nothing
   * at either site said out loud, so agreeing looked identical to diverging.
   *
   * WHAT THIS MEANS, IN code-d's WORDS, WHICH ARE BETTER THAN MINE: while the
   * reaper was unscheduled, expired work was STRANDED PERMANENTLY. Not "recovery
   * was slower" -- claim_task would not pick it up, whoever asked. I wrote that
   * migration up as a missing convenience and it was a missing recovery path.
   *
   * SO THIS TEST IS A DEPENDENCY DECLARATION. The lease layer's recovery
   * property lives in reconcile_leases running on its schedule, NOT in the
   * expiry timestamp. If that cron job is ever removed, this comment is where
   * the reason it existed is written down.
   */
  const justDied = task({ state: 'assigned', assigned_session: 'danny-win-10', lease_expires_at: at(-1) });
  const r = canClaim(justDied, worker(), { now: NOW });

  assert.equal(r.ok, false,
    'an expired lease made assigned work claimable here while the SQL refuses it — the two have diverged');
  assert.match(r.errors.join(' '), /assigned/,
    'the refusal did not name the state, which is the only thing that explains why an expiry was not enough');
});

test('only runnable or returned work is claimable', () => {
  assert.deepEqual(CLAIMABLE_FROM, ['runnable', 'returned']);
  for (const state of ['assigned', 'accepted', 'cancelled', 'blocked']) {
    const r = canClaim(task({ state, lease_token: null }), worker(), { now: NOW });
    assert.equal(r.ok, false, state);
  }
});

test('dependencies are checked, and an unsatisfied one refuses the claim', () => {
  const t = task({ state: 'runnable', lease_token: null, depends_on: ['dep'] });
  const withDep = (s) => canClaim(t, worker(), { now: NOW, tasks: [{ task_id: 'dep', state: s }] });

  assert.equal(withDep('accepted').ok, true);
  assert.match(withDep('returned').errors.join(' '), /is "returned" and not accepted/);
  assert.match(canClaim(t, worker(), { now: NOW, tasks: [] }).errors.join(' '), /does not exist/);
});

test('a lease outside the bounds is refused in both directions', () => {
  const t = task({ state: 'runnable', lease_token: null });
  assert.equal(canClaim(t, worker(), { now: NOW, leaseMs: MIN_LEASE_MS - 1 }).ok, false);
  assert.equal(canClaim(t, worker(), { now: NOW, leaseMs: MAX_LEASE_MS + 1 }).ok, false);
  assert.equal(canClaim(t, worker(), { now: NOW, leaseMs: DEFAULT_LEASE_MS }).ok, true);
});

// ── 4. ZOMBIE LATE RESULT ──────────────────────────────────────────────────
test('PROOF 4: a superseded token cannot return work, however plausible the clock', () => {
  /*
   * THE test for fencing. The worker died, its lease expired, the task was
   * re-claimed by somebody else (new token, fresh expiry), and the original
   * worker came back holding a finished commit. Its write must be refused --
   * accepting it would overwrite live work with the output of a run nobody is
   * waiting for.
   *
   * Note the lease on the row is LIVE. Time alone would let this through; only
   * the token catches it.
   */
  const reclaimed = task({ lease_token: OTHER, lease_expires_at: at(10 * MIN) });
  const r = canReturnWithLease(reclaimed, { token: TOKEN, headSha: SHA, now: NOW });

  assert.equal(r.ok, false, 'a zombie wrote a result for work that had moved on');
  assert.match(r.errors.join(' '), /superseded/);
});

test('PROOF 4b: an expired-but-matching token is also refused', () => {
  const stale = task({ lease_expires_at: at(-1) });
  const r = canReturnWithLease(stale, { token: TOKEN, headSha: SHA, now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /expired/);
});

test('a current lease returns work normally', () => {
  assert.equal(canReturnWithLease(task(), { token: TOKEN, headSha: SHA, now: NOW }).ok, true);
});

test('a return still carries a real commit or it is not a return', () => {
  for (const headSha of [null, '', 'HEAD', 'abc123']) {
    const r = canReturnWithLease(task(), { token: TOKEN, headSha, now: NOW });
    assert.equal(r.ok, false, String(headSha));
  }
});

test('renewal is compare-and-set, and an expired lease is not renewable', () => {
  assert.equal(canRenew(task(), { token: TOKEN, now: NOW }).ok, true);
  assert.match(canRenew(task(), { token: OTHER, now: NOW }).errors.join(' '), /superseded/);
  assert.match(
    canRenew(task({ lease_expires_at: at(-1) }), { token: TOKEN, now: NOW }).errors.join(' '),
    /expired/,
  );
});

// ── 1 & 3. DUPLICATE DELIVERY, AND WHY THE BODY IS NEVER TRUSTED ───────────
test('PROOF 1: the same event delivered twice acts once', () => {
  /*
   * The outbox commits with the claim, so an event is never lost -- and is
   * therefore sometimes delivered twice. The second delivery must be a no-op.
   */
  const t = task();
  const event = { kind: 'assigned', task_id: 't1', lease_token: TOKEN };

  assert.equal(shouldActOnEvent(event, t, { now: NOW }).act, true);

  const second = { ...event, delivered_at: at(1000) };
  assert.equal(shouldActOnEvent(second, t, { now: NOW }).act, false);
});

test('PROOF 3: the consumer re-reads and compares the TOKEN, not the body', () => {
  /*
   * The delivered_at flag is advisory only -- at-least-once means that flag can
   * itself be written twice. The load-bearing check is that the event's token
   * still matches the row. An event replayed from the outbox hours later, with
   * delivered_at never set, must still be refused once the claim has moved on.
   */
  const replayed = { kind: 'assigned', task_id: 't1', lease_token: TOKEN };
  const movedOn = task({ lease_token: OTHER });

  const r = shouldActOnEvent(replayed, movedOn, { now: NOW });
  assert.equal(r.act, false, 'a consumer acted on an event body without checking the row');
  assert.equal(r.reason, 'superseded-claim');
});

test('an event about a task that has since been accepted is not acted on', () => {
  const event = { kind: 'assigned', task_id: 't1', lease_token: TOKEN };
  const done = task({ state: 'accepted' });
  assert.equal(shouldActOnEvent(event, done, { now: NOW }).act, false);
});

test('an event for a different task is never acted on', () => {
  const event = { kind: 'assigned', task_id: 'other', lease_token: TOKEN };
  assert.equal(shouldActOnEvent(event, task(), { now: NOW }).reason, 'event-is-about-another-task');
});

test('an unknown event kind is refused rather than assumed harmless', () => {
  const r = shouldActOnEvent({ kind: 'deploy', task_id: 't1' }, task(), { now: NOW });
  assert.equal(r.act, false);
  assert.match(r.reason, /unknown-kind:deploy/);
});

// ── 5. REVIEWER DEATH ──────────────────────────────────────────────────────
test('PROOF 5: work whose holder died returns to the pool, carrying its attempt count', () => {
  /*
   * Exactly what happened three times today: the process was killed and nothing
   * noticed. The lease expiring is what makes it recoverable WITHOUT a person,
   * and the attempt count is what stops a crash-loop looking like fresh work.
   */
  const rows = [
    task({ task_id: 'dead', lease_expires_at: at(-5 * MIN), attempt: 3 }),
    task({ task_id: 'alive' }),
    task({ task_id: 'done', state: 'accepted', lease_expires_at: at(-MIN) }),
  ];

  const lost = expiredLeases(rows, { now: NOW });
  assert.deepEqual(lost.map((l) => l.task_id), ['dead'], 'the wrong set was reclaimed');
  assert.equal(lost[0].attempt, 3);
  assert.equal(lost[0].session_id, 'danny-win-f1');
  assert.equal(lost[0].lease_token, TOKEN);
});

test('a lease_expired event is ignored once somebody has re-claimed the work', () => {
  const event = { kind: 'lease_expired', task_id: 't1', lease_token: TOKEN };
  assert.equal(shouldActOnEvent(event, task({ state: 'runnable' }), { now: NOW }).act, true);
  assert.equal(shouldActOnEvent(event, task({ state: 'assigned' }), { now: NOW }).act, false);
});

// ── 6. DEDUPLICATED OWNER ESCALATION ───────────────────────────────────────
test('PROOF 6: sixty identical escalations reach the owner as one, with a count', () => {
  /*
   * A reconciliation loop running every minute produces one escalation per
   * minute. Sending the owner the same sentence sixty times is how a channel
   * gets muted -- and a muted channel is worse than no channel, because it
   * looks like it is working.
   */
  const many = Array.from({ length: 60 }, (_, i) => ({
    task_id: 't-42', reason: 'lease expired 3 times', at: at(-i * MIN),
  }));

  const out = dedupeEscalations(many, { now: NOW });
  assert.equal(out.length, 1, 'the owner was going to be paged sixty times');
  assert.equal(out[0].occurrences, 60, 'the repetition was hidden instead of counted');
  assert.equal(out[0].last_at, at(0));
  assert.equal(out[0].first_at, at(-59 * MIN));
});

test('different reasons on one task stay separate decisions', () => {
  // Collapsing these would hide the second problem behind the first.
  const out = dedupeEscalations([
    { task_id: 't-42', reason: 'lease expired 3 times', at: at(-MIN) },
    { task_id: 't-42', reason: 'dependency never accepted', at: at(-2 * MIN) },
  ], { now: NOW });
  assert.equal(out.length, 2);
});

test('escalations outside the window are dropped, not counted forever', () => {
  const out = dedupeEscalations([
    { task_id: 't-42', reason: 'x', at: at(-2 * 60 * MIN) },
    { task_id: 't-42', reason: 'x', at: at(-MIN) },
  ], { now: NOW, windowMs: 60 * MIN });
  assert.equal(out[0].occurrences, 1, 'an hours-old escalation inflated today\'s count');
});

test('malformed escalations are skipped rather than paging the owner about nothing', () => {
  const out = dedupeEscalations([
    null, {}, { task_id: 't' }, { reason: 'r' }, { task_id: 't', reason: 'r', at: 'whenever' },
  ], { now: NOW });
  assert.deepEqual(out, []);
});
