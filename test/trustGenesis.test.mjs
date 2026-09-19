/**
 * THE BOOTSTRAP BOUNDARY, AND THE ONE PROPERTY THAT MATTERS.
 *
 * A trust system that requires authoritatively-bound authorship cannot accept
 * the commit that BUILDS authoritative authorship binding. Danny named the
 * loop: need trusted identity -> to accept a trusted audit -> which needs
 * trusted code implementing identity -> which needs a trusted audit.
 *
 * The escape is one owner-authorised exception for one exact frozen tree. The
 * danger is the one he also named: a temporary exception becomes the permanent
 * hole. So the assertions here are overwhelmingly about what genesis CANNOT
 * reach -- a descendant, a sibling, an unplaceable candidate, a second tree --
 * because a boundary that only proves it works for its intended case is the
 * same shape as a gate that only ever passes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateGenesis, regimeOf, genesisApplies, legacyMarking, REGIME,
} from '../src/trustGenesis.mjs';

const TREE = 'a'.repeat(40);
const OTHER_TREE = 'b'.repeat(40);
const CAND = 'c'.repeat(40);

const good = {
  tree_sha: TREE,
  candidate_sha: CAND,
  base_sha: 'd'.repeat(40),
  policy_version: '2026-09-20-v1',
  authorised_by: 'danny',
  owner_decision_id: 'd-trust-genesis-20260920',
  reviewer: 'blind-subagent-xyz',
  review_verdict: 'PASS',
  verification_key: '210cbd7fa78cd197af86cb3847c77530',
  verification_state: 'VERIFY_PASSED',
  accepted_at: '2026-09-20T02:00:00Z',
};

/* ── the property the whole module exists for ────────────────────────── */

test('GENESIS CANNOT REACH A DESCENDANT -- not by policy, by construction', () => {
  /*
   * THE HOLE THIS PREVENTS. If the exception could extend to work created
   * after the owner authorised it, the owner would be consenting in advance to
   * code that did not exist. A tree hash cannot do that: every descendant has
   * a different tree, so equality on a frozen hash is self-limiting.
   */
  const { genesis } = validateGenesis(good);
  assert.equal(genesisApplies(TREE, genesis), true, 'the frozen tree itself must qualify');
  assert.equal(genesisApplies(OTHER_TREE, genesis), false, 'a different tree took the bootstrap exception');

  assert.equal(regimeOf({ candidateTree: OTHER_TREE, genesis, isDescendant: true }).regime, REGIME.POST_GENESIS);
  assert.match(regimeOf({ candidateTree: OTHER_TREE, genesis, isDescendant: true }).why, /no exception/);
});

test('AN UNPLACEABLE CANDIDATE GETS THE STRICT REGIME, not the exception', () => {
  /*
   * Guessing PRE_GENESIS for a candidate nobody can place would hand the
   * bootstrap exception to exactly the commits whose provenance is unclear --
   * the leak, arriving through the one case nobody tested.
   */
  const { genesis } = validateGenesis(good);
  const r = regimeOf({ candidateTree: OTHER_TREE, genesis, isDescendant: null });
  assert.equal(r.regime, REGIME.POST_GENESIS);
  assert.match(r.why, /does not get the bootstrap exception/);
});

test('BEFORE GENESIS EXISTS, NOTHING IS EXEMPT -- including the future genesis tree', () => {
  /*
   * The candidate that will BECOME genesis is not genesis until the owner says
   * so. Treating it as pre-authorised would let an author nominate its own
   * tree and proceed.
   */
  assert.equal(genesisApplies(TREE, null), false);
  assert.equal(regimeOf({ candidateTree: TREE, genesis: null }).regime, REGIME.PRE_GENESIS);
});

test('A PRE-GENESIS CANDIDATE CANNOT BE PROMOTED, and the reason is stated', () => {
  const { genesis } = validateGenesis(good);
  const r = regimeOf({ candidateTree: OTHER_TREE, genesis, isDescendant: false });
  assert.equal(r.regime, REGIME.PRE_GENESIS);
  assert.match(r.why, /nobody can now truthfully produce/);
});

/* ── what makes a genesis record usable at all ───────────────────────── */

test('THE POSITIVE CONTROL: a complete genesis record validates', () => {
  const v = validateGenesis(good);
  assert.equal(v.ok, true, v.errors?.join('; '));
  assert.equal(v.genesis.tree_sha, TREE);
});

