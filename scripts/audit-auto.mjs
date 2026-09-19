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
    const out = rev.includes('..')
      ? git(['rev-list', '--reverse', '--no-merges', rev])
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
function subjectsOf(testFiles) {
  const out = new Set();
  for (const t of testFiles) {
    let src;
    try { src = readFileSync(path.join(REPO, t), 'utf8'); } catch { continue; }
    const rels = [
      ...[...src.matchAll(/from\s+['"](\.\.?\/[^'"]+)['"]/g)].map((m) => m[1]),
      ...[...src.matchAll(/new URL\(\s*['"](\.\.?\/[^'"]+)['"]/g)].map((m) => m[1]),
    ];
    for (const rel of rels) {
      const abs = path.resolve(path.dirname(path.join(REPO, t)), rel);
      const repoRel = path.relative(REPO, abs).split(path.sep).join('/');
      // Its own siblings are not its subject, and nor is anything outside the repo.
      if (repoRel.startsWith('..') || isTest(repoRel)) continue;
      if (!existsSync(abs)) continue;
      out.add(repoRel);
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
  const out = git(['show', '--name-only', '--format=', sha]);
  const files = out.split('\n').map((s) => s.trim()).filter(Boolean);
  return { tests: files.filter(isTest), sources: files.filter((f) => !isTest(f)) };
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
  return { status: r.status, pass: num('pass'), fail: num('fail'), text };
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
    const red = after.fail > 0 || (after.status !== 0 && after.pass === 0);

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
console.log('');
console.log(`gates proven: ${findings.filter((f) => f.verdict === 'real-gate').length}`
  + `  hollow: ${hollow.length}`
  + `  loose: ${loose.length}`
  + `  needs-manual: ${manual.length}`
  + `  skipped: ${findings.filter((f) => String(f.verdict).startsWith('no-') || ['all-new', 'not-green'].includes(f.verdict)).length}`);
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
    + (hollow.length
      ? `${hollow.length} HOLLOW gate(s) -- a test that cannot fail is worse than no test, because it is counted as coverage.`
      : 'No hollow gates in this range. This says the tests are load-bearing; it says NOTHING about whether the code is correct, which still needs a reader.');

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
