#!/usr/bin/env node
/**
 * THE MECHANICAL HALF OF AN AUDIT, RUN WITHOUT BEING ASKED.
 *
 * A blind auditor is expensive -- 150k to 265k tokens and twenty minutes to an
 * hour -- and most of what one finds early is a single mechanical fact: DOES
 * THIS COMMIT'S TEST ACTUALLY FAIL WITHOUT THIS COMMIT'S CODE. That question
 * needs no judgement, so it should not need an agent.
 *
 * It is also the question that has caught the most real defects here. On
 * 2026-09-18 a gate pinning a Windows workaround asserted
 *
 *   assert.match(CODE, /npm-cli\.js/)
 *
 * and the subject contained `console.log('... npm-cli.js not found ...')`, so
 * the gate was satisfied by the DIAGNOSTIC THAT FIRES WHEN THE WORKAROUND IS
 * MISSING. Two agents confirmed it green. Reverting the source and re-running
 * the test would have exposed it in seconds, and nobody did that until late.
 *
 * WHAT IT DOES, per commit in the range:
 *   1. clone the repo at that commit, isolated, with its own AGENTBRIDGE_HOME
 *   2. restore the commit's NON-TEST files to their parent versions
 *   3. run only the test files the commit touched
 *   4. they must go RED. Still green means the tests do not gate the change.
 *
 * WHAT IT IS NOT. It is not a blind auditor and does not replace one -- it has
 * no opinion about whether the code is RIGHT, only about whether its tests are
 * load-bearing. Rule 20 still sends guard, rail and grant-channel changes to a
 * separate reader. This is the cheap pass that runs first and every time.
 *
 * IT READS NO COMMIT MESSAGE. Deliberately: the claim is what an auditor is
 * most likely to be led by, and a message asserting "138 of 138" was wrong the
 * same night. Only the diff and the tests are consulted.
 *
 *   npm run audit:auto                      HEAD
 *   npm run audit:auto -- <rev>             one commit
 *   npm run audit:auto -- <base>..<head>    a range
 *   npm run audit:auto -- <range> --notify  also send the result to fixer
 */
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runGit } from '../src/safeGit.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const notify = argv.includes('--notify');
const range = argv.find((a) => !a.startsWith('--')) ?? 'HEAD';

