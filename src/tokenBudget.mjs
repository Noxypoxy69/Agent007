/**
 * VERIFIED WORK PER TOKEN — and the precedence is structural, not advisory.
 *
 * THE FAILURE THIS IS BUILT AGAINST. Any measure of tokens creates pressure to
 * send less, and the cheapest thing to drop is always the evidence: the
 * mutation table, the named remaining risks, the sentence saying which proof
 * was not run. A 300-token handoff that says "done, green" costs a fifth of a
 * 1500-token one that shows fifteen mutations going red — and it is worth
 * nothing, because nobody can check it. If brevity can win on its own, this
 * module makes the work worse while reporting an improvement.
 *
 * SO BREVITY CANNOT WIN ON ITS OWN. Comparison is LEXICOGRAPHIC: correctness,
 * then evidence, then safety, and only then tokens. A handoff missing mutation
 * evidence loses to a complete one at any size, and no amount of shortening
 * moves it. That is a property of the comparator rather than a recommendation
 * in a comment, and there is a test that a 300-token incomplete handoff scores
 * worse than a 1500-token complete one.
 *
 * AUDIT EVIDENCE IS EXEMPT FROM THE COUNT, and the exemption is proven in both
 * directions: evidence is not counted, and everything else IS. An exemption
 * that quietly swallowed ordinary prose would be a way to hide cost by labelling
 * it, which is the same failure arriving from the other side.
 *
 * TWO KINDS OF METRIC, AND THEY ARE NOT INTERCHANGEABLE.
 *
 *   TARGET       may be optimised and ranked. Tokens per accepted task, per
 *                accepted commit, compression, repeated context, machine-state
 *                references, evidence completeness.
 *
 *   DESCRIPTIVE  may be REPORTED and never ranked: tokens per finding, tokens
 *                per bug found. Ranking those rewards finding cheap bugs and
 *                punishes the session that spent a long time proving a hard
 *                thing was fine — and "no bug here, and here is why" is the
 *                expensive, valuable answer this system exists to produce.
 *                `rankBy` REFUSES a descriptive metric rather than returning a
 *                sorted list somebody will use anyway.
 *
 * IT REPORTS. IT NEVER REWRITES. Nothing here returns modified message text,
 * truncates, or suggests wording. A measurement tool that edits the thing it
 * measures is how the evidence gets removed by the machine rather than by a
 * tired person, and there is a structural test asserting no function returns
 * altered input.
 */

/** Ranking is allowed on these. */
export const TARGET_METRICS = [
  'tokens_per_accepted_task',
  'tokens_per_accepted_commit',
  'handoff_compression_ratio',
  'repeated_context_ratio',
  'machine_state_reference_ratio',
  'audit_evidence_completeness',
];

/** Reported, never ranked, never a target. See the header. */
export const DESCRIPTIVE_METRICS = ['tokens_per_finding', 'tokens_per_bug_found'];

/**
 * The gates, worst-first. A handoff sits in the first tier it fails.
 *
 * Order matters and is the whole design: correctness before evidence before
 * safety before cost.
 */
export const TIERS = ['correctness', 'evidence', 'safety', 'complete'];

/**
 * How good each tier is, LOWER IS BETTER. Stated explicitly rather than derived
 * from the order of TIERS above, because the two orderings are opposites and
 * conflating them inverts the entire module.
 *
 * TIERS is written worst-gate-first: correctness is checked before evidence,
 * which is checked before safety. Using indexOf on that list as a score makes
 * `correctness` — a FAILURE — rank best and `complete` rank worst, so a broken
 * handoff beat a finished one. Every precedence test failed at once, which is
 * the only reason it was caught rather than shipping as a leaderboard that
 * rewarded incomplete work.
 */
export const TIER_RANK = { complete: 0, safety: 1, evidence: 2, correctness: 3 };

