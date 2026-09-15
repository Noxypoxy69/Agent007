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
