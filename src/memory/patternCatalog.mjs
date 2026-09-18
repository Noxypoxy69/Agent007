/**
 * THE IMMUTABLE CATALOG. IT VERIFIES NOTHING AND IT CERTIFIES NOTHING.
 *
 * Spec section 7: "The catalog must never self-certify unverified code. It
 * consumes proof produced by the assembly line." That sentence is the entire
 * design, and this repository has already paid four times to learn why.
 *
 * src/verificationProof.mjs records the history: four reviews found the same
 * defect and the first three repairs MOVED it rather than removing it -- the
 * candidate controlled verification, then the caller did, then the artifact
 * carried no context, and finally the artifact manufactured authority outright
 * ({promotable:true, standingBlockers:[]} with a recomputed digest read back as
 * approved). The settled answer was to delete the promotion vocabulary: no
 * promotable field, no success-looking `ok`, reader always says
 * authorization:'none'.
 *
 * SO THIS MODULE MUST NOT REBUILD THAT DEFECT ONE DIRECTORY OVER. The
 * verification manifest arrives as OPAQUE CALLER-SUPPLIED INPUT. This file may:
 * check the declared fields are present and well-formed, canonicalise it, and
 * hash it. It may NOT construct a manifest, decide whether a test passed, judge
 * a mutation result, or infer proof from anything it can reach. Missing or
 * malformed proof is a refusal (spec 16.8, "admission fails closed on missing
 * proof"), and a refusal is the ONLY thing this module can say about proof.
 *
 * WHAT IS DELIBERATELY ABSENT AND MUST STAY ABSENT:
 *   any function that runs a test, a suite, or a mutation;
 *   any field named promotable, approved, verified or ok;
 *   any code path that derives proof from the implementation blobs;
 *   any default that supplies a missing proof field.
 *
 * ONE SPEC CONTRADICTION IS RESOLVED HERE, AND THE OWNER SHOULD CONFIRM IT.
 * Spec 3.3's example manifest carries "status":"ACTIVE", while section 4 makes
 * status a MUTABLE lifecycle state. Both cannot hold: verification_manifest_hash
 * feeds pattern_id, so a status inside the manifest would mean ACTIVE ->
 * DEPRECATED mints a NEW pattern_id and the old identity can never be
 * re-derived -- contradicting 12 ("must not mutate immutable pattern identity")
 * and 16.4. Lifecycle state is therefore MUTABLE CATALOG METADATA held beside
 * the immutable record, and `status` inside a verification manifest is REFUSED
 * by name rather than silently dropped (a silently dropped key is the unhashed
 * forgery surface described in src/memory/canonical.mjs).
 *
 * PURE apart from the injected CAS. No clock, no filesystem, no network.
 *
 * THIS MODULE IS DELIBERATELY ORPHANED, AND THAT IS NOT AN OVERSIGHT TO FIX.
 * Slice 1 stops before patternRetriever, so nothing shipped imports it yet and
 * test/noOrphanModules.test.mjs reports it as test-only. Owner decision
 * 2026-09-17: HOLD the slice rather than move a baseline. Do NOT add a KNOWN
 * entry and do NOT raise BASELINE_TEST_ONLY to accommodate it -- that file's own
 * comment says a baseline raised to fit the change it was meant to catch is not
 * a gate. The finding clears by itself when Slice 2 gives this a real caller,
 * which is the only correct way for it to clear.
 */

import {
  CanonicalizationError,
  assertExactKeys,
  canonicalJson,
  canonicalSet,
  canonicalStub,
  hashCanonical,
  isGitSha,
  isSha256Hex,
  sha256Hex,
} from './canonical.mjs';

/** Each a distinct defect. Never collapsed into one "invalid". */
export const REFUSALS = Object.freeze([
  'candidate-not-reusable',
  'proof-missing',
  'proof-malformed',
  'proof-carries-lifecycle-status',
  'canonicalization-failed',
  'identity-input-malformed',
  'blob-missing',
  'blob-corrupt',
  'duplicate-identity-conflict',
  'unknown-pattern',
  'invalid-transition',
]);

export class AdmissionRefused extends Error {
  constructor(refusal, detail) {
    super(`${refusal}: ${detail}`);
    this.name = 'AdmissionRefused';
    this.refusal = refusal;
    this.detail = detail;
  }
}

const refuse = (refusal, detail) => {
  throw new AdmissionRefused(refusal, detail);
};

