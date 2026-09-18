import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCas, memoryStore } from '../src/cas.mjs';
import { indexCandidate } from '../src/memory/patternIndexer.mjs';
import {
  ACTIVE,
  DEPRECATED,
  QUARANTINED,
  RETIRED,
  canTransition,
  canonicalRuntimeManifest,
  canonicalVerificationManifest,
  createPatternCatalog,
  derivePatternId,
} from '../src/memory/patternCatalog.mjs';

/**
 * WHAT THESE TESTS ARE GUARDING, given the file they are testing.
 *
 * The catalog's whole job is to refuse. So a green run here is worth nothing
 * unless each refusal has been watched failing: every negative below is paired
 * with the positive that proves the fixture was admissible in the first place
 * (CLAUDE.md rule 5 -- "the tool is absent for a reader" passes against a
 * fixture that stopped being a reader).
 *
 * And the identity tests deliberately change ONE input at a time from a shared
 * base. A fixture that differs in two places cannot tell you which one moved
 * the id.
 */

const SHA40_A = 'de09536bd1f8b4a2c7e05a1d3f6b9c8e4a2d7f01';
const SHA40_B = '90b29243c8cc0057db44788b1e164e88a25d64dc';
const TREE_A = 'a'.repeat(64);
const TREE_B = 'b'.repeat(64);

const manifest = (over = {}) => ({
  schema_version: 1,
  targeted_tests: [{ name: 'normalizes 10-digit US', hash: 'a1b2' }],
  mutation_tests: [{ mutation: 'invert length check', result: 'caught_red' }],
  full_suite_ref: 'npm-test-commit-1a0d8b3',
  verifier_version: 'external-verifier-2026-09-17-v1',
  baseline_sha: SHA40_A,
  integration_sha: SHA40_B,
  known_limitations: [],
  ...over,
});

const runtime = (over = {}) => ({
  runtime: 'node20',
  module_system: 'esm',
  platform_constraints: ['linux', 'win32'],
  compiler_options: { strict: true, target: 'es2022' },
  feature_flags: ['alpha', 'beta'],
  ...over,
});

/**
 * A candidate built by the REAL indexer, not by hand.
 *
 * Hollow gate 9 in CLAUDE.md is a fixture that constructs a shape the system
 * never produces. A hand-written candidate object would drift from
 * indexCandidate's output the first time either file changed, and every
 * admission test here would keep passing against a shape nothing supplies.
 */
function candidate(over = {}) {
  const { deps = { zod: '4.0.0' }, rt = runtime(), impl, tests } = over;
  return indexCandidate({
    implementation: impl ?? {
      'src/normalize.mjs': 'export function normalize(n) { return String(n).trim(); }\n',
    },
    tests: tests ?? {
      'test/normalize.test.mjs': "import { normalize } from '../src/normalize.mjs';\nnormalize(1);\n",
    },
    dependencyManifest: deps,
    runtimeManifest: rt,
    semanticFamilyHint: 'phone_normalization_e164',
  });
}

const newCatalog = () => {
  const store = memoryStore();
  return { store, catalog: createPatternCatalog({ cas: createCas({ store, namespace: 'patterns' }) }) };
};

const admit = (catalog, over = {}) =>
  catalog.admit({
    candidate: over.candidate ?? candidate(),
    verificationManifest: over.verificationManifest ?? manifest(),
    treeHash: over.treeHash ?? TREE_A,
    semanticFamilyId: over.semanticFamilyId ?? 'phone_normalization_e164',
  });

/* ── the fixture is admissible at all ────────────────────────────────── */

test('THE POSITIVE FIRST: the indexer produces a candidate the catalog admits', async () => {
  const c = candidate();
  assert.equal(c.reusability_result.reusable, true, `indexer refused the base fixture: ${c.reusability_result.reasons.join('; ')}`);

  const { catalog } = newCatalog();
  const record = await admit(catalog, { candidate: c });
  assert.match(record.pattern_id, /^[0-9a-f]{64}$/);
  assert.equal(catalog.lifecycleOf(record.pattern_id).state, ACTIVE);
});

