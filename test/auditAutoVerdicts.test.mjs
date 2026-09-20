/**
 * THE VERDICT MACHINE HAD NO TESTS.
 *
 * scripts/audit-auto.mjs decides whether a commit's tests are load-bearing,
 * and it is the cheap rule-20 pass this repository runs first and every time.
 * A blind audit pointed out that it has changed verdict logic repeatedly --
 * HOLLOW/LOOSE, COLLAPSED/UNKNOWN, the load-time GATE -- with no test file
 * anywhere in the tree, and that its commit messages carry "MEASURED" rows
 * whose fixtures were never committed and cannot be re-run by a reader.
 *
 * Run through its own tool, the commit that last changed it scored
 * `SKIP no test files touched`. So the thing that judges everybody else's
 * coverage was the one module exempt from the question.
 *
 * WHAT THESE TESTS DRIVE. The real script, as a subprocess, against real git
 * repositories built here -- because its whole job is cloning a commit,
 * reverting files and re-running a suite, and none of that is reachable by
 * importing a function. Each fixture is a repository where the right answer
 * is known by construction.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseImports, resolveSpecifier } from '../src/moduleGraph.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The base subject, which the tool restores underneath the commit's test. */
const BASE = 'export const ITEMS = ["a", "b", "c"];\nexport const shipped = (n) => n;\n';

/** The shipped script plus everything it imports, in a throwaway repository. */
function probeRepo(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'auto-probe-'));
  const home = mkdtempSync(path.join(tmpdir(), 'auto-home-'));
  t.after(() => {
    for (const d of [root, home]) rmSync(d, { recursive: true, force: true });
  });

  const seen = new Set();
  const queue = ['scripts/audit-auto.mjs'];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    let src;
    try { src = readFileSync(path.join(REPO, rel), 'utf8'); } catch { continue; }
    for (const spec of parseImports(src).specifiers) {
      const target = resolveSpecifier(REPO, rel, spec);
      if (target) queue.push(target.split(path.sep).join('/'));
    }
  }
  for (const f of seen) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    cpSync(path.join(REPO, f), path.join(root, f));
  }
  writeFileSync(path.join(root, 'package.json'), '{"name":"probe","type":"module","version":"1.0.0"}\n');

  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
  git('init', '-q', '.');
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@t');
  git('add', '-A');
  git('commit', '-qm', 'harness');

  /* The parent version of the subject, one commit before the one judged. */
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'test'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'probeSubject.mjs'), BASE);
  git('add', '-A');
  git('commit', '-qm', 'base subject');

  return { root, home, git };
}

/** Commit a subject/test pair; its correct verdict is known by construction. */
function landPair(env, { subject, spec }) {
  writeFileSync(path.join(env.root, 'src', 'probeSubject.mjs'), subject);
  writeFileSync(path.join(env.root, 'test', 'probeSubject.test.mjs'), spec);
  env.git('add', '-A');
  env.git('commit', '-qm', 'the commit under judgement');
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: env.root, encoding: 'utf8' }).trim();
}

