import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_FLOOR_MS,
  DEFAULT_RESERVE_MS,
  FALLBACK_HOOK_BUDGET_MS,
  stopHookBudgetMs,
  suiteBudget,
} from '../src/stopGateBudget.mjs';

/**
 * THE PROPERTY, NOT A TABLE OF EXAMPLES.
 *
 * The bug being prevented is a process killed before it writes a verdict, and it
 * happens whenever elapsed + suite + reporting exceeds what the hook allows. So
 * the assertion that matters is the INEQUALITY, checked across the range rather
 * than at three hand-picked points -- CLAUDE.md rule 7: a claim about what cannot
 * happen, tested with inputs that already worked, proves nothing.
 */

const INVARIANT_CASES = [];
for (const hookBudgetMs of [60_000, 150_000, 190_000, 600_000]) {
  for (const elapsedMs of [0, 1, 500, 9_000, 45_000, 100_000]) {
    for (const reserveMs of [1_000, 20_000, 45_000]) {
      INVARIANT_CASES.push({ hookBudgetMs, elapsedMs, reserveMs });
    }
  }
}

test('THE INVARIANT: elapsed + timeout + reserve NEVER exceeds the hook budget', () => {
  let granted = 0;
  for (const c of INVARIANT_CASES) {
    const verdict = suiteBudget(c);
    if (!verdict.ok) continue;
    granted += 1;
    assert.ok(
      c.elapsedMs + verdict.timeoutMs + c.reserveMs <= c.hookBudgetMs,
      `budget overrun for ${JSON.stringify(c)}: granted ${verdict.timeoutMs}ms`,
    );
  }
  /*
   * A NEGATIVE NEEDS THE POSITIVE FIRST (rule 5). Without this the test passes
   * perfectly against a function that refuses everything, which is the failure
   * mode a budget check is most likely to drift into.
   */
  assert.ok(granted > 20, `expected most cases to be grantable, only ${granted} were`);
});

test('the granted timeout is always a positive integer spawnSync can use', () => {
  for (const c of INVARIANT_CASES) {
    const verdict = suiteBudget(c);
    if (!verdict.ok) continue;
    assert.ok(Number.isInteger(verdict.timeoutMs), `${verdict.timeoutMs} is not an integer`);
    assert.ok(verdict.timeoutMs > 0, `${verdict.timeoutMs} is not positive`);
  }
});

test('more setup time spent means strictly less suite time granted', () => {
  const at = (elapsedMs) => suiteBudget({ hookBudgetMs: 190_000, elapsedMs, reserveMs: 20_000 });
  const early = at(1_000);
  const late = at(30_000);
  assert.equal(early.ok, true);
  assert.equal(late.ok, true);
  assert.equal(early.timeoutMs - late.timeoutMs, 29_000);
});

/* ── hostile input: the NaN case is the whole point ──────────────────── */

test('A NaN BUDGET IS REFUSED, because spawnSync reads NaN as NO TIMEOUT', () => {
  /*
   * This is the regression that would restore the original defect in one line:
   * Number(process.env.SOMETHING_UNSET) is NaN, every comparison against NaN is
   * false so a bounds check waves it through, and spawnSync given a NaN timeout
   * simply does not time out. The run then outlives the hook, the process is
   * killed with empty stdout, and an empty hook result is non-blocking.
   */
  for (const field of ['hookBudgetMs', 'reserveMs', 'floorMs', 'elapsedMs']) {
    const verdict = suiteBudget({ hookBudgetMs: 190_000, elapsedMs: 0, [field]: NaN });
    assert.equal(verdict.ok, false, `${field}=NaN must be refused`);
    assert.match(verdict.reason, new RegExp(field));
  }
});

test('every other unusable value is refused too, and named', () => {
  const bad = [Infinity, -Infinity, -1, 0, '190000', null, undefined, {}, [], true];
  for (const field of ['hookBudgetMs', 'reserveMs', 'floorMs']) {
    for (const value of bad) {
      // undefined means "use the default", which is a legitimate call
      if (value === undefined) continue;
      const verdict = suiteBudget({ hookBudgetMs: 190_000, elapsedMs: 0, [field]: value });
      assert.equal(verdict.ok, false, `${field}=${JSON.stringify(value)} must be refused`);
    }
  }
  // elapsedMs is the one field where 0 is legitimate
  assert.equal(suiteBudget({ hookBudgetMs: 190_000, elapsedMs: 0 }).ok, true);
  for (const value of [-1, '0', null, {}, true]) {
    assert.equal(suiteBudget({ hookBudgetMs: 190_000, elapsedMs: value }).ok, false,
      `elapsedMs=${JSON.stringify(value)} must be refused`);
  }
});

test('omitting everything uses the conservative fallback rather than failing', () => {
  const verdict = suiteBudget();
  assert.equal(verdict.ok, true);
  assert.equal(verdict.timeoutMs, FALLBACK_HOOK_BUDGET_MS - DEFAULT_RESERVE_MS);
});

/* ── the refusals, which must be refusals and not small timeouts ─────── */

test('SETUP THAT ATE THE BUDGET IS A REFUSAL, not a two-second suite run', () => {
  const verdict = suiteBudget({ hookBudgetMs: 190_000, elapsedMs: 180_000, reserveMs: 20_000 });
  assert.equal(verdict.ok, false);
  assert.equal('timeoutMs' in verdict, false, 'a refusal must not carry a timeout a caller could use');
  assert.match(verdict.reason, /floor/);
});

