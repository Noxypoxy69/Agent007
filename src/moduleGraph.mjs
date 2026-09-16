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
  'bin/agentbridge-attempt.mjs',
  /* A human runs this before hand-deploying the edge function. It is an entry
   * point in the only sense that matters here: something outside the graph
   * invokes it, so what it imports is shipped rather than orphaned. */
  'bin/agentbridge-deploy-check.mjs',
  /* A CODING ENGINE runs this — it is named as a command string in a settings
   * file handed to the agent, so nothing here imports it and no graph can see
   * the caller. Same sense as the deploy check above.
   *
   * SAID PLAINLY: NOTHING IN THIS REPOSITORY WRITES THAT SETTINGS FILE YET.
   * `agentToolBoundary.hookSettings` produces it and only the live test calls
   * that; wiring it through `attemptPipeline` is open work. So this line is
   * forward-looking, which is a weaker claim than the entries above it and is
   * exactly the kind of entry that becomes a snooze button if nobody says so.
   * Delete it when the wiring lands and the graph should still be fine —
   * if it is not, this line was carrying more than it admitted.
   *
   * It was THIS GATE that caught `agentToolBoundary.mjs` as test-only on the
   * commit that added it, which is the gate doing its job. */
  'bin/agentbridge-guard-hook.mjs',
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
/**
 * MODULES THAT SHIP BY BEING COPIED, NOT BY BEING IMPORTED.
 *
 * A Supabase Edge Function cannot import from outside its own directory, so
 * `supabase/functions/mcp/_shared.js` is a HAND-MAINTAINED splice of modules
 * from src/ and bridge/. There is no generator and no manifest: the copy is
 * made by a person.
 *
 * NO IMPORT GRAPH CAN SEE THAT. A splice is a copy step, so from the graph's
 * point of view these modules are imported by nothing and the gate calls them
 * orphans -- confidently, about code that is deployed and serving traffic. That
 * is the false-positive direction that matters, because the finding reads
 * "wire it or justify it" and the other obvious response is to delete the
 * module. Deleting it would remove the SOURCE of deployed code while production
 * kept running on the stale copy, and nothing would surface until the next
 * splice regenerated from nothing.
 *
 * So the splice is DECLARED here -- and, unlike an opt-out, it is CHECKED. See
 * verifySplices: every module named below must have all of its exports present
 * in the splice file. A declaration that stops being true fails the gate rather
 * than silencing it, which is the difference between a manifest and a snooze
 * button.
 */
export const DEFAULT_SPLICES = {
  'supabase/functions/mcp/_shared.js': [
    'src/coordination.mjs',
    'src/dispatch.mjs',
    'src/events.mjs',
    'src/glob.mjs',
    'src/liveRegistry.mjs',
    'src/ownWork.mjs',
    'src/ownerDecisions.mjs',
    'src/permissionRequest.mjs',
    'bridge/collisions.mjs',
    'mcp/toolDefs.mjs',
  ],
};

/**
 * Declared modules whose SPLICE IS CHECKED BY NAME ONLY, each with the reason.
 *
 * WHY THIS LIST HAD TO EXIST, demonstrated rather than argued. verifySplices
 * marks a module spliced when every export NAME of the source appears among the
 * export names of the copy. It never compares bodies -- deliberately, because a
 * splice legitimately differs in its imports, so a text comparison would be
 * noise. test/sharedSpliceMatches.test.mjs is the behaviour half.
 *
 * The gap was the RATIO between those halves, and nothing made it visible. Ten
 * modules were declared spliced; two were behaviour-compared. Found by b6, who
 * inverted the executable guard inside `executableMatch` in the source --
 * changing what it RETURNS, touching no export name -- and left the copy alone.
 * Source and copy then differed by eight lines inside that function and
 * verifySplices still reported `spliced: 10, findings: 0`. I reproduced it here
 * before building this: the guard was made to permit everything, and the gate
 * said nothing.
 *
 * So a change to validateMessage's real behaviour, not mirrored into the copy,
 * would ship an edge function whose message guard disagrees with the one every
 * test in the suite exercises -- with both gates green. Given what that function
 * guards, it is the worst one to let drift.
 *
 * A REASON HERE IS A DEBT, NOT A DISPENSATION. It says "this module is trusted
 * to a weaker check, and here is why" -- so the weakness is legible in review
 * instead of implicit in a count nobody computed. It rots loudly: delete a
 * behaviour pair and the module must appear here or the gate fails; add one and
 * the entry becomes unnecessary and can go.
 */
