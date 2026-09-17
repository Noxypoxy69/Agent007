import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { artifactLoads } from '../src/artifactLoads.mjs';

/**
 * A DIGEST CANNOT TELL YOU THE ARTIFACT LOADS.
 *
 * The deploy gate proves the bytes are what we think and that they arrived.
 * Neither says the module STARTS, and that failure sits between those two steps
 * with every step around it green: the digest is valid, the read-back matches,
 * the log is clean, and every route answers 500.
 *
 * It has happened here. f04426d -- "I took the Bridge down with a duplicate
 * const, and no check I had could see it". And the check that existed before
 * this one skipped .ts entirely, so index.ts -- the entrypoint, and the file
 * that went down -- was the one file never examined.
 *
 * EVERY FIXTURE IS A REAL DIRECTORY. No mocked filesystem: the thing under test
 * is "what is actually sitting in the artifact directory", and a fake tree can
 * express a shape a real deploy never produces. That is the fixture defect
 * code-d found in the lease proofs, and it is easy to repeat here.
 */

/** A throwaway artifact tree. Files are written exactly as given. */
async function artifact(t, files) {
  const root = await mkdtemp(path.join(tmpdir(), 'ab-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, 'supabase/functions/mcp', rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body, 'utf8');
  }
  return root;
}

const GOOD = 'export const a = 1;\nexport function f() { return a; }\n';

/* ── it passes what should pass ───────────────────────────────────────── */

test('a clean artifact loads', async (t) => {
  const root = await artifact(t, { 'index.ts': GOOD, '_shared.js': GOOD });
  const r = artifactLoads(root, 'supabase/functions/mcp');
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  assert.equal(r.checked, 2);
  assert.deepEqual(r.findings, []);
});

test('POSITIVE CONTROL: legitimate shadowing is not a duplicate', async (t) => {
  /*
   * Load-bearing. A check that flagged an inner binding sharing a name with an
   * outer one would fire on ordinary code, and a gate that fires on ordinary
   * code gets switched off before it ever sees a real duplicate.
   */
  const root = await artifact(t, {
    'index.ts': 'const b = 1;\nfunction f() { const b = 2; return b; }\nexport { f, b };\n',
  });
  assert.equal(artifactLoads(root, 'supabase/functions/mcp').ok, true);
});

/* ── it catches what took the Bridge down ─────────────────────────────── */

test('THE REAL OUTAGE: a duplicate top-level const is caught, and named', async (t) => {
  const root = await artifact(t, {
    'index.ts': 'const UUID = /x/;\nconst other = 2;\nconst UUID = /y/;\n',
  });
  const r = artifactLoads(root, 'supabase/functions/mcp');
  assert.equal(r.ok, false);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].kind, 'duplicate-declaration');
  assert.match(r.findings[0].file, /index\.ts$/);
  assert.match(r.findings[0].detail, /already been declared/i);
});

test('A .ts FILE IS CHECKED — the bug in the version this replaces', async (t) => {
  /*
   * The previous implementation matched /\.(js|mjs)$/ and so never looked at
   * index.ts. The entrypoint, and the exact file that went down, was the one it
   * could not see. This asserts the extension explicitly rather than trusting
   * that a general walk happens to include it.
   */
  const root = await artifact(t, { 'index.ts': 'const A = 1;\nconst A = 2;\n' });
  const r = artifactLoads(root, 'supabase/functions/mcp');
  assert.equal(r.ok, false, '.ts was not parsed');
  assert.equal(r.checked, 1);
});

test('a plain syntax error is a parse-failure, not a duplicate', async (t) => {
  // Unterminated: refused by the as-is parser whatever the extension, so this
  // blocks rather than merely warning.
  const root = await artifact(t, { '_shared.js': 'function f() { return 1;\n' });
  const r = artifactLoads(root, 'supabase/functions/mcp');
  assert.equal(r.ok, false);
  assert.equal(r.findings[0].kind, 'parse-failure');
});

