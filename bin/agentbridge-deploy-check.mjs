#!/usr/bin/env node
/*
 * CAN THIS TREE BE DEPLOYED? Run it before you ship the edge function by hand.
 *
 * This CHECKS and it does not deploy. The separation is deliberate: deploying
 * is Danny's under d-owner-production-gate-20260915, which is the only
 * unrevoked routing decision standing, and a checker that also ships is one
 * somebody runs "just to see" and then cannot un-ship.
 *
 * It is also why this exists rather than the gate being left with no caller:
 * the gate's job is answerable without any authority at all. A human about to
 * hand-deploy can run this first, and that is worth more than a module nothing
 * calls waiting for a pipeline that does not exist yet.
 *
 *   node bin/agentbridge-deploy-check.mjs
 *   node bin/agentbridge-deploy-check.mjs --ref origin/master --json
 *
 * Exit 0 deployable, 1 refused, 2 could not run. A refusal prints every reason
 * at once, because a caller can usually fix one and needs to know all of them.
 *
 * WHAT IT CANNOT DO, stated here rather than discovered. It does not read the
 * live artifact unless a control-plane reading is supplied with --live, because
 * that needs a credential this script deliberately does not hold. WITHOUT IT
 * THE DRIFT CHECK IS SKIPPED, AND IT SAYS SO. A skip is not a pass: the whole
 * point of the read-back is catching the hand-deploy nobody recorded, and a
 * checker that quietly omits it while printing DEPLOYABLE is the decoration
 * this gate exists to replace.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { artifactDigest, assertPromotable, verifyLive } from '../src/deployGate.mjs';
import { linesMissingFrom } from '../scripts/check-edge-deploy.mjs';
import { artifactLoads as checkArtifactLoads } from '../src/artifactLoads.mjs';

const ARTIFACT_DIR = 'supabase/functions/mcp';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

let files = [];
try {
  files = walk(ARTIFACT_DIR).map((p) => ({
    path: p.split(path.sep).join('/'),
    content: readFileSync(p, 'utf8'),
  }));
} catch (err) {
  console.error(`could not read ${ARTIFACT_DIR}: ${err.message}`);
  process.exit(2);
}

/*
 * DOES IT LOAD? Delegated to src/artifactLoads.mjs.
 *
 * This catches the duplicate top-level declaration that took the Bridge down
 * for eleven minutes -- a shape every one of 1079 passing tests was blind to,
 * because index.ts is an entrypoint nothing in the suite can import.
 *
 * THE LOOP THAT USED TO BE HERE SKIPPED .ts. It matched /\.(js|mjs)$/, so the
 * entrypoint -- the actual file that went down -- was the one file it never
 * parsed. It also spawned a process per file and could not tell a parse failure
 * from a duplicate declaration.
 *
 * The module additionally handles what that loop could not: an empty artifact
 * REFUSES rather than reporting a clean check of nothing; a stale shadow copy
 * beside a real file is reported without refusing; and every non-.mjs file gets
 * a strict second parse, because node --check is weaker on .ts and .js than on
 * .mjs and the entrypoint was getting the weakest parse of the three.
 *
 * A pass still means "it parses", never "it starts". Nothing here runs a Deno
 * isolate, and `crypto.randomUUID()` at module scope threw only when the isolate
 * started, after typecheck, lint and build were all green.
 */
const loadCheck = checkArtifactLoads(process.cwd(), ARTIFACT_DIR);
const artifactLoads = loadCheck.ok;

/*
 * Advisory findings are carried, not dropped. shadow-copy and
 * weak-parse-coverage do not refuse -- a noisy gate gets switched off and is
 * then absent for the case that matters -- but they are the reason a human
 * reads this output at all, so they travel with the blocking ones.
 */
const loadErrors = loadCheck.findings.map(
  (f) => `${f.kind} ${f.file}: ${f.detail}`,
);

const releaseRef = arg('--ref', 'origin/master');
let headSha;
let dirtyPaths;
let headIsAncestorOfRelease = null;
try {
  headSha = git('rev-parse', 'HEAD');
  /*
   * NOT git() HERE, AND THE REASON IS A BUG THIS TOOL HAD ON ITS FIRST REAL RUN.
   *
   * git() trims its whole output. Porcelain status is two status columns then a
   * space, and an unstaged modification's first column is a SPACE -- so
   * " M package-lock.json" became "M package-lock.json" and the slice below cut
   * a character off the path. It reported `ackage-lock.json`, which is the same
   * family as the trailing-newline path bug that once made a held-file check
   * report zero held while git plainly showed thirteen.
   *
   * So only the trailing newline comes off, and the columns are matched rather
   * than counted.
   */
  const porcelain = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  dirtyPaths = porcelain
    .split('\n')
    .filter((l) => l.length > 3)
    .map((l) => {
      const body = l.slice(3);
      /* A rename is "R  old -> new"; the new path is what would ship. */
      const arrow = body.indexOf(' -> ');
      return arrow === -1 ? body : body.slice(arrow + 4);
    })
    .filter(Boolean);
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', headSha, releaseRef], { stdio: 'pipe' });
    headIsAncestorOfRelease = true;
  } catch {
    /* Exit 1 means "not an ancestor". Any other failure leaves it null, which
     * the gate treats as unchecked, which is a refusal rather than a pass. */
    headIsAncestorOfRelease = false;
  }
} catch (err) {
  console.error(`could not read git state: ${err.message}`);
  process.exit(2);
}