/* ── identity: one input moves at a time ─────────────────────────────── */

test('identical canonical input produces an identical pattern_id', async () => {
  const a = await admit(newCatalog().catalog);
  const b = await admit(newCatalog().catalog);
  assert.equal(a.pattern_id, b.pattern_id);
});

test('an INTERFACE change produces a different pattern_id', async () => {
  const base = await admit(newCatalog().catalog);
  const changed = await admit(newCatalog().catalog, {
    candidate: candidate({
      impl: { 'src/normalize.mjs': 'export function normalize(n, country) { return String(n).trim(); }\n' },
    }),
  });
  assert.notEqual(changed.pattern_id, base.pattern_id);
});

test('a DEPENDENCY change produces a different pattern_id', async () => {
  const base = await admit(newCatalog().catalog);
  const changed = await admit(newCatalog().catalog, { candidate: candidate({ deps: { zod: '4.0.1' } }) });
  assert.notEqual(changed.pattern_id, base.pattern_id);
  assert.notEqual(changed.dep_manifest_hash, base.dep_manifest_hash);
});

test('a RUNTIME change produces a different pattern_id', async () => {
  const base = await admit(newCatalog().catalog);
  const changed = await admit(newCatalog().catalog, {
    candidate: candidate({ rt: runtime({ runtime: 'node22' }) }),
  });
  assert.notEqual(changed.pattern_id, base.pattern_id);
  assert.notEqual(changed.runtime_manifest_hash, base.runtime_manifest_hash);
});

test('a VERIFICATION MANIFEST change produces a different pattern_id', async () => {
  const base = await admit(newCatalog().catalog);
  const changed = await admit(newCatalog().catalog, {
    verificationManifest: manifest({ integration_sha: SHA40_A }),
  });
  assert.notEqual(changed.pattern_id, base.pattern_id);
  assert.notEqual(changed.verification_manifest_hash, base.verification_manifest_hash);
});

test('a TREE change produces a different pattern_id', async () => {
  const base = await admit(newCatalog().catalog);
  const changed = await admit(newCatalog().catalog, { treeHash: TREE_B });
  assert.notEqual(changed.pattern_id, base.pattern_id);
});

/* ── ordering is not a value change ──────────────────────────────────── */

test('ORDERING-ONLY differences in sets and maps do NOT change the hash', async () => {
  const base = await admit(newCatalog().catalog);
  const reordered = await admit(newCatalog().catalog, {
    candidate: candidate({
      rt: {
        module_system: 'esm',
        feature_flags: ['beta', 'alpha'],
        compiler_options: { target: 'es2022', strict: true },
        platform_constraints: ['win32', 'linux'],
        runtime: 'node20',
      },
    }),
  });
  assert.equal(reordered.runtime_manifest_hash, base.runtime_manifest_hash);
  assert.equal(reordered.pattern_id, base.pattern_id);
});

test('a duplicate inside a SET is the same set, but a different member is not', () => {
  const once = canonicalRuntimeManifest(runtime({ feature_flags: ['alpha'] })).hash;
  const twice = canonicalRuntimeManifest(runtime({ feature_flags: ['alpha', 'alpha'] })).hash;
  const other = canonicalRuntimeManifest(runtime({ feature_flags: ['gamma'] })).hash;
  assert.equal(twice, once, 'a set containing a duplicate is the same set');
  assert.notEqual(other, once, 'a different member must move the hash');
});

test('known_limitations is order-insensitive, but its CONTENT is not', () => {
  const a = canonicalVerificationManifest(manifest({ known_limitations: ['x', 'y'] })).hash;
  const b = canonicalVerificationManifest(manifest({ known_limitations: ['y', 'x'] })).hash;
  const c = canonicalVerificationManifest(manifest({ known_limitations: ['x', 'z'] })).hash;
  assert.equal(b, a);
  assert.notEqual(c, a);
});

