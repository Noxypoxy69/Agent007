import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { linesMissingFrom, sharedImports, moduleExports } from '../scripts/check-edge-deploy.mjs';

/**
 * THE DEPLOY GATE, WATCHED FAILING.
 *
 * scripts/check-edge-deploy.mjs compares what is about to ship against what is
 * already serving traffic. CLAUDE.md puts a check script at the top of the
 * durability list, above this file, above a comment, above a commit message --
 * which is exactly why it is the one that must not be hollow.
 *
 * Every case below is a real deploy accident: a reverted line, a modified one,
 * a file dropped from the bundle, an entrypoint paired with the wrong shared
 * file, and the two ways the gate could pass while proving nothing -- comparing
 * nothing at all, and calling a line-ending change a rewrite.
 */

const SCRIPT = fileURLToPath(new URL('../scripts/check-edge-deploy.mjs', import.meta.url));

/** Run the real script as a real process, so the exit code is the shipped one. */
const run = (a, b) => new Promise((resolve) => {
  execFile(process.execPath, [SCRIPT, a, b], (error, stdout, stderr) => {
    resolve({ code: error?.code ?? 0, stdout, stderr });
  });
});

async function dirs(t, deployed, incoming) {
  const root = await mkdtemp(path.join(tmpdir(), 'edgecheck-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, files] of [['deployed', deployed], ['incoming', incoming]]) {
    await mkdir(path.join(root, name), { recursive: true });
    for (const [f, body] of Object.entries(files)) await writeFile(path.join(root, name, f), body);
  }
  return [path.join(root, 'deployed'), path.join(root, 'incoming')];
}

const ENTRY = "import { alpha } from './_shared.js';\nalpha();\n";
const SHARED = 'export function alpha() { return 1; }\n';

test('A PURELY ADDITIVE DEPLOY PASSES, and that is the positive the rest need', async (t) => {
  const [a, b] = await dirs(t,
    { 'index.ts': ENTRY, '_shared.js': SHARED },
    { 'index.ts': `${ENTRY}// a new route\n`, '_shared.js': SHARED });
  const r = await run(a, b);
  assert.equal(r.code, 0, `refused a safe deploy: ${r.stderr}`);
  assert.match(r.stdout, /index\.ts: \+1 -0/);
});

test('A DEPLOY THAT REMOVES A LIVE LINE IS REFUSED', async (t) => {
  const [a, b] = await dirs(t,
    { 'index.ts': `${ENTRY}const theFix = true;\n`, '_shared.js': SHARED },
    { 'index.ts': ENTRY, '_shared.js': SHARED });
  const r = await run(a, b);
  assert.equal(r.code, 1, 'a deploy that reverts a line was allowed');
  assert.match(r.stderr, /REMOVES 1 line/);
  assert.match(r.stderr, /theFix/, 'the refusal does not name the line it is protecting');
});

test('A MODIFIED LINE IS A REMOVAL, which is the stronger claim', async (t) => {
  // A changed line is a removal plus an addition. Catching it here is what lets
  // "zero removals" mean "nothing was altered" rather than merely "nothing was deleted".
  const [a, b] = await dirs(t,
    { 'index.ts': 'const timeout = 900;\n', '_shared.js': SHARED },
    { 'index.ts': 'const timeout = 30;\n', '_shared.js': SHARED });
  const r = await run(a, b);
  assert.equal(r.code, 1, 'a silently modified line passed as an addition');
  assert.match(r.stderr, /timeout = 900/);
});

test('A FILE DROPPED FROM THE BUNDLE IS REFUSED', async (t) => {
  const [a, b] = await dirs(t,
    { 'index.ts': ENTRY, '_shared.js': SHARED },
    { 'index.ts': ENTRY });
  const r = await run(a, b);
  assert.equal(r.code, 1, 'shipping a bundle with a file missing was allowed');
  assert.match(r.stderr, /_shared\.js: deployed but missing/);
});

test('A LINE-ENDING CHANGE IS NOT A REWRITE', async (t) => {
  /*
   * THE TRAP THIS WAS WRITTEN AFTER. The deployed bundle came back CRLF and the
   * repo is LF, so an unnormalised comparison reported all 1813 lines changed.
   * Without this, the gate refuses every real deploy and gets switched off.
   */
  /*
   * THE FIXTURE IS A REAL BUNDLE, and the first version of this test was not:
   * it used two bare assignments with no import, and the script refused it for
   * the RIGHT reason -- an entrypoint that imports nothing from _shared.js is a
   * failed parse. The line-ending comparison was fine all along. A fixture that
   * is not a shape the system produces cannot test what it claims to.
   */
  const crlf = (s) => s.replace(/\n/g, '\r\n');
  const [a, b] = await dirs(t,
    { 'index.ts': crlf(ENTRY), '_shared.js': crlf(SHARED) },
    { 'index.ts': ENTRY, '_shared.js': SHARED });
  const r = await run(a, b);
  assert.equal(r.code, 0, `a CRLF-to-LF change was reported as a rewrite: ${r.stderr}`);
  assert.match(r.stdout, /index\.ts: \+0 -0/);
  assert.match(r.stdout, /_shared\.js: \+0 -0/);
});

test('AN ENTRYPOINT PAIRED WITH THE WRONG SHARED FILE IS REFUSED', async (t) => {
  // A runtime failure on the first request, not a build error, so nothing else
  // catches it before production does.
  const [a, b] = await dirs(t,
    { 'index.ts': ENTRY, '_shared.js': SHARED },
    { 'index.ts': "import { alpha, beta } from './_shared.js';\nalpha();beta();\n", '_shared.js': SHARED });
  const r = await run(a, b);
  assert.equal(r.code, 1, 'an entrypoint needing an export the shared file lacks was allowed');
  assert.match(r.stderr, /does not export: beta/);
});

test('COMPARING NOTHING IS REFUSED, NOT PASSED', async (t) => {
  /*
   * THE HOLLOW-GATE CASE, and the only one that makes the others trustworthy.
   * Point the script at two empty directories -- a wrong path, a renamed folder
   * -- and every check above is vacuously satisfied. A gate that is green
   * because it read nothing is worse than no gate.
   */
  const [a, b] = await dirs(t, {}, {});
  const r = await run(a, b);
  assert.equal(r.code, 1, 'the gate passed having compared no files at all');
  assert.match(r.stderr, /no file was compared/);
});

test('IT NAMES verify_jwt EVERY TIME, because it cannot check it', async (t) => {
  const [a, b] = await dirs(t, { 'index.ts': ENTRY, '_shared.js': SHARED }, { 'index.ts': ENTRY, '_shared.js': SHARED });
  const r = await run(a, b);
  assert.match(r.stdout, /verify_jwt/);
  assert.match(r.stdout, /--no-verify-jwt/);
});

test('missing arguments exit 2, which is not 1 and not 0', async () => {
  // A non-zero exit is not evidence of a refusal; it is evidence of unhappiness.
  // Usage and refusal are different outcomes and the codes say which.
  const r = await new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT], (error, stdout, stderr) =>
      resolve({ code: error?.code ?? 0, stderr }));
  });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage/);
});