function runAuto(env, sha) {
  /*
   * NODE_TEST_CONTEXT MUST NOT REACH THE GRANDCHILD.
   *
   * node --test sets it in every test file's process. audit-auto spawns
   * `node --test` of its own and inherits the environment, so the grandchild
   * decides it is a nested test run and emits the child protocol instead of
   * the human summary. The tool parses the summary, gets no counts, and
   * reports `fail -1` -> `SKIP its own tests are not green at this commit`,
   * for a suite that is perfectly green.
   *
   * That is an accident of running the tool UNDER the runner (rule 21), not
   * something a shell invocation can hit, so it is stripped here rather than
   * worked around in the subject. Verified by hand outside the runner first:
   * the same fixture reports HOLLOW with the variable absent.
   */
  const clean = { ...process.env, AGENTBRIDGE_HOME: env.home };
  for (const k of Object.keys(clean)) {
    if (k.toUpperCase().startsWith('NODE_TEST_')) delete clean[k];
  }

  const r = spawnSync(process.execPath, [path.join(env.root, 'scripts', 'audit-auto.mjs'), sha], {
    cwd: env.root,
    encoding: 'utf8',
    timeout: 300_000,
    env: clean,
  });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

test('A SHRINKING TEST COUNT WITH NOTHING FAILING IS NOT A PROVEN GATE', (t) => {
  /*
   * THE FALSE POSITIVE, and the reason this file exists.
   *
   * The load-time branch fired on "the count dropped" plus "a reverted file
   * is imported by the test", and printed `the test cannot even load without
   * the code` -- with `gates proven: 1` -- without ever reading the fail
   * count.
   *
   * Here the test count is DERIVED from an imported array, which is this
   * repository's commonest generated-test shape. Revert the subject, the
   * array is shorter, fewer tests are generated, and every one of them
   * passes. Nothing failed to load; nothing failed at all. The commit's
   * actual behaviour -- shipped() -- is asserted nowhere, so the honest
   * answer is that the commit is UNPROVEN.
   */
  const env = probeRepo(t);
  const sha = landPair(env, {
    subject: 'export const ITEMS = ["a","b","c","d","e","f","g","h"];\nexport const shipped = (n) => n * 2;\n',
    spec: [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { ITEMS } from "../src/probeSubject.mjs";',
      '/* One test per item, and not one assertion about shipped(). */',
      'for (const item of ITEMS) test(`item ${item}`, () => { assert.ok(item); });',
      '',
    ].join('\n'),
  });

  const out = runAuto(env, sha);

  assert.doesNotMatch(out, /cannot even load/,
    `the tests loaded and passed, so that claim is false on its face.\n${out}`);
  assert.doesNotMatch(out, /gates proven: 1/,
    `a commit whose behaviour is asserted nowhere was certified as covered.\n${out}`);
  assert.match(out, /HOLLOW/,
    `green without the code is hollow, whatever happened to the count.\n${out}`);
});

test('A TEST THAT GENUINELY CANNOT LOAD WITHOUT THE CODE IS STILL A GATE', (t) => {
  /*
   * THE POSITIVE CONTROL, and the reason the branch exists at all (rule 5).
   * Tightening this must not turn a real load-time gate into a HOLLOW: that
   * direction is an outage for anybody whose test imports a symbol the parent
   * does not export, and a tool that cries wolf about working gates is one
   * people stop running.
   */
  const env = probeRepo(t);
  const sha = landPair(env, {
    subject: `${BASE}export const addedLater = () => 'here';\n`,
    spec: [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      '/* The parent exports no such symbol, so this import throws at load. */',
      'import { addedLater } from "../src/probeSubject.mjs";',
      'test("it is there", () => { assert.equal(addedLater(), "here"); });',
      '',
    ].join('\n'),
  });

  const out = runAuto(env, sha);
  assert.match(out, /GATE/, `a test that cannot load without the code is a gate.\n${out}`);
  assert.doesNotMatch(out, /HOLLOW/, out);
});

test('the ordinary two verdicts still work: red without the code is a gate, green is not', (t) => {
  /*
   * The baseline that says the harness itself is sound. Without it, a subject
   * that answered HOLLOW to everything would satisfy the first test here.
   */
  const red = probeRepo(t);
  const redSha = landPair(red, {
    subject: 'export const ITEMS = ["a","b","c"];\nexport const shipped = (n) => n * 2;\n',
    spec: [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { shipped } from "../src/probeSubject.mjs";',
      'test("doubles", () => { assert.equal(shipped(3), 6); });',
      '',
    ].join('\n'),
  });
  const redOut = runAuto(red, redSha);
  assert.match(redOut, /GATE/, `reverting the doubling must turn this red.\n${redOut}`);

  const green = probeRepo(t);
  const greenSha = landPair(green, {
    subject: 'export const ITEMS = ["a","b","c"];\nexport const shipped = (n) => n * 2;\n',
    spec: [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { shipped } from "../src/probeSubject.mjs";',
      '/* Imports it, never exercises what the commit changed. */',
      'test("exists", () => { assert.equal(typeof shipped, "function"); });',
      '',
    ].join('\n'),
  });
  const greenOut = runAuto(green, greenSha);
  assert.match(greenOut, /HOLLOW/, `the change is unasserted, so this is hollow.\n${greenOut}`);
});

test('A RANGE THAT WAS NEVER MEASURED DOES NOT PRINT AN ALL-ZERO SUMMARY', (t) => {
  /*
   * Found by blind audit. Three verdicts -- collapsed, unknown, error --
   * reached no counter at all, so a commit the tool could not measure printed
   *
   *     gates proven: 0  hollow: 0  loose: 0  needs-manual: 0  skipped: 0
   *
   * which is the line a reader scans, and is indistinguishable from a clean
   * range. The summary is the whole point of a summary.
   *
   * It is also the SECOND instance of one class. The previous commit fixed a
   * HOLLOW line printing above `hollow: 0` because the finding used a
   * spelling no counter matched -- and stopped at that instance.
   *
   * THE FIXTURE PRODUCES A GENUINE COLLAPSE, not a simulated one: the test
   * generates its cases from a JSON data file it reads with readFileSync +
   * path.join, which subjectsOf cannot resolve as an import. So reverting
   * the data file shrinks the test count while the reverted set and the
   * test's imports stay disjoint -- exactly the COLLAPSED branch.
   */
  const env = probeRepo(t);

  writeFileSync(path.join(env.root, 'src', 'cases.json'), JSON.stringify(['a', 'b']));
  writeFileSync(path.join(env.root, 'test', 'probeGen.test.mjs'), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { readFileSync } from "node:fs";',
    'import path from "node:path";',
    'import { fileURLToPath } from "node:url";',
    'const here = path.dirname(fileURLToPath(import.meta.url));',
    '/* Read, not imported: subjectsOf cannot see this as a dependency. */',
    'const cases = JSON.parse(readFileSync(path.join(here, "..", "src", "cases.json"), "utf8"));',
    'for (const c of cases) test(`case ${c}`, () => { assert.ok(c); });',
    '',
  ].join('\n'));
  env.git('add', '-A');
  env.git('commit', '-qm', 'base cases');

  writeFileSync(path.join(env.root, 'src', 'cases.json'), JSON.stringify(['a', 'b', 'c', 'd', 'e']));
  /*
   * The commit must touch a TEST file too, or audit-auto SKIPs it as "no test
   * files touched" before the collapse branch is ever reached -- which is
   * what the first version of this fixture did, and the precondition
   * assertion below is what caught it.
   */
  writeFileSync(path.join(env.root, 'test', 'probeGen.test.mjs'),
    `${readFileSync(path.join(env.root, 'test', 'probeGen.test.mjs'), 'utf8')}/* touched */\n`);
  env.git('add', '-A');
  env.git('commit', '-qm', 'fewer cases, still unmeasured');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: env.root, encoding: 'utf8' }).trim();

  const out = runAuto(env, sha);

  /*
   * Precondition asserted, not guarded (rule 6): if the fixture did not
   * actually collapse, this test measures nothing about the counters.
   */
  assert.match(out, /COLLAPSED/,
    `the fixture did not reach the COLLAPSED branch, so this proves nothing.\n${out}`);

  assert.doesNotMatch(out, /gates proven: 0 {2}hollow: 0 {2}loose: 0 {2}needs-manual: 0 {2}inconclusive: 0 {2}skipped: 0/,
    `an unmeasured commit produced an all-zero summary, which reads as a clean range.\n${out}`);
  assert.match(out, /inconclusive: 1/,
    `the collapse must reach a counter.\n${out}`);
  assert.match(out, /NOT MEASURED/,
    `and the reader must be told it is not a pass.\n${out}`);
  assert.doesNotMatch(out, /SUMMARY IS WRONG/,
    `every finding must land in a bucket.\n${out}`);
});

