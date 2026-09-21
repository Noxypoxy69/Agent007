#!/usr/bin/env node
/**
 * MAKE THE WORKSPACE RULE 20 DEMANDS, WITHOUT WIDENING THE RAIL.
 *
 * Rule 20 requires an auditor to work in ITS OWN CLONE with AGENTBRIDGE_HOME
 * pointed at a temp directory. A guarded session can do neither:
 *
 *   git clone ...                 [agentbridge:shell-not-allowlisted]
 *                                 "git clone" is not an approved read-only shape
 *   AGENTBRIDGE_HOME=/tmp/x node  refused: a leading environment assignment
 *
 * Both refusals are CORRECT and neither should be relaxed. `git clone` takes a
 * destination path as a string, and a carve-out that accepts one is worse than
 * the problem it solves. `AGENTBRIDGE_HOME` is where guardSession reads the
 * SNAPSHOT and the GRANT FILE from -- a session that can point it at a
 * directory it controls can write itself a grant, which is the exact
 * forged-grant channel an audit found in worktree settings on 2026-09-18.
 *
 * So the capability moves into committed code instead of the rail widening.
 * `npm run` is already permitted, this file is tracked and reviewable, and the
 * two dangerous parameters are NOT caller-supplied: the destination and the
 * isolated home are both created here, under the OS temp directory, with
 * mkdtemp. The caller chooses a git REVISION, which is an object id rather than
 * a path, and cannot escape anything.
 *
 * That is the same move as asking git what a pathspec covers: put the decision
 * where it can be reasoned about, rather than parsing a string at the boundary.
 *
 *   npm run audit:workspace                 clone HEAD, install, run the suite
 *   npm run audit:workspace -- <rev>        the same at any revision
 *   npm run audit:workspace -- <rev> --keep leave the clone for inspection
 *
 * It prints the workspace path, the isolated home, and the suite's REAL exit
 * code -- measured unpiped, because `cmd | tail` reports tail's status and that
 * mistake has already been made in this repository.
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runGit } from '../src/safeGit.mjs';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const rev = argv.find((a) => !a.startsWith('--')) ?? 'HEAD';

/*
 * The revision is resolved BEFORE anything is created, so a typo fails here
 * rather than after a clone and an install. It is resolved through the
 * repository rather than trusted as text.
 */