/* ── lifecycle ───────────────────────────────────────────────────────── */

export const ACTIVE = 'ACTIVE';
export const DEPRECATED = 'DEPRECATED';
export const QUARANTINED = 'QUARANTINED';
export const RETIRED = 'RETIRED';

export const LIFECYCLE_STATES = Object.freeze([ACTIVE, DEPRECATED, QUARANTINED, RETIRED]);

/**
 * The state machine, transcribed from the spec section 4 diagram and no wider.
 *
 * ACTIVE -> DEPRECATED          deprecation trigger
 * ACTIVE -> QUARANTINED         known vulnerability / proof invalidation
 * DEPRECATED -> RETIRED         the diagram's second downward arrow
 * RETIRED -> QUARANTINED        administrative override
 * QUARANTINED -> (terminal)     "permanently blocked from normal retrieval"
 *
 * DELIBERATELY NARROWER THAN THE PROSE. Section 4 also says a RETIRED pattern
 * may be "administratively restored through an explicit migration path", but the
 * diagram draws no such edge and the spec never names the path. Inventing a
 * restore edge would hand this module an authority the spec did not grant it, so
 * the edge is absent and the ambiguity is reported rather than guessed at.
 */
const TRANSITIONS = Object.freeze({
  [ACTIVE]: Object.freeze([DEPRECATED, QUARANTINED]),
  [DEPRECATED]: Object.freeze([RETIRED]),
  [RETIRED]: Object.freeze([QUARANTINED]),
  [QUARANTINED]: Object.freeze([]),
});

/** Spec section 4 retrieval rules, as data rather than as scattered ifs. */
const NORMALLY_RETRIEVABLE = Object.freeze(new Set([ACTIVE]));
const RETRIEVABLE_WITH_COMPATIBILITY_INTENT = Object.freeze(new Set([ACTIVE, DEPRECATED]));

export function canTransition(from, to) {
  if (!LIFECYCLE_STATES.includes(from) || !LIFECYCLE_STATES.includes(to)) return false;
  return TRANSITIONS[from].includes(to);
}

/* ── the manifests, each canonicalised under a declared schema ────────── */

export const VERIFICATION_MANIFEST_FIELDS = Object.freeze([
  'schema_version',
  'targeted_tests',
  'mutation_tests',
  'full_suite_ref',
  'verifier_version',
  'baseline_sha',
  'integration_sha',
  'known_limitations',
]);

export const RUNTIME_MANIFEST_FIELDS = Object.freeze([
  'runtime',
  'module_system',
  'platform_constraints',
  'compiler_options',
  'feature_flags',
]);

/** Set-like by declaration, never by guess: sorting an ordered array loses meaning. */
const RUNTIME_SET_FIELDS = Object.freeze(['platform_constraints', 'feature_flags']);

const nonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Canonicalise a verification manifest and hash it. PRESENCE AND SHAPE ONLY.
 *
 * Note what is NOT checked: whether a targeted test passed, whether a mutation
 * was actually caught, whether the suite was green. This module cannot know any
 * of that and must not appear to. It checks that the assembly line supplied the
 * fields the spec requires, in the shapes the spec requires, and refuses when it
 * did not.
 *
 * EMPTY IS NOT PRESENT, for the two proof arrays. A manifest with
 * targeted_tests:[] and mutation_tests:[] satisfies "the key exists" while
 * carrying no proof at all -- a green check proving nothing, which is the one
 * bug class CLAUDE.md says this project produces in volume. known_limitations
 * is different and MAY be empty: "nothing known" is a real answer there.
 */
