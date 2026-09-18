import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  cyclomaticComplexity,
  extractInterfaceStub,
  indexCandidate,
} from '../src/memory/patternIndexer.mjs';

/**
 * THE INDEXER'S ONLY OUTPUT IS A VERDICT, SO EVERY VERDICT NEEDS ITS OPPOSITE.
 *
 * A refusal test alone proves nothing: "this candidate is not reusable" passes
 * just as well against a fixture that was never reusable for an unrelated
 * reason. So each refusal below is asserted on its SPECIFIC reason code, and the
 * near-identical reusable fixture sits next to it (CLAUDE.md rule 5).
 */

const PURE = 'export function normalize(n) { return String(n).trim(); }\n';
const PURE_TEST = "import { normalize } from '../src/normalize.mjs';\nnormalize(1);\n";

const index = (over = {}) =>
  indexCandidate({
    implementation: { 'src/normalize.mjs': PURE },
    tests: { 'test/normalize.test.mjs': PURE_TEST },
    dependencyManifest: {},
    runtimeManifest: {
      runtime: 'node20',
      module_system: 'esm',
      platform_constraints: [],
      compiler_options: {},
      feature_flags: [],
    },
    ...over,
  });

const reasonsOf = (result) => result.reusability_result.reasons.join(' | ');
const refusedFor = (result, code) =>
  result.reusability_result.reusable === false && result.reusability_result.reasons.some((r) => r.startsWith(code));

/* ── the positive ────────────────────────────────────────────────────── */

test('A PURE, TESTED, PINNED CANDIDATE IS REUSABLE', () => {
  const c = index();
  assert.equal(c.reusability_result.reusable, true, reasonsOf(c));
  assert.deepEqual(c.reusability_result.reasons, []);
  assert.deepEqual(c.implementation_paths, ['src/normalize.mjs']);
  assert.deepEqual(c.test_paths, ['test/normalize.test.mjs']);
  assert.deepEqual(c.exported_names, ['normalize']);
  assert.ok(c.interface_stub.includes('normalize'));
});

test('the candidate carries every field spec section 7 requires', () => {
  const c = index();
  for (const field of [
    'interface_stub', 'semantic_family_candidate', 'implementation_paths',
    'test_paths', 'dependency_manifest', 'runtime_manifest', 'reusability_result',
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(c, field), `candidate is missing ${field}`);
  }
});

/* ── rule 13: comment-blank before matching anything ─────────────────── */

test('A MODULE THAT ONLY DISCUSSES fetch AND globalThis IN COMMENTS IS REUSABLE', () => {
  /*
   * CLAUDE.md rule 13, rediscovered three separate times in one day. This
   * repository's modules are mostly header comment and several of them explain
   * at length why they do NOT reach a network. Matching raw source would refuse
   * the cleanest files in the tree for describing the thing they avoid.
   */
  const source = [
    '/**',
    ' * This module never calls fetch( and never assigns globalThis.cache = 1.',
    ' * It does not import node:https. It reads no clock: no Date.now() here.',
    ' */',
    '// Also avoided: Math.random() and process.exit(1).',
    'export function pure(n) { return n; }',
    '',
  ].join('\n');

  const c = index({ implementation: { 'src/normalize.mjs': source } });
  assert.equal(c.reusability_result.reusable, true, reasonsOf(c));
});

test('the same names inside STRING LITERALS are not matches either', () => {
  const source = [
    'export const advice = "do not call fetch( in a pattern";',
    "export const warning = 'globalThis.x = 1 is ambient mutation';",
    'export const tpl = `Date.now() is a clock read`;',
    'export function pure(n) { return n; }',
    '',
  ].join('\n');

  const c = index({ implementation: { 'src/normalize.mjs': source } });
  assert.equal(c.reusability_result.reusable, true, reasonsOf(c));
});

test('WATCH IT FAIL: the same constructs in REAL CODE are refused', () => {
  /*
   * The pair that makes the two tests above mean something. If the matcher were
   * deleted entirely, those two would still pass and this one would go red.
   */
  const c = index({
    implementation: { 'src/normalize.mjs': 'export function go(n) { globalThis.cache = n; return fetch("/x"); }\n' },
  });
  assert.equal(c.reusability_result.reusable, false);
  assert.ok(refusedFor(c, 'ambient-state-mutation'), reasonsOf(c));
  assert.ok(refusedFor(c, 'requires-network'), reasonsOf(c));
});