const git = (args, cwd = REPO) =>
  String(runGit(args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();

function commitsIn(rev) {
  try {
    /*
     * MERGES ARE ENUMERATED. `--no-merges` meant a merge never reached
     * filesOf at all, so the --diff-merges fix one function below could not
     * help it -- and in RANGE mode, which is how this tool is documented and
     * actually invoked, a merge was not even reported as SKIP. It was
     * silently absent.
     *
     * Found by the audit OF that fix: I fixed the call site and left the
     * enumeration, then wrote that the class was closed. The test I added
     * passed a bare sha, which is the single-rev branch -- it exercised the
     * one line I changed and none of the path the tool is run on.
     *
     * 39 merges in this history were invisible this way, including 0c05d25,
     * which carries the guard binary, the Stop gate, guardSession and
     * safeGit and reports tests=5 sources=10 once it is enumerated.
     *
     * An evil merge's conflict resolution exists in no other commit, so this
     * is not staleness that ages out; it is permanent for that content.
     */
    const out = rev.includes('..')
      ? git(['rev-list', '--reverse', rev])
      : git(['rev-list', '-n', '1', rev]);
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    console.error(`audit-auto: ${rev} does not name a commit or range`);
    process.exit(2);
  }
}

const isTest = (f) => /(^|\/)test\/.+\.test\.mjs$/.test(f);

/**
 * What a test file names as its subject: local relative imports, and files it
 * reads with new URL(...). A test says what it tests; this reads that rather
 * than guessing from the filename, which would match by coincidence.
 */
function subjectsOf(testFiles, root = REPO, { transitive = false } = {}) {
  /*
   * `root` DEFAULTS TO THE LIVE WORKTREE AND THAT IS A KNOWN DEFECT.
   *
   * A blind audit found this function reads the test out of whatever the
   * operator currently has checked out, not out of the commit under audit --
   * so the SAME COMMIT gets different verdicts depending on the checkout, and
   * it can resolve a subject the audited commit's test never imported.
   *
   * Callers that have a clone pinned at the commit should pass it, and the
   * collapse check below does. The default is left in place only because the
   * test-only path still calls it without one; that call site is the
   * remaining half of the defect and is NOT fixed here.
   */
  /*
   * `transitive` FOLLOWS RE-EXPORTS, AND IT IS OPT-IN FOR A REASON.
   *
   * A blind audit found two spellings of the same blind spot: a test that
   * imports a BARREL (`export * from './impl.mjs'`) and a test that uses a
   * DYNAMIC `await import(...)`. Both are real load-bearing gates and both
   * scored COLLAPSED -- "nothing the test imports was reverted" -- which is
   * the not-a-gate verdict, for gates that work.
   *
   * The barrel case is not a matching failure: `export * from './x.mjs'`
   * already contains `from './x.mjs'`, so depth one matches it. The failure
   * is DEPTH. The test imports the barrel, the barrel re-exports the impl,
   * the commit changed the impl, and the impl never appears in the set.
   *
   * WHY IT IS NOT ON BY DEFAULT. The two callers want different things:
   *
   *   the collapse check     asks "does this test DEPEND on a reverted
   *                          file". Transitive is exactly right: a
   *                          dependency two hops away is still a dependency.
   *   the test-only path     REVERTS each subject it is given. Transitive
   *                          there would check out the parent version of
   *                          every module in the closure -- a far larger
   *                          mutation than the commit made, and the verdict
   *                          would be about a repository nobody wrote.
   *
   * So the closure is requested by the caller that can use it. Bounded by a
   * visited set, and only relative specifiers are followed, so a bare
   * package name never drags node_modules in.
   */
  const RELS = (src) => [
    ...[...src.matchAll(/from\s+['"](\.\.?\/[^'"]+)['"]/g)].map((m) => m[1]),
    ...[...src.matchAll(/new URL\(\s*['"](\.\.?\/[^'"]+)['"]/g)].map((m) => m[1]),
    /*
     * `import('...')`, with or without await. The dynamic form was matched by
     * nothing, so a test whose subject is loaded at run time looked like a
     * test with no subject at all.
     */
    ...[...src.matchAll(/\bimport\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g)].map((m) => m[1]),
  ];

  const out = new Set();
  const seen = new Set();
  const queue = [...testFiles];

  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);

    let src;
    try { src = readFileSync(path.join(root, file), 'utf8'); } catch { continue; }

    for (const rel of RELS(src)) {
      const abs = path.resolve(path.dirname(path.join(root, file)), rel);
      const repoRel = path.relative(root, abs).split(path.sep).join('/');
      // Its own siblings are not its subject, and nor is anything outside the repo.
      if (repoRel.startsWith('..') || isTest(repoRel)) continue;
      if (!existsSync(abs)) continue;
      out.add(repoRel);
      if (transitive && !seen.has(repoRel)) queue.push(repoRel);
    }
  }
  return [...out];
}

/**
 * node_modules for a fresh clone. Installing per commit is too slow, and the
 * measurement is about the code rather than about npm.
 */
function linkModules(work) {
  const nm = path.join(work, 'node_modules');
  if (!existsSync(nm) && existsSync(path.join(REPO, 'node_modules'))) {
    spawnSync('cmd', ['/c', 'mklink', '/J', nm, path.join(REPO, 'node_modules')],
      { encoding: 'utf8', windowsHide: true });
  }
}

function filesOf(sha) {
  /*
   * --diff-merges=first-parent, OR A MERGE HAS NO FILES AND IS SKIPPED.
   *
   * The same defect a3f3fa6 fixed in src/auditLedger.mjs, still here, found
   * by the audit of that commit: `git show --name-only` prints nothing for a
   * merge because git declines to pick a side. files=[] then means tests=[]
   * and sources=[], and the consumer below prints
   *
   *     SKIP   no test files touched (0 source file(s))
   *
   * -- so a merge carrying a control AND its test is reported as having
   * touched nothing, by the tool this project runs as its automatic rule-20
   * pass. Fixing one of two call sites and announcing the class closed is
   * the mistake this branch keeps making; this is the second site.
   *
   * Measured on the same merge a3f3fa6 used:
   *   git show --name-only --format= cbbe34c          -> 0 lines
   *   git show -m --first-parent --name-only cbbe34c  -> test/leakRegression.test.mjs
   */
  const out = git(['show', '--diff-merges=first-parent', '--name-only', '--format=', sha]);
  const files = out.split('\n').map((s) => s.trim()).filter(Boolean);
  /*
   * ANYTHING UNDER test/ IS TEST-SIDE AND IS NEVER REVERTED.
   *
   * Found by blind audit. `sources` was "everything that is not *.test.mjs",
   * so test/helpers/*.mjs and test/fixtures/*.mjs -- which exist in this
   * repository -- were treated as THE CODE and reverted. A commit touching
   * only a test and its own helper therefore reported GATE: the "code" whose
   * removal turned the test red was a test fixture. That reads as proof of
   * coverage for a commit that shipped no product code at all.
   *
   * The question this tool asks is "does this commit's test fail without this
   * commit's CODE", so the test side of the tree is not code by definition.
   * A commit that changes only test/ now has no sources and falls into the
   * test-only path, where it is reported as needing judgement rather than
   * silently scored.
   */
  const underTest = (f) => /(^|\/)test\//.test(f);
  return { tests: files.filter(isTest), sources: files.filter((f) => !underTest(f)) };
}

/** node --test with a real exit status; never piped, so the code is node's. */
function runTests(cwd, files, home) {
  const r = spawnSync(process.execPath, ['--test', '--test-timeout=120000', ...files], {
    cwd, encoding: 'utf8', maxBuffer: 6.4e7,
    env: { ...process.env, AGENTBRIDGE_HOME: home },
  });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const num = (label) => {
    const m = [...text.matchAll(new RegExp(`^\\u2139 ${label} (\\d+)`, 'gm'))];
    return m.length ? Number(m[m.length - 1][1]) : -1;
  };
  const pass = num('pass');
  const fail = num('fail');
  const tests = num('tests');

  /*
   * "COULD NOT RUN" AND "FAILED" MUST NOT RENDER ALIKE, and the -1 sentinel
   * must never reach an operator.
   *
   * Found by blind audit. node --test prints no summary block at all when a
   * file is missing or the runner cannot start, so num() returned -1 -- and
   * -1 was then printed verbatim ("fail -1") and fed into the verdict
   * arithmetic, where it renders a run that EXPLODED as a weak-gate lead.
   * A non-zero exit is not evidence a test ran (rule 3); the reported COUNT
   * is, so that is what decides.
   */
  const ran = tests >= 0 && pass >= 0 && fail >= 0;
  return { status: r.status, pass, fail, tests, ran, text };
}

const findings = [];
const shas = commitsIn(range);
console.log(`audit-auto: ${shas.length} commit(s) in ${range}\n`);

for (const sha of shas) {
  const short = sha.slice(0, 7);
  const { tests, sources } = filesOf(sha);

  if (tests.length === 0) {
    console.log(`${short}  SKIP   no test files touched (${sources.length} source file(s))`);
    findings.push({ sha: short, verdict: 'no-tests', detail: `${sources.length} source files, 0 tests` });
    continue;
  }
  if (sources.length === 0) {
    /*
     * A TEST-ONLY COMMIT IS THE CASE THIS TOOL CANNOT DECIDE, AND IT IS EXACTLY
     * WHERE THE HOLLOW GATE WAS.
     *
     * The method is "revert the source, see the test go red". A commit that adds
     * a gate for code that ALREADY EXISTS changes no source, so there is nothing
     * to revert -- and reverting the unchanged subject to its parent is a no-op,
     * which leaves the test green and would report HOLLOW for every such commit
     * regardless of the truth. A false mechanism that happens to give the right
     * answer is still a false mechanism.
     *
     * Measured on the first run of this script: 99c690c added
     * test/auditWorkspaceUsesNpmCli.test.mjs alone, pinning a workaround landed
     * in an earlier commit. That gate WAS hollow -- it matched its subject's own
     * error message -- and this tool skipped it.
     *
     * So it is reported as NEEDS-MANUAL rather than skipped quietly. A silent
     * skip in the one category that has produced a hollow gate is how the tool
     * itself becomes one.
     */
    /*
     * BUT THE SUBJECT IS DISCOVERABLE, so this is decidable after all.
     *
     * The first version reported NEEDS-MANUAL here and stopped, which left 7 of
     * 18 commits undecided in the first real run -- in the one category that has
     * actually produced a hollow gate. A detector blind to its own highest-risk
     * case is not much of a detector.
     *
     * A test names what it tests: its relative imports, and any file it reads
     * with new URL(...). So instead of reverting THIS commit's source (there is
     * none), find where each subject LAST CHANGED and revert it to that commit's
     * parent -- undoing the behaviour the gate claims to pin. If the gate is
     * real it goes red. This is what catches 99c690c: its subject is
     * scripts/audit-workspace.mjs, last changed in dcc9a98, and reverting to
     * dcc9a98^ removes the npm-cli workaround entirely.
     *
     * It is still NEEDS-MANUAL when no subject can be resolved -- a test that
     * names nothing local cannot be checked this way, and saying so is better
     * than guessing.
     */
    const subjects = subjectsOf(tests);
    if (subjects.length === 0) {
      console.log(`${short}  MANUAL tests only, and no local subject could be resolved  [${tests.join(' ')}]`);
      findings.push({
        sha: short,
        verdict: 'NEEDS-MANUAL',
        detail: `${tests.join(', ')} names no local subject; automatic revert cannot decide this one`,
      });
      continue;
    }

    const work2 = mkdtempSync(path.join(tmpdir(), 'ab-auto-'));
    const home2 = mkdtempSync(path.join(tmpdir(), 'ab-auto-home-'));
    try {
      git(['clone', '--no-hardlinks', '--quiet', REPO, work2]);
      git(['checkout', '--quiet', '--detach', sha], work2);
      linkModules(work2);

      const before2 = runTests(work2, tests, home2);
      if (before2.fail !== 0) {
        console.log(`${short}  SKIP   its own tests are not green at this commit (fail ${before2.fail})`);
        findings.push({ sha: short, verdict: 'not-green', detail: `fail ${before2.fail} before any revert` });
        continue;
      }

      const undone = [];
      for (const s of subjects) {
        let last;
        try { last = git(['log', '-n', '1', '--format=%H', sha, '--', s], work2); } catch { last = ''; }
        if (!last) continue;
        try { git(['cat-file', '-e', `${last}^:${s}`], work2); } catch { continue; }
        git(['checkout', `${last}^`, '--', s], work2);
        undone.push(`${s}@${last.slice(0, 7)}^`);
      }
      if (undone.length === 0) {
        console.log(`${short}  MANUAL tests only; subjects found but none had a prior version  [${subjects.join(' ')}]`);
        findings.push({ sha: short, verdict: 'NEEDS-MANUAL', detail: `subjects ${subjects.join(', ')} have no parent version` });
        continue;
      }

      /*
       * THE VERDICT HERE IS WEAKER THAN THE SAME-COMMIT ONE, AND CALLING IT
       * "HOLLOW" WAS OVERCLAIMING.
       *
       * This path undoes the subject's LAST CHANGE, which is not necessarily
       * the behaviour the gate pins. Measured on 99c690c: the tool undid
       * scripts/audit-workspace.mjs@3e1373b^ -- a safeGit routing change -- and
       * reported HOLLOW. That gate WAS hollow, proven separately by hand, but
       * not for this reason: the npm-cli workaround it pins was untouched by
       * that revert, so staying green was the correct behaviour of a correct
       * gate. A right answer reached by a wrong mechanism is still a wrong
       * mechanism, and it is precisely the trap this file warns about two
       * branches above.
       *
       * So the finding is named for what was actually measured. A gate that
       * does not notice its subject's most recent change MIGHT be hollow and
       * might simply be pinning something else -- it is a lead for a person,
       * not a verdict. Only the same-commit path, where the change under test
       * is the thing reverted, says HOLLOW.
       */
      const after2 = runTests(work2, tests, home2);
      if (after2.fail > 0) {
        console.log(`${short}  PINNED tests go red when the subject's last change is undone (fail ${after2.fail})  [${tests.join(' ')}]`);
        findings.push({ sha: short, verdict: 'real-gate', detail: `fail ${after2.fail} with ${undone.join(', ')}` });
      } else {
        console.log(`${short}  LOOSE  tests do not notice the subject's last change  [${tests.join(' ')}]`);
        console.log(`         undone: ${undone.join(', ')}`);
        console.log('         a LEAD, not a verdict: the gate may pin something that change did not touch');
        findings.push({
          sha: short,
          verdict: 'LOOSE',
          detail: `stayed green (pass ${after2.pass}) with ${undone.join(', ')} -- worth a human look, not proof of hollowness`,
        });
      }
    } catch (e) {
      console.log(`${short}  ERROR  ${String(e?.message ?? e).split('\n')[0].slice(0, 120)}`);
      findings.push({ sha: short, verdict: 'error', detail: String(e?.message ?? e).slice(0, 200) });
    } finally {
      for (const d of [work2, home2]) rmSync(d, { recursive: true, force: true });
    }
    continue;
  }

  const work = mkdtempSync(path.join(tmpdir(), 'ab-auto-'));
  const home = mkdtempSync(path.join(tmpdir(), 'ab-auto-home-'));
  try {
    git(['clone', '--no-hardlinks', '--quiet', REPO, work]);
    git(['checkout', '--quiet', '--detach', sha], work);

    linkModules(work);

    const before = runTests(work, tests, home);
    if (before.fail !== 0) {
      console.log(`${short}  SKIP   its own tests are not green at this commit (fail ${before.fail})`);
      findings.push({ sha: short, verdict: 'not-green', detail: `fail ${before.fail} before any revert` });
      continue;
    }

    // Put the SOURCE back to the parent, keep the tests as committed.
    const restorable = sources.filter((f) => {
      try { git(['cat-file', '-e', `${sha}^:${f}`], work); return true; } catch { return false; }
    });
    if (restorable.length === 0) {
      console.log(`${short}  SKIP   every source file is new at this commit, nothing to revert to`);
      findings.push({ sha: short, verdict: 'all-new', detail: `${sources.length} new source files` });
      continue;
    }
    git(['checkout', `${sha}^`, '--', ...restorable], work);

    const after = runTests(work, tests, home);

    /*
     * A SUITE THAT COLLAPSED IS NOT A GATE THAT FIRED.
     *
     * Found by blind audit. Any non-zero fail count was read as GATE, so a
     * run where the parent version of an unrelated reverted file fails to
     * IMPORT -- six real tests becoming one file-level crash -- was
     * indistinguishable from six assertions catching the change. Nothing the
     * test asserts differed; the module list simply stopped loading. The one
     * signal that separates them was computed and thrown away.
     *
     * So the count must survive the revert. If the number of tests that RAN
     * drops, the comparison is not between two versions of the code, it is
     * between a suite and a wreck.
     */
    if (!after.ran) {
      console.log(`${short}  UNKNOWN the suite did not run after the revert -- no summary was produced  [${tests.join(' ')}]`);
      console.log('         That is NOT a gate and NOT a pass: nothing was measured.');
      findings.push({ sha: short, verdict: 'unknown', detail: 'no test summary after revert' });
      continue;
    }
    if (before.ran && after.tests < before.tests) {
      /*
       * A COLLAPSE IS NOT AUTOMATICALLY A NON-GATE. THE FIRST VERSION OF THIS
       * CHECK OVERCORRECTED AND BROKE HONEST VERDICTS.
       *
       * The previous commit read any drop in test count as "the suite stopped
       * loading rather than the assertions firing" and printed NOT A GATE. A
       * blind audit showed that is wrong for the COMMONEST HONEST PATTERN in
       * this repository: a new export plus the test that imports it. Revert
       * the export and the test cannot load -- the count drops -- and that
       * collapse IS the gate working. It fired on e53b8c8's own auditEscalation
       * test, calling a load-bearing gate not-a-gate.
       *
       * So the question is not "did the count drop" but "did it drop BECAUSE
       * the reverted code is what the test imports". The test names its own
       * subject, so that is answerable rather than guessable: if anything we
       * reverted is among the modules this test imports, a failure to load is
       * evidence the test depends on the code -- which is what a gate is.
       *
       * If the reverted set and the test's imports are disjoint, the collapse
       * had some other cause and the assertions never ran. That is the
       * auditor's original case, and it is reported as a lead, not a verdict.
       */
      /* Transitive: a dependency two hops behind a barrel is still a dependency. */
      const imported = new Set(subjectsOf(tests, work, { transitive: true }));
      const revertedAndImported = restorable.filter((f) => imported.has(f));

      if (revertedAndImported.length > 0) {
        /*
         * "CANNOT EVEN LOAD" IS A CLAIM, AND IT HAS TO BE CHECKED.
         *
         * Found by blind audit of the commit that added this branch -- mine.
         * It fired on a shrinking count plus an import overlap and never
         * looked at after.fail, so it announced "the test cannot even load"
         * about runs that loaded perfectly and passed.
         *
         * The case is not exotic, it is this repo's commonest generated-test
         * shape:
         *
         *     for (const x of IMPORTED_LIST) test(`...${x}`, () => {});
         *
         * Revert the subject, the list gets shorter, FEWER TESTS ARE
         * GENERATED, and every one of them passes. Count drops, imports
         * overlap, the branch fires, `gates proven: 1`.
         *
         * That is worse than the COLLAPSED under-claim it replaced. This is
         * the repo's cheap automatic rule-20 pass, the one that runs first
         * and every time, and a tool that manufactures false positives in
         * the "this is covered" direction is more dangerous than one that
         * admits ignorance. An honest UNKNOWN sends a reader to look; a
         * false GATE tells them not to bother.
         *
         * A test that genuinely cannot load is REPORTED BY THE RUNNER as a
         * failure, so the evidence already existed and simply was not read.
         */
        if (after.fail > 0) {
          console.log(`${short}  GATE   the test cannot even load without the code (${before.tests} -> ${after.tests} tests, fail ${after.fail})  [${tests.join(' ')}]`);
          console.log(`         reverted and imported by the test: ${revertedAndImported.join(', ')}`);
          findings.push({
            sha: short,
            verdict: 'real-gate',
            detail: `load-time: ${revertedAndImported.join(', ')} reverted, ${before.tests} -> ${after.tests} tests, fail ${after.fail}`,
          });
          continue;
        }

        console.log(`${short}  HOLLOW the test COUNT shrank with the code and NOTHING FAILED (${before.tests} -> ${after.tests} tests, fail 0)  [${tests.join(' ')}]`);
        console.log(`         reverted and imported by the test: ${revertedAndImported.join(', ')}`);
        console.log('         The tests were not caught out, they stopped being GENERATED -- a count');
        console.log('         derived from the reverted code. Whatever the commit added is unproven.');
        findings.push({
          sha: short,
          /* 'HOLLOW', not 'hollow': the summary counters match on the
           * upper-case spelling, and the lower-case one printed a HOLLOW line
           * while reporting "hollow: 0" underneath it. */
          verdict: 'HOLLOW',
          detail: `count derived from reverted code: ${before.tests} -> ${after.tests} tests, fail 0`,
        });
        continue;
      }

      console.log(`${short}  COLLAPSED ${before.tests} tests became ${after.tests} after the revert  [${tests.join(' ')}]`);
      console.log('         Nothing the test imports was reverted, so the assertions never ran.');
      console.log('         A LEAD, not a verdict: look for an import the parent version breaks.');
      findings.push({ sha: short, verdict: 'collapsed', detail: `${before.tests} -> ${after.tests} tests, no reverted file imported` });
      continue;
    }

    const red = after.fail > 0;

    if (red) {
      console.log(`${short}  GATE   tests go red without the code (fail ${after.fail})  [${tests.join(' ')}]`);
      findings.push({ sha: short, verdict: 'real-gate', detail: `fail ${after.fail} when ${restorable.length} source file(s) reverted` });
    } else {
      console.log(`${short}  HOLLOW tests STAY GREEN without the code  [${tests.join(' ')}]`);
      console.log(`         reverted: ${restorable.join(', ')}`);
      findings.push({
        sha: short,
        verdict: 'HOLLOW',
        detail: `tests stayed green (pass ${after.pass}) with ${restorable.join(', ')} reverted to ${short}^`,
      });
    }
  } catch (e) {
    console.log(`${short}  ERROR  ${String(e?.message ?? e).split('\n')[0].slice(0, 120)}`);
    findings.push({ sha: short, verdict: 'error', detail: String(e?.message ?? e).slice(0, 200) });
  } finally {
    for (const d of [work, home]) rmSync(d, { recursive: true, force: true });
  }
}

const hollow = findings.filter((f) => f.verdict === 'HOLLOW');
const loose = findings.filter((f) => f.verdict === 'LOOSE');
const manual = findings.filter((f) => f.verdict === 'NEEDS-MANUAL');

/*
 * EVERY VERDICT REACHES A COUNTER, AND THE SUMMARY REFUSES TO ADD UP WRONG.
 *
 * A blind audit found three verdicts counted by nothing -- `collapsed`,
 * `unknown` and `error`. So a range in which NOTHING was measured printed
 *
 *     gates proven: 0  hollow: 0  loose: 0  needs-manual: 0  skipped: 0
 *
 * which is the row a reader scans, and it is indistinguishable from a clean
 * one. That is this repository's own bug class aimed at its own summary
 * line, and it is the same defect the previous commit fixed ONE instance of:
 * a HOLLOW line printed above `hollow: 0`, because the finding used a
 * spelling no counter matched. I fixed the instance and left the class.
 *
 * So the buckets are derived from the findings rather than enumerated, and
 * anything unrecognised lands in `uncounted` instead of vanishing. The total
 * is asserted against findings.length: if those disagree the summary says so
 * loudly rather than under-reporting, because a verdict machine whose
 * arithmetic is wrong has no business being believed about anything else.
 */
const inconclusive = findings.filter((f) => ['collapsed', 'unknown', 'error'].includes(f.verdict));
const skipped = findings.filter((f) => String(f.verdict).startsWith('no-')
  || ['all-new', 'not-green'].includes(f.verdict));
const proven = findings.filter((f) => f.verdict === 'real-gate');

const counted = proven.length + hollow.length + loose.length + manual.length
  + inconclusive.length + skipped.length;
const uncounted = findings.length - counted;

console.log('');
console.log(`gates proven: ${proven.length}`
  + `  hollow: ${hollow.length}`
  + `  loose: ${loose.length}`
  + `  needs-manual: ${manual.length}`
  + `  inconclusive: ${inconclusive.length}`
  + `  skipped: ${skipped.length}`);

if (uncounted !== 0) {
  console.log('');
  console.log(`SUMMARY IS WRONG: ${findings.length} finding(s) but ${counted} counted `
    + `(${uncounted} in no bucket). A verdict was added without a counter -- the row above `
    + 'under-reports and must not be read as a result.');
}

if (inconclusive.length) {
  console.log('');
  console.log(`${inconclusive.length} commit(s) were NOT MEASURED -- collapsed, unknown or errored.`);
  console.log('That is not a pass. Nothing was established about them either way.');
}
if (hollow.length) {
  console.log('');
  console.log('HOLLOW is a verdict: the test did not notice the very change it shipped with.');
}
if (loose.length) {
  console.log('');
  console.log('LOOSE is a LEAD, not a verdict. The subject\'s last change was undone and the gate');
  console.log('did not notice -- which is expected if the gate pins something else. Look, do not');
  console.log('conclude. Calling this hollow would be a right answer from a wrong mechanism.');
}
if (manual.length) {
  console.log('');
  console.log('NEEDS-MANUAL is not a pass either. Nothing about the subject could be undone,');
  console.log('so the gate was never exercised.');
}

/*
 * SHIP THE RESULT BACK. A report nobody reads is the same as no report, and
 * this runs unattended -- so it goes to the bridge, addressed to the lane that
 * owns the guard surface, rather than to a log file somebody has to remember.
 */
if (notify) {
  const lines = findings.map((f) => `  ${f.sha}  ${f.verdict.padEnd(10)} ${f.detail}`).join('\n');
  const body = `AUTOMATED GATE AUDIT of ${range}. No commit messages were read; only the diff and the tests.\n\n`
    + `Method: clone each commit, restore its NON-TEST files to the parent, run only the tests it touched. `
    + `They must go RED. Still green means the tests do not gate the change.\n\n${lines}\n\n`
    /*
     * THE "ALL CLEAR" SENTENCE MUST NOT BE SENT FOR A RANGE THAT WAS NEVER
     * MEASURED. Found by blind audit: this said "the tests are load-bearing"
     * whenever hollow.length was 0 -- including when every commit came back
     * collapsed, unknown or errored, i.e. when nothing had been established
     * at all. It is sent to the fixer lane as `type: status`, so it reads as
     * a clearance. Absence of a finding is not a finding.
     */
    + (hollow.length
      ? `${hollow.length} HOLLOW gate(s) -- a test that cannot fail is worse than no test, because it is counted as coverage.`
      : (inconclusive.length
        ? `No hollow gates found, but ${inconclusive.length} commit(s) were NOT MEASURED (collapsed, unknown or errored). This is not a clean range -- it is a range with holes in it.`
        : 'No hollow gates in this range. This says the tests are load-bearing; it says NOTHING about whether the code is correct, which still needs a reader.'));

  const r = spawnSync(process.execPath, [
    path.join(REPO, 'bin', 'agentbridge.mjs'), 'send-message',
    '--to', 'fixer', '--from', 'audit-auto', '--type', hollow.length ? 'blocker' : 'status',
    '--body', body,
  ], { cwd: REPO, encoding: 'utf8' });
  if (r.status === 0) console.log('result sent to fixer');
  else {
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    console.log(`could not send (${r.status}): ${out.split('\n')[0]}`);
    const file = path.join(REPO, '.audit-auto-last.json');
    writeFileSync(file, `${JSON.stringify({ range, findings }, null, 2)}\n`);
    console.log(`written to ${file} instead -- a result that cannot be delivered is still evidence`);
  }
}

process.exit(hollow.length ? 1 : 0); // LOOSE is a lead, not a failure: it must not break a build
