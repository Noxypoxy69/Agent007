import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokens,
  splitEvidence,
  repeatedContext,
  tierOf,
  measureHandoff,
  metricsFor,
  compareHandoffs,
  rankBy,
  report,
  TARGET_METRICS,
  DESCRIPTIVE_METRICS,
  TIERS,
} from '../src/tokenBudget.mjs';

/**
 * THE ONE ASSERTION THIS FILE EXISTS FOR: brevity cannot win on its own.
 *
 * Any measure of tokens creates pressure to send less, and the cheapest thing
 * to drop is always the evidence — the mutation table, the named remaining
 * risks, the sentence saying which proof was not run. If a short handoff can
 * outrank a complete one, this module makes the work worse while reporting an
 * improvement.
 *
 * So the first test is a 300-token handoff missing mutation evidence against a
 * 1500-token one that proves its gate works, and the long one must win.
 */

const long = (n) => 'x'.repeat(n);

const COMPLETE = {
  id: 'complete-1500',
  text: long(6000), // ~1500 tokens
  tests_pass: true,
  mutation_evidence: true,
  contract_audit_held: true,
};

const SHORT_NO_EVIDENCE = {
  id: 'short-300',
  text: long(1200), // ~300 tokens
  tests_pass: true,
  mutation_evidence: false,
  contract_audit_held: true,
};

test('A 300-TOKEN HANDOFF MISSING EVIDENCE SCORES WORSE THAN A 1500-TOKEN COMPLETE ONE', () => {
  const short = measureHandoff(SHORT_NO_EVIDENCE);
  const complete = measureHandoff(COMPLETE);
  assert.ok(short.counted_tokens < complete.counted_tokens, 'the short one really is cheaper');
  assert.ok(compareHandoffs(complete, short) < 0, 'the complete one must still win');
});

test('no amount of shortening rescues a handoff missing evidence', () => {
  // The structural claim: tier dominates, so this holds at every size.
  const complete = measureHandoff(COMPLETE);
  for (const chars of [40, 400, 4000, 40000]) {
    const m = measureHandoff({ ...SHORT_NO_EVIDENCE, text: long(chars) });
    assert.ok(compareHandoffs(complete, m) < 0, `still lost at ${chars} chars`);
  }
});

test('NEAREST CLEAN: between two COMPLETE handoffs, the cheaper one wins', () => {
  // Or the module measures nothing at all.
  const a = measureHandoff({ ...COMPLETE, id: 'a', text: long(1200) });
  const b = measureHandoff({ ...COMPLETE, id: 'b', text: long(6000) });
  assert.ok(compareHandoffs(a, b) < 0);
});

/* ── precedence order ────────────────────────────────────────────────── */

test('the tiers are correctness, then evidence, then safety, then cost', () => {
  assert.deepEqual(TIERS, ['correctness', 'evidence', 'safety', 'complete']);
});

test('the first failing gate decides the tier', () => {
  assert.equal(tierOf({ tests_pass: false, mutation_evidence: true, contract_audit_held: true }), 'correctness');
  assert.equal(tierOf({ tests_pass: true, mutation_evidence: false, contract_audit_held: true }), 'evidence');
  assert.equal(tierOf({ tests_pass: true, mutation_evidence: true, contract_audit_held: false }), 'safety');
  assert.equal(tierOf({ tests_pass: true, mutation_evidence: true, contract_audit_held: true }), 'complete');
});

test('a failing gate is not rescued by a later passing one', () => {
  // Correctness unproven means evidence cannot be meaningfully judged.
  const broken = measureHandoff({ text: long(40), tests_pass: false, mutation_evidence: true, contract_audit_held: true });
  const ok = measureHandoff({ text: long(40000), ...COMPLETE });
  assert.ok(compareHandoffs(ok, broken) < 0);
});

test('missing flags are treated as NOT satisfied, never as satisfied', () => {
  // An absent claim is not a claim. Defaulting to true would let an incomplete
  // handoff top the table by omitting fields.
  assert.equal(tierOf({}), 'correctness');
  assert.equal(tierOf({ tests_pass: 'yes' }), 'correctness', 'only an explicit true counts');
});

/* ── audit evidence is exempt, proven BOTH directions ────────────────── */