test('a commented-out export is not part of the interface stub', () => {
  const stub = extractInterfaceStub('// export function ghost() {}\nexport function real(n) { return n; }\n');
  assert.ok(stub.includes('real'));
  assert.equal(stub.includes('ghost'), false);
});

/* ── each refusal, with its reason code ──────────────────────────────── */

test('NO STABLE INTERFACE: a module that exports nothing is refused', () => {
  const c = index({ implementation: { 'src/normalize.mjs': 'function hidden(n) { return n; }\n' } });
  assert.ok(refusedFor(c, 'no-stable-interface'), reasonsOf(c));
});

test('NO ISOLATED TESTS: none supplied at all', () => {
  const c = index({ tests: {} });
  assert.ok(refusedFor(c, 'no-isolated-tests'), reasonsOf(c));
});

test('NO ISOLATED TESTS: a test that does not import the module is not its test', () => {
  /*
   * Matching on filename alone would be the proxy assertion rule 4 forbids: the
   * convention agrees with the truth right up until somebody renames a file.
   */
  const c = index({ tests: { 'test/normalize.test.mjs': "import { other } from '../src/other.mjs';\nother();\n" } });
  assert.ok(refusedFor(c, 'no-isolated-tests'), reasonsOf(c));
});

test('AMBIENT STATE MUTATION, in each shape the table names', () => {
  const shapes = [
    'export const a = () => { globalThis.x = 1; };',
    'export const b = () => { global.y = 2; };',
    'export const c = () => { process.env.TOKEN = "x"; };',
    'export const d = () => { process.chdir("/tmp"); };',
    'export const e = () => { process.exit(1); };',
    'export const f = () => { Object.defineProperty(globalThis, "z", {}); };',
  ];
  for (const source of shapes) {
    const c = index({ implementation: { 'src/normalize.mjs': `${source}\n` } });
    assert.ok(refusedFor(c, 'ambient-state-mutation'), `${source} -> ${reasonsOf(c)}`);
  }
});

test('READING ambient state is not mutating it', () => {
  /*
   * process.platform is a runtime CONSTRAINT and belongs in the runtime
   * manifest. Refusing a read would make most legitimate cross-platform helpers
   * permanently unreusable.
   */
  const c = index({
    implementation: { 'src/normalize.mjs': 'export const sep = () => (process.platform === "win32" ? "\\\\" : "/");\n' },
  });
  assert.equal(c.reusability_result.reusable, true, reasonsOf(c));
});

test('REQUIRES NETWORK, by import and by call', () => {
  for (const source of [
    "import https from 'node:https';\nexport const a = () => https;\n",
    "import net from 'net';\nexport const b = () => net;\n",
    "import axios from 'axios';\nexport const c = () => axios;\n",
    'export const d = () => fetch("/x");\n',
    'export const e = () => new WebSocket("wss://x");\n',
  ]) {
    const c = index({ implementation: { 'src/normalize.mjs': source } });
    assert.ok(refusedFor(c, 'requires-network'), `${source} -> ${reasonsOf(c)}`);
  }
});

test('a method named fetch on an object is not the global fetch', () => {
  const c = index({ implementation: { 'src/normalize.mjs': 'export const go = (db) => db.fetch(1);\n' } });
  assert.equal(c.reusability_result.reusable, true, reasonsOf(c));
});

test('NONDETERMINISTIC: clock and entropy reads are refused', () => {
  for (const source of [
    'export const a = () => Date.now();\n',
    'export const b = () => new Date();\n',
    'export const c = () => Math.random();\n',
    'export const d = () => process.hrtime();\n',
  ]) {
    const c = index({ implementation: { 'src/normalize.mjs': source } });
    assert.ok(refusedFor(c, 'nondeterministic-metadata'), `${source} -> ${reasonsOf(c)}`);
  }
});

test('UNRESOLVED DEPENDENCIES and UNRESOLVED RUNTIME are distinct refusals', () => {
  assert.ok(refusedFor(index({ dependencyManifest: null }), 'unresolved-dependencies'));
  assert.ok(refusedFor(index({ runtimeManifest: null }), 'unresolved-runtime'));
});

test('an ABSOLUTE MACHINE PATH in the metadata is a canonicalisation refusal', () => {
  /*
   * Spec 16.7: candidate git/worktree paths never enter identity. The check has
   * teeth because canonicalJson throws on them, so the refusal happens at
   * indexing time rather than surfacing as an unreproducible id later.
   */
  const c = index({
    runtimeManifest: {
      runtime: 'node20',
      module_system: 'esm',
      platform_constraints: [],
      compiler_options: { outDir: 'C:\\Users\\DANNY GARCIA\\Agent007\\build' },
      feature_flags: [],
    },
  });
  assert.ok(refusedFor(c, 'nondeterministic-metadata'), reasonsOf(c));
});