/* ══ the collapse branch's blind spots: a barrel, and a dynamic import ═══
 *
 * BOTH FIXTURES MUST DROP THE TEST COUNT **AND** FAIL SOMETHING, or they
 * never reach the collapse branch at all and prove nothing. The first
 * versions of these two tests did neither: reverting turned one assertion
 * red without changing the count, so they took the ordinary "tests go red"
 * GATE path -- which works regardless of subjectsOf -- and passed against
 * the defect they were written for.
 *
 * So each generates its cases from a value behind the indirection (count
 * drops on revert) AND asserts one behaviour that the revert breaks
 * (after.fail > 0). That combination lands exactly on the branch where
 * "is the reverted file among this test's dependencies" decides the verdict.
 */

/** A subject whose CASES drive the test count and whose answer() is asserted. */
const IMPL_BASE = 'export const CASES = ["a", "b"];\nexport const answer = () => 1;\n';
const IMPL_NEW = 'export const CASES = ["a", "b", "c", "d", "e"];\nexport const answer = () => 2;\n';

const genSpec = (importLine, use) => [
  'import test from "node:test";',
  'import assert from "node:assert/strict";',
  importLine,
  '/* Count comes from CASES, so reverting the subject SHRINKS it. */',
  `for (const c of ${use}.CASES) test(\`case \${c}\`, () => { assert.ok(c); });`,
  '/* And one assertion the revert actually breaks, so after.fail > 0. */',
  `test("answers 2", () => { assert.equal(${use}.answer(), 2); });`,
  '',
].join('\n');