let sha;
try {
  sha = String(runGit(['rev-parse', '--verify', `${rev}^{commit}`],
    { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim();
} catch {
  console.error(`audit-workspace: ${rev} does not name a commit in this repository`);
  process.exit(2);
}

const work = mkdtempSync(path.join(tmpdir(), 'ab-audit-'));
const home = mkdtempSync(path.join(tmpdir(), 'ab-audit-home-'));

console.log(`revision   : ${sha}  (${rev})`);
console.log(`workspace  : ${work}`);
console.log(`isolated   : AGENTBRIDGE_HOME=${home}`);
console.log('');

const step = (label, file, args, opts = {}) => {
  process.stdout.write(`${label.padEnd(28)}`);
  const r = spawnSync(file, args, {
    encoding: 'utf8', windowsHide: true, maxBuffer: 6.4e7, ...opts,
  });
  const code = r.status;
  console.log(code === 0 ? 'ok' : `FAILED (exit ${code === null ? 'killed' : code})`);
  if (code !== 0 && r.stderr) console.log(`  ${String(r.stderr).trim().split('\n').slice(0, 4).join('\n  ')}`);
  return { code, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

/*
 * --no-hardlinks so the clone cannot share objects with the source. An audit
 * that can reach back into the operator's object store is not isolated.
 */
/*
 * THROUGH safeGit, BECAUSE THIS IS THE SHARPEST PLACE NOT TO BE. Cloning a
 * repository and checking out a caller-named revision is precisely where a
 * repository config that executes would matter, and my own lint caught this
 * file using a bare execFileSync for exactly that.
 *
 * runGit throws rather than returning a status, so these adapt to the throw.
 */
const gitStep = (label, args, cwd) => {
  process.stdout.write(`${label.padEnd(28)}`);
  try {
    runGit(args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    console.log('ok');
    return true;
  } catch (e) {
    console.log('FAILED');
    const said = String(e?.stderr ?? e?.message ?? e).trim();
    if (said) console.log(`  ${said.split('\n').slice(0, 4).join('\n  ')}`);
    return false;
  }
};

if (!gitStep('cloning', ['clone', '--no-hardlinks', '--quiet', REPO, work], REPO)) process.exit(2);
if (!gitStep('checking out', ['checkout', '--quiet', '--detach', sha], work)) process.exit(2);

/*
 * npm is a .cmd shim on Windows, and node 24 refuses to spawn a .cmd without a
 * shell (the CVE-2024-27980 mitigation). Measured on this machine:
 * execFile('npm') is ENOENT and execFile('npm.cmd') is EINVAL. So npm is run
 * through its own JS entry point, which is a plain file node can execute.
 */
function npmArgs(rest) {
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return existsSync(cli) ? [cli, ...rest] : null;
}

const install = npmArgs(['ci', '--no-audit', '--no-fund']);
if (!install) {
  console.log('installing                  SKIPPED -- npm-cli.js not found beside node');
  console.log('  the suite below will fail on missing dependencies; say so in the report');
} else if (step('installing', process.execPath, install, { cwd: work }).code !== 0) {
  console.log('  dependencies did not install; the suite result below is not meaningful');
}

/*
 * The suite runs with the ISOLATED home, which is the whole point: without it
 * an audit writes fixtures into the operator's live guard store and reads their
 * real overrides. Not piped, so the exit code is node's.
 */
const suite = spawnSync(process.execPath,
  ['--test', '--test-timeout=120000', 'test/**/*.test.mjs'],
  {
    cwd: work,
    encoding: 'utf8',
    maxBuffer: 6.4e7,
    env: { ...process.env, AGENTBRIDGE_HOME: home },
  });

const text = `${suite.stdout ?? ''}${suite.stderr ?? ''}`;
const num = (label) => {
  const m = [...text.matchAll(new RegExp(`^\\u2139 ${label} (\\d+)`, 'gm'))];
  return m.length ? m[m.length - 1][1] : '?';
};

console.log('');
console.log(`suite exit : ${suite.status === null ? 'killed' : suite.status}   (0 is green; there is no piping here, so this is node's own status)`);
console.log(`tests ${num('tests')}  pass ${num('pass')}  fail ${num('fail')}  skipped ${num('skipped')}`);

const failing = [...text.matchAll(/^✖ (.+?) \(/gm)].map((m) => m[1]);
if (failing.length) {
  console.log('');
  console.log('failing:');
  for (const f of [...new Set(failing)].slice(0, 40)) console.log(`  ${f}`);

  /*
   * ═══ AND THE REASON, BECAUSE A NAME CANNOT TELL YOU WHOSE FAULT IT IS ═══
   *
   * This printed names only, and it cost a full audit pass. Measured
   * 2026-09-20: a clone reported 12 deploy-gate failures at two revisions;
   * an auditor recorded them as the pre-existing baseline and wrote, in
   * these words, "NO ENVIRONMENT FINDING ... the 12 reproduce identically
   * in clone and shared tree". The shared tree is 0 -- green sharded AND
   * unsharded, with the test file, the script and _shared.js byte-identical
   * between tree and clone.
   *
   * The answer was in the failure MESSAGE the whole time.
   * test/checkEdgeDeploy.test.mjs carries a `ranAtAll` assertion written
   * for exactly this, reading "the check script could not be STARTED ...
   * This is the machine, not the deploy gate -- under a full-suite run
   * these tests each spawn a node process and resource exhaustion surfaces
   * here first." Somebody anticipated this failure, wrote the sentence that
   * identifies it, and THIS SCRIPT THREW THE SENTENCE AWAY.
   *
   * So rule 21's environment-finding clause -- the one that exists to stop
   * an auditor spending a pass on a phantom -- was unanswerable from the
   * evidence the auditor was handed. Printing the assertion text is what
   * makes that clause usable, and it is three lines.
   *
   * The clone is kept under --keep for the full transcript; this is the
   * first screen, which is what actually gets read.
   */
  /*
   * THE FIRST VERSION OF THIS PRINTED LINE FRAGMENTS -- "was allowed",
   * "ictly equal:" -- because `AssertionError[^\n]*` ate the message
   * greedily and the capture landed on the NEXT line. Watched failing on
   * a real run before it was believed, which is the only reason it is not
   * still doing that. The error CLASS is bounded to the token, the
   * bracketed code is skipped without crossing the colon, and the message
   * is whatever follows on that same line.
   */
  const reasons = [...text.matchAll(/^\s*(?:AssertionError|TypeError|RangeError|SyntaxError|Error)\b[^:\n]*:[ \t]*([^\n]{5,300})/gm)]
    .map((m) => m[1].trim())
    .filter((r) => !/^[+\-]/.test(r));
  if (reasons.length) {
    console.log('');
    console.log('why (first line of each distinct failure message):');
    for (const r of [...new Set(reasons)].slice(0, 12)) console.log(`  ${r}`);
    console.log('');
    console.log('  A MESSAGE NAMING THE MACHINE IS AN ENVIRONMENT FINDING, NOT A DEFECT.');
    console.log('  Say so explicitly in the report -- see CLAUDE.md rule 21.');
  }
}

if (keep) {
  console.log('');
  console.log(`kept: ${work}`);
  console.log(`kept: ${home}`);
} else {
  for (const d of [work, home]) rmSync(d, { recursive: true, force: true });
}

process.exit(suite.status === 0 ? 0 : 1);