test('a timestamp anywhere in the metadata is a canonicalisation refusal', () => {
  const c = index({ dependencyManifest: { zod: '4.0.0', created_at: '2026-09-17' } });
  assert.ok(refusedFor(c, 'nondeterministic-metadata'), reasonsOf(c));
});

/* ── all reasons, not just the first ─────────────────────────────────── */

test('EVERY reason is reported, so a fix is one round trip rather than five', () => {
  const c = indexCandidate({
    implementation: { 'src/bad.mjs': 'function hidden() { globalThis.x = fetch("/y"); return Date.now(); }\n' },
    tests: {},
    dependencyManifest: null,
    runtimeManifest: null,
  });
  const codes = c.reusability_result.reasons.map((r) => r.split(':')[0]);
  for (const expected of [
    'no-stable-interface', 'no-isolated-tests', 'ambient-state-mutation',
    'requires-network', 'nondeterministic-metadata', 'unresolved-dependencies', 'unresolved-runtime',
  ]) {
    assert.ok(codes.includes(expected), `expected ${expected} in ${JSON.stringify(codes)}`);
  }
});

test('reasons are sorted, so the verdict is stable across runs', () => {
  const a = index({ implementation: { 'src/n.mjs': 'export const x = () => { globalThis.a = fetch("/z"); };\n' } });
  const b = index({ implementation: { 'src/n.mjs': 'export const x = () => { globalThis.a = fetch("/z"); };\n' } });
  assert.deepEqual(a.reusability_result.reasons, b.reusability_result.reasons);
  assert.deepEqual([...a.reusability_result.reasons].sort(), a.reusability_result.reasons);
});

/* ── complexity is reported, never enforced ──────────────────────────── */

test('cyclomatic complexity counts decision points on blanked source', () => {
  assert.equal(cyclomaticComplexity('export const a = (n) => n;\n'), 1);
  assert.equal(cyclomaticComplexity('export const a = (n) => { if (n) { return 1; } return 2; };\n'), 2);
  assert.equal(
    cyclomaticComplexity('// if (x) for (;;) while (y)\nexport const a = (n) => n;\n'),
    1,
    'decision points inside a comment are not decision points',
  );
});

test('complexity is REPORTED and never changes the verdict', () => {
  const gnarly = [
    'export function messy(a, b, c) {',
    '  if (a) { for (let i = 0; i < 10; i += 1) { while (b) { if (c) { break; } } } }',
    '  return a && b || c ? 1 : 2;',
    '}',
    '',
  ].join('\n');
  const result = index({ implementation: { 'src/normalize.mjs': gnarly } });
  assert.ok(result.cyclomatic_complexity['src/normalize.mjs'] > 5);
  assert.equal(result.reusability_result.reusable, true, reasonsOf(result));
});

/* ── the boundary the spec draws ─────────────────────────────────────── */

test('THE INDEXER CANNOT ADMIT: it does not import the catalog', () => {
  /*
   * Spec section 7: "The indexer produces candidates. It does not admit them."
   * Asserted against the SOURCE rather than against behaviour, because the
   * failure being prevented is a future edit adding the import -- there is no
   * runtime observation that catches that before it has already happened.
   *
   * Comment-blanked first: this module's own header discusses patternCatalog.mjs
   * by name while explaining why it does not import it, and matching raw source
   * would fail on the explanation. That is rule 13 pointed at this very file.
   */
  const source = readFileSync(fileURLToPath(new URL('../src/memory/patternIndexer.mjs', import.meta.url)), 'utf8');
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  assert.match(source, /patternCatalog/, 'the positive first: the name does appear, in the header');
  assert.equal(/patternCatalog/.test(code), false, 'but never in code — the indexer must not import the catalog');
  assert.equal(/\badmit\s*\(/.test(code), false, 'and it must not call admit');
});

test('the candidate is frozen, so a caller cannot edit a verdict into it', () => {
  const c = index({ implementation: { 'src/normalize.mjs': 'export const go = () => fetch("/x");\n' } });
  assert.equal(c.reusability_result.reusable, false);
  assert.throws(() => { c.reusability_result.reusable = true; }, TypeError);
  assert.equal(c.reusability_result.reusable, false);
});