function landIndirect(env, { files, spec, testName }) {
  for (const [rel, body] of Object.entries(files.base)) {
    writeFileSync(path.join(env.root, rel), body);
  }
  writeFileSync(path.join(env.root, 'test', testName), spec);
  env.git('add', '-A');
  env.git('commit', '-qm', 'base');

  for (const [rel, body] of Object.entries(files.next)) {
    writeFileSync(path.join(env.root, rel), body);
  }
  writeFileSync(path.join(env.root, 'test', testName),
    `${readFileSync(path.join(env.root, 'test', testName), 'utf8')}/* touched */\n`);
  env.git('add', '-A');
  env.git('commit', '-qm', 'the behaviour the test pins');
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: env.root, encoding: 'utf8' }).trim();
}

test('A GATE BEHIND A BARREL RE-EXPORT IS A GATE, NOT A COLLAPSE', (t) => {
  /*
   * Found by blind audit. The test imports a barrel, the barrel re-exports
   * the implementation, the commit changes the implementation. subjectsOf
   * resolved only the barrel, so the reverted file and the test's imports
   * looked disjoint and the verdict was COLLAPSED -- the NOT-a-gate verdict
   * -- for a gate that works.
   *
   * It was never a matching failure: `export * from './impl.mjs'` contains
   * `from './impl.mjs'`, so depth one already saw the barrel. The failure was
   * DEPTH, which is why the fix is a closure and not another regex.
   */
  const env = probeRepo(t);
  const sha = landIndirect(env, {
    testName: 'barrel.test.mjs',
    files: {
      base: { 'src/barrelImpl.mjs': IMPL_BASE, 'src/barrel.mjs': "export * from './barrelImpl.mjs';\n" },
      next: { 'src/barrelImpl.mjs': IMPL_NEW },
    },
    spec: genSpec('import * as subject from "../src/barrel.mjs";', 'subject'),
  });

  const out = runAuto(env, sha);
  assert.doesNotMatch(out, /COLLAPSED/,
    `a real gate two hops behind a barrel was reported as not-a-gate.\n${out}`);
  assert.match(out, /GATE/, out);
  assert.match(out, /barrelImpl\.mjs/,
    `the implementation must be named as the dependency that was reverted.\n${out}`);
});

test('A GATE REACHED BY A DYNAMIC import() IS A GATE, NOT A COLLAPSE', (t) => {
  /*
   * The second spelling from the same audit, and a plain matching gap:
   * subjectsOf matched `from '...'` and `new URL('...')` and nothing else, so
   * a subject loaded at run time looked like no subject at all.
   */
  const env = probeRepo(t);
  const sha = landIndirect(env, {
    testName: 'dyn.test.mjs',
    files: { base: { 'src/dyn.mjs': IMPL_BASE }, next: { 'src/dyn.mjs': IMPL_NEW } },
    spec: genSpec('const subject = await import("../src/dyn.mjs");', 'subject'),
  });

  const out = runAuto(env, sha);
  assert.doesNotMatch(out, /COLLAPSED/,
    `a real gate behind a dynamic import was reported as not-a-gate.\n${out}`);
  assert.match(out, /GATE/, out);
  assert.match(out, /dyn\.mjs/, out);
});

