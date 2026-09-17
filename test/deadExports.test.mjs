import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deadExports, stripNonCode } from '../src/moduleGraph.mjs';

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

const IS_CONSTANT = /^[A-Z][A-Z0-9_]*$/;

/** Functions and values, excluding exported frozen constants. */
function deadFunctions(root) {
  return deadExports(root).filter((d) => !IS_CONSTANT.test(d.name));
}

const BASELINE_DEAD_FUNCTIONS = 158;

test('the dead-export ratchet does not increase', () => {
  const dead = deadFunctions(REPO_ROOT);
  assert.ok(
    dead.length <= BASELINE_DEAD_FUNCTIONS,
    `dead exported functions rose to ${dead.length} from a baseline of ${BASELINE_DEAD_FUNCTIONS}.\n` +
      'A new export with no production caller is contract item 1 unmet. Wire it or do not export it.\n' +
      dead.slice(0, 12).map((d) => `  ${d.file} -> ${d.name}`).join('\n'),
  );
});

test('the baseline is honest: it matches what is actually there', () => {
  // A baseline set above the real count is a gate that permits a regression
  // silently. If this fails LOW, lower the constant -- that is the ratchet working.
  const dead = deadFunctions(REPO_ROOT);
  assert.equal(
    dead.length,
    BASELINE_DEAD_FUNCTIONS,
    `baseline drift: measured ${dead.length}. If lower, lower BASELINE_DEAD_FUNCTIONS to match.`,
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