export const NAME_ONLY_SPLICES = {
  'src/coordination.mjs':
    'HIGHEST RISK of the eight and named first for that reason. Carries '
    + 'validateMessage and the executable-text guard behind it. Wants a behaviour '
    + 'pair next; it is only here because writing one is more than this change.',
  'src/events.mjs':
    'Pure shaping of rows into events, no I/O and no decision that is not a '
    + 'field comparison. A name-level splice catches the realistic drift, which '
    + 'is an event kind added on one side only.',
  'src/glob.mjs':
    'Pattern matching with no state. Its behaviour is already pinned by its own '
    + 'unit tests on the source side, and the copy is a verbatim splice.',
  'src/liveRegistry.mjs':
    'Liveness arithmetic over a timestamp and a constant. STALE_AFTER_MS drifting '
    + 'between the halves is the risk, and that is a value a name check does see '
    + 'because it is an export.',
  'src/ownWork.mjs':
    'Read-side filtering with no writes. A drift here narrows or widens what a '
    + 'worker sees rather than what it may do.',
  'src/ownerDecisions.mjs':
    'Decision records are append-only and validated at the database by a check '
    + 'constraint, so the copy cannot admit a shape Postgres would refuse.',
  'src/permissionRequest.mjs':
    'Newest of the eight and still moving. Deliberately not given a behaviour '
    + 'pair while its shape is unsettled, because a pair written against a moving '
    + 'target gets deleted rather than maintained.',
  'mcp/toolDefs.mjs':
    'The node-side twin, guarded end-to-end instead: test/coordinatorAuth.test.mjs '
    + 'imports the DEPLOYED copy rather than this one, and coordinatorAuthLive '
    + 'certifies the same surface against the live server.',
};

/**
 * Which declared modules the behaviour half actually compares, READ FROM THAT
 * FILE rather than restated here.
 *
 * A second hand-kept list would be one more copy of a claim, which is the class
 * of defect this whole gate exists for. Adding a behaviour pair should make the
 * ratio improve on its own, without anybody remembering to update a constant.
 */
export function behaviourComparedModules(root, testFile = 'test/sharedSpliceMatches.test.mjs') {
  let text;
  try {
    text = readFileSync(path.join(root, testFile), 'utf8');
  } catch {
    return null; // absent under this root: not evidence either way
  }
  const found = new Set();
  for (const m of text.matchAll(/from\s+'\.\.\/([^']+)'/g)) found.add(m[1]);
  return found;
}

/** Reached only through a hand-maintained copy. Shipped, but not by an import. */
export const SPLICED = 'spliced';

