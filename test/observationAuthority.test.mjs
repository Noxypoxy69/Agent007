import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments, parseImports } from '../src/moduleGraph.mjs';
import { assertObserved, REQUIRED_BLOCKERS } from '../src/verificationProof.mjs';

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
  const VERDICT_FIELDS = ['promotable', 'promotionBlockers', 'blockerPolicyComplete', 'assertObserved'];
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

test('exit 0 is unreachable: promotable cannot be true for any observation', () => {
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
  assert.equal(r.ok, true, 'control: this is an otherwise clean observation');
  assert.equal(r.promotable, false);
  assert.equal(r.promotionBlockers.length, REQUIRED_BLOCKERS.length);
});

test('the observation module registers NO verifier adapters yet', () => {
  /*
   * The load-bearing fact behind the test above. An adapter appearing here must
   * perform a real cryptographic, policy or attestation check -- if one is added
   * without that, this gate is the last thing standing between a claim and a
   * promotion, so it fails loudly rather than adapting.
   */
  const src = stripComments(readFileSync(path.join(REPO, OBSERVATION_MODULE), 'utf8'));
  const block = src.slice(src.indexOf('VERIFIER_ADAPTERS'), src.indexOf('VERIFIER_ADAPTERS') + 400);
  assert.ok(block.length > 50, 'the adapter registry must be found');
  assert.ok(
    !/:\s*\(/.test(block) && !/:\s*function/.test(block),
    'a verifier adapter was registered; this gate must be updated deliberately, with the real check reviewed',
  );
});
