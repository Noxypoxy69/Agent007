import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deadExports, stripNonCode, classifyExports, EXPORT_CATEGORIES, DEFAULT_SPLICES,
} from '../src/moduleGraph.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * CONTRACT ITEM 1, MECHANISED: "name the exact production caller".
 *
 * noOrphanModules asks whether anything imports a MODULE. That granularity went
 * green on src/completion.mjs while workFingerprint, resolveWork and canComplete
 * -- the three functions that ARE the completion seam -- had no caller
 * anywhere. The module was reachable through one small helper, so the gate was
 * satisfied by the side dish. A module is not wired because one export is.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT. A name referenced in shipped code means
 * something mentions it. It does NOT mean that path ever runs. This is item 1 of
 * the contract, never item 6. Nobody may read a green run here as end-to-end
 * evidence.
 *
 * RATCHET, NOT ABSOLUTE. 158 dead functions were inherited on the day this was
 * written; a permanently red gate is one people learn to ignore. The baseline
 * may only ever go DOWN. This is a legitimate ratchet rather than a countdown:
 * a NEW unwired export raises the number immediately, which is the case it
 * exists to catch, and clearing debt lowers it.
 */

/*
 * ============================================================================
 * PROVISIONAL. A GREEN RUN HERE IS NOT EVIDENCE OF REACHABILITY.
 * ============================================================================
 *
 * The second independent review rejected this gate's implementation, and the
 * finding is correct: classification is built from repo-wide NAME MENTIONS, not
 * from a resolved import graph. Consequences, stated rather than discovered
 * later:
 *
 *   A same-named function, property or local variable in an unrelated module
 *   marks an export as production-referenced. That is the resolveWork /
 *   resolveWorker defect in a broader form -- word boundaries stop the substring
 *   case and do nothing about a genuine name collision across modules.
 *
 *   The splice check asks whether a name occurs ANYWHERE in edge source, not
 *   whether it occurs inside the splice target declared for THAT module in
 *   DEFAULT_SPLICES.
 *
 *   Imported-but-unused, re-exported public surface, and dynamic/unresolved are
 *   not distinguished at all.
 *
 * SO THE NUMBERS BELOW ARE A FLOOR, NOT A MEASUREMENT. They can only understate
 * how much is unreferenced. The ratchet still catches a new export appearing
 * with no mention anywhere, which is worth keeping running, but nobody may cite
 * a pass here as proof that an export has a production caller -- that is
 * contract item 1 and this does not currently satisfy it.
 *
 * THE REBUILD, specified by the review: reachability from parsed imports and
 * re-exports with resolved module paths; splice checked source -> declared
 * target; categories reported separately for imported-and-referenced,
 * imported-but-unused, re-exported public surface, dynamic/unresolved,
 * test-only, spliced-only and truly unreferenced; dynamic/unresolved fail-safe
 * until exhaustively resolved; and the ratchet drawn ONLY from truly
 * unreferenced, with exceptions listed as explicit names rather than a broad
 * gate-machinery exclusion.
 *
 * parseImports currently returns specifiers without imported NAMES, so the
 * rebuild needs a named-import parser. That is its own pass with its own
 * mutation proofs, not a patch bolted onto this one.
 */

const IS_CONSTANT = /^[A-Z][A-Z0-9_]*$/;

/** Exported functions and values, by category, excluding frozen constants. */
function fnsByCategory(root, { excludeGateMachinery = false } = {}) {
  const all = classifyExports(root)
    .filter((d) => !IS_CONSTANT.test(d.name))
    .filter((d) => !(excludeGateMachinery && GATE_MACHINERY.includes(d.file)));
  const by = {};
  for (const c of EXPORT_CATEGORIES) by[c] = all.filter((d) => d.category === c);
  return by;
}

