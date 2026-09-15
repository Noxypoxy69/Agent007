import test from 'node:test';
import assert from 'node:assert/strict';
import {
  preflight, escalationKey, openEscalations, createEscalation, answerEscalation,
  REASK_AFTER_MS,
} from '../src/escalation.mjs';
import { resolveOwnerDecision, createDecision } from '../src/ownerDecisions.mjs';

/**
 * ASKED ONCE, NOT ASKED ONCE PER AGENT.
 *
 * The decision ledger already stops a question being asked twice across TIME.
 * This is the other half: five agents starting at once, all reaching
 * no_decision on the same question inside a minute, and all interrupting the
 * builder. The ledger is silent about that, because none of them has an answer
 * to find.
 */

const NOW = '2026-09-15T12:00:00.000Z';
const ago = (ms) => new Date(Date.parse(NOW) - ms).toISOString();

const decision = (over = {}) => createDecision({
  decision_id: 'd1', owner_id: 'danny', statement: 'a rule',
  scope_type: 'bridge', effect: 'allow', capabilities: ['deploy.production'],
  created_by: 'danny', created_at: ago(60_000), ...over,
});

const esc = (over = {}) => ({
  escalation_id: 'e1',
  action: 'deploy.production',
  context: { project: null, repo: null, lane: null, task: null },
  question: 'May I deploy?',
  asked_by: 'code-a',
  asked_at: ago(30_000),
  answered_at: null,
  decision_id: null,
  ...over,
});

const pre = (over = {}) => preflight({
  decisions: [], escalations: [], action: 'deploy.production', context: {},
  now: NOW, resolve: resolveOwnerDecision, ...over,
});

// ── the gap this closes ────────────────────────────────────────────────────
test('the FIRST worker to hit no_decision escalates', () => {
  const r = pre();
  assert.equal(r.outcome, 'escalate');
  assert.match(r.reason, /nobody has asked this yet/);
});

test('the SECOND worker is told it is already open and does NOT ask', () => {
  const r = pre({ escalations: [esc()] });
  assert.equal(r.outcome, 'already_escalated');
  assert.equal(r.escalation.asked_by, 'code-a');
  assert.match(r.reason, /do not ask again/);
});

test('a DIFFERENTLY WORDED question is still the same question', () => {
  /*
   * Matching is on action and scope, never on prose. Two agents will phrase
   * the same question differently -- that is precisely what makes duplicates
   * hard to spot by eye -- and matching on wording would let every reworded
   * duplicate through, which is the thing this exists to stop.
   */
  const r = pre({ escalations: [esc({ question: 'can i push to prod lol' })] });
  assert.equal(r.outcome, 'already_escalated');
});

test('a DIFFERENT action is not suppressed', () => {
  // The mirror, and the one that would hurt more: over-matching would silence
  // a real question nobody has asked.
  const r = pre({ action: 'deploy.staging', escalations: [esc()] });
  assert.equal(r.outcome, 'escalate');
});

test('the same action in a DIFFERENT scope is a different question', () => {
  const open = esc({ context: { project: null, repo: 'agentbridge', lane: null, task: null } });
  assert.equal(pre({ escalations: [open], context: { repo: 'agentbridge' } }).outcome, 'already_escalated');
  assert.equal(pre({ escalations: [open], context: { repo: 'social-sparks-app' } }).outcome, 'escalate');
});

// ── a decided question is never escalated at all ───────────────────────────
test('an ANSWERED question never reaches the escalation ledger', () => {
  for (const [effect, outcome] of [['allow', 'allowed'], ['deny', 'denied']]) {
    const r = pre({ decisions: [decision({ effect })], escalations: [esc()] });
    assert.equal(r.outcome, outcome, `effect ${effect}`);
    // Even with an open escalation sitting there, a decided question short
    // circuits: the ledger answered, so nobody is asked and nothing is opened.
    assert.equal(r.escalation, null);
  }
});