test('GENESIS IS AN OWNER ACT, and the authorisation must exist elsewhere', () => {
  /*
   * A genesis authorised by an agent is an agent declaring itself trustworthy.
   * And `authorised_by` alone is a field somebody typed -- the decision has to
   * exist as a recorded owner decision that can be looked up.
   */
  assert.equal(validateGenesis({ ...good, authorised_by: null }).ok, false);
  const noDecision = validateGenesis({ ...good, owner_decision_id: null });
  assert.equal(noDecision.ok, false);
  assert.match(noDecision.errors.join(' '), /not as a field somebody typed/);
});

test('AN INDEPENDENT REVIEW STILL HAPPENS -- genesis relaxes identity, not scrutiny', () => {
  /*
   * The bootstrap relaxes WHOSE identity can be proved cryptographically. It
   * does not relax that somebody who did not write the tree looked at it;
   * without that, genesis is self-certification with ceremony.
   */
  assert.equal(validateGenesis({ ...good, reviewer: null }).ok, false);
  for (const verdict of ['FAIL', 'INCONCLUSIVE', null, '']) {
    const r = validateGenesis({ ...good, review_verdict: verdict });
    assert.equal(r.ok, false, `a root of trust was accepted with review_verdict ${JSON.stringify(verdict)}`);
  }
});

test('A MACHINE CHECKED IT TOO, bound to the same tree', () => {
  /*
   * A reviewer's PASS is a judgement; a suite result is a measurement. Genesis
   * needs both, and the verification must be keyed to this exact tree or it is
   * a measurement of something else.
   */
  assert.equal(validateGenesis({ ...good, verification_key: null }).ok, false);
  assert.equal(validateGenesis({ ...good, verification_state: 'VERIFY_FAILED' }).ok, false);
  assert.equal(validateGenesis({ ...good, verification_state: null }).ok, false);
});

test('GENESIS IS A TREE, NOT A MOMENT', () => {
  /*
   * Every alternative spelling -- a date, a commit range, a flag, a grace
   * period -- extends to work not yet written. The refusal says so.
   */
  const r = validateGenesis({ ...good, tree_sha: null });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /a TREE, not a moment/);
  assert.equal(validateGenesis({ ...good, tree_sha: 'abc123' }).ok, false, 'a short sha was accepted');
});

test('A MALFORMED GENESIS GRANTS NOTHING', () => {
  /*
   * genesisApplies re-validates rather than trusting that somebody checked.
   * A half-written root of trust must not be usable BECAUSE it names the right
   * tree -- that would make the exception easier to obtain than the record.
   */
  for (const broken of [
    { ...good, owner_decision_id: null },
    { ...good, review_verdict: 'FAIL' },
    { ...good, verification_state: 'VERIFY_FAILED' },
    {}, null, undefined,
  ]) {
    assert.equal(genesisApplies(TREE, broken), false, `a broken genesis granted the exception: ${JSON.stringify(broken)?.slice(0, 60)}`);
  }
});

/* ── the legacy backlog ──────────────────────────────────────────────── */

test('LEGACY COMMITS ARE SUPERSEDED, NEVER PASSED', () => {
  /*
   * The 24 control commits predate the machinery. Nobody can now truthfully
   * produce a principal, an authenticated session, an attempt or a lease for
   * them, and their trailers are author-written. Marking them PASS would be
   * the fabricated-ledger-line failure the audit ledger has a header about.
   * What the owner accepted is the resulting aggregate tree.
   */
  const { genesis } = validateGenesis(good);
  const marked = legacyMarking(genesis);
  assert.equal(marked.status, 'SUPERSEDED_BY_GENESIS');
  assert.equal(marked.genesis_tree, TREE);
  assert.notEqual(marked.status, 'PASS');

  assert.equal(legacyMarking(null).status, 'PRE_GENESIS');
  assert.equal(legacyMarking(null).genesis_tree, null);
});

test('THE CONTROL: this distinguishes, in both directions', () => {
  const { genesis } = validateGenesis(good);
  assert.equal(genesisApplies(TREE, genesis), true);
  assert.equal(genesisApplies(OTHER_TREE, genesis), false);
  assert.equal(validateGenesis(good).ok, true);
  assert.equal(validateGenesis({}).ok, false);
});