test('the ORDER of the proof log IS meaningful and does move the hash', () => {
  /*
   * targeted_tests is a log of what ran, not a set. Sorting it would make two
   * different runs canonicalise identically -- the joined-list defect named in
   * src/verificationProof.mjs, one level up.
   */
  const forward = canonicalVerificationManifest(manifest({
    targeted_tests: [{ name: 'a', hash: '1' }, { name: 'b', hash: '2' }],
  })).hash;
  const backward = canonicalVerificationManifest(manifest({
    targeted_tests: [{ name: 'b', hash: '2' }, { name: 'a', hash: '1' }],
  })).hash;
  assert.notEqual(backward, forward);
});

/* ── the framing that makes a plain concatenation safe ───────────────── */

test('derivePatternId REFUSES a component that is not exactly 64 hex characters', () => {
  /*
   * WHY THIS IS THE LOAD-BEARING TEST FOR IDENTITY. The spec's formula is a
   * plain concatenation, which is ambiguous framing -- the reason
   * src/deployGate.mjs carries literal NUL bytes. It is safe here ONLY because
   * the four trailing components are fixed-width, so the last 256 characters
   * parse unambiguously as four hashes. Remove this validation and a stub whose
   * tail looks like hex can imitate a hash boundary.
   */
  const good = {
    canonical_interface_stub: 'export function x()',
    tree_hash: TREE_A,
    dep_manifest_hash: TREE_B,
    verification_manifest_hash: 'c'.repeat(64),
    runtime_manifest_hash: 'd'.repeat(64),
  };
  assert.match(derivePatternId(good), /^[0-9a-f]{64}$/);

  for (const field of ['tree_hash', 'dep_manifest_hash', 'verification_manifest_hash', 'runtime_manifest_hash']) {
    for (const bad of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'zz', '']) {
      assert.throws(
        () => derivePatternId({ ...good, [field]: bad }),
        /identity-input-malformed/,
        `${field}=${JSON.stringify(bad)} must be refused`,
      );
    }
  }
});

test('an empty interface stub has no identity', () => {
  assert.throws(
    () => derivePatternId({
      canonical_interface_stub: '   ',
      tree_hash: TREE_A,
      dep_manifest_hash: TREE_B,
      verification_manifest_hash: 'c'.repeat(64),
      runtime_manifest_hash: 'd'.repeat(64),
    }),
    /canonicalization-failed/,
  );
});

/* ── proof is required, and never manufactured ───────────────────────── */

test('MISSING VERIFICATION PROOF refuses admission, field by field', async () => {
  const { catalog } = newCatalog();
  // the positive first: the complete manifest is admissible
  assert.ok(await admit(catalog, { verificationManifest: manifest() }));

  for (const field of [
    'schema_version', 'targeted_tests', 'mutation_tests', 'full_suite_ref',
    'verifier_version', 'baseline_sha', 'integration_sha', 'known_limitations',
  ]) {
    const incomplete = manifest();
    delete incomplete[field];
    await assert.rejects(
      () => admit(newCatalog().catalog, { verificationManifest: incomplete }),
      /proof-missing|proof-malformed/,
      `a manifest without ${field} must be refused`,
    );
  }
});

test('NO MANIFEST AT ALL is refused rather than defaulted', async () => {
  /*
   * CALLS catalog.admit DIRECTLY, AND THAT IS THE POINT OF THE TEST.
   *
   * Written first through the `admit` helper above, which fills its arguments
   * with `over.verificationManifest ?? manifest()`. undefined and null are both
   * nullish, so the helper QUIETLY SUBSTITUTED A VALID MANIFEST and the case
   * under test was never constructed -- the assertion failed with "missing
   * expected rejection" against a perfectly good admission.
   *
   * That is CLAUDE.md rule 9 inside a test rather than inside a fixture: if the
   * harness cannot build the real case it cannot fail for it. The three
   * non-nullish values passed the whole time, which is exactly how this hides.
   */
  for (const absent of [undefined, null, 'proof', 42, []]) {
    await assert.rejects(
      () => newCatalog().catalog.admit({
        candidate: candidate(),
        verificationManifest: absent,
        treeHash: TREE_A,
        semanticFamilyId: 'phone_normalization_e164',
      }),
      /proof-missing/,
      `${JSON.stringify(absent) ?? 'undefined'} must not stand in for a manifest`,
    );
  }
});

