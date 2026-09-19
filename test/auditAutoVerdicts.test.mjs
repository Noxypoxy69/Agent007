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