/*
 * THE FIXTURES PROVED THE CHECK WORKED ON FILES THAT WERE NOT TYPESCRIPT.
 *
 * Everything above this line passed while the module was blind to the outage it
 * is named after, and these three tests are why that was invisible.
 *
 * MEASURED, on node v24.18.1:
 *
 *   'const A = 1; const A = 2;'            as .ts  -> exit 1   CAUGHT
 *   the same duplicate appended to the REAL index.ts -> exit 0   MISSED
 *
 * Both are .ts. The difference is that the real file CONTAINS TypeScript, so
 * node takes its permissive type-stripping path; a two-line fixture with no
 * type syntax gets the strict parser and fails as expected. Every fixture here
 * was of the second kind, so `node --check` looked like it caught duplicates in
 * TypeScript. It does not.
 *
 * The fix strips the types first and parses the JavaScript that comes out,
 * which is a strict parse of THIS file rather than of a file that happens to
 * share its extension. These tests use fixtures with real type annotations so
 * they exercise the path the artifact actually takes.
 */

test('THE FIXTURE DEFECT: the REAL entrypoint, with the REAL outage shape', async (t) => {
  /*
   * The fixture is the artifact itself, because that is where the gap lives and
   * no synthetic file reproduced it. A duplicate in a small typed fixture IS
   * caught by node --check; the same duplicate appended to this file is not.
   */
  const { readFileSync } = await import('node:fs');
  const real = readFileSync(
    fileURLToPath(new URL('../supabase/functions/mcp/index.ts', import.meta.url)),
    'utf8',
  );
  const root = await artifact(t, { 'index.ts': `${real}\nconst UUID = /x/;\nconst UUID = /y/;\n` });

  const r = artifactLoads(root, 'supabase/functions/mcp');
  assert.equal(r.ok, false, 'a duplicate const in the real entrypoint was not caught');
  const dup = r.findings.find((f) => f.kind === 'duplicate-declaration');
  assert.ok(dup, `no duplicate-declaration finding: ${JSON.stringify(r.findings.map((f) => f.kind))}`);
});

test('CONTROL: node --check ALONE misses it, which is what makes stripping load-bearing', async (t) => {
  /*
   * MEASURED, node v24.18.1. This is the assertion that justifies the whole
   * stripping pass, so it is checked rather than described -- and if node ever
   * fixes its permissive path this goes red and tells whoever is here that the
   * extra work can be dropped.
   *
   * Worse than the duplicate: an outright SYNTAX ERROR appended to this file
   * also exits 0. `node --check` on this artifact was not weak, it was vacuous,
   * and the gate printed "parses yes" on the strength of it for as long as the
   * check has existed.
   */
  const { readFileSync, writeFileSync, rmSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');

  const real = readFileSync(
    fileURLToPath(new URL('../supabase/functions/mcp/index.ts', import.meta.url)),
    'utf8',
  );
  const dup = path.join(tmpdir(), `ab-control-dup-${process.pid}.ts`);
  const broken = path.join(tmpdir(), `ab-control-syn-${process.pid}.ts`);
  t.after(() => { rmSync(dup, { force: true }); rmSync(broken, { force: true }); });

  writeFileSync(dup, `${real}\nconst UUID = /x/;\nconst UUID = /y/;\n`);
  writeFileSync(broken, `${real}\nexport function stillBroken( {\n`);

  assert.equal(
    spawnSync(process.execPath, ['--check', dup], { encoding: 'utf8' }).status, 0,
    'node --check now catches a duplicate here by itself; the stripping pass can be simplified',
  );
  assert.equal(
    spawnSync(process.execPath, ['--check', broken], { encoding: 'utf8' }).status, 0,
    'node --check now catches a syntax error here by itself; update this header',
  );
});

test('a malformed .ts is REFUSED now, not merely noted', async (t) => {
  /*
   * This is the assertion that flipped. It used to require ok:true and a
   * `weak-parse-coverage` note, on the reasoning that a strict-parse failure
   * might only be TypeScript syntax the .mjs parser cannot read. After
   * stripping, it cannot be: the types are gone, so a failure is a real one and
   * an advisory would be an outage nobody was warned about.
   */
  const root = await artifact(t, { 'index.ts': 'export function f( {\n' });
  const r = artifactLoads(root, 'supabase/functions/mcp');
  assert.equal(r.ok, false, 'a file that cannot parse was allowed to deploy');
  assert.ok(
    r.findings.some((f) => f.kind === 'parse-failure' || f.kind === 'duplicate-declaration'),
    `expected a blocking finding, got ${JSON.stringify(r.findings)}`,
  );
});

test('a .ts that IS strictly parseable gets no weak-coverage note', async (t) => {
  /*
   * The positive half. Without it the note would fire on every .ts file and
   * become noise nobody reads -- which is how an advisory finding trains people
   * to skim past the blocking ones beside it.
   */
  const root = await artifact(t, { 'index.ts': GOOD });
  const r = artifactLoads(root, 'supabase/functions/mcp');
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, []);
});