test('a missing treeHash or semanticFamilyId is refused, not defaulted', async () => {
  // same trap as above: these go through admit() directly so nothing fills them in
  const base = { candidate: candidate(), verificationManifest: manifest() };
  await assert.rejects(
    () => newCatalog().catalog.admit({ ...base, semanticFamilyId: 'x' }),
    /identity-input-malformed/,
    'an absent treeHash must be refused',
  );
  await assert.rejects(
    () => newCatalog().catalog.admit({ ...base, treeHash: TREE_A }),
    /identity-input-malformed/,
    'an absent semanticFamilyId must be refused',
  );
});

test('AN EMPTY PROOF ARRAY IS NOT PROOF', async () => {
  /*
   * "The key is present" is the hollow gate in one line: a green check that
   * proves nothing. targeted_tests:[] and mutation_tests:[] both satisfy a
   * presence check and carry no evidence whatsoever.
   */
  await assert.rejects(
    () => admit(newCatalog().catalog, { verificationManifest: manifest({ targeted_tests: [] }) }),
    /proof-missing/,
  );
  await assert.rejects(
    () => admit(newCatalog().catalog, { verificationManifest: manifest({ mutation_tests: [] }) }),
    /proof-missing/,
  );
});

test('AN UNDECLARED KEY IN THE MANIFEST IS REFUSED, NOT IGNORED', async () => {
  /*
   * The exact forgery src/verificationProof.mjs records: spreading an extra
   * field onto a valid record and having it read back as valid, because the
   * digest did not cover the extra key.
   */
  await assert.rejects(
    () => admit(newCatalog().catalog, {
      verificationManifest: { ...manifest(), authorization: 'approved', promotable: true },
    }),
    /proof-malformed/,
  );
});

test('LIFECYCLE STATUS INSIDE THE MANIFEST IS REFUSED BY NAME', async () => {
  /*
   * Spec 3.3's example carries "status":"ACTIVE" while section 4 makes status
   * mutable. Accepting it into the identity-bearing manifest would make a
   * lifecycle transition mint a new pattern_id. Refused loudly rather than
   * silently dropped: a silently dropped key is a key the caller supplied that
   * the hash does not cover.
   */
  await assert.rejects(
    () => admit(newCatalog().catalog, { verificationManifest: { ...manifest(), status: 'ACTIVE' } }),
    /proof-carries-lifecycle-status/,
  );
});

test('a malformed sha in the manifest is refused', async () => {
  for (const field of ['baseline_sha', 'integration_sha']) {
    await assert.rejects(
      () => admit(newCatalog().catalog, { verificationManifest: manifest({ [field]: 'not-a-sha' }) }),
      /proof-malformed/,
    );
  }
});

/* ── a non-reusable candidate cannot be admitted by accident ─────────── */

test('A NON-REUSABLE CANDIDATE IS REFUSED, and the indexer is what says so', async () => {
  const bad = candidate({
    impl: { 'src/net.mjs': "import https from 'node:https';\nexport const go = () => https.get('x');\n" },
  });
  assert.equal(bad.reusability_result.reusable, false);

  await assert.rejects(() => admit(newCatalog().catalog, { candidate: bad }), /candidate-not-reusable/);
});

test('a candidate with no reusability_result at all is refused', async () => {
  for (const shape of [{}, { reusability_result: {} }, { reusability_result: { reusable: 'yes' } }]) {
    await assert.rejects(
      () => admit(newCatalog().catalog, { candidate: shape }),
      /candidate-not-reusable/,
      `${JSON.stringify(shape)} must not be admitted`,
    );
  }
});

test('an unpinned dependency range is refused', async () => {
  await assert.rejects(
    () => admit(newCatalog().catalog, { candidate: candidate({ deps: { zod: '^4.0.0' } }) }),
    /identity-input-malformed/,
  );
});

