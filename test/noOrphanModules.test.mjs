import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo root, resolved properly: URL.pathname yields /C:/... on Windows. */
const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
import {
  parseImports,
  resolveSpecifier,
  buildGraph,
  classifyModules,
  findOrphans,
  REACHABLE,
  TEST_ONLY,
  UNREFERENCED,
  SPLICED,
  DEFAULT_SPLICES,
  verifySplices,
} from '../src/moduleGraph.mjs';

/**
 * A MODULE NOTHING CALLS, FOUND BY THE GRAPH RATHER THAN BY SOMEBODY NOTICING.
 *
 * Four real orphans in one day — resolveWorker/bindDelegation, supersession.mjs,
 * tokenBudget.mjs, and schedule.mjs — each with a full green suite in front of
 * it, proving behaviour no shipped code could ask for. A module's own tests can
 * never catch this: they import it, so from inside, test-only and used look
 * identical.
 *
 * And a FIFTH instance was a FALSE positive: transition() was announced orphaned
 * because a search used the wrong identifiers while the call site sat in
 * bin/agentbridge.mjs. That is why the contract forbids grep-for-a-name, and why
 * the first test below plants a real call site and deletes it.
 */

/** Build a throwaway repo. Fixtures beat the real tree for behaviour. */
async function repo(t, files) {
  const root = await mkdtemp(path.join(tmpdir(), 'ab-graph-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  }
  return root;
}

const ENTRY = { entryPoints: ['bin/app.mjs'], allowedOrphans: {} };
const statusOf = (rows, m) => rows.find((r) => r.module === m)?.status;

/* ── the mutation the contract names: delete a real call site ────────── */

test('DELETING THE ONLY CALL SITE TURNS A REACHABLE MODULE INTO AN ORPHAN', async (t) => {
  const called = await repo(t, {
    'bin/app.mjs': `import { go } from '../src/used.mjs';\ngo();\n`,
    'src/used.mjs': `export const go = () => 1;\n`,
  });
  assert.equal(statusOf(classifyModules(called, ENTRY).rows, 'src/used.mjs'), REACHABLE);

  // The same repo with the import removed — nothing else changed.
  const orphaned = await repo(t, {
    'bin/app.mjs': `const go = () => 1;\ngo();\n`,
    'src/used.mjs': `export const go = () => 1;\n`,
  });
  assert.equal(statusOf(classifyModules(orphaned, ENTRY).rows, 'src/used.mjs'), UNREFERENCED);
});

test('A RENAME DOES NOT FOOL IT — the edge is the specifier, not the name', async (t) => {
  /*
   * The transition() false positive in one test. A name-based search for `go`
   * finds nothing here and would report the module orphaned; the import edge is
   * still there and the module is still reached.
   */
  const root = await repo(t, {
    'bin/app.mjs': `import { go as somethingElse } from '../src/used.mjs';\nsomethingElse();\n`,
    'src/used.mjs': `export const go = () => 1;\n`,
  });
  assert.equal(statusOf(classifyModules(root, ENTRY).rows, 'src/used.mjs'), REACHABLE);
});

test('a name appearing only in a LINE comment is not an edge', async (t) => {
  const root = await repo(t, {
    'bin/app.mjs': `// we could import { go } from '../src/used.mjs' one day\nexport const x = 1;\n`,
    'src/used.mjs': `export const go = () => 1;\n`,
  });
  assert.equal(statusOf(classifyModules(root, ENTRY).rows, 'src/used.mjs'), UNREFERENCED);
});

test('an import quoted inside a BLOCK comment is not an edge either', async (t) => {
  /*
   * The case that matters in THIS repository, and mutation is what exposed the
   * gap: disabling the block-comment stripper left the suite green, because the
   * only comment test used `//`.
   *
   * Every module header here is a block comment, and several quote import
   * statements while explaining the deferred-import idiom. Counting those as
   * edges would mark a module reachable because somebody DESCRIBED importing
   * it — the documentation agreeing with itself, which is the same shape as a
   * gate that reconstructs the rule it is supposed to check.
   */
  const root = await repo(t, {
    'bin/app.mjs':
      `/**\n * Explaining the idiom:\n *   import { go } from '../src/used.mjs';\n */\nexport const x = 1;\n`,
    'src/used.mjs': `export const go = () => 1;\n`,
  });
  assert.equal(statusOf(classifyModules(root, ENTRY).rows, 'src/used.mjs'), UNREFERENCED);
});

/* ── the three answers ───────────────────────────────────────────────── */

test('TEST-ONLY is distinguished from unreferenced — the state all four were in', async (t) => {
  /*
   * Collapsing these would have reported four covered modules as uncovered,
   * which is the opposite of true and sends somebody to write tests that exist.
   */
  const root = await repo(t, {
    'bin/app.mjs': `export const x = 1;\n`,
    'src/tested.mjs': `export const go = () => 1;\n`,
    'src/nothing.mjs': `export const nope = () => 1;\n`,
    'test/tested.test.mjs': `import { go } from '../src/tested.mjs';\ngo();\n`,
  });
  const { rows } = classifyModules(root, ENTRY);
  assert.equal(statusOf(rows, 'src/tested.mjs'), TEST_ONLY);
  assert.equal(statusOf(rows, 'src/nothing.mjs'), UNREFERENCED);
});

test('reachability is TRANSITIVE — a module reached through another counts', async (t) => {
  const root = await repo(t, {
    'bin/app.mjs': `import '../src/a.mjs';\n`,
    'src/a.mjs': `import '../src/b.mjs';\n`,
    'src/b.mjs': `import '../src/c.mjs';\n`,
    'src/c.mjs': `export const deep = 1;\n`,
  });
  const { rows } = classifyModules(root, ENTRY);
  for (const m of ['src/a.mjs', 'src/b.mjs', 'src/c.mjs']) {
    assert.equal(statusOf(rows, m), REACHABLE, `${m} should be reachable`);
  }
});

test('NEAREST CLEAN: a module imported by a REAL entry point is never reported', async (t) => {
  const root = await repo(t, {
    'bin/app.mjs': `import '../src/used.mjs';\n`,
    'src/used.mjs': `export const x = 1;\n`,
  });
  assert.deepEqual(findOrphans(root, ENTRY).findings, []);
  assert.equal(findOrphans(root, ENTRY).ok, true);
});

/* ── the import forms that must all be edges ─────────────────────────── */

test('every import form is parsed, and a variable import is never guessed', () => {
  const src = `
    import a from './a.mjs';
    import { b } from './b.mjs';
    import './c.mjs';
    export { d } from './d.mjs';
    export * from './e.mjs';
    const f = await import('./f.mjs');
    const g = await import(someVariable);
  `;
  const { specifiers, dynamic } = parseImports(src);
  for (const s of ['./a.mjs', './b.mjs', './c.mjs', './d.mjs', './e.mjs', './f.mjs']) {
    assert.ok(specifiers.includes(s), `${s} must be an edge`);
  }
  // A dynamic import built from a variable is REPORTED, never resolved:
  // reporting a maybe as a yes is the false-confidence failure this avoids.
  assert.deepEqual(dynamic, ['someVariable']);
  assert.equal(specifiers.some((s) => s.includes('someVariable')), false);
});

test('a deferred import inside a function body is still an edge', async (t) => {
  // This repo's own idiom: `const { x } = await import('./y.mjs')` inside a
  // handler. Missing it would report half the codebase orphaned.
  const root = await repo(t, {
    'bin/app.mjs': `export async function run() { const { go } = await import('../src/used.mjs'); return go(); }\n`,
    'src/used.mjs': `export const go = () => 1;\n`,
  });
  assert.equal(statusOf(classifyModules(root, ENTRY).rows, 'src/used.mjs'), REACHABLE);
});

test('bare specifiers are packages, not repo edges', () => {
  assert.equal(resolveSpecifier('/root', 'src/a.mjs', 'node:fs'), null);
  assert.equal(resolveSpecifier('/root', 'src/a.mjs', 'express'), null);
  assert.equal(resolveSpecifier('/root', 'src/a.mjs', './b.mjs'), 'src/b.mjs');
});

test('paths are repo-relative and forward-slashed, so no absolute path can leak', async (t) => {
  const root = await repo(t, { 'bin/app.mjs': `import '../src/a.mjs';\n`, 'src/a.mjs': `export const x=1;\n` });
  const { graph } = buildGraph(root);
  for (const key of graph.keys()) {
    assert.doesNotMatch(key, /^[A-Za-z]:|^\//, `${key} is absolute`);
    assert.doesNotMatch(key, /\\/, `${key} carries a backslash`);
  }
});

/* ── the opt-out list, and its own guard ─────────────────────────────── */

test('an allowed orphan with a REASON is not a finding', async (t) => {
  const root = await repo(t, {
    'bin/app.mjs': `export const x = 1;\n`,
    'src/plugin.mjs': `export const p = 1;\n`,
  });
  const r = findOrphans(root, {
    entryPoints: ['bin/app.mjs'],
    allowedOrphans: { 'src/plugin.mjs': 'loaded by name at runtime from config; see loader docs' },
  });
  assert.deepEqual(r.findings, []);
});

test('AN OPT-OUT WITH NO REASON IS ITSELF A FINDING', async (t) => {
  /*
   * The way a gate like this dies is somebody adding a line to silence it on a
   * Friday, and nobody afterwards being able to tell whether that line is still
   * true. A silencer nobody can evaluate is not an exemption, it is a snooze.
   */
  const root = await repo(t, {
    'bin/app.mjs': `export const x = 1;\n`,
    'src/plugin.mjs': `export const p = 1;\n`,
  });
  for (const reason of ['', '   ', null]) {
    const r = findOrphans(root, { entryPoints: ['bin/app.mjs'], allowedOrphans: { 'src/plugin.mjs': reason } });
    assert.equal(r.ok, false, `reason ${JSON.stringify(reason)} must not silence it`);
    assert.equal(r.findings[0].kind, 'unreasoned-opt-out');
  }
});

/* ── wrong roots must not masquerade as orphans ──────────────────────── */

test('A MISSING ENTRY POINT IS REPORTED AS SUCH, not as a pile of orphans', async (t) => {
  /*
   * Wrong roots make everything downstream look unreached. That is a failure of
   * the check, and reporting it as twenty orphans would send somebody deleting
   * working code.
   */
  const root = await repo(t, {
    'bin/app.mjs': `import '../src/a.mjs';\n`,
    'src/a.mjs': `export const x = 1;\n`,
  });
  const r = findOrphans(root, { entryPoints: ['bin/app.mjs', 'bin/does-not-exist.mjs'], allowedOrphans: {} });
  assert.equal(r.ok, false);
  const kinds = r.findings.map((f) => f.kind);
  assert.ok(kinds.includes('missing-entry-point'));
  assert.equal(kinds.includes(UNREFERENCED), false, 'src/a.mjs is fine and must not be blamed');
});

/* ── a finding says who imports it, so it is actionable ──────────────── */

test('a test-only finding names the test that imports it', async (t) => {
  const root = await repo(t, {
    'bin/app.mjs': `export const x = 1;\n`,
    'src/tested.mjs': `export const go = () => 1;\n`,
    'test/t.test.mjs': `import '../src/tested.mjs';\n`,
  });
  const f = findOrphans(root, ENTRY).findings.find((x) => x.module === 'src/tested.mjs');
  assert.deepEqual(f.importedBy, ['test/t.test.mjs']);
});

/* ── THE REAL REPOSITORY: a ratchet, not a pass ──────────────────────── */

/**
 * Known orphans in THIS repo, each with the reason it is still here.
 *
 * A ratchet rather than an absolute, deliberately: both entries are true today
 * and fixing them belongs to a wiring contract, not to this gate. The list may
 * only ever SHRINK — a new orphan fails, and removing one without deleting its
 * entry fails too, so it cannot rot into a rubber stamp.
 */
const KNOWN = {
  'src/runtime.mjs':
    'A JS MIRROR OF LOGIC THE DATABASE IS AUTHORITATIVE FOR. Owner ruling 2026-09-16: ' +
    'SQL stays authority for leases, review leases, retry limits and the outbox. ' +
    'reviewerQueue and canReview are implemented in ' +
    '20260915220223_the_review_lease_gets_a_writer_a_renewer_and_a_reaper.sql; retry and ' +
    'outbox concepts appear in 20260915220139_leases_fencing_tokens_and_an_outbox.sql. ' +
    'So this module must not acquire a caller: a second live implementation is the defect. ' +
    'It is NOT deleted yet because "the SQL mentions the concept" is proximity, not proven ' +
    'equivalence, and deleting behaviour on a grep is the proxy assertion rule 4 forbids. ' +
    'invalidatedBy in particular has NO SQL counterpart at all. Removal is per-function and ' +
    'needs equivalence proven first; until then this is a test oracle, not shipped logic.',
  'src/auditRange.mjs':
    'RECOVERED 2026-09-16 from b/audit-range, unmerged work from a worker that went silent ' +
    'mid-task. It arrived green and orphaned: the branch added the module and its tests and ' +
    'never added a call site, which is the same pattern this gate was written for. Kept ' +
    'because losing it again is worse than carrying it; needs a caller in the precommit or ' +
    'audit path, and this entry should go the moment one exists.',
  'src/schedule.mjs':
    'ORPHANED IN PRODUCTION. Integrated and green, imported only by its tests. ' +
    'The fifth instance of this pattern and the first found by machine. Needs a CLI caller.',
  'src/moduleGraph.mjs':
    'This gate itself, not yet wired to a command. Becomes test-only once its test lands, ' +
    'and reachable when a caller exists.',
};

test('THE REAL REPO HAS NO ORPHAN BEYOND THE KNOWN LIST', () => {
  const root = REPO_ROOT;
  const r = findOrphans(root, { allowedOrphans: KNOWN });
  assert.deepEqual(
    r.findings.map((f) => `${f.kind} ${f.module}`),
    [],
    'a NEW module is reachable from nothing shipped. Wire it or justify it in KNOWN.',
  );
});

test('the known list may only SHRINK — a stale entry is a finding', () => {
  /*
   * An allowlist entry for something that is no longer orphaned is permission
   * with nothing to permit, and it is how a list like this rots.
   */
  const root = REPO_ROOT;
  const { rows } = classifyModules(root, { allowedOrphans: KNOWN });
  for (const m of Object.keys(KNOWN)) {
    const row = rows.find((r) => r.module === m);
    assert.ok(row, `${m} is in KNOWN but no longer exists — remove the entry`);
    assert.notEqual(row.status, REACHABLE, `${m} is now reachable: delete its KNOWN entry`);
  }
});

test('every known entry carries a reason a later reader can disagree with', () => {
  for (const [m, reason] of Object.entries(KNOWN)) {
    assert.ok(reason && reason.trim().length > 20, `${m} needs a real reason, not a placeholder`);
  }
});

/* ── shipped by being copied, not by being imported ──────────────────── */

/*
 * THE FALSE POSITIVE THIS PREVENTS, stated plainly because it nearly cost three
 * live modules. supabase/functions/mcp/_shared.js is a hand-maintained copy of
 * src/ and bridge/ modules -- an Edge Function cannot import from outside its
 * own directory. A copy is not an import, so no graph can see it, and this gate
 * reported dispatch.mjs, ownWork.mjs and permissionRequest.mjs as orphaned while
 * they were deployed and serving. The finding reads "wire it or justify it", and
 * the other obvious response is deletion: removing the SOURCE of deployed code
 * while production keeps running on the stale copy.
 *
 * So the splice is declared -- and every test below exists because a declaration
 * that is never checked is just a longer allowlist.
 */

const SPLICE_ENTRY = { entryPoints: ['bin/app.mjs'], allowedOrphans: {} };

test('A SPLICED MODULE IS SHIPPED, NOT TEST-ONLY', async (t) => {
  const root = await repo(t, {
    'bin/app.mjs': `export const noop = 1;\n`,
    'src/carried.mjs': `export const alpha = () => 1;\nexport const beta = () => 2;\n`,
    'test/carried.test.mjs': `import { alpha } from '../src/carried.mjs';\nalpha();\n`,
    'edge/_shared.js': `export const alpha = () => 1;\nexport const beta = () => 2;\n`,
  });
  const opts = { ...SPLICE_ENTRY, splices: { 'edge/_shared.js': ['src/carried.mjs'] } };
  assert.equal(statusOf(classifyModules(root, opts).rows, 'src/carried.mjs'), SPLICED);
  assert.deepEqual(findOrphans(root, opts).findings, [], 'deployed code is not a finding');
});

test('WATCH IT FAIL: drop one export from the copy and the splice is no longer honoured', async (t) => {
  // Byte-for-byte the previous fixture, except beta is missing from the copy.
  const root = await repo(t, {
    'bin/app.mjs': `export const noop = 1;\n`,
    'src/carried.mjs': `export const alpha = () => 1;\nexport const beta = () => 2;\n`,
    'test/carried.test.mjs': `import { alpha } from '../src/carried.mjs';\nalpha();\n`,
    'edge/_shared.js': `export const alpha = () => 1;\n`,
  });
  const opts = { ...SPLICE_ENTRY, splices: { 'edge/_shared.js': ['src/carried.mjs'] } };

  const { findings } = findOrphans(root, opts);
  const drift = findings.find((f) => f.kind === 'splice-drifted');
  assert.ok(drift, 'a copy that lost an export must be reported, not silently accepted');
  assert.deepEqual(drift.absent, ['beta'], 'the finding names what is missing');

  // and the exemption is withdrawn: it goes back to being an orphan
  assert.equal(statusOf(classifyModules(root, opts).rows, 'src/carried.mjs'), TEST_ONLY);
});

test('A DECLARATION IS NOT A SNOOZE BUTTON: naming a module that was never spliced fails', async (t) => {
  const root = await repo(t, {
    'bin/app.mjs': `export const noop = 1;\n`,
    'src/never.mjs': `export const gamma = () => 3;\n`,
    'test/never.test.mjs': `import { gamma } from '../src/never.mjs';\ngamma();\n`,
    'edge/_shared.js': `export const unrelated = () => 0;\n`,
  });
  const opts = { ...SPLICE_ENTRY, splices: { 'edge/_shared.js': ['src/never.mjs'] } };
  const { findings } = findOrphans(root, opts);
  assert.equal(findings.filter((f) => f.kind === 'splice-drifted').length, 1);
  assert.equal(statusOf(classifyModules(root, opts).rows, 'src/never.mjs'), TEST_ONLY);
});

test('PARTIAL OVERLAP IS NOT A SPLICE: a shared name does not buy an exemption', async (t) => {
  /*
   * Two modules can export the same name by coincidence. Accepting a partial
   * match would let a module REMOVED from the copy keep its exemption because
   * one of its names happened to survive somewhere else in the bundle.
   */
  const root = await repo(t, {
    'bin/app.mjs': `export const noop = 1;\n`,
    'src/partial.mjs': `export const shared = () => 1;\nexport const only = () => 2;\n`,
    'test/partial.test.mjs': `import { only } from '../src/partial.mjs';\nonly();\n`,
    'edge/_shared.js': `export const shared = () => 1;\n`,
  });
  const opts = { ...SPLICE_ENTRY, splices: { 'edge/_shared.js': ['src/partial.mjs'] } };
  assert.equal(statusOf(classifyModules(root, opts).rows, 'src/partial.mjs'), TEST_ONLY);
});

test('A ROOT WITH NO COPY IS NOT EVIDENCE ABOUT THE COPY', async (t) => {
  // The declaration describes the real repository. Applied to a fixture that has
  // no splice file it says nothing, and must not fail every fixture for it.
  const root = await repo(t, {
    'bin/app.mjs': `import { go } from '../src/used.mjs';\ngo();\n`,
    'src/used.mjs': `export const go = () => 1;\n`,
  });
  const { findings } = verifySplices(root, { 'edge/_shared.js': ['src/used.mjs'] });
  assert.deepEqual(findings, []);
});

test('THE REAL SPLICE DECLARATION IS TRUE TODAY', () => {
  /*
   * A NEGATIVE NEEDS THE POSITIVE FIRST: assert the declaration actually
   * resolved something before asserting it produced no complaints, or an empty
   * declaration would pass this for the wrong reason.
   */
  const { spliced, findings } = verifySplices(REPO_ROOT, DEFAULT_SPLICES);
  assert.ok(spliced.size >= 8, `expected the copy to carry the declared modules, got ${spliced.size}`);
  assert.deepEqual(findings, [], 'the deployed copy has drifted from the modules it claims to carry');
  assert.ok(spliced.has('src/dispatch.mjs'));
  assert.ok(spliced.has('src/permissionRequest.mjs'));
});