/* ── the parsing helpers, at the edges that bit ──────────────────────── */

test('a commented-out import name is not counted as an import', async () => {
  const src = `import {\n  alpha,\n  // beta, one day\n  gamma,\n} from './_shared.js';\n`;
  assert.deepEqual([...sharedImports(src)].sort(), ['alpha', 'gamma']);
});

test('an aliased import is counted under the name the shared file exports', async () => {
  assert.deepEqual([...sharedImports("import { alpha as a } from './_shared.js';")], ['alpha']);
});

test('an import from somewhere else is not counted', async () => {
  assert.deepEqual([...sharedImports("import { alpha } from './other.js';")], []);
});

test('moduleExports sees declarations and export lists alike', async () => {
  const src = 'export function a(){}\nexport const b = 1;\nconst c = 2;\nexport { c as d };\n';
  assert.deepEqual([...moduleExports(src)].sort(), ['a', 'b', 'd']);
});

test('linesMissingFrom counts multiplicity, so two copies losing one is a removal', async () => {
  assert.deepEqual(linesMissingFrom('x\nx\n', 'x\n'), ['x']);
  assert.deepEqual(linesMissingFrom('x\n', 'x\nx\n'), []);
});

test('A DEPLOY THAT CHANGES NOTHING SAYS SO', async (t) => {
  /*
   * WATCHED HAPPEN, 2026-09-16: version 22 to version 23, byte-identical
   * bundles, a clean success, and not one line shipped -- the deploy ran from a
   * checkout that did not contain the branch. From outside it is
   * indistinguishable from a deploy that worked, and the person who ran it
   * reasonably believed it had.
   *
   * Not a refusal. Redeploying identical bytes is legitimate -- forcing a
   * restart, recovering a failed rollout -- and a gate that blocked it would be
   * wrong and would get switched off. It has to be LOUD and it has to be
   * allowed.
   */
  const files = { 'index.ts': ENTRY, '_shared.js': SHARED };
  const [a, b] = await dirs(t, files, files);
  const r = await run(a, b);
  assert.equal(r.code, 0, 'a no-op redeploy was refused; it is legitimate');
  assert.match(r.stdout, /NOTHING WOULD CHANGE/);
  assert.match(r.stdout, /wrong tree/);
});

test('and a real change does NOT claim nothing would change', async (t) => {
  // The negative the notice needs. A banner that printed unconditionally would
  // pass the test above while telling every deploy it shipped nothing.
  const [a, b] = await dirs(t,
    { 'index.ts': ENTRY, '_shared.js': SHARED },
    { 'index.ts': `${ENTRY}// a new route\n`, '_shared.js': SHARED });
  const r = await run(a, b);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.stdout, /NOTHING WOULD CHANGE/,
    'a deploy carrying 1 added line was reported as changing nothing');
});
