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
const recordPath = arg('--record');
if (livePath && recordPath) {
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

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ...verdict, digest, driftChecked, loadErrors }, null, 2));
} else {
  console.log(`deploy check — ${ARTIFACT_DIR}`);
  console.log(`  head       ${headSha.slice(0, 12)} against ${releaseRef}`);
  console.log(`  artifact   ${files.length} files, digest ${digest.slice(0, 16)}`);
  console.log(`  parses     ${artifactLoads ? 'yes' : 'NO'}`);
  for (const e of loadErrors) console.log(`             ${e}`);
  console.log(
    driftChecked
      ? `  live drift ${liveDrift.ok ? 'none' : 'DRIFTED'}`
      : '  live drift NOT CHECKED — pass --live and --record. A skip is not a pass: this is the\n' +
        '             check that catches a hand-deploy nobody recorded.',
  );
  console.log('');
  if (verdict.ok) {
    console.log('DEPLOYABLE.' + (driftChecked ? '' : ' Drift unchecked — see above.'));
  } else {
    console.log('REFUSED:');
    for (const r of verdict.refusals) console.log(`  - ${r.reason}: ${r.detail}`);
  }
}

process.exit(verdict.ok ? 0 : 1);