/**
 * A deliberately crude token estimate.
 *
 * It is not a model tokeniser and does not pretend to be. What this measures is
 * RATIOS between handoffs produced by the same process, and for that a stable,
 * inspectable rule beats an accurate opaque one — an estimate somebody can
 * reason about will not silently change under them when a dependency updates.
 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  if (!s.trim()) return 0;
  // ~4 characters per token is the usual rough figure for English prose.
  return Math.max(1, Math.round(s.trim().length / 4));
}

/**
 * Sections of a handoff that are AUDIT EVIDENCE and therefore exempt.
 *
 * Matched on explicit markers rather than guessed from shape: a heuristic that
 * decided what "looks like evidence" would be gameable by formatting, and the
 * whole point of the exemption is that it cannot be used to hide cost.
 */
const EVIDENCE_MARKERS = [
  /^\s*mutation table\b/i,
  /^\s*mutation_result\b/i,
  /^\s*contract_audit\b/i,
  /^\s*tests\b\s*[:|]/i,
  /^\s*remaining risks?\b/i,
  /^\s*proofs?\b\s*[:|]/i,
];

const isEvidenceLine = (line) => EVIDENCE_MARKERS.some((re) => re.test(line));

/**
 * Split a handoff into evidence and everything else.
 *
 * A marker opens an evidence block that runs until a blank line followed by a
 * non-indented, non-marker line — so a table under "mutation table" stays with
 * it without the marker having to be repeated on every row.
 */
export function splitEvidence(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const evidence = [];
  const prose = [];
  let inEvidence = false;

  for (const line of lines) {
    if (isEvidenceLine(line)) {
      inEvidence = true;
      evidence.push(line);
      continue;
    }
    if (inEvidence) {
      // Indented or non-empty continuation stays; a flush-left new paragraph ends it.
      if (line.trim() === '' || /^\s/.test(line)) {
        evidence.push(line);
        continue;
      }
      inEvidence = false;
    }
    prose.push(line);
  }
  return { evidence: evidence.join('\n'), prose: prose.join('\n') };
}

/**
 * Facts a handoff restates that the Bridge already holds in structured state.
 *
 * Counted SEPARATELY rather than merely subtracted, because it is the one
 * number that says "this could have been a reference". Repeating a base SHA the
 * ledger already stores is not free and is not evidence; it is the same fact
 * paid for twice.
 */
export function repeatedContext(text, bridgeState = {}) {
  const s = String(text ?? '');
  const hits = [];
  for (const [key, value] of Object.entries(bridgeState)) {
    if (value == null) continue;
    const v = String(value);
    if (v.length < 6) continue; // too short to be distinctive
    let idx = s.indexOf(v);
    let count = 0;
    while (idx !== -1) {
      count += 1;
      idx = s.indexOf(v, idx + 1);
    }
    if (count > 0) hits.push({ key, value: v, occurrences: count, tokens: estimateTokens(v) * count });
  }
  return { facts: hits, tokens: hits.reduce((n, h) => n + h.tokens, 0) };
}

const bool = (v) => v === true;

/**
 * Which tier a handoff sits in. The first failure wins; later gates are not
 * consulted, because a handoff whose correctness is unproven cannot be
 * meaningfully judged on its evidence.
 */
export function tierOf(h = {}) {
  if (!bool(h.tests_pass)) return 'correctness';
  if (!bool(h.mutation_evidence)) return 'evidence';
  if (!bool(h.contract_audit_held)) return 'safety';
  return 'complete';
}

/**
 * Measure one handoff. Reports; changes nothing.
 *
 * `counted_tokens` is what the budget is spent on: everything except audit
 * evidence. `total_tokens` is what was actually sent. Both are reported, so
 * nobody has to reverse-engineer the exemption.
 */