/* The drift check needs a reading from the control plane, which this script
 * does not have a credential for. Supplied or skipped, never assumed. */
let liveDrift = null;
let driftChecked = false;
const livePath = arg('--live');

/*
 * A CONTROL-PLANE READING GOES STALE, AND A STALE ONE IS A HOLLOW GATE.
 *
 * code-c, 18:18Z: passed a live.json written 63 minutes earlier, so the drift
 * check compared live against a cached file, agreed with itself, and printed
 * "live drift none" at the exact moment there WAS an unrecorded hand-deploy --
 * the thing it exists to catch. The gate did not fail; it was hand-fed.
 *
 * This cannot re-read the control plane: no credential, deliberately. What it
 * CAN check is how old the reading it was handed is, which is the property that
 * failure actually had. bin/agentbridge-deploy.mjs does the real re-read
 * immediately before upload; this only bounds the window, and the refusal says
 * so rather than implying it is closed.
 */
const MAX_LIVE_AGE_MS = 120_000;
let liveAgeMs = null;
if (livePath) {
  try {
    liveAgeMs = Date.now() - statSync(livePath).mtimeMs;
  } catch { /* unreadable is handled where the file is parsed, not here */ }
}
const recordPath = arg('--record');
/*
 * THE HONEST FIRST DEPLOY SAYS SO, RATHER THAN LOOKING LIKE A SKIPPED CHECK.
 *
 * Without this there is one value -- absent -- for both "there is no prior
 * deployment" and "nobody compared", and the gate cannot refuse the second
 * without also blocking the first. The flag costs one deploy one word, and it
 * is the only shape a forgetful caller cannot silently get wrong.
 */
if (process.argv.includes('--no-prior-deployment')) {
  liveDrift = { noPriorDeployment: true };
  driftChecked = true;
} else if (livePath && recordPath) {
  try {
    liveDrift = verifyLive({
      recorded: JSON.parse(readFileSync(recordPath, 'utf8')),
      live: JSON.parse(readFileSync(livePath, 'utf8')),
    });
    driftChecked = true;
  } catch (err) {
    console.error(`could not compare live against the record: ${err.message}`);
    process.exit(2);
  }
}

const digest = artifactDigest(files);
const verdict = assertPromotable({
  dirtyPaths,
  headSha,
  releaseRef,
  headIsAncestorOfRelease,
  artifactFileCount: files.length,
  artifactLoads,
  liveDrift,
});

/*
 * IS THIS EVEN THE RIGHT TREE? The one question this gate could not answer.
 *
 * It compares HEAD against the release ref, and live against the RECORD. Both
 * passed at 19:37 on 2026-09-16 while the deploy shipped nothing: version 22 to
 * 23, byte-identical, clean success, because the checkout did not carry the
 * branch. Neither question is "do the bytes about to ship differ from the bytes
 * already serving", and that is the only one that catches it.
 *
 * scripts/check-edge-deploy.mjs could answer it and was invoked by nothing but
 * its own test. Pass --live-dir <downloaded> and it is answered here, in the
 * gate people actually run.
 */
const liveDirArg = arg('--live-dir');
let treeCompared = false;
let treeAdded = 0;
let treeRemoved = 0;
if (liveDirArg) {
  try {
    for (const f of files) {
      const name = f.path.split('/').pop();
      const livePath = path.join(liveDirArg, name);
      const liveText = readFileSync(livePath, 'utf8');
      // linesMissingFrom(a, b) is 'present in a, absent from b'. ADDED is therefore
      // mine-not-in-live, and REMOVED is live-not-in-mine. I had these the wrong way
      // round first and the gate cheerfully reported +9 -358 for a tree that was a
      // strict superset of what was live.
      treeAdded += linesMissingFrom(f.content, liveText).length;
      treeRemoved += linesMissingFrom(liveText, f.content).length;
    }
    treeCompared = true;
  } catch (err) {
    console.error(`could not compare against --live-dir: ${err.message}`);
  }
}

