import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments, parseImports } from '../src/moduleGraph.mjs';
import { assertObserved, STANDING_BLOCKERS } from '../src/verificationProof.mjs';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * THE AUTHORITY BOUNDARY, ENFORCED RATHER THAN RE-ASSERTED EACH REVIEW.
 *
 * Two reviews have now turned on the same question and I answered it twice by
 * running a grep and reporting the result. A grep is a claim about today. The
 * second review found the false green anyway -- not in a consumer, but in the
 * observation module itself, whose blockers were cleared by caller-supplied
 * strings. The lesson is the same either way: "no consumer treats this as
 * authority" must be a gate, not a sentence in a bundle.
 *
 * WHAT THIS PROVES: no path in the repository can read an observation and act on
 * it, and exit 0 is unreachable. WHAT IT DOES NOT: that the module's own
 * verdicts are correct. That is the other tests' job.
 */

const PROD_DIRS = ['src', 'bin', 'bridge', 'mcp'];
const OBSERVATION_MODULE = 'src/verificationProof.mjs';
/** The ONLY file permitted to import the observation module. */
const PERMITTED_IMPORTERS = ['bin/agentbridge.mjs'];

async function sourceFiles() {
  const { readdir, stat } = await import('node:fs/promises');
  const out = [];
  const visit = async (d) => {
    let entries = [];
    try { entries = await readdir(d); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e);
      const st = await stat(p).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) await visit(p);
      else if (/\.(mjs|js|ts)$/.test(p)) out.push(p);
    }
  };
  for (const d of PROD_DIRS) await visit(path.join(REPO, d));
  return out;
}

const rel = (p) => path.relative(REPO, p).split(path.sep).join('/');

test('only the CLI imports the observation module', async () => {
  const files = await sourceFiles();
  assert.ok(files.length > 20, 'the walk must actually find the tree');
  const importers = [];
  for (const f of files) {
    const r = rel(f);
    if (r === OBSERVATION_MODULE) continue;
    const { specifiers, dynamic } = parseImports(readFileSync(f, 'utf8'));
    const all = [...specifiers, ...dynamic];
    if (all.some((sp) => typeof sp === 'string' && sp.includes('verificationProof'))) importers.push(r);
  }
  assert.deepEqual(
    importers.sort(), [...PERMITTED_IMPORTERS].sort(),
    'a production module importing the observation module is a promotion authority in waiting',
  );
});

