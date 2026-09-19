import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedger, overBudget, record, totals } from '../src/tokenTelemetry.mjs';

const event = (id, phase, input, output, cacheRead = 0, cacheCreation = 0) => ({
  id,
  phase,
  input,
  output,
  cacheRead,
  cacheCreation,
});

test('records and totals by phase', () => {
  let ledger = createLedger();
  ledger = record(ledger, event('e1', 'execute', 100, 20));
  ledger = record(ledger, event('e2', 'review', 50, 10));
  const t = totals(ledger);
  assert.equal(t.billed, 180);
  assert.equal(t.byPhase.execute.billed, 120);
  assert.equal(t.byPhase.review.billed, 60);
});

test('CACHED INPUT IS NOT INPUT, and read is separate from creation', () => {
  let ledger = createLedger();
  ledger = record(ledger, event('e1', 'execute', 100, 20, 900, 40));
  const t = totals(ledger);
  assert.equal(t.input, 100, 'cached input must not inflate input');
  assert.equal(t.cacheRead, 900, 'cache read is its own dimension');
  assert.equal(t.cacheCreation, 40, 'cache creation is its own dimension, never merged with read');
  assert.equal(t.billed, 120, 'and neither cache dimension is billed');
});

test('A RETRIED REPORT IS NOT A SECOND COST', () => {
  let ledger = createLedger();
  ledger = record(ledger, event('e1', 'execute', 100, 20));
  ledger = record(ledger, event('e1', 'execute', 100, 20));
  assert.equal(totals(ledger).billed, 120);
  assert.equal(totals(ledger).events, 1);
});

test('ABSENT IS NOT ZERO: an uninstrumented phase is missing, not free', () => {
  let ledger = createLedger();
  ledger = record(ledger, event('e1', 'execute', 10, 1));
  assert.equal('review' in totals(ledger).byPhase, false);
});

test('the ledger is immutable, so it can be rebuilt from durable events', () => {
  const empty = createLedger();
  const after = record(empty, event('e1', 'execute', 10, 1));
  assert.equal(totals(empty).billed, 0, 'the original is untouched');
  assert.equal(totals(after).billed, 11);
  const revived = JSON.parse(JSON.stringify(after));
  assert.equal(totals(revived).billed, 11);
});

test('overBudget is true, false, or NULL when there is no budget', () => {
  let ledger = createLedger({ budget: 100 });
  assert.equal(overBudget(ledger), false);
  ledger = record(ledger, event('e1', 'execute', 90, 20));
  assert.equal(overBudget(ledger), true);
  // no budget is not "within budget"
  assert.equal(overBudget(createLedger()), null);
});

test('negative counts are refused', () => {
  assert.throws(() => record(createLedger(), event('e1', 'execute', -1, 0)), /non-negative/);
  assert.throws(() => record(createLedger(), event('e1', 'execute', 0, 0, -5)), /non-negative/);
});

test('a non-integer count is refused', () => {
  assert.throws(() => record(createLedger(), event('e1', 'execute', 1.5, 0)), /non-negative/);
});

test('an unknown phase is refused rather than silently bucketed', () => {
  assert.throws(() => record(createLedger(), event('e1', 'vibes', 1, 1)), /unknown phase/);
});

test('an event with no id is refused -- idempotency needs one', () => {
  assert.throws(() => record(createLedger(), { phase: 'execute', input: 1 }), /id required/);
});

test('a nonsense budget is refused at construction', () => {
  assert.throws(() => createLedger({ budget: 0 }), /positive integer or null/);
});