/*
 * THE BASELINES, RECALCULATED AFTER A REVIEW FOUND THE OLD ONE INVALID.
 *
 * It was 158 "dead functions" and that number conflated three different things:
 * 133 referenced only by tests, 13 deliberately spliced into the edge function,
 * and 14 genuinely unreferenced. A ratchet at 158 was over eleven times looser
 * than it appeared -- decoration wearing the shape of a gate.
 *
 * TEST_ONLY IS THE ONE THAT MATTERS FOR CONTRACT ITEM 1. An export with tests
 * and no production caller is exactly the completion.mjs shape: correct, proven,
 * and called by nothing. UNREFERENCED is worse but rarer. Both ratchet down only.
 *
 * SPLICED_ONLY IS NOT DEBT and is not ratcheted. Those names are carried into
 * supabase/functions/mcp/_shared.js as declared, verified copies; counting them
 * as dead was the misclassification the review caught.
 */
const BASELINE_UNREFERENCED = 13;
const BASELINE_TEST_ONLY = 124;

/*
 * GATE MACHINERY IS TEST-ONLY BY NATURE, and excluding it makes the number mean
 * something. src/moduleGraph.mjs exists to be run BY gates; its consumers are
 * tests because that is its job, and counting its exports as unwired debt would
 * make the ratchet rise every time a gate gains a helper -- punishing exactly
 * the work that closes the other categories.
 *
 * NOT SPECIAL PLEADING: noOrphanModules already carries src/moduleGraph.mjs in
 * its KNOWN list for this reason ("This gate itself, not yet wired to a
 * command"). This applies the same judgement per export.
 *
 * Excluding it LOWERED the baseline from 133 to 124 rather than raising it,
 * which is the direction a ratchet is allowed to move. The alternative on the
 * table was bumping 133 to 134 to accommodate this commit's own new exports,
 * and a baseline raised to fit the change it was meant to catch is not a gate.
 */
const GATE_MACHINERY = ['src/moduleGraph.mjs'];

test('PROVISIONAL: the unreferenced ratchet does not increase', () => {
  const by = fnsByCategory(REPO_ROOT);
  assert.ok(
    by.unreferenced.length <= BASELINE_UNREFERENCED,
    `unreferenced exported functions rose to ${by.unreferenced.length} from ${BASELINE_UNREFERENCED}:\n` +
      by.unreferenced.slice(0, 12).map((d) => `  ${d.file} -> ${d.name}`).join('\n'),
  );
});

test('PROVISIONAL: the test-only floor does not increase (NOT contract item 1 yet)', () => {
  const by = fnsByCategory(REPO_ROOT, { excludeGateMachinery: true });
  assert.ok(
    by['test-only'].length <= BASELINE_TEST_ONLY,
    `exports with tests but no production caller rose to ${by['test-only'].length} from ${BASELINE_TEST_ONLY}.\n` +
      'That is "correct, proven, and called by nothing" — name the production caller or do not export it.\n' +
      by['test-only'].slice(0, 12).map((d) => `  ${d.file} -> ${d.name}`).join('\n'),
  );
});

test('both baselines are honest: they match what is actually there', () => {
  // A baseline above the real count silently permits a regression. Failing LOW
  // means lower the constant -- that is the ratchet working.
  assert.equal(fnsByCategory(REPO_ROOT).unreferenced.length, BASELINE_UNREFERENCED, 'unreferenced drifted');
  assert.equal(
    fnsByCategory(REPO_ROOT, { excludeGateMachinery: true })['test-only'].length,
    BASELINE_TEST_ONLY,
    'test-only drifted',
  );
});

test('the gate-machinery exclusion is narrow and each entry is really gate machinery', () => {
  // An exclusion list is how a ratchet quietly stops meaning anything, so it is
  // asserted rather than trusted: every entry must be consumed ONLY by tests.
  assert.ok(GATE_MACHINERY.length <= 2, 'keep this list tiny or the number stops meaning anything');
  const all = classifyExports(REPO_ROOT);
  for (const file of GATE_MACHINERY) {
    const own = all.filter((d) => d.file === file);
    assert.ok(own.length > 0, `${file} must exist and export something`);
    assert.equal(
      own.filter((d) => d.category === 'production-referenced').length,
      0,
      `${file} is excluded as gate machinery but has production-referenced exports; it is not test-support code`,
    );
  }
});