test('nested files are reached', async (t) => {
  const root = await artifact(t, { 'index.ts': GOOD, 'lib/deep/thing.js': 'const A=1;const A=2;\n' });
  const r = artifactLoads(root, 'supabase/functions/mcp');
  assert.equal(r.ok, false);
  assert.match(r.findings[0].file, /lib\/deep\/thing\.js$/);
});

/* ── the negative needs a positive ────────────────────────────────────── */

test('AN EMPTY ARTIFACT REFUSES rather than reporting a clean check of nothing', async (t) => {
  /*
   * Every other assertion here is a negative and a negative is satisfied by an
   * empty list. A wrong path would otherwise return ok:true with zero findings
   * and deploy while sounding fine -- a non-match is not evidence the search ran.
   */
  const root = await artifact(t, { 'index.ts': GOOD });
  const r = artifactLoads(root, 'supabase/functions/does-not-exist');
  assert.equal(r.ok, false);
  assert.equal(r.findings[0].kind, 'artifact-empty');
  assert.equal(r.checked, 0);
});

/* ── shadow copies: reported, never refused ───────────────────────────── */

test('a shadow copy is REPORTED and does not refuse', async (t) => {
  /*
   * An unreferenced file cannot break the boot, so refusing on one is a red gate
   * for a non-hazard -- and the failure mode of a noisy gate is that somebody
   * switches it off, leaving it absent for the case that IS a hazard.
   */
  const root = await artifact(t, { 'index.ts': GOOD, 'index.ts.bak': 'const A=1;const A=2;\n' });
  const r = artifactLoads(root, 'supabase/functions/mcp');
  assert.equal(r.ok, true, 'a shadow copy must not refuse the deploy');
  const shadow = r.findings.filter((f) => f.kind === 'shadow-copy');
  assert.equal(shadow.length, 1);
  assert.match(shadow[0].file, /index\.ts\.bak$/);
});

test('a backup that shadows NOTHING is not reported', async (t) => {
  /*
   * The line that makes this mechanical rather than a heuristic: the finding is
   * a relation between two real files. `notes.bak` beside no `notes` is just a
   * file. A rule that guessed from the suffix alone would be occasionally wrong,
   * which is how a gate earns a reputation.
   */
  const root = await artifact(t, { 'index.ts': GOOD, 'notes.bak': 'whatever\n' });
  const r = artifactLoads(root, 'supabase/functions/mcp');
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, []);
});

test('a shadow copy alongside a REAL failure still refuses, on the real one', async (t) => {
  const root = await artifact(t, {
    'index.ts': 'const A=1;const A=2;\n',
    'index.ts.bak': 'anything\n',
  });
  const r = artifactLoads(root, 'supabase/functions/mcp');
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.findings.map((f) => f.kind).sort(),
    ['duplicate-declaration', 'shadow-copy'],
  );
});

/* ── the parser is the authority, and it is injectable ────────────────── */

test('the caller can inject a parser, and a refusal from it is honoured', async (t) => {
  const root = await artifact(t, { 'index.ts': GOOD });
  const r = artifactLoads(root, 'supabase/functions/mcp', {
    parse: () => ({ status: 1, stderr: 'SyntaxError: invented by the test' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.findings[0].kind, 'parse-failure');
});