export function canonicalVerificationManifest(manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    refuse('proof-missing', 'a verification manifest object is required');
  }

  if (Object.prototype.hasOwnProperty.call(manifest, 'status')) {
    refuse(
      'proof-carries-lifecycle-status',
      'lifecycle status is mutable catalog metadata and must not appear in the identity-bearing ' +
        'verification manifest: including it would make ACTIVE->DEPRECATED mint a new pattern_id, ' +
        'contradicting spec 12 and 16.4. Pass it to transition() instead.',
    );
  }

  let missing;
  try {
    ({ missing } = assertExactKeys(manifest, VERIFICATION_MANIFEST_FIELDS, 'verification_manifest'));
  } catch (err) {
    if (err instanceof CanonicalizationError) refuse('proof-malformed', err.message);
    throw err;
  }
  if (missing.length > 0) {
    refuse('proof-missing', `verification manifest is missing ${missing.join(', ')}`);
  }

  const {
    schema_version: schemaVersion,
    targeted_tests: targeted,
    mutation_tests: mutations,
    full_suite_ref: fullSuiteRef,
    verifier_version: verifierVersion,
    baseline_sha: baselineSha,
    integration_sha: integrationSha,
    known_limitations: knownLimitations,
  } = manifest;

  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    refuse('proof-malformed', 'schema_version must be an integer >= 1');
  }

  if (!Array.isArray(targeted) || targeted.length === 0) {
    refuse('proof-missing', 'targeted_tests must be a non-empty array; an empty proof array proves nothing');
  }
  targeted.forEach((entry, i) => {
    try {
      assertExactKeys(entry, ['name', 'hash'], `targeted_tests[${i}]`);
    } catch (err) {
      refuse('proof-malformed', err.message);
    }
    if (!nonEmptyString(entry.name)) refuse('proof-malformed', `targeted_tests[${i}].name must be a non-empty string`);
    if (!nonEmptyString(entry.hash)) refuse('proof-malformed', `targeted_tests[${i}].hash must be a non-empty string`);
  });

  if (!Array.isArray(mutations) || mutations.length === 0) {
    refuse('proof-missing', 'mutation_tests must be a non-empty array; an empty proof array proves nothing');
  }
  mutations.forEach((entry, i) => {
    try {
      assertExactKeys(entry, ['mutation', 'result'], `mutation_tests[${i}]`);
    } catch (err) {
      refuse('proof-malformed', err.message);
    }
    if (!nonEmptyString(entry.mutation)) refuse('proof-malformed', `mutation_tests[${i}].mutation must be a non-empty string`);
    /*
     * The RESULT is recorded verbatim and never interpreted. Reading 'caught_red'
     * as "this pattern is safe" would be this module deciding a verification
     * question, which is precisely what it may not do.
     */
    if (!nonEmptyString(entry.result)) refuse('proof-malformed', `mutation_tests[${i}].result must be a non-empty string`);
  });

  if (!nonEmptyString(fullSuiteRef)) refuse('proof-missing', 'full_suite_ref must be a non-empty string');
  if (!nonEmptyString(verifierVersion)) refuse('proof-missing', 'verifier_version must be a non-empty string');
  if (!isGitSha(baselineSha)) refuse('proof-malformed', 'baseline_sha must be a 40-character git sha');
  if (!isGitSha(integrationSha)) refuse('proof-malformed', 'integration_sha must be a 40-character git sha');
  if (!Array.isArray(knownLimitations) || knownLimitations.some((v) => typeof v !== 'string')) {
    refuse('proof-malformed', 'known_limitations must be an array of strings (it may be empty)');
  }

  try {
    /*
     * targeted_tests and mutation_tests keep their ORDER. They are a log of what
     * the assembly line ran, and reordering a log is a different log -- unlike
     * platform_constraints, which is a set. known_limitations is sorted because
     * it is a set of statements about the pattern, not a sequence.
     */
    const canonical = {
      schema_version: schemaVersion,
      targeted_tests: targeted.map((e) => ({ name: e.name, hash: e.hash })),
      mutation_tests: mutations.map((e) => ({ mutation: e.mutation, result: e.result })),
      full_suite_ref: fullSuiteRef,
      verifier_version: verifierVersion,
      baseline_sha: baselineSha,
      integration_sha: integrationSha,
      known_limitations: canonicalSet(knownLimitations, 'known_limitations'),
    };
    return { canonical, hash: hashCanonical(canonical, 'verification_manifest') };
  } catch (err) {
    if (err instanceof CanonicalizationError) refuse('canonicalization-failed', err.message);
    throw err;
  }
}

/**
 * Canonicalise a runtime manifest and hash it.
 *
 * Spec 3.1: order differences in semantically equivalent maps and sets must not
 * change the hash; actual value differences must. compiler_options is a MAP, so
 * key order is irrelevant and canonicalJson sorts it. platform_constraints and
 * feature_flags are SETS, so they are sorted and deduplicated.
 */