test('owner_required is an ANSWER, not a question to deduplicate', () => {
  /*
   * "This always needs me" is a decision the builder already made. The action
   * still goes to them, but as an escalation of THAT action -- and it is not
   * suppressed, because "may I do this specific thing now" is a different
   * question each time.
   */
  const r = pre({ decisions: [decision({ effect: 'require_owner' })], escalations: [esc()] });
  assert.equal(r.outcome, 'owner_required');
  assert.equal(r.escalation, null);
});

// ── staleness ──────────────────────────────────────────────────────────────
test('an unanswered question goes stale and MAY be raised again', () => {
  // A question the builder never answered eight hours ago is not a reason to
  // stay silent forever; they may simply have missed it.
  const stale = esc({ asked_at: ago(REASK_AFTER_MS + 60_000) });
  assert.equal(pre({ escalations: [stale] }).outcome, 'escalate');
  assert.equal(pre({ escalations: [esc({ asked_at: ago(REASK_AFTER_MS - 60_000) })] }).outcome, 'already_escalated');
});

test('an ANSWERED escalation does not suppress anything', () => {
  const answered = esc({ answered_at: ago(10_000), decision_id: 'd1' });
  // It is closed, so it is not open -- and with no decision matching, the next
  // worker asks. (In practice the decision that closed it would answer them.)
  assert.equal(pre({ escalations: [answered] }).outcome, 'escalate');
  assert.deepEqual(openEscalations([answered], { now: NOW }), []);
});

test('an escalation with an unreadable timestamp is not treated as open', () => {
  // Silence on the basis of a record we cannot date would be silence we cannot
  // justify.
  for (const at of [null, '', 'whenever']) {
    assert.deepEqual(openEscalations([esc({ asked_at: at })], { now: NOW }), []);
  }
});

// ── records ────────────────────────────────────────────────────────────────
test('an escalation must carry the question text', () => {
  const base = { escalation_id: 'e', action: 'a', question: 'q?', asked_by: 'w', asked_at: NOW };
  assert.equal(createEscalation(base).ok, true);
  // The builder has to read something, and the next worker needs to see how it
  // was put so they recognise the answer when it lands.
  assert.equal(createEscalation({ ...base, question: '' }).ok, false);
  assert.equal(createEscalation({ ...base, asked_by: '' }).ok, false);
  assert.equal(createEscalation({ ...base, action: '' }).ok, false);
});

test('an escalation is closed with a DECISION ID, never with prose', () => {
  const open = esc();
  const bad = answerEscalation(open, { decision_id: '', at: NOW });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /decision id, not prose/);

  const good = answerEscalation(open, { decision_id: 'd-prod-rule', at: NOW });
  assert.equal(good.ok, true);
  assert.equal(good.record.decision_id, 'd-prod-rule');
  assert.equal(good.record.answered_at, NOW);
  // The original question survives closing.
  assert.equal(good.record.question, open.question);
});

test('an escalation cannot be answered twice', () => {
  const closed = esc({ answered_at: ago(1000), decision_id: 'd1' });
  assert.equal(answerEscalation(closed, { decision_id: 'd2', at: NOW }).ok, false);
});

test('preflight REFUSES to run without the resolver', () => {
  // The resolver is injected so this module never carries a second copy of the
  // precedence rules. Missing it is a wiring fault, not a question to answer
  // optimistically.
  assert.throws(() => preflight({ action: 'x', now: NOW }), /requires the owner-decision resolver/);
});

test('escalationKey distinguishes scope but ignores wording', () => {
  const k = (a, c) => escalationKey(a, c);
  assert.equal(k('deploy.production', {}), k('deploy.production', {}));
  assert.notEqual(k('deploy.production', {}), k('deploy.staging', {}));
  assert.notEqual(k('x', { repo: 'a' }), k('x', { repo: 'b' }));
  assert.equal(k('x', { repo: 'a' }), k('x', { repo: 'a', extra: 'ignored' }));
});