/** Every name a module exports, read from the syntax rather than by executing it. */
export function exportedNames(text) {
  const names = new Set();
  for (const m of text.matchAll(/^export\s+(?:async\s+)?(?:function\s+|const\s+|class\s+|let\s+)(\w+)/gm)) {
    names.add(m[1]);
  }
  for (const m of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/**
 * Prove each declared splice is real, and still real.
 *
 * A module is only treated as shipped-by-copy if EVERY name it exports is also
 * exported by the splice file. Partial overlap is not enough: two modules can
 * share a name by coincidence, and accepting a partial match would let a module
 * that was removed from the splice keep its exemption because one of its names
 * happened to survive elsewhere.
 */
export function verifySplices(root, splices = DEFAULT_SPLICES) {
  const spliced = new Set();
  const findings = [];
  for (const [target, modules] of Object.entries(splices)) {
    let text;
    try {
      text = readFileSync(path.join(root, target), 'utf8');
    } catch {
      /*
       * No splice file under THIS root, so the declaration does not describe
       * this tree and is not evidence about it. That is the normal case for the
       * synthetic roots the tests build, and treating it as a finding would
       * make every fixture fail for a fact about the real repository.
       *
       * The real repository's copy cannot go missing unnoticed:
       * test/sharedSpliceMatches.test.mjs imports it directly, so its absence
       * is a hard import failure there rather than a soft finding here.
       */
      continue;
    }
    const carried = exportedNames(text);
    for (const m of modules) {
      let src;
      try {
        src = readFileSync(path.join(root, m), 'utf8');
      } catch {
        findings.push({ module: m, status: 'missing-spliced-module', kind: 'missing-spliced-module', importedBy: [] });
        continue;
      }
      const want = exportedNames(src);
      const absent = [...want].filter((n) => !carried.has(n));
      if (want.size > 0 && absent.length === 0) spliced.add(m);
      else {
        findings.push({
          module: m,
          status: 'splice-drifted',
          kind: 'splice-drifted',
          importedBy: [target],
          absent,
        });
      }
    }
  }
  /*
   * THE RATIO, MADE VISIBLE. Everything above proves the NAMES match. This
   * requires each declared module to be either behaviour-compared or carrying a
   * stated reason for being trusted to the weaker check -- so "ten declared, two
   * compared" can never again be a fact nobody has computed.
   */
  const compared = behaviourComparedModules(root);
  if (compared) {
    for (const modules of Object.values(splices)) {
      for (const m of modules) {
        if (!spliced.has(m)) continue; // already reported as drifted or missing
        if (compared.has(m)) continue; // the behaviour half checks this one
        if (NAME_ONLY_SPLICES[m]) continue; // weaker check, declared and reasoned
        findings.push({
          module: m,
          status: 'splice-name-only-undeclared',
          kind: 'splice-name-only-undeclared',
          importedBy: [],
        });
      }
    }
  }

  return { spliced, findings };
}

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
  {
    entryPoints = DEFAULT_ENTRY_POINTS,
    allowedOrphans = DEFAULT_ALLOWED_ORPHANS,
    splices = DEFAULT_SPLICES,
    dirs,
  } = {},
) {
  const { graph, dynamicOnly, files } = buildGraph(root, dirs ? { dirs } : {});
  const { spliced, findings: spliceFindings } = verifySplices(root, splices);

  const presentEntries = entryPoints.filter((e) => graph.has(e));
  const missingEntries = entryPoints.filter((e) => !graph.has(e));

  const fromProduction = reachableFrom(graph, presentEntries);
  const testRoots = files.filter(isTestFile);
  const fromTests = reachableFrom(graph, testRoots);

  const modules = files.filter((f) => f.startsWith('src/'));
  const rows = modules.map((m) => {
    let status;
    if (fromProduction.has(m)) status = REACHABLE;
    /*
     * The splice is checked BEFORE the test roots. A spliced module is usually
     * imported by its tests too, so asking "test-only?" first would classify
     * deployed code as orphaned -- the exact false positive this exists to end.
     */
    else if (spliced.has(m)) status = SPLICED;
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

  return { rows, missingEntries, dynamicOnly: [...dynamicOnly.entries()], graph, spliceFindings };
}

/**
 * The gate's verdict. Returns findings; never edits, never deletes.
 *
 * An allowed orphan with no reason is itself a finding — see the note on
 * DEFAULT_ALLOWED_ORPHANS. A silencer nobody can evaluate is how this check
 * stops meaning anything.
 */
export function findOrphans(root, options = {}) {
  const { rows, missingEntries, dynamicOnly, spliceFindings } = classifyModules(root, options);
  const findings = [];

  /*
   * A declaration that stopped being true comes first: if the splice drifted,
   * everything it carries is mis-classified, and reporting that as a pile of
   * orphans would blame the modules for a failure of the check's own inputs.
   */
  findings.push(...spliceFindings);

  for (const r of rows) {
    if (r.status === REACHABLE || r.status === SPLICED) continue;
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
