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
/**
 * THE DIRECTORIES THAT SHIP. Declared once, because this file had THREE copies of
 * this list and they had already drifted.
 *
 * buildGraph walked src, bin, bridge, mcp and test; classifyExports walked those
 * plus scripts, with a comment explaining that scripts IS production because a
 * Claude Code hook runs claude-stop-gate.mjs; deadExports walked neither scripts
 * nor test. So one file gave two different answers about whether a module
 * imported by the Stop gate was reachable, and a third about whether its exports
 * were used. Adding scripts to one of them fixed one answer and left the others
 * -- which is how a fourth copy gets added later. (Second list found by the
 * independent review on fix/stop-gate-rebaseline; the first cost a module being
 * reported as an orphan while a hook was calling it.)
 *
 * test/ is deliberately NOT here: it is a root for reachability, never a
 * definition of what production reaches.
 */
export const PRODUCTION_DIRS = Object.freeze(['src', 'bin', 'bridge', 'mcp', 'scripts']);

export const DEFAULT_ENTRY_POINTS = [
  'bin/agentbridge.mjs',
  'bin/agentbridge-precommit.mjs',
  'bin/agentbridge-preflight.mjs',
  'bin/agentbridge-attempt.mjs',
  /* The reviewer runtime. It is the caller claim_review never had, and it is an
   * entry point in the same sense the others are: something outside the graph
   * invokes it, so src/reviewRunner.mjs and src/reviewDecision.mjs are shipped
   * rather than test-only. */
  'bin/agentbridge-review.mjs',
  /* The Step 4A verification path. Two separate executables ON PURPOSE: the
   * worker's command can verify and cannot promote, and that separation is the
   * only authority claim available while both run as the same OS user. Declared
   * here because an entry point and an orphan look identical from the graph --
   * the difference has to be stated by a person, and this is that statement. */
  'bin/agentbridge-verify.mjs',
  'bin/agentbridge-integrate.mjs',
  /* Claude invokes this from a PreToolUse hook. It is a shipped process entry,
   * not merely a test import. */
  'bin/agentbridge-claude-guard.mjs',
  /* AND THE STOP HOOK, for the same reason and from the same authority.
   * classifyExports below has counted `scripts` as production since omitting it
   * reported discoverTests, protectedDrift and snapshotPath as unreferenced
   * while a hook was calling them. buildGraph did not, so the two halves of this
   * file gave opposite answers about one directory -- and the half that was
   * wrong is the one that decides whether a module is an orphan. A module
   * imported only by this gate read as unreferenced, which invites a permanent
   * allowlist entry for something that is in fact wired. */
  'scripts/claude-stop-gate.mjs',
  /* A human runs this before hand-deploying the edge function. It is an entry
   * point in the only sense that matters here: something outside the graph
   * invokes it, so what it imports is shipped rather than orphaned. */
  'bin/agentbridge-deploy-check.mjs',
  /* The Run 2 envelope script. It is run directly, never imported, so it is
   * an entry point in the same sense as the deploy check: undeclared, it makes
   * src/run2Envelope.mjs read as test-only while shipped code is calling it. */
  'scripts/run2-envelope.mjs',
  'bridge/server.mjs',
  'bridge/worker.mjs',
  /* The deployed Cloudflare OAuth worker: wrangler.toml `main`. Cloudflare
   * invokes it and nothing imports it, so it is an entry point in the same
   * sense as the Stop hook -- undeclared, the graph cannot see it ship. */
  'bridge/oauthWorker.mjs',
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
export function buildGraph(root, { dirs = [...PRODUCTION_DIRS, 'test'] } = {}) {
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

/*
 * ------------------------------------------------------------------------
 * PER-EXPORT REACHABILITY: THE GAP THAT LET A DEAD SEAM SHIP.
 *
 * findOrphans above answers "does anything import this MODULE". That is the
 * wrong granularity and it passed while being wrong: src/completion.mjs was
 * reachable through one helper, so the gate went green while workFingerprint,
 * resolveWork and canComplete -- the three functions that ARE the completion
 * seam -- had no caller anywhere. A module is not wired because one of its
 * exports is.
 *
 * TWO WAYS TO GET THIS WRONG, BOTH ALREADY PAID FOR HERE:
 *
 *   SUBSTRING MATCHING. A hand grep for "resolveWork" reported 13 callers. Every
 *   one was "resolveWorker". Identifiers are matched on word boundaries, and the
 *   test plants exactly that pair.
 *
 *   COMMENTS COUNTING AS USES. A structural gate in this repo once failed
 *   against correct code because it matched its own explanatory comment. This
 *   repository is densely commented by policy, and every export is named in
 *   prose somewhere. Comments and strings are stripped before matching.
 */

/**
 * Remove comments ONLY, keeping string literals intact.
 *
 * Separate from stripNonCode because the two answer opposite questions.
 * deadExports must drop strings -- a name inside a string is not a call site.
 * A structural check asserting that a caller hardcodes `suiteSource: 'candidate'`
 * must KEEP them, because the string is the value under assertion.
 *
 * Written after a structural test used stripNonCode, searched the result for a
 * string literal that had just been removed, and got an empty slice. Two of its
 * assertions then failed loudly; the third -- a negative -- would have passed
 * vacuously against nothing at all, which is the hollow-gate shape again.
 */
export function stripComments(source) {
  return String(source ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** Remove line comments, block comments and string bodies. Crude and sufficient. */
export function stripNonCode(source) {
  return String(source ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, ' `` ')
    .replace(/'(?:\\.|[^\\'])*'/g, " '' ")
    .replace(/"(?:\\.|[^\\"])*"/g, ' "" ');
}

/**
 * Exports of `dirs` modules that no NON-TEST module mentions.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT. A name appearing in shipped code means
 * something references it; it does not mean that code path ever runs. That is
 * contract item 1 (name the caller), not item 6 (run it end to end). A gate
 * cannot do item 6 and must not be read as having done it.
 *
 * SCOPE: src, bin, bridge and mcp. supabase/ is excluded, which was CHECKED
 * rather than assumed -- no file under supabase/functions imports from src/, so
 * the edge functions cannot be the missing caller. If that ever changes, add
 * the directory here or this gate starts reporting live exports as dead.
 */
/**
 * CATEGORIES, because "dead" was a single bucket hiding at least four things.
 *
 * An independent review caught this: the gate excluded supabase/ entirely, and I
 * had claimed that exclusion was CHECKED. It was not -- my grep looked only for
 * relative imports of src/ and found none, so I concluded the edge functions
 * could not be consumers. 34 dead-reported names DO appear in supabase source.
 *
 * But they are not callers either, which matters for the fix. _shared.js is a
 * DECLARED SPLICE: DEFAULT_SPLICES lists ten source modules deliberately ported
 * into it and checked by verifySplices. So the edge function carries verified
 * COPIES. Adding supabase/ to the reference universe would count a copy as a
 * caller and mask exactly the duplication the splice mechanism exists to manage.
 *
 * Hence categories rather than a bigger universe, and a baseline drawn only from
 * the one that means what the old number pretended to mean.
 */
export const EXPORT_CATEGORIES = Object.freeze([
  'production-referenced',
  'edge-referenced',
  'spliced-only',
  'test-only',
  'unreferenced',
]);

export function classifyExports(root, { allowed = {} } = {}) {
  /*
   * `scripts` IS PRODUCTION. scripts/claude-stop-gate.mjs is invoked by a Claude
   * Code Stop hook -- something outside the graph runs it, which is the only
   * sense of "entry point" that matters here. Omitting the directory reported
   * discoverTests, protectedDrift and snapshotPath as unreferenced while a hook
   * was calling them.
   */
  const PROD = PRODUCTION_DIRS;
  const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
  const mentions = (text, name) =>
    new RegExp(`(^|[^A-Za-z0-9_$])${name}([^A-Za-z0-9_$]|$)`).test(text);

  const prodFiles = PROD.flatMap((d) => walkDir(path.join(root, d)));
  const testFiles = walkDir(path.join(root, 'test'));
  const edgeFiles = walkDir(path.join(root, 'supabase')).filter((f) => /\.(ts|js|mjs)$/.test(f));

  const prod = prodFiles.map((f) => [f, stripNonCode(read(f))]);
  const testText = testFiles.map(read).map(stripNonCode).join('\n');
  const edgeText = edgeFiles.map(read).map(stripNonCode).join('\n');

  // Which source modules are declared splice SOURCES, and into which target.
  const spliceSourceOf = new Map();
  for (const [target, sources] of Object.entries(DEFAULT_SPLICES)) {
    for (const src of sources) spliceSourceOf.set(src, target);
  }

  const out = [];
  for (const [f, _text] of prod) {
    const relPath = rel(root, f);
    if (!relPath.startsWith('src/')) continue;
    let names = [];
    try { names = exportedNames(read(f)); } catch { continue; }
    for (const name of names) {
      if (!name || name === 'default') continue;
      if ((allowed[relPath] ?? []).includes(name)) continue;

      /*
       * SAME-FILE USE COUNTS. A helper called by its own module's shipped
       * function is production code, and excluding the defining file reported
       * isProtectedPath and normalizedCandidates as unreferenced while
       * evaluateClaudeTool called them on every hook invocation. The definition
       * itself is skipped so an export is not "used" merely by existing.
       */
      const own = stripNonCode(read(f)).replace(new RegExp(`export\\s+(?:function|const|let|class)\\s+${name}\\b`), ' ');
      const inProd = mentions(own, name)
        || prod.some(([other, text]) => other !== f && mentions(text, name));
      if (inProd) { out.push({ file: relPath, name, category: 'production-referenced' }); continue; }

      const inEdge = mentions(edgeText, name);
      if (inEdge) {
        // A splice source's name appearing in its own splice target is a COPY,
        // not a call. Only a non-spliced module counts as genuinely edge-used.
        out.push({
          file: relPath, name,
          category: spliceSourceOf.has(relPath) ? 'spliced-only' : 'edge-referenced',
        });
        continue;
      }

      if (mentions(testText, name)) { out.push({ file: relPath, name, category: 'test-only' }); continue; }
      out.push({ file: relPath, name, category: 'unreferenced' });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
}

export function deadExports(root, { dirs = PRODUCTION_DIRS, allowed = {} } = {}) {
  // walkDir and readFileSync, the same helpers buildGraph uses. The first draft
  // of this invoked a nodeFs()/collectFiles() pair that does not exist in this
  // module -- invented while writing, caught by running it.
  const files = dirs.flatMap((d) => walkDir(path.join(root, d)));

  const corpus = new Map();
  for (const f of files) {
    try { corpus.set(f, stripNonCode(readFileSync(f, 'utf8'))); } catch { /* unreadable */ }
  }

  const findings = [];
  for (const f of files) {
    const relPath = rel(root, f);
    if (!relPath.startsWith('src/')) continue;          // only library modules have this question
    let names = [];
    try { names = exportedNames(readFileSync(f, 'utf8')); } catch { continue; }
    for (const name of names) {
      if (!name || name === 'default') continue;
      if ((allowed[relPath] ?? []).includes(name)) continue;
      // WORD BOUNDARIES. resolveWork must not be satisfied by resolveWorker.
      const re = new RegExp(`(^|[^A-Za-z0-9_$])${name}([^A-Za-z0-9_$]|$)`);
      let used = false;
      for (const [other, text] of corpus) {
        if (other === f) continue;
        if (re.test(text)) { used = true; break; }
      }
      if (!used) findings.push({ file: relPath, name });
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
}