export function canonicalRuntimeManifest(manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    refuse('identity-input-malformed', 'a runtime manifest object is required');
  }

  let missing;
  try {
    ({ missing } = assertExactKeys(manifest, RUNTIME_MANIFEST_FIELDS, 'runtime_manifest'));
  } catch (err) {
    if (err instanceof CanonicalizationError) refuse('identity-input-malformed', err.message);
    throw err;
  }
  if (missing.length > 0) {
    refuse('identity-input-malformed', `runtime manifest is missing ${missing.join(', ')}`);
  }

  if (!nonEmptyString(manifest.runtime)) refuse('identity-input-malformed', 'runtime must be a non-empty string');
  if (!nonEmptyString(manifest.module_system)) refuse('identity-input-malformed', 'module_system must be a non-empty string');

  const options = manifest.compiler_options;
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    refuse('identity-input-malformed', 'compiler_options must be an object');
  }

  try {
    const canonical = {
      runtime: manifest.runtime,
      module_system: manifest.module_system,
      platform_constraints: canonicalSet(manifest.platform_constraints, 'platform_constraints'),
      compiler_options: options,
      feature_flags: canonicalSet(manifest.feature_flags, 'feature_flags'),
    };
    for (const field of RUNTIME_SET_FIELDS) {
      if (!Array.isArray(manifest[field])) {
        refuse('identity-input-malformed', `${field} must be an array`);
      }
    }
    return { canonical, hash: hashCanonical(canonical, 'runtime_manifest') };
  } catch (err) {
    if (err instanceof AdmissionRefused) throw err;
    if (err instanceof CanonicalizationError) refuse('canonicalization-failed', err.message);
    throw err;
  }
}

/** A version range is not a pinned version. Spec 10 asks for EXACT versions. */
const EXACT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * Canonicalise a dependency manifest and hash it.
 *
 * Refusing a RANGE is the point. "^1.2.0" names a set of possible behaviours,
 * and a pattern whose identity covers a set of behaviours is a pattern whose
 * proof covers none of them in particular -- the same shape as a fixture that
 * cannot construct the real case (CLAUDE.md hollow gate 9).
 */
export function canonicalDependencyManifest(deps) {
  if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) {
    refuse('identity-input-malformed', 'a dependency manifest object is required (it may be empty)');
  }
  for (const [name, version] of Object.entries(deps)) {
    if (!nonEmptyString(version) || !EXACT_VERSION.test(version)) {
      refuse(
        'identity-input-malformed',
        `dependency ${JSON.stringify(name)} must be pinned to an exact version, got ${JSON.stringify(version)}`,
      );
    }
  }
  try {
    return { canonical: deps, hash: hashCanonical(deps, 'dep_manifest') };
  } catch (err) {
    if (err instanceof CanonicalizationError) refuse('canonicalization-failed', err.message);
    throw err;
  }
}

/* ── identity ────────────────────────────────────────────────────────── */

/**
 * pattern_id, exactly as spec 3.1 writes it:
 *
 *   SHA256(canonical_interface_stub + tree_hash + dep_manifest_hash
 *          + verification_manifest_hash + runtime_manifest_hash)
 *
 * THE FORMULA IS A PLAIN CONCATENATION AND THAT IS ONLY SAFE BECAUSE OF THE
 * VALIDATION BELOW. Concatenation without framing is ambiguous -- it is why
 * src/deployGate.mjs carries literal NUL bytes. Here the four trailing
 * components are each asserted to be exactly 64 lowercase hex characters, which
 * makes the encoding injective without deviating from the spec's formula: the
 * last 256 characters are unambiguously the four hashes and everything before
 * them is the stub, whatever the stub contains. Drop the assertion and a stub
 * ending in hex-looking text can imitate a hash boundary and collide.
 */
export function derivePatternId({
  canonical_interface_stub: stub,
  tree_hash: treeHash,
  dep_manifest_hash: depHash,
  verification_manifest_hash: proofHash,
  runtime_manifest_hash: runtimeHash,
}) {
  const named = [
    ['tree_hash', treeHash],
    ['dep_manifest_hash', depHash],
    ['verification_manifest_hash', proofHash],
    ['runtime_manifest_hash', runtimeHash],
  ];
  for (const [name, value] of named) {
    if (!isSha256Hex(value)) {
      refuse('identity-input-malformed', `${name} must be 64 lowercase hex characters, got ${JSON.stringify(value)}`);
    }
  }
  let canonicalStubText;
  try {
    canonicalStubText = canonicalStub(stub);
  } catch (err) {
    if (err instanceof CanonicalizationError) refuse('canonicalization-failed', err.message);
    throw err;
  }
  return sha256Hex(canonicalStubText + treeHash + depHash + proofHash + runtimeHash);
}