test('spliced-only is a category, not debt', () => {
  const by = fnsByCategory(REPO_ROOT);
  assert.ok(by['spliced-only'].length > 0, 'the splice into _shared.js is real and must be visible');
  for (const d of by['spliced-only']) {
    assert.ok(
      DEFAULT_SPLICES['supabase/functions/mcp/_shared.js'].includes(d.file),
      `${d.file} was called spliced-only but is not a declared splice source`,
    );
  }
});

test('a name appearing ONLY in a splice target is spliced-only, never production', () => {
  const c = classifyExports(REPO_ROOT);
  const canConfirm = c.find((d) => d.file === 'src/dispatch.mjs' && d.name === 'canConfirm');
  assert.ok(canConfirm, 'canConfirm must be classified');
  assert.notEqual(
    canConfirm.category,
    'production-referenced',
    '_shared.js defines its OWN canConfirm; a copy is not a caller',
  );
});

/* ---------------------------------------------------- THE TWO WAYS TO BE WRONG */

async function repo(t, files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dead-exports-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, body, 'utf8');
  }
  return dir;
}

test('a LONGER identifier does not satisfy a shorter one', async (t) => {
  /*
   * THE EXACT BUG THIS SESSION MADE. A hand grep for "resolveWork" reported 13
   * callers; every one was "resolveWorker". The measurement said wired and the
   * truth was dead.
   */
  const dir = await repo(t, {
    'src/a.mjs': 'export function resolveWork() { return 1; }\n',
    'src/b.mjs': 'export function resolveWorker() { return 2; }\n',
    'bin/cli.mjs': "import { resolveWorker } from '../src/b.mjs';\nresolveWorker();\n",
  });
  const dead = deadExports(dir).map((d) => d.name);
  assert.ok(dead.includes('resolveWork'), 'resolveWork has no caller and must be reported');
  assert.ok(!dead.includes('resolveWorker'), 'resolveWorker IS called and must not be');
});

test('a mention in a COMMENT is not a caller', async (t) => {
  /*
   * This repository is densely commented by policy, so every export is named in
   * prose somewhere. A structural gate here once failed against correct code by
   * matching its own explanatory comment; this is the same trap pointed the
   * other way, where prose would hide a dead function.
   */
  const dir = await repo(t, {
    'src/a.mjs': 'export function neverCalled() { return 1; }\n',
    'bin/cli.mjs': '// neverCalled is described here but not used\n/* neverCalled again */\nconst s = "neverCalled";\nexport { s };\n',
  });
  assert.ok(
    deadExports(dir).some((d) => d.name === 'neverCalled'),
    'a comment and a string literal must not count as a call site',
  );
});

test('a real import IS a caller', async (t) => {
  const dir = await repo(t, {
    'src/a.mjs': 'export function used() { return 1; }\n',
    'bin/cli.mjs': "import { used } from '../src/a.mjs';\nused();\n",
  });
  assert.deepEqual(deadExports(dir), [], 'a genuine import and call must clear the finding');
});

test('a TEST-only caller does not count as production', async (t) => {
  const dir = await repo(t, {
    'src/a.mjs': 'export function onlyTested() { return 1; }\n',
    'test/a.test.mjs': "import { onlyTested } from '../src/a.mjs';\nonlyTested();\n",
  });
  assert.ok(
    deadExports(dir).some((d) => d.name === 'onlyTested'),
    'tests import the module, so from inside, test-only and wired look identical',
  );
});

test('stripNonCode removes comments and string bodies, not code', () => {
  const out = stripNonCode('const a = 1; // foo\n/* bar */ const b = "baz"; const c = `qux`;');
  assert.match(out, /const a = 1;/);
  assert.match(out, /const b =/);
  assert.ok(!out.includes('foo'));
  assert.ok(!out.includes('bar'));
  assert.ok(!out.includes('baz'));
  assert.ok(!out.includes('qux'));
});