test('elapsed beyond the whole budget is refused rather than going negative', () => {
  const verdict = suiteBudget({ hookBudgetMs: 190_000, elapsedMs: 250_000 });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /0ms/, 'a negative remainder must be reported as none, never as a negative timeout');
});

test('the floor is exact: one millisecond either side flips the verdict', () => {
  /*
   * WATCH IT FAIL AT THE BOUNDARY. A comparison written >= instead of > or with
   * the operands swapped still passes every example far from the edge, so the
   * edge is where the test has to be.
   */
  const at = (elapsedMs) => suiteBudget({ hookBudgetMs: 100_000, elapsedMs, reserveMs: 20_000, floorMs: 30_000 });
  assert.equal(at(50_000).ok, true, 'exactly at the floor must be allowed');
  assert.equal(at(50_000).timeoutMs, 30_000);
  assert.equal(at(50_001).ok, false, 'one millisecond under the floor must refuse');
});

test('a reserve larger than the budget refuses instead of granting negative time', () => {
  const verdict = suiteBudget({ hookBudgetMs: 10_000, elapsedMs: 0, reserveMs: 20_000 });
  assert.equal(verdict.ok, false);
});

/* ── reading the real configured timeout ─────────────────────────────── */

test('the hook timeout is read from settings and converted from SECONDS', () => {
  const settings = { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'x', timeout: 190 }] }] } };
  assert.equal(stopHookBudgetMs(settings), 190_000);
});

test('THE SMALLEST CONFIGURED TIMEOUT WINS', () => {
  /*
   * Whichever limit expires first is the one that kills the process, so taking
   * the maximum would be the optimistic reading -- and an optimistic budget is
   * precisely how the gate gets killed mid-verdict.
   */
  const settings = {
    hooks: {
      Stop: [
        { matcher: '', hooks: [{ timeout: 190 }, { timeout: 45 }] },
        { matcher: '', hooks: [{ timeout: 300 }] },
      ],
    },
  };
  assert.equal(stopHookBudgetMs(settings), 45_000);
});

test('an unreadable or absent timeout is null, which means FALL BACK, not unlimited', () => {
  for (const settings of [
    {}, null, undefined, { hooks: {} }, { hooks: { Stop: [] } },
    { hooks: { Stop: [{ hooks: [] }] } },
    { hooks: { Stop: [{ hooks: [{ type: 'command' }] }] } },
    { hooks: { Stop: [{ hooks: [{ timeout: 0 }] }] } },
    { hooks: { Stop: [{ hooks: [{ timeout: -5 }] }] } },
    { hooks: { Stop: [{ hooks: [{ timeout: 'soon' }] }] } },
    { hooks: { Stop: [{ hooks: [{ timeout: NaN }] }] } },
    { hooks: { Stop: 'not-an-array' } },
  ]) {
    assert.equal(stopHookBudgetMs(settings), null, `${JSON.stringify(settings)} must yield null`);
  }
});

test('a null budget still produces a usable, conservative verdict', () => {
  const budget = stopHookBudgetMs({}) ?? FALLBACK_HOOK_BUDGET_MS;
  const verdict = suiteBudget({ hookBudgetMs: budget, elapsedMs: 5_000 });
  assert.equal(verdict.ok, true);
  assert.ok(verdict.timeoutMs + 5_000 + DEFAULT_RESERVE_MS <= FALLBACK_HOOK_BUDGET_MS);
});

/* ── the two numbers that must not drift apart ───────────────────────── */

test('THE REAL settings.json IS READABLE BY THIS PARSER, and is stricter than the fallback', () => {
  /*
   * The finding is that two timeouts live in two files and can drift. This reads
   * the ACTUAL configured value rather than a fixture, so the day the settings
   * shape changes, this fails instead of the gate silently falling back.
   */
  const settingsPath = fileURLToPath(new URL('../.claude/settings.json', import.meta.url));
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));

  const configured = stopHookBudgetMs(settings);
  assert.notEqual(configured, null, 'the Stop hook timeout could not be read from the real settings file');
  assert.ok(configured > 0);

  const verdict = suiteBudget({ hookBudgetMs: configured, elapsedMs: 0 });
  assert.equal(verdict.ok, true, `the configured budget ${configured}ms leaves no room to run a suite`);
  assert.ok(
    verdict.timeoutMs + DEFAULT_RESERVE_MS <= configured,
    'the granted suite timeout plus the reporting reserve must fit inside the configured hook timeout',
  );
});

test('the fallback is BELOW the configured timeout, so a failed read errs toward blocking early', () => {
  const settingsPath = fileURLToPath(new URL('../.claude/settings.json', import.meta.url));
  const configured = stopHookBudgetMs(JSON.parse(readFileSync(settingsPath, 'utf8')));
  assert.ok(
    FALLBACK_HOOK_BUDGET_MS <= configured,
    `the fallback ${FALLBACK_HOOK_BUDGET_MS}ms exceeds the configured ${configured}ms: ` +
      'if this constant is wrong it must be wrong toward blocking early, because overrunning is the silent failure',
  );
});

test('the floor and reserve are both smaller than the fallback budget', () => {
  assert.ok(DEFAULT_RESERVE_MS + DEFAULT_FLOOR_MS <= FALLBACK_HOOK_BUDGET_MS,
    'the defaults must admit at least one runnable suite, or the gate refuses every time');
});