export function measureHandoff(h = {}) {
  const text = String(h.text ?? '');
  const { evidence, prose } = splitEvidence(text);
  const evidenceTokens = estimateTokens(evidence);
  const proseTokens = estimateTokens(prose);
  const repeated = repeatedContext(prose, h.bridge_state ?? {});
  const tier = tierOf(h);

  return {
    id: h.id ?? null,
    tier,
    tier_rank: TIER_RANK[tier],
    total_tokens: estimateTokens(text),
    evidence_tokens: evidenceTokens,
    counted_tokens: proseTokens,
    repeated_context_tokens: repeated.tokens,
    repeated_context: repeated.facts,
    machine_state_references: Number(h.machine_state_references ?? 0),
    findings: Number(h.findings ?? 0),
    bugs_found: Number(h.bugs_found ?? 0),
    accepted_tasks: Number(h.accepted_tasks ?? 0),
    accepted_commits: Number(h.accepted_commits ?? 0),
  };
}

const ratio = (a, b) => (b > 0 ? a / b : null);

/** Every metric, target and descriptive, clearly separated. */
export function metricsFor(m) {
  const target = {
    tokens_per_accepted_task: ratio(m.counted_tokens, m.accepted_tasks),
    tokens_per_accepted_commit: ratio(m.counted_tokens, m.accepted_commits),
    handoff_compression_ratio: ratio(m.counted_tokens, m.total_tokens),
    repeated_context_ratio: ratio(m.repeated_context_tokens, m.counted_tokens),
    machine_state_reference_ratio: ratio(
      m.machine_state_references,
      m.machine_state_references + m.repeated_context.length,
    ),
    audit_evidence_completeness: m.tier === 'complete' ? 1 : 0,
  };
  const descriptive = {
    tokens_per_finding: ratio(m.counted_tokens, m.findings),
    tokens_per_bug_found: ratio(m.counted_tokens, m.bugs_found),
  };
  return { target, descriptive };
}

/**
 * Compare two measured handoffs. NEGATIVE means `a` is better.
 *
 * LEXICOGRAPHIC, AND THAT IS THE POINT. Tier first, always. Tokens are consulted
 * only between two handoffs in the SAME tier, so a short one missing evidence
 * can never beat a long one that proves its gate works, however short it gets.
 */
export function compareHandoffs(a, b) {
  if (a.tier_rank !== b.tier_rank) return a.tier_rank - b.tier_rank;
  return a.counted_tokens - b.counted_tokens;
}

/**
 * Rank by a TARGET metric. REFUSES a descriptive one.
 *
 * Refusing rather than warning is deliberate. A function that logged a warning
 * and returned a sorted list would have its list used, and the warning would be
 * read once. Ranking tokens-per-bug rewards cheap bugs and punishes the session
 * that spent a long time proving a hard thing was fine.
 */
export function rankBy(metric, measured = []) {
  if (DESCRIPTIVE_METRICS.includes(metric)) {
    return {
      ok: false,
      reason: 'descriptive-metric-not-rankable',
      detail: `"${metric}" is descriptive: report it, never rank on it. Ranking it rewards cheap findings and punishes proving a hard thing was fine.`,
    };
  }
  if (!TARGET_METRICS.includes(metric)) {
    return { ok: false, reason: 'unknown-metric', detail: `"${metric}" is not a declared metric` };
  }

  /*
   * Even a legitimate target metric is ranked WITHIN tier, never across it.
   * Otherwise a handoff missing evidence could top the table by being cheap,
   * which is the whole thing this module exists to prevent — reintroduced
   * through a sort instead of a score.
   */
  const rows = [...measured].sort((x, y) => {
    if (x.tier_rank !== y.tier_rank) return x.tier_rank - y.tier_rank;
    const mx = metricsFor(x).target[metric];
    const my = metricsFor(y).target[metric];
    if (mx == null && my == null) return 0;
    if (mx == null) return 1;
    if (my == null) return -1;
    return metric === 'audit_evidence_completeness' ? my - mx : mx - my;
  });
  return { ok: true, metric, rows };
}

/** A report. Returns numbers and never message text. */
export function report(handoffs = []) {
  const measured = handoffs.map(measureHandoff);
  return measured.map((m) => ({ ...m, metrics: metricsFor(m) }));
}