test('EXEMPT: audit evidence is not counted against the budget', () => {
  const withEvidence = measureHandoff({
    ...COMPLETE,
    text: `summary line\n\nmutation table\n  rule a   red 1\n  rule b   red 2\n`,
  });
  assert.ok(withEvidence.evidence_tokens > 0, 'the evidence was recognised');
  assert.ok(
    withEvidence.counted_tokens < withEvidence.total_tokens,
    'evidence must not be charged for',
  );
});

test('NOT EXEMPT: ordinary prose IS counted', () => {
  /*
   * The other direction, and the one that matters. An exemption that quietly
   * swallowed prose would be a way to hide cost by labelling it — the same
   * failure from the other side.
   */
  const plain = measureHandoff({ ...COMPLETE, text: 'just some ordinary narrative prose here' });
  assert.equal(plain.evidence_tokens, 0);
  assert.equal(plain.counted_tokens, plain.total_tokens);
});

test('prose after an evidence block is counted again', () => {
  const m = measureHandoff({
    ...COMPLETE,
    text: `mutation table\n  rule a   red 1\n\nand now a great deal of ordinary prose that must be charged for\n`,
  });
  assert.ok(m.counted_tokens > 0, 'the trailing prose was swallowed by the exemption');
});

test('the exemption is marker-based, not shape-guessed', () => {
  // A heuristic guessing what "looks like evidence" would be gameable by
  // formatting, which is exactly what the exemption must not be.
  const notEvidence = splitEvidence('  rule a   red 1\n  rule b   red 2');
  assert.equal(notEvidence.evidence.trim(), '', 'an unmarked table is not evidence');
});

/* ── target vs descriptive is structural ─────────────────────────────── */

test('DESCRIPTIVE METRICS ARE REFUSED FOR RANKING, not warned about', () => {
  /*
   * A function that logged a warning and returned a sorted list would have its
   * list used and its warning read once. Ranking tokens-per-bug rewards cheap
   * bugs and punishes the session that spent a long time proving a hard thing
   * was fine — which is the expensive, valuable answer.
   */
  for (const m of DESCRIPTIVE_METRICS) {
    const r = rankBy(m, [measureHandoff(COMPLETE)]);
    assert.equal(r.ok, false, `${m} must not be rankable`);
    assert.equal(r.reason, 'descriptive-metric-not-rankable');
    assert.equal(r.rows, undefined, 'a refusal must not hand back a list anyway');
  }
});

test('NEAREST CLEAN: every target metric IS rankable', () => {
  for (const m of TARGET_METRICS) {
    assert.equal(rankBy(m, [measureHandoff(COMPLETE)]).ok, true, `${m} should rank`);
  }
});

test('an unknown metric is refused too', () => {
  assert.equal(rankBy('vibes', []).ok, false);
});

test('descriptive metrics are still REPORTED', () => {
  // Refusing to rank them is not refusing to show them.
  const m = measureHandoff({ ...COMPLETE, findings: 4, bugs_found: 2 });
  const { descriptive } = metricsFor(m);
  assert.ok(descriptive.tokens_per_finding > 0);
  assert.ok(descriptive.tokens_per_bug_found > 0);
});

test('the two metric lists do not overlap', () => {
  for (const d of DESCRIPTIVE_METRICS) assert.equal(TARGET_METRICS.includes(d), false);
});

test('RANKING IS WITHIN TIER, never across it', () => {
  /*
   * Otherwise a handoff missing evidence tops the table by being cheap — the
   * thing this module exists to prevent, reintroduced through a sort instead of
   * a score.
   */
  const rows = [measureHandoff(SHORT_NO_EVIDENCE), measureHandoff(COMPLETE)];
  const r = rankBy('tokens_per_accepted_commit', rows);
  assert.equal(r.ok, true);
  assert.equal(r.rows[0].id, 'complete-1500', 'the complete handoff must lead');
});

/* ── repeated context is counted separately ──────────────────────────── */

test('a fact the Bridge already holds is counted as repeated context', () => {
  const sha = 'e6806bc65ba4097781e3d3c8dbf78e35b611e6a8';
  const r = repeatedContext(`the head is ${sha} and it held`, { head_sha: sha });
  assert.equal(r.facts.length, 1);
  assert.equal(r.facts[0].occurrences, 1);
  assert.ok(r.tokens > 0);
});