/* ── the catalog ─────────────────────────────────────────────────────── */

/**
 * `cas` is the injected content store from src/cas.mjs.
 *
 * NOT REBUILT HERE. src/cas.mjs already deduplicates by content address, carries
 * hash AND size in every digest, verifies both on read, and returns null rather
 * than wrong bytes when a stored blob does not match its name. Spec section 7
 * lists "CAS write/read" as a catalog RESPONSIBILITY, not as a module the
 * catalog owns, and section 9's requirements are met by that file.
 */
export function createPatternCatalog({ cas } = {}) {
  if (!cas || typeof cas.put !== 'function' || typeof cas.get !== 'function') {
    throw new TypeError('patternCatalog: a cas with put and get is required');
  }

  /** pattern_id -> frozen immutable record. */
  const records = new Map();
  /** pattern_id -> mutable lifecycle metadata. Deliberately a SEPARATE map. */
  const lifecycle = new Map();

  /**
   * Write a blob and prove it comes back.
   *
   * Spec 9 requires refusing "silent mutation of existing blobs". Under content
   * addressing a key cannot name two different byte strings, so the only way to
   * observe mutation is a store that hands back something other than what the
   * digest names -- and cas.get() already answers null for exactly that. So the
   * enforcement is a read-back: put, then get, and treat a miss as corruption.
   * This is the far end, not a proxy for it (CLAUDE.md rule 4).
   */
  async function putBlob(bytes, label) {
    const digest = await cas.put(bytes);
    const readBack = await cas.get(digest);
    if (readBack === null) {
      refuse('blob-corrupt', `${label} did not read back from the store under its own digest`);
    }
    return digest;
  }

  /**
   * Admit a pattern. EVERY argument is supplied by the caller; nothing is derived
   * from running anything.
   */
  async function admit({ candidate, verificationManifest, treeHash, semanticFamilyId, provenance = null } = {}) {
    if (candidate === null || typeof candidate !== 'object') {
      refuse('candidate-not-reusable', 'a candidate from the pattern indexer is required');
    }

    /*
     * THE INDEXER'S VERDICT IS LOAD-BEARING AND IS CHECKED FIRST.
     *
     * Spec 15 requires "non-reusable candidate -> admission refused", and the
     * order matters: checking proof first would let a non-reusable candidate
     * with perfect proof get further into this function than it should, and a
     * later reader would reasonably assume reaching the proof check meant the
     * candidate was reusable.
     */
    if (candidate.reusability_result?.reusable !== true) {
      const reasons = candidate.reusability_result?.reasons ?? ['no reusability_result on the candidate'];
      refuse('candidate-not-reusable', `the indexer did not mark this candidate reusable: ${reasons.join('; ')}`);
    }

    if (!nonEmptyString(semanticFamilyId)) {
      refuse('identity-input-malformed', 'semanticFamilyId is required (spec 3.2)');
    }
    if (!isSha256Hex(treeHash)) {
      refuse('identity-input-malformed', 'treeHash must be 64 lowercase hex characters, supplied by the verifier (spec 3.1)');
    }

    const proof = canonicalVerificationManifest(verificationManifest);
    const runtime = canonicalRuntimeManifest(candidate.runtime_manifest);
    const deps = canonicalDependencyManifest(candidate.dependency_manifest);

    let stub;
    try {
      stub = canonicalStub(candidate.interface_stub);
    } catch (err) {
      if (err instanceof CanonicalizationError) refuse('canonicalization-failed', err.message);
      throw err;
    }

    const patternId = derivePatternId({
      canonical_interface_stub: stub,
      tree_hash: treeHash,
      dep_manifest_hash: deps.hash,
      verification_manifest_hash: proof.hash,
      runtime_manifest_hash: runtime.hash,
    });

    /*
     * RE-ADMITTING THE SAME IDENTITY IS FINE; CONTRADICTING ONE IS NOT.
     * Identical inputs produce an identical id by design, so a repeat admission
     * is a no-op. A DIFFERENT record under the same id would mean the identity
     * function is not injective, and silently overwriting would hide that.
     */
    const existing = records.get(patternId);

    const implementation = [];
    for (const [path, bytes] of Object.entries(candidate.implementation_blobs ?? {})) {
      implementation.push({ path, digest: await putBlob(bytes, `implementation ${path}`) });
    }
    const tests = [];
    for (const [path, bytes] of Object.entries(candidate.test_blobs ?? {})) {
      tests.push({ path, digest: await putBlob(bytes, `test ${path}`) });
    }

    const record = Object.freeze({
      pattern_id: patternId,
      semantic_family_id: semanticFamilyId,
      canonical_interface_stub: stub,
      tree_hash: treeHash,
      dep_manifest_hash: deps.hash,
      verification_manifest_hash: proof.hash,
      runtime_manifest_hash: runtime.hash,
      dependency_manifest: Object.freeze({ ...deps.canonical }),
      runtime_manifest: Object.freeze({ ...runtime.canonical }),
      verification_manifest: Object.freeze(JSON.parse(canonicalJson(proof.canonical, 'verification_manifest'))),
      implementation: Object.freeze(implementation.map((e) => Object.freeze(e))),
      tests: Object.freeze(tests.map((e) => Object.freeze(e))),
      provenance,
    });

    if (existing !== undefined) {
      const before = canonicalJson({ ...existing, provenance: null }, 'record');
      const after = canonicalJson({ ...record, provenance: null }, 'record');
      if (before !== after) {
        refuse('duplicate-identity-conflict', `two different records derived the same pattern_id ${patternId}`);
      }
      return existing;
    }

    records.set(patternId, record);
    lifecycle.set(patternId, { state: ACTIVE, history: Object.freeze([]) });
    return record;
  }

  const requireRecord = (patternId) => {
    const record = records.get(patternId);
    if (record === undefined) refuse('unknown-pattern', `no pattern with id ${patternId}`);
    return record;
  };

  function lifecycleOf(patternId) {
    requireRecord(patternId);
    const entry = lifecycle.get(patternId);
    return Object.freeze({ state: entry.state, history: entry.history });
  }

  /** Move lifecycle state. Identity is NOT touched -- see the header. */
  function transition(patternId, to, reason) {
    requireRecord(patternId);
    const entry = lifecycle.get(patternId);
    if (!canTransition(entry.state, to)) {
      refuse('invalid-transition', `${entry.state} -> ${to} is not a transition the spec section 4 machine allows`);
    }
    if (!nonEmptyString(reason)) {
      refuse('invalid-transition', 'a transition needs a reason a later reader can disagree with');
    }
    const history = Object.freeze([...entry.history, Object.freeze({ from: entry.state, to, reason })]);
    lifecycle.set(patternId, { state: to, history });
    return Object.freeze({ state: to, history });
  }

  /**
   * Normal retrieval. Spec 4: ACTIVE only, unless the caller states an explicit
   * compatibility intent, which additionally admits DEPRECATED. QUARANTINED and
   * RETIRED are never returned by either (spec 16.10).
   */
  function retrieve({ semanticFamilyId = null, intent = 'normal' } = {}) {
    const allowed = intent === 'compatibility' ? RETRIEVABLE_WITH_COMPATIBILITY_INTENT : NORMALLY_RETRIEVABLE;
    const out = [];
    for (const [patternId, record] of records) {
      if (!allowed.has(lifecycle.get(patternId).state)) continue;
      if (semanticFamilyId !== null && record.semantic_family_id !== semanticFamilyId) continue;
      out.push(record);
    }
    return out;
  }

  /**
   * Explicit inspection, spec 5: implementation is never returned by retrieval
   * and must be asked for by id. Every blob is re-verified on the way out, so a
   * corrupted store fails closed here too rather than returning partial code.
   */
  async function inspect(patternId) {
    const record = requireRecord(patternId);
    const load = async (entries, kind) => {
      const out = {};
      for (const entry of entries) {
        const bytes = await cas.get(entry.digest);
        if (bytes === null) refuse('blob-corrupt', `${kind} blob ${entry.path} failed hash verification on read`);
        out[entry.path] = bytes;
      }
      return out;
    };
    return {
      record,
      implementation: await load(record.implementation, 'implementation'),
      tests: await load(record.tests, 'test'),
    };
  }

  const get = (patternId) => records.get(patternId) ?? null;

  return Object.freeze({ admit, get, retrieve, inspect, transition, lifecycleOf, size: () => records.size });
}
