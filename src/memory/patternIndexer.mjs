/**
 * THE INDEXER PRODUCES CANDIDATES. IT DOES NOT ADMIT THEM.
 *
 * Spec section 7: "The indexer produces candidates. It does not admit them."
 * Nothing here writes to a catalog, touches a CAS, or reaches a network, and
 * there is deliberately no import of patternCatalog.mjs -- a module that can
 * both judge reusability and admit is one refactor away from admitting whatever
 * it judged, which is the candidate-controls-verification defect that
 * src/verificationProof.mjs was rewritten four times to remove.
 *
 * NO LLM DECIDES ADMISSION. Spec section 16.1. Every verdict below comes from
 * the syntax of the supplied source, and a verdict this file cannot reach from
 * the syntax is a REFUSAL, never a guess.
 *
 * FAIL CLOSED, AND SAY WHY IN THE PLURAL. reusability_result carries every
 * reason it found, not the first. A candidate rejected for one reason gets fixed
 * and resubmitted only to fail on the next; returning all of them is the
 * difference between one round trip and five.
 *
 * EVERY MATCH RUNS ON COMMENT- AND STRING-BLANKED SOURCE. CLAUDE.md rule 13,
 * rediscovered three times in one day: a check that greps for `claim_task`
 * matches its own explanatory comment. This repository's modules are mostly
 * header comment, and several of them discuss `fetch` and `globalThis` while
 * explaining why they avoid them -- so matching raw source here would refuse the
 * cleanest files in the tree for describing the thing they do not do.
 * stripNonCode is imported from src/moduleGraph.mjs rather than re-implemented,
 * because that copy is the one with tests proving the block-comment case.
 *
 * PURE. No clock, no filesystem, no network, no randomness.
 *
 * DELIBERATELY ORPHANED UNTIL SLICE 2 -- see the same note in patternCatalog.mjs.
 * Owner decision 2026-09-17: hold the slice rather than move a gate's baseline.
 */

import { stripNonCode, exportedNames, parseImports } from '../moduleGraph.mjs';
import { CanonicalizationError, canonicalJson } from './canonical.mjs';

/** Every reason a candidate can be refused. Distinct defects, never merged. */
export const NOT_REUSABLE = Object.freeze([
  'no-stable-interface',
  'nondeterministic-metadata',
  'no-isolated-tests',
  'ambient-state-mutation',
  'requires-network',
  'unresolved-dependencies',
  'unresolved-runtime',
]);

/*
 * AMBIENT HOST STATE. Writes only -- reading process.platform is a runtime
 * constraint, which belongs in the runtime manifest, not a disqualification.
 */