test('repeating it twice is counted twice — the same fact paid for twice', () => {
  const sha = 'e6806bc65ba4097781e3d3c8dbf78e35b611e6a8';
  const once = repeatedContext(sha, { head_sha: sha });
  const twice = repeatedContext(`${sha} ... ${sha}`, { head_sha: sha });
  assert.equal(twice.facts[0].occurrences, 2);
  /*
   * The cost must scale with the repetition, not just the count. Asserting only
   * `occurrences` left the token arithmetic untested — mutation showed that
   * dropping the multiplier kept this green, so a fact restated ten times was
   * charged once and the "could have been a reference" number understated it.
   */
  assert.equal(twice.tokens, once.tokens * 2, 'a fact paid for twice must cost twice');
});

test('NEAREST CLEAN: a handoff that references rather than restates has none', () => {
  const r = repeatedContext('see the recorded head on the contract', { head_sha: 'e6806bc65ba409' });
  assert.deepEqual(r.facts, []);
  assert.equal(r.tokens, 0);
});

test('repeated context is reported SEPARATELY, not merely subtracted', () => {
  // It is the one number that says "this could have been a reference".
  const sha = 'e6806bc65ba4097781e3d3c8dbf78e35b611e6a8';
  const m = measureHandoff({ ...COMPLETE, text: `done at ${sha}`, bridge_state: { head_sha: sha } });
  assert.ok(m.repeated_context_tokens > 0);
  assert.ok(m.counted_tokens > 0, 'it is still part of what was sent');
});

test('a short bridge value is not matched — too undistinctive to be a restatement', () => {
  assert.deepEqual(repeatedContext('the id is b', { id: 'b' }).facts, []);
});

/* ── it reports; it never rewrites ───────────────────────────────────── */

test('NO FUNCTION RETURNS ALTERED MESSAGE TEXT', () => {
  /*
   * Structural, because the temptation is obvious and the next person adding
   * "suggestedRewrite" would think they were helping. A measurement tool that
   * edits what it measures is how evidence gets removed by the machine rather
   * than by a tired person.
   */
  const text = 'summary\n\nmutation table\n  a red 1\n';
  const m = measureHandoff({ ...COMPLETE, text });
  const serialised = JSON.stringify(m);
  assert.doesNotMatch(serialised, /summary/, 'the report must not carry the message back');
  for (const key of Object.keys(m)) {
    if (key === 'repeated_context' || key === 'id' || key === 'tier') continue; // identifiers, not prose
    assert.notEqual(typeof m[key], 'string', `${key} must be a number or id, not prose`);
  }
});

test('the report exposes no rewrite, truncate or suggestion surface', () => {
  const rows = report([COMPLETE]);
  assert.doesNotMatch(JSON.stringify(rows), /rewrite|truncat|suggest|shorten/i);
});

test('measuring does not mutate the handoff it is given', () => {
  /*
   * BUILT FROM A LITERAL, NOT FROM THE SHARED FIXTURE, and mutation is what
   * forced that. Spreading COMPLETE looked equivalent and was not: an earlier
   * test calls report([COMPLETE]), and a measureHandoff that wrote to its input
   * would already have stamped the shared object by the time this ran. The
   * contamination then appeared in `before` as well as `after`, so the two
   * matched and the test passed against exactly the defect it exists to catch.
   *
   * A shared mutable fixture cannot check whether anything mutates it.
   */
  const h = {
    id: 'isolation',
    text: 'a handoff that must come back unchanged',
    tests_pass: true,
    mutation_evidence: true,
    contract_audit_held: true,
  };
  const before = JSON.stringify(h);
  measureHandoff(h);
  assert.equal(JSON.stringify(h), before, 'measureHandoff wrote into its argument');
  assert.deepEqual(Object.keys(h).sort(), ['contract_audit_held', 'id', 'mutation_evidence', 'tests_pass', 'text']);
});

/* ── the estimator ───────────────────────────────────────────────────── */

test('the token estimate is deterministic and monotonic', () => {
  assert.equal(estimateTokens('hello world'), estimateTokens('hello world'));
  assert.ok(estimateTokens(long(4000)) > estimateTokens(long(400)));
});

test('empty and absent text cost nothing', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('   '), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
});

test('an empty report is not an error', () => {
  assert.deepEqual(report([]), []);
  assert.deepEqual(report(), []);
});

test('a handoff with no accepted work reports null rather than dividing by zero', () => {
  const m = measureHandoff({ ...COMPLETE, accepted_tasks: 0 });
  assert.equal(metricsFor(m).target.tokens_per_accepted_task, null);
});