test('no production module reads a verdict field outside the CLI command block', async () => {
  /*
   * Names, not imports, because a consumer could receive a verdict object it did
   * not import the module to build. Comments are stripped; string literals are
   * kept, since a field name inside a string is exactly how a JSON consumer
   * would read one.
   */
  /*
   * DISTINCTIVE NAMES ONLY. `authorization` was in this list for one run and
   * fired on six modules -- it is an HTTP header name and appears legitimately
   * all over the tree. A gate that reddens on `Authorization:` is a gate someone
   * deletes, so the field is dropped rather than exempted module by module.
   */
  const VERDICT_FIELDS = [
    'assertObserved', 'inspectObservationRecord', 'blockersAtObservation',
    // `promotable` no longer exists anywhere; naming it means a consumer
    // reintroducing the vocabulary is caught rather than quietly accommodated.
    'promotable', 'promotionBlockers',
  ];
  const files = await sourceFiles();
  const offenders = [];
  for (const f of files) {
    const r = rel(f);
    if (r === OBSERVATION_MODULE || PERMITTED_IMPORTERS.includes(r)) continue;
    const text = stripComments(readFileSync(f, 'utf8'));
    for (const field of VERDICT_FIELDS) {
      if (new RegExp(`(^|[^A-Za-z0-9_$])${field}([^A-Za-z0-9_$]|$)`).test(text)) {
        offenders.push(`${r} reads ${field}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'no merge, accept, integration or completion path may read a verdict');
});

test('no workflow invokes the observation command', () => {
  const wf = path.join(REPO, '.github', 'workflows');
  /*
   * A NEGATIVE NEEDS THE POSITIVE FIRST, and this caught itself: the first
   * version called require() inside an ES module, so the read threw, names was
   * [] and "no workflow matches" would have passed against nothing at all.
   */
  const names = readdirSync(wf).filter((n) => /\.ya?ml$/.test(n));
  assert.ok(names.length > 0, 'there is at least one workflow, so an empty read means the check is broken');
  for (const n of names) {
    const text = readFileSync(path.join(wf, n), 'utf8');
    assert.ok(!/observe-sha|verify-sha/.test(text), `${n} invokes the observation command`);
  }
});

test('a clean observation still answers authorization: none', () => {
  /*
   * The CLI maps promotable -> exit 0. This asserts the ONLY thing that could
   * produce it. Not a sample: a blocker with no verifier adapter can never be
   * cleared, so a standing blocker on a fully clean run is the whole proof.
   */
  const clean = {
    sha: 'a'.repeat(40), repoId: 'r', checkoutHead: 'a'.repeat(40), headAfter: 'a'.repeat(40),
    sourceClean: true, treeCleanAfter: true, depsInstalled: true,
    suiteExitCode: 0, terminationSignal: null, timedOut: false,
    tests: 10, pass: 10, fail: 0, skip: 0, cancelled: 0, todo: 0, suiteCommand: 'npm test',
  };
  const r = assertObserved(clean);
  assert.deepEqual(r.refusals, [], 'control: this is an otherwise clean observation');
  assert.equal(r.authorization, 'none');
  assert.ok(!('promotable' in r), 'the promotion vocabulary must not come back');
  assert.equal(r.blockers.length, STANDING_BLOCKERS.length);
});

test('the CLI has no code path that can exit 0', async () => {
  /*
   * The previous mapping was `!ok ? 1 : (promotable ? 0 : 3)`. It never returned
   * 0 -- and kept a branch that WOULD the moment something became promotable. A
   * dormant false-green is still a false-green, so the conditional is gone and
   * this asserts it stays gone.
   */
  const { readFile } = await import('node:fs/promises');
  const cli = stripComments(await readFile(path.join(REPO, 'bin', 'agentbridge.mjs'), 'utf8'));
  const block = cli.slice(cli.indexOf("cmd === 'observe-sha'"));
  const end = block.indexOf("cmd === 'check-first'");
  const body = end > 0 ? block.slice(0, end) : block;
  assert.ok(body.length > 500, 'the observe-sha block must be found');

  const assignments = [...body.matchAll(/exitCode\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.equal(assignments.length, 1, `expected one exitCode assignment, got ${assignments.length}`);

  /*
   * THE RESULTS, NOT EVERY DIGIT. A first version rejected any `0` in the
   * expression and reddened on `refusals.length > 0 ? 1 : 3` -- where the zero
   * is a comparison, not an outcome. What matters is the values the expression
   * can YIELD.
   */
  const expr = assignments[0];
  const results = [...expr.matchAll(/[?:]\s*(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(results.length >= 2, `could not read the outcomes from: ${expr}`);
  assert.ok(!results.includes(0), `an exit-0 outcome exists in: ${expr}`);

  // And the whole block must never call done(0) directly either.
  assert.ok(!/done\(\s*0\s*\)/.test(body), 'the block calls done(0) somewhere');
});

test('no production module has an unresolved dynamic import', async () => {
  /*
   * The authority audit reads static imports. `import(someVariable)` cannot be
   * resolved, so a consumer could reach the observation module through one and
   * the audit would see nothing. Measured at zero today, so this is absolute
   * rather than a baseline: the first one to appear must be looked at.
   */
  const files = await sourceFiles();
  const unresolved = [];
  for (const f of files) {
    const { dynamic } = parseImports(readFileSync(f, 'utf8'));
    if (dynamic.length) unresolved.push(`${rel(f)} -> import(${dynamic.join(', ')})`);
  }
  assert.deepEqual(unresolved, [], 'an unresolved dynamic import can hide a consumer from this audit');
});