/*
 * ONE REFUSAL LIST, AND THE EXIT CODE IS COMPUTED FROM IT.
 *
 * All three of the following were true of this file until 2026-09-17, and they
 * were true together, which is why none of them showed:
 *
 * 1. The tree refusal set `process.exitCode = 1` and the last line then called
 *    `process.exit(verdict.ok ? 0 : 1)`. An explicit argument to process.exit
 *    DISCARDS process.exitCode, so "REFUSED: nothing-would-change" printed and
 *    the process returned 0. Measured: with --live and --record supplied so the
 *    drift check was satisfied, an identical tree printed REFUSED and exited 0.
 *
 * 2. A --live-dir that could not be read logged one line to stderr and left
 *    treeCompared false -- the SAME state as never passing the flag at all. So
 *    "I asked for the comparison and it failed" was indistinguishable from "I
 *    did not ask", and both printed DEPLOYABLE. That is the skip-is-not-a-pass
 *    rule this gate states in its own header, broken by the newest check in it.
 *
 * 3. The if/else-if chain meant that when the tree refusal fired, verdict's own
 *    refusals were never printed. The gate refused for one reason while hiding
 *    the others.
 *
 * And they hid each other. test/deployCheckTree.test.mjs asserts the exit code
 * is non-zero for an identical tree, and it PASSES -- because it runs without
 * --live/--record, so verdict.ok is false on live-drift-unchecked and that is
 * what returns 1. The assertion was reading an exit code produced by a
 * different refusal than the one it names, and defect 3 hid the evidence by
 * suppressing that refusal from the output. A proxy agreed with the truth until
 * the drift check was satisfied, which is exactly when this gate is asked to
 * speak.
 */
const refusals = verdict.ok ? [] : [...verdict.refusals];

if (liveDirArg && !treeCompared) {
  refusals.push({
    reason: 'live-dir-unreadable',
    detail: 'a tree comparison was REQUESTED with --live-dir and could not be performed (see '
      + 'stderr above). Refusing rather than proceeding: a check that was asked for and failed '
      + 'is not the same as one nobody asked for, and treating it as one is how a skip becomes '
      + 'a pass.',
  });
}

if (liveAgeMs !== null && liveAgeMs > MAX_LIVE_AGE_MS) {
  refusals.push({
    reason: 'stale-live-reading',
    detail: `the --live reading is ${Math.round(liveAgeMs / 1000)}s old, past the `
      + `${Math.round(MAX_LIVE_AGE_MS / 1000)}s window. Generate it in the same breath as this `
      + 'check: a cached control-plane reading makes the drift check agree with itself, which is '
      + 'how it printed "drift none" during an unrecorded hand-deploy. This bounds the window and '
      + 'does NOT close it -- somebody can still deploy between this check and your upload, which '
      + 'is how v28 re-shipped v27 byte for byte. bin/agentbridge-deploy.mjs closes it.',
  });
}

if (treeCompared && treeAdded === 0 && treeRemoved === 0) {
  refusals.push({
    reason: 'nothing-would-change',
    detail: 'the tree about to ship is identical to what is already serving. A deploy now bumps '
      + 'the version, changes no bytes, and reports success, which is exactly what v23 did. '
      + 'Either this is the wrong checkout, or there is nothing to deploy.',
  });
}

if (process.argv.includes('--json')) {
  // ok and refusals come from the COMBINED list, not from verdict alone. A JSON
  // consumer reading verdict.ok would have been told `true` for a run the gate
  // refused on the tree, and would have deployed on it.
  console.log(JSON.stringify({
    ...verdict,
    ok: refusals.length === 0,
    refusals,
    digest,
    driftChecked,
    treeCompared,
    treeAdded: treeCompared ? treeAdded : null,
    treeRemoved: treeCompared ? treeRemoved : null,
    loadErrors,
  }, null, 2));
} else {
  console.log(`deploy check — ${ARTIFACT_DIR}`);
  console.log(`  head       ${headSha.slice(0, 12)} against ${releaseRef}`);
  console.log(`  artifact   ${files.length} files, digest ${digest.slice(0, 16)}`);
  console.log(`  parses     ${artifactLoads ? 'yes' : 'NO'}`);
  for (const e of loadErrors) console.log(`             ${e}`);
  console.log(
    // eslint-disable-next-line no-nested-ternary
    !driftChecked
      ? '  live drift NOT CHECKED — pass --live and --record, or --no-prior-deployment if this\n' +
        '             is genuinely the first. A skip is not a pass, and it is now refused:\n' +
        '             this is the check that catches a hand-deploy nobody recorded.'
      : liveDrift.noPriorDeployment
        ? '  live drift none recorded yet, declared explicitly'
        : `  live drift ${liveDrift.ok ? 'none' : 'DRIFTED'}`,
  );
  if (treeCompared) {
    console.log(`  tree       +${treeAdded} -${treeRemoved} against the live artifact`);
  } else {
    console.log('  tree       NOT COMPARED against what is live. Download the function and');
    console.log('             pass --live-dir. This is the check that catches the WRONG TREE,');
    console.log('             and it is the one that was missing when v22 to v23 shipped nothing.');
  }
  console.log('');
  if (refusals.length === 0) {
    console.log('DEPLOYABLE.');
  } else {
    // EVERY reason, not the first one to match. A caller can usually fix one
    // and needs to know all of them -- and a refusal that hides its siblings
    // is how the tree check masked live-drift-unchecked.
    console.log('REFUSED:');
    for (const r of refusals) console.log(`  - ${r.reason}: ${r.detail}`);
  }
}

process.exit(refusals.length === 0 ? 0 : 1);