/* ── CAS ─────────────────────────────────────────────────────────────── */

test('DUPLICATE CONTENT DEDUPLICATES IN THE STORE', async () => {
  const { store, catalog } = newCatalog();
  const body = 'export function normalize(n) { return String(n).trim(); }\n';
  await admit(catalog, {
    candidate: candidate({
      impl: { 'src/a.mjs': body, 'src/b.mjs': body },
      tests: { 'test/a.test.mjs': "import '../src/a.mjs';\n" },
    }),
  });
  const keys = [...store.map.keys()];
  assert.equal(new Set(keys).size, keys.length, 'keys must be unique');
  // two implementation paths, identical bytes, plus one distinct test blob
  assert.equal(keys.length, 2, `identical bytes must share one entry, got keys ${JSON.stringify(keys)}`);
});

test('A CORRUPTED BLOB FAILS CLOSED ON RETRIEVAL', async () => {
  const { store, catalog } = newCatalog();
  const record = await admit(catalog);

  // the positive first: it reads back before the store is tampered with
  const before = await catalog.inspect(record.pattern_id);
  assert.equal(Object.keys(before.implementation).length, 1);

  const key = [...store.map.keys()][0];
  store.map.set(key, Buffer.from('tampered bytes that do not match the digest'));

  await assert.rejects(() => catalog.inspect(record.pattern_id), /blob-corrupt/);
});

test('retrieval never carries implementation source; inspection is explicit', async () => {
  const { catalog } = newCatalog();
  const record = await admit(catalog);
  const [found] = catalog.retrieve({ semanticFamilyId: 'phone_normalization_e164' });
  assert.equal(found.pattern_id, record.pattern_id);

  const serialised = JSON.stringify(found);
  assert.equal(serialised.includes('return String(n).trim()'), false, 'a retrieval result must not carry the body');
  assert.ok(found.canonical_interface_stub.includes('normalize'), 'but it must carry the stub');

  const inspected = await catalog.inspect(record.pattern_id);
  assert.ok(inspected.implementation['src/normalize.mjs'].toString().includes('return String(n).trim()'));
});

/* ── lifecycle ───────────────────────────────────────────────────────── */

test('the transition table matches the spec section 4 diagram exactly', () => {
  const allowed = [
    [ACTIVE, DEPRECATED], [ACTIVE, QUARANTINED],
    [DEPRECATED, RETIRED], [RETIRED, QUARANTINED],
  ];
  for (const [from, to] of allowed) assert.equal(canTransition(from, to), true, `${from} -> ${to} must be allowed`);

  const refused = [
    [ACTIVE, ACTIVE], [DEPRECATED, ACTIVE], [QUARANTINED, ACTIVE], [RETIRED, ACTIVE],
    [QUARANTINED, DEPRECATED], [QUARANTINED, RETIRED], [QUARANTINED, QUARANTINED],
    [DEPRECATED, QUARANTINED], [RETIRED, DEPRECATED],
  ];
  for (const [from, to] of refused) assert.equal(canTransition(from, to), false, `${from} -> ${to} must be refused`);
});

test('AN INVALID TRANSITION IS REFUSED at the catalog, not just in the table', async () => {
  const { catalog } = newCatalog();
  const { pattern_id: id } = await admit(catalog);

  // the positive first: a legal move works
  assert.equal(catalog.transition(id, DEPRECATED, 'superseded by a wider matcher').state, DEPRECATED);

  assert.throws(() => catalog.transition(id, ACTIVE, 'undo'), /invalid-transition/);
  assert.equal(catalog.lifecycleOf(id).state, DEPRECATED, 'a refused transition must not have moved anything');
});

test('a transition needs a reason a later reader can disagree with', async () => {
  const { catalog } = newCatalog();
  const { pattern_id: id } = await admit(catalog);
  for (const reason of ['', '   ', null, undefined]) {
    assert.throws(() => catalog.transition(id, DEPRECATED, reason), /invalid-transition/);
  }
});