const AMBIENT_MUTATION = Object.freeze([
  [/\bglobalThis\s*\.\s*\w+\s*=[^=]/, 'assigns to a property of globalThis'],
  [/\bglobal\s*\.\s*\w+\s*=[^=]/, 'assigns to a property of global'],
  [/\bprocess\s*\.\s*env\s*(?:\.\s*\w+|\[[^\]]*\])\s*=[^=]/, 'writes to process.env'],
  [/\bprocess\s*\.\s*(?:chdir|exit|abort|umask|setuid|setgid|setgroups)\s*\(/, 'calls a process-wide mutator'],
  [/\bObject\s*\.\s*defineProperty\s*\(\s*(?:globalThis|global)\b/, 'defines a property on the global object'],
  [/\brequire\s*\.\s*cache\b/, 'manipulates the module cache'],
]);

/*
 * LIVE NETWORK. Spec section 7 disqualifies a component that "requires live
 * network access for its core behavior".
 */
const NETWORK_MODULES = Object.freeze(new Set([
  'http', 'https', 'net', 'dgram', 'tls', 'dns', 'http2',
  'node:http', 'node:https', 'node:net', 'node:dgram', 'node:tls', 'node:dns', 'node:http2',
  'axios', 'undici', 'node-fetch', 'got', 'superagent', 'ws',
]));

const NETWORK_CALLS = Object.freeze([
  [/(?<![.\w])fetch\s*\(/, 'calls fetch'],
  [/\bnew\s+(?:XMLHttpRequest|WebSocket|EventSource)\s*\(/, 'opens a browser network primitive'],
]);

/*
 * NONDETERMINISM. A pattern whose behaviour varies with the clock or with
 * entropy cannot have its proof re-established later, which makes every
 * invalidation trigger in spec section 4 unevaluable.
 *
 * DELIBERATELY STRICT, AND THE OWNER MAY WANT IT LOOSER. A module that takes an
 * injected clock is hermetic and a module that reads the global one is not, and
 * from the syntax alone those look the same at the call site. This repository's
 * own convention makes the strict reading the right default -- its pure modules
 * announce "No clone, no spawn, no clock" in their headers -- but a legitimate
 * crypto helper calling randomBytes would be refused here and would need an
 * explicit declaration to pass. Flagged in the handoff rather than softened.
 */
const NONDETERMINISM = Object.freeze([
  [/\bDate\s*\.\s*now\s*\(/, 'reads the wall clock via Date.now'],
  [/\bnew\s+Date\s*\(\s*\)/, 'constructs a Date from the current time'],
  [/\bMath\s*\.\s*random\s*\(/, 'draws from Math.random'],
  [/\bprocess\s*\.\s*(?:hrtime|uptime)\s*\b/, 'reads a process timer'],
  [/\b(?:randomUUID|randomBytes|randomFillSync|webcrypto)\s*\(?/, 'draws cryptographic entropy'],
]);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The exported signature lines, in source order, as the pattern's stub.
 *
 * Spec 3.1 wants a "trimmed signature declaration". Taken from the syntax rather
 * than by executing the module: importing a candidate to enumerate its exports
 * would run code this function is being asked to judge.
 */
export function extractInterfaceStub(source) {
  const code = stripNonCode(source);
  const lines = [];
  for (const m of code.matchAll(/^export\s+(?:async\s+)?(?:function\s*\*?|const|class|let)\s+\w+[^\n{=]*/gm)) {
    lines.push(m[0].replace(/\s+/g, ' ').trim());
  }
  for (const m of code.matchAll(/^export\s*\{[^}]*\}/gm)) {
    lines.push(m[0].replace(/\s+/g, ' ').trim());
  }
  return lines.sort().join('\n');
}

/**
 * Cyclomatic complexity: decision points + 1, counted on blanked source.
 *
 * REPORTED, NOT ENFORCED. Spec section 7 asks the indexer to calculate it and
 * never says what threshold disqualifies. Inventing one here would be this
 * module deciding a policy question the spec left to the owner, so the number
 * goes in the candidate and nothing branches on it.
 */
export function cyclomaticComplexity(source) {
  const code = stripNonCode(source);
  const points = [
    /\bif\s*\(/g, /\bfor\s*\(/g, /\bwhile\s*\(/g, /\bcase\s+/g,
    /\bcatch\s*\(/g, /&&/g, /\|\|/g, /\?\?/g, /\?[^.]/g,
  ];
  return points.reduce((total, re) => total + [...code.matchAll(re)].length, 1);
}

function scan(sources, table) {
  const hits = [];
  for (const [path, source] of Object.entries(sources)) {
    const code = stripNonCode(source);
    for (const [re, description] of table) {
      if (re.test(code)) hits.push(`${path} ${description}`);
    }
  }
  return hits;
}

/**
 * Index a candidate. Every input is supplied; nothing is read from disk.
 *
 * The caller passes implementation and test sources as path -> source maps, plus
 * the dependency and runtime manifests the assembly line resolved. Passing null
 * for either manifest means "could not be resolved", which is a refusal rather
 * than a default -- a defaulted runtime manifest would put a guess into
 * identity, and every pattern sharing that guess would share an id it did not
 * earn.
 */
export function indexCandidate({
  implementation = {},
  tests = {},
  dependencyManifest = null,
  runtimeManifest = null,
  semanticFamilyHint = null,
} = {}) {
  if (!isPlainObject(implementation) || !isPlainObject(tests)) {
    throw new TypeError('patternIndexer: implementation and tests must be path -> source objects');
  }

  const implementationPaths = Object.keys(implementation).sort();
  const testPaths = Object.keys(tests).sort();
  const reasons = [];

  /* ── a stable exported interface ──────────────────────────────────── */
  const stubs = implementationPaths.map((p) => extractInterfaceStub(implementation[p])).filter((s) => s !== '');
  const interfaceStub = stubs.join('\n');
  const exported = new Set();
  for (const path of implementationPaths) {
    for (const name of exportedNames(stripNonCode(implementation[path]))) exported.add(name);
  }
  if (interfaceStub === '' || exported.size === 0) {
    reasons.push('no-stable-interface: the implementation exports no named function, class or const');
  }

  /* ── isolated tests that actually reach this implementation ───────── */
  if (testPaths.length === 0) {
    reasons.push('no-isolated-tests: no test sources were supplied');
  } else {
    const basenames = new Set(implementationPaths.map((p) => p.split('/').pop()));
    const reaching = testPaths.filter((testPath) => {
      const { specifiers } = parseImports(tests[testPath]);
      return specifiers.some((s) => basenames.has(s.split('/').pop()));
    });
    /*
     * A TEST THAT DOES NOT IMPORT THE MODULE IS NOT ITS TEST. Accepting one by
     * filename convention alone is the proxy assertion CLAUDE.md rule 4 forbids:
     * the name agrees with the truth right up until somebody renames a file.
     */
    if (reaching.length === 0) {
      reasons.push('no-isolated-tests: no supplied test imports any implementation module');
    }
  }

  /* ── hermeticity ──────────────────────────────────────────────────── */
  const ambient = scan(implementation, AMBIENT_MUTATION);
  if (ambient.length > 0) reasons.push(`ambient-state-mutation: ${ambient.join('; ')}`);

  const networkCalls = scan(implementation, NETWORK_CALLS);
  const networkImports = [];
  for (const path of implementationPaths) {
    const { specifiers } = parseImports(implementation[path]);
    for (const s of specifiers) {
      if (NETWORK_MODULES.has(s)) networkImports.push(`${path} imports ${s}`);
    }
  }
  const network = [...networkImports, ...networkCalls];
  if (network.length > 0) reasons.push(`requires-network: ${network.join('; ')}`);

  const nondeterministic = scan(implementation, NONDETERMINISM);
  if (nondeterministic.length > 0) {
    reasons.push(`nondeterministic-metadata: ${nondeterministic.join('; ')}`);
  }

  /* ── resolvable dependency and runtime requirements ───────────────── */
  if (!isPlainObject(dependencyManifest)) {
    reasons.push('unresolved-dependencies: no dependency manifest was resolved for this candidate');
  }
  if (!isPlainObject(runtimeManifest)) {
    reasons.push('unresolved-runtime: no runtime manifest was resolved for this candidate');
  }

  /*
   * THE METADATA MUST SURVIVE CANONICALISATION.
   *
   * This is the "metadata is nondeterministic" check with teeth on it: an
   * absolute worktree path, a Date, or an ambient key anywhere in the candidate
   * makes canonicalJson throw, and a candidate that cannot be canonicalised can
   * never produce a reproducible pattern_id. Catching it HERE means the caller
   * learns at indexing time rather than at admission time.
   */
  const identityBearing = {
    interface_stub: interfaceStub,
    implementation_paths: implementationPaths,
    test_paths: testPaths,
    dependency_manifest: isPlainObject(dependencyManifest) ? dependencyManifest : {},
    runtime_manifest: isPlainObject(runtimeManifest) ? runtimeManifest : {},
  };
  try {
    canonicalJson(identityBearing, 'candidate');
  } catch (err) {
    if (err instanceof CanonicalizationError) {
      reasons.push(`nondeterministic-metadata: ${err.message}`);
    } else {
      throw err;
    }
  }

  const complexity = {};
  for (const path of implementationPaths) complexity[path] = cyclomaticComplexity(implementation[path]);

  return Object.freeze({
    interface_stub: interfaceStub,
    semantic_family_candidate: semanticFamilyHint,
    implementation_paths: Object.freeze(implementationPaths),
    test_paths: Object.freeze(testPaths),
    dependency_manifest: dependencyManifest,
    runtime_manifest: runtimeManifest,
    exported_names: Object.freeze([...exported].sort()),
    cyclomatic_complexity: Object.freeze(complexity),
    implementation_blobs: implementation,
    test_blobs: tests,
    reusability_result: Object.freeze({
      reusable: reasons.length === 0,
      reasons: Object.freeze(reasons.sort()),
    }),
  });
}