test('A MERGE CARRYING A SUBJECT AND ITS TEST IS NOT SKIPPED', (t) => {
  /*
   * The same defect a3f3fa6 fixed in src/auditLedger.mjs, still present
   * here, found by the audit OF that commit. `git show --name-only` prints
   * nothing for a merge, so filesOf returned [], tests and sources were both
   * empty, and this tool -- the project's automatic rule-20 pass -- printed
   *
   *     SKIP   no test files touched (0 source file(s))
   *
   * for a merge that carried a subject AND its test. Fixing one of two call
   * sites and calling the class closed is the mistake this branch keeps
   * making, so this pins the second site.
   */
  const env = probeRepo(t);

  writeFileSync(path.join(env.root, 'src', 'merged.mjs'), 'export const answer = () => 1;\n');
  writeFileSync(path.join(env.root, 'test', 'merged.test.mjs'), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { answer } from "../src/merged.mjs";',
    'test("answers 2", () => { assert.equal(answer(), 2); });',
    '',
  ].join('\n'));
  env.git('add', '-A');
  env.git('commit', '-qm', 'base for the merge');

  const main = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'],
    { cwd: env.root, encoding: 'utf8' }).trim();
  env.git('branch', 'side');

  /* Mainline moves, so the merge is real rather than a fast-forward. */
  writeFileSync(path.join(env.root, 'README.md'), 'moved\n');
  env.git('add', '-A');
  env.git('commit', '-qm', 'mainline');

  env.git('checkout', '-q', 'side');
  writeFileSync(path.join(env.root, 'src', 'merged.mjs'), 'export const answer = () => 2;\n');
  writeFileSync(path.join(env.root, 'test', 'merged.test.mjs'),
    `${readFileSync(path.join(env.root, 'test', 'merged.test.mjs'), 'utf8')}/* touched */\n`);
  env.git('add', '-A');
  env.git('commit', '-qm', 'the behaviour, on a side branch');

  env.git('checkout', '-q', main);
  env.git('merge', '--no-ff', '-q', 'side', '-m', 'Merge side');
  const merge = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: env.root, encoding: 'utf8' }).trim();

  /*
   * RANGE MODE, NOT A BARE SHA. The first version of this test passed the
   * merge sha directly -- which is the single-rev branch, the one line the
   * fix touched. An auditor pointed out it therefore exercised none of the
   * path the tool is documented and invoked on, where --no-merges dropped
   * the merge before it could reach the fixed call site at all.
   */
  const out = runAuto(env, `${merge}^..${merge}`);

  /*
   * THE ASSERTION IS SCOPED TO THE MERGE'S OWN LINE, and the version that
   * was not is the reason this note exists.
   *
   * `merge^..merge` is "reachable from merge, not from its first parent",
   * which is the merge AND the side commit. The side commit touches
   * src/merged.mjs and test/merged.test.mjs itself, so a whole-output
   * `match(/merged.test.mjs/)` was satisfied by the SIDE commit whatever
   * the tool did with the merge -- and `doesNotMatch(out, /SKIP/)` is a
   * total over two commits rather than a claim about either.
   *
   * That is rule 14: score the named assertion, not the total. The range
   * still has to contain the side commit, because the point of range mode
   * is that --no-merges used to drop the merge out of a range that had
   * other commits in it. So the range stays and the assertion narrows.
   */
  const mergeShort = merge.slice(0, 7);
  const line = out.split('\n').find((l) => l.startsWith(mergeShort));

  assert.ok(line,
    `the merge ${mergeShort} produced no line at all -- in range mode --no-merges `
    + `dropped it silently, which is worse than SKIP.\n${out}`);
  assert.doesNotMatch(line, /SKIP/,
    `the merge carried src/merged.mjs and its test, and the tool saw neither.\n${line}\n\n${out}`);
  assert.match(line, /merged\.test\.mjs/,
    `the merge's own line must name the test it carried.\n${line}\n\n${out}`);

  /*
   * AND THE SIDE COMMIT IS STILL THERE, so a future change that fixes the
   * merge by dropping everything else from the range turns this red rather
   * than green.
   */
  const side = execFileSync('git', ['rev-parse', `${merge}^2`], { cwd: env.root, encoding: 'utf8' }).trim();
  assert.ok(out.split('\n').some((l) => l.startsWith(side.slice(0, 7))),
    `the side commit vanished from the range, so this fixture no longer reproduces `
    + `the shape the merge defect lived in.\n${out}`);
});
