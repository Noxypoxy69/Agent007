/**
 * WHICH MODULES ARE ACTUALLY REACHED, COMPUTED FROM THE IMPORT GRAPH.
 *
 * FOUR ORPHANS IN ONE DAY, AND NOBODY NOTICED ANY OF THEM FROM THE TESTS.
 * resolveWorker and bindDelegation shipped with no call site. supersession.mjs
 * was written, mutation-proven and integrated while nothing invoked it.
 * tokenBudget.mjs measured into nothing. Each had a full suite in front of it,
 * green, proving behaviour no shipped code could ever ask for.
 *
 * A pure module's own tests can never catch this. They import it — that is what
 * makes them its tests — so from inside, a module used only by its tests looks
 * exactly like a module used by the product. The question "does anything real
 * call this?" is a property of the graph, not of any file in it.
 *
 * IT MUST NOT GREP FOR A NAME, and that is not a style preference. The fifth
 * instance today was a FALSE one: transition() was announced orphaned because
 * the search used the wrong identifiers while the call site sat in
 * bin/agentbridge.mjs the whole time. A name-based check produced a confident
 * wrong answer about working code, which is worse than no check — so this parses
 * `import` statements and resolves specifiers to files. A rename cannot fool it
 * and neither can a string in a comment.
 *
 * THREE ANSWERS, because "unused" is not one condition:
 *
 *   reachable      imported, directly or transitively, from a shipped entry
 *                  point. Nothing to report.
 *   test-only      imported ONLY by files under test/. Orphaned IN PRODUCTION:
 *                  it ships, it is covered, and no product code path reaches it.
 *                  This is the state all four real orphans were in, and it is
 *                  the answer the suite alone cannot give.
 *   unreferenced   imported by nothing at all, tests included. A harder failure
 *                  and usually a deletion.
 *
 * Collapsing test-only into unreferenced would have reported those four as
 * uncovered, which is the opposite of true and would have sent somebody to write
 * tests that already existed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const REACHABLE = 'reachable';
export const TEST_ONLY = 'test-only';
export const UNREFERENCED = 'unreferenced';

/**
 * Entry points that ship. Everything reachable from here is production code.
 *
 * Declared rather than discovered: "a file nothing imports" describes an entry
 * point and an orphan identically, so the difference has to be stated by a
 * person. That is exactly why the opt-out list below is explicit and commented.
 */
export const DEFAULT_ENTRY_POINTS = [
  'bin/agentbridge.mjs',
  'bin/agentbridge-precommit.mjs',
  'bin/agentbridge-preflight.mjs',
  'bridge/server.mjs',
  'bridge/worker.mjs',
  'mcp/stdio.mjs',
];

/**
 * Modules allowed to be unreached, each with the reason it is not a defect.
 *
 * AN OPT-OUT WITHOUT A REASON IS A SNOOZE BUTTON. The entry is a sentence a
 * later reader can disagree with, not a bare path — because the way this gate
 * dies is somebody adding a line to silence it on a Friday and nobody ever
 * being able to tell whether that line is still true.
 */
export const DEFAULT_ALLOWED_ORPHANS = {
  // Nothing today. Every entry added here should name why the module ships
  // without a caller, and should be removed the moment one exists.
};

/**
 * Every `import` specifier in a source file, from the syntax rather than a
 * search for names.
 *
 * Covers static imports, side-effect imports, `export ... from`, and dynamic
 * `import()` with a literal argument. A dynamic import built from a variable is
 * deliberately NOT guessed at: reporting a maybe as a yes would reintroduce the
 * false-confidence failure this module exists to avoid, so it is returned
 * separately as `dynamic` for the caller to see.
 */
export function parseImports(source) {
  const src = String(source ?? '')
    // Strip comments first: this repo's own headers discuss imports constantly,
    // and a commented example is not an edge in the graph.
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  const specifiers = [];
  const dynamic = [];

  // import ... from 'x'  |  import 'x'  |  export ... from 'x'
  const staticRe = /(?:^|[\s;}])(?:import|export)\s+(?:[^'"()]*?\sfrom\s*)?['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(staticRe)) specifiers.push(m[1]);

  // await import('x') with a literal
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(m[1]);

  // import(someVariable) — recorded, never resolved, never guessed
  for (const m of src.matchAll(/\bimport\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) dynamic.push(m[1]);

  return { specifiers: [...new Set(specifiers)], dynamic: [...new Set(dynamic)] };
}

/** Repo-relative, forward-slashed, so keys compare the same on every platform. */
const rel = (root, p) => path.relative(root, p).split(path.sep).join('/');

/** Resolve a specifier against the importing file. Bare specifiers are packages. */
export function resolveSpecifier(root, fromFile, specifier) {
  if (!specifier.startsWith('.')) return null; // node: builtins and npm packages
  const abs = path.resolve(path.dirname(path.join(root, fromFile)), specifier);
  return rel(root, abs);
}

const walkDir = (dir, out = []) => {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e === '.git') continue;
    const full = path.join(dir, e);
    if (statSync(full).isDirectory()) walkDir(full, out);
    else if (e.endsWith('.mjs') || e.endsWith('.js')) out.push(full);
  }
  return out;
};

