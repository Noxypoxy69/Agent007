/*
 * TOKEN TELEMETRY.
 *
 * What an attempt cost, by phase, so "the loop is expensive" becomes "review is
 * 60% of it and 90% of that is re-read files". Immutable: `record` returns a
 * new ledger, so a ledger can be kept in a durable row and rebuilt from events.
 *
 * THREE THINGS IT REFUSES TO GET WRONG.
 *
 * CACHED INPUT IS NOT INPUT. It is counted in its own column and never summed
 * into `input`. Adding them is the classic double count: it inflates the total,
 * makes a cache that is working look like a regression, and the correction
 * usually arrives as someone disabling the cache.
 *
 * A RETRIED REPORT IS NOT A SECOND COST. Events carry an id and a repeat id is
 * ignored. A worker that retries its telemetry POST -- which is the normal
 * response to a timeout -- must not double the number.
 *
 * ABSENT IS NOT ZERO. A phase nobody reported is missing from `byPhase`, not
 * present with zeros, so "we never instrumented review" cannot read as "review
 * is free".
 */

export const PHASES = Object.freeze(['plan', 'execute', 'review', 'fix', 'overhead']);

function fail(message) {
  throw new TypeError(`token telemetry: ${message}`);
}

export function createLedger({ budget = null } = {}) {
  if (budget !== null && (!Number.isInteger(budget) || budget <= 0)) {
    fail('budget must be a positive integer or null');
  }
  return Object.freeze({
    budget,
    seen: Object.freeze([]),
    events: Object.freeze([]),
  });
}

export function record(ledger, event) {
  if (event === null || typeof event !== 'object') fail('event must be an object');
  const { id, phase, input = 0, output = 0, cacheRead = 0, cacheCreation = 0, attempt = 0 } = event;
  if (typeof id !== 'string' || id === '') fail('event.id required for idempotency');
  if (!PHASES.includes(phase)) fail(`unknown phase ${JSON.stringify(phase)}`);
  for (const [name, value] of [
    ['input', input],
    ['output', output],
    ['cacheRead', cacheRead],
    ['cacheCreation', cacheCreation],
  ]) {
    if (!Number.isInteger(value) || value < 0) fail(`${name} must be a non-negative integer`);
  }

  // A repeat is a retry of the same report, not a second cost.
  if (ledger.seen.includes(id)) return ledger;

  return Object.freeze({
    budget: ledger.budget,
    seen: Object.freeze([...ledger.seen, id]),
    events: Object.freeze([
      ...ledger.events,
      Object.freeze({ id, phase, attempt, input, output, cacheRead, cacheCreation }),
    ]),
  });
}

export function totals(ledger) {
  const sum = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  const byPhase = {};
  for (const event of ledger.events) {
    sum.input += event.input;
    sum.output += event.output;
    sum.cacheRead += event.cacheRead;
    sum.cacheCreation += event.cacheCreation;
    const phase = (byPhase[event.phase] ??= { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, billed: 0 });
    phase.input += event.input;
    phase.output += event.output;
    phase.cacheRead += event.cacheRead;
    phase.cacheCreation += event.cacheCreation;
    phase.billed += event.input + event.output;
  }
  return Object.freeze({
    ...sum,
    // What is charged. Cached input is reported and excluded on purpose.
    billed: sum.input + sum.output,
    byPhase: Object.freeze(byPhase),
    events: ledger.events.length,
  });
}

/*
 * Over budget is a question with three answers, and the third is the one that
 * matters: with no budget set, this returns null rather than false. A caller
 * that treats an unset budget as "within budget" has no budget and does not
 * know it.
 */
export function overBudget(ledger) {
  if (ledger.budget === null) return null;
  return totals(ledger).billed > ledger.budget;
}