test('QUARANTINED IS UNAVAILABLE FOR NORMAL RETRIEVAL', async () => {
  const { catalog } = newCatalog();
  const { pattern_id: id } = await admit(catalog);
  assert.equal(catalog.retrieve().length, 1, 'the positive first: it is retrievable while ACTIVE');

  catalog.transition(id, QUARANTINED, 'dependency advisory 2026-09-17');
  assert.deepEqual(catalog.retrieve(), []);
  assert.deepEqual(catalog.retrieve({ intent: 'compatibility' }), [], 'not even with compatibility intent');
});

test('RETIRED IS UNAVAILABLE FOR NORMAL RETRIEVAL', async () => {
  const { catalog } = newCatalog();
  const { pattern_id: id } = await admit(catalog);
  assert.equal(catalog.retrieve().length, 1);

  catalog.transition(id, DEPRECATED, 'superseded');
  catalog.transition(id, RETIRED, 'proof decayed: integration_sha reverted');
  assert.deepEqual(catalog.retrieve(), []);
  assert.deepEqual(catalog.retrieve({ intent: 'compatibility' }), []);
});

test('DEPRECATED is withheld from normal retrieval but offered on explicit intent', async () => {
  const { catalog } = newCatalog();
  const { pattern_id: id } = await admit(catalog);
  catalog.transition(id, DEPRECATED, 'superseded by a wider matcher');

  assert.deepEqual(catalog.retrieve(), [], 'normal retrieval must not prefer it');
  assert.equal(catalog.retrieve({ intent: 'compatibility' }).length, 1);
});

test('A LIFECYCLE TRANSITION DOES NOT CHANGE pattern_id', async () => {
  /*
   * The spec contradiction this slice resolves. If status were inside the
   * canonicalised verification manifest, this assertion could not hold: the
   * manifest hash feeds pattern_id, so deprecating a pattern would mint a new
   * identity and the old one could never be re-derived (spec 12, 16.4).
   */
  const { catalog } = newCatalog();
  const record = await admit(catalog);
  const before = record.pattern_id;

  catalog.transition(before, DEPRECATED, 'superseded');
  catalog.transition(before, RETIRED, 'retired');

  assert.equal(catalog.get(before).pattern_id, before);
  assert.equal(catalog.get(before).verification_manifest_hash, record.verification_manifest_hash);
  assert.equal(catalog.lifecycleOf(before).state, RETIRED);
});

test('lifecycle history records every move with its reason', async () => {
  const { catalog } = newCatalog();
  const { pattern_id: id } = await admit(catalog);
  catalog.transition(id, DEPRECATED, 'superseded');
  catalog.transition(id, RETIRED, 'proof decayed');
  assert.deepEqual(catalog.lifecycleOf(id).history, [
    { from: ACTIVE, to: DEPRECATED, reason: 'superseded' },
    { from: DEPRECATED, to: RETIRED, reason: 'proof decayed' },
  ]);
});

test('an unknown pattern id is a refusal, not a null that reads as absent', async () => {
  const { catalog } = newCatalog();
  assert.throws(() => catalog.lifecycleOf('f'.repeat(64)), /unknown-pattern/);
  await assert.rejects(() => catalog.inspect('f'.repeat(64)), /unknown-pattern/);
});

/* ── re-admission ────────────────────────────────────────────────────── */

test('re-admitting identical inputs is a no-op, not a duplicate', async () => {
  const { catalog } = newCatalog();
  const first = await admit(catalog);
  const second = await admit(catalog);
  assert.equal(second.pattern_id, first.pattern_id);
  assert.equal(catalog.size(), 1);
});

test('re-admission does not reset a lifecycle state', async () => {
  const { catalog } = newCatalog();
  const { pattern_id: id } = await admit(catalog);
  catalog.transition(id, QUARANTINED, 'vulnerability');
  await admit(catalog);
  assert.equal(catalog.lifecycleOf(id).state, QUARANTINED, 're-admitting must not launder a quarantine');
  assert.deepEqual(catalog.retrieve(), []);
});