/**
 * Build the import graph for a repository.
 *
 * Returns edges as repo-relative paths, so nothing downstream has to know where
 * the checkout lives — and so no absolute path can end up in a report.
 */
export function buildGraph(root, { dirs = ['src', 'bin', 'bridge', 'mcp', 'test'] } = {}) {
  const files = dirs.flatMap((d) => walkDir(path.join(root, d)));
  const graph = new Map();
  const dynamicOnly = new Map();

  for (const abs of files) {
    const from = rel(root, abs);
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const { specifiers, dynamic } = parseImports(text);
    const edges = specifiers.map((s) => resolveSpecifier(root, from, s)).filter(Boolean);
    graph.set(from, edges);
    if (dynamic.length) dynamicOnly.set(from, dynamic);
  }
  return { graph, dynamicOnly, files: [...graph.keys()] };
}

const isTestFile = (p) => p.startsWith('test/');

/** Everything reachable from a set of roots, following edges transitively. */
function reachableFrom(graph, roots) {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length) {
    const cur = queue.pop();
    if (!cur || seen.has(cur)) continue;
    seen.add(cur);
    for (const next of graph.get(cur) ?? []) queue.push(next);
  }
  return seen;
}

/**
 * Classify every module under `src/`.
 *
 * `reachable` is computed from the shipped entry points only. A module reached
 * ONLY once test files are added as roots is test-only: covered, shipped, and
 * called by nothing real.
 */
export function classifyModules(
  root,
  { entryPoints = DEFAULT_ENTRY_POINTS, allowedOrphans = DEFAULT_ALLOWED_ORPHANS, dirs } = {},
) {
  const { graph, dynamicOnly, files } = buildGraph(root, dirs ? { dirs } : {});

  const presentEntries = entryPoints.filter((e) => graph.has(e));
  const missingEntries = entryPoints.filter((e) => !graph.has(e));

  const fromProduction = reachableFrom(graph, presentEntries);
  const testRoots = files.filter(isTestFile);
  const fromTests = reachableFrom(graph, testRoots);

  const modules = files.filter((f) => f.startsWith('src/'));
  const rows = modules.map((m) => {
    let status;
    if (fromProduction.has(m)) status = REACHABLE;
    else if (fromTests.has(m)) status = TEST_ONLY;
    else status = UNREFERENCED;
    return {
      module: m,
      status,
      allowed: Object.prototype.hasOwnProperty.call(allowedOrphans, m),
      reason: allowedOrphans[m] ?? null,
      importedBy: files.filter((f) => (graph.get(f) ?? []).includes(m)),
    };
  });

  return { rows, missingEntries, dynamicOnly: [...dynamicOnly.entries()], graph };
}

/**
 * The gate's verdict. Returns findings; never edits, never deletes.
 *
 * An allowed orphan with no reason is itself a finding — see the note on
 * DEFAULT_ALLOWED_ORPHANS. A silencer nobody can evaluate is how this check
 * stops meaning anything.
 */
export function findOrphans(root, options = {}) {
  const { rows, missingEntries, dynamicOnly } = classifyModules(root, options);
  const findings = [];

  for (const r of rows) {
    if (r.status === REACHABLE) continue;
    if (r.allowed) {
      if (!r.reason || !String(r.reason).trim()) {
        findings.push({ module: r.module, status: r.status, kind: 'unreasoned-opt-out', importedBy: r.importedBy });
      }
      continue;
    }
    findings.push({ module: r.module, status: r.status, kind: r.status, importedBy: r.importedBy });
  }

  /*
   * A declared entry point that does not exist means the roots are wrong, and
   * wrong roots make everything downstream of them look orphaned. That is a
   * failure of the check itself and must not be reported as a pile of orphans.
   */
  for (const e of missingEntries) {
    findings.push({ module: e, status: 'missing-entry-point', kind: 'missing-entry-point', importedBy: [] });
  }

  return { ok: findings.length === 0, findings, rows, dynamicOnly };
}

/** Render findings for a terminal. Wording is never asserted on. */
export function formatOrphans(findings) {
  return findings
    .map((f) => {
      const by = f.importedBy.length ? `  (imported by ${f.importedBy.slice(0, 3).join(', ')})` : '';
      return `  ${f.kind.padEnd(20)} ${f.module}${by}`;
    })
    .join('\n');
}
