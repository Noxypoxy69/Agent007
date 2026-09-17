#!/usr/bin/env node
/*
 * DEPLOY THE EDGE FUNCTION, AND REFUSE IF SOMEBODY ELSE GOT THERE FIRST.
 *
 * The deploy gate answers "should this tree ship". It cannot answer "is what I
 * checked still what is live", because it holds no credential and that is
 * deliberate. So there is a window between the check and the upload, and on
 * 2026-09-17 that window was six minutes wide and cost a deploy:
 *
 *   01:18:56  somebody deployed version 27, landing the bytes
 *   01:25:10  code-d uploaded against a reading taken before 27 existed,
 *             producing version 28 with ezbr_sha256 ca618cb2b449 -- IDENTICAL
 *             to 27. The counter moved and nothing shipped.
 *
 * Caught afterwards by code-c on a read-back, not by the gate and not by the
 * person who ran it. Every check in front of that deploy passed.
 *
 * This closes the window rather than bounding it: the version is re-read from
 * the control plane IMMEDIATELY before upload and compared to what the caller
 * says it checked. If it moved, somebody deployed in between and the caller's
 * verification describes a world that no longer exists -- so it refuses and
 * says what to re-run.
 *
 *   node bin/agentbridge-deploy.mjs --project-ref <ref> --expect-version 28
 *
 * Exit 0 deployed and confirmed, 1 refused, 2 could not run.
 *
 * WHAT IT DOES NOT DO. It does not decide whether the tree is deployable. Run
 * agentbridge-deploy-check.mjs first; this refuses to be a second opinion about
 * a question that already has a gate.
 */

import { execFileSync } from 'node:child_process';

const PROJECT = arg('--project-ref');
const EXPECT = arg('--expect-version');
const SLUG = arg('--slug') ?? 'mcp';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

/*
 * exitCode AND THROW, NOT process.exit(), AND THE REASON IS WINDOWS-SPECIFIC.
 *
 * process.exit() straight after a fetch tears the process down while undici's
 * keep-alive socket is still closing, and libuv aborts:
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src/win/async.c:94
 * The process then exits 127 rather than the code asked for, so a caller
 * branching on 1-versus-2 sees "command not found" and mishandles a refusal as
 * a broken install. Measured here: the two paths that exit BEFORE any fetch
 * returned 2 correctly; the one after a fetch returned 127.
 */
class Refusal extends Error {
  constructor(code, lines) { super(lines[0]); this.code = code; this.lines = lines; }
}
function die(code, ...lines) { throw new Refusal(code, lines); }

const token = process.env.SUPABASE_ACCESS_TOKEN;

/*
 * VALIDATED INSIDE main(), NOT AT TOP LEVEL. die() throws now, and a throw
 * outside the try below is an unhandled rejection: node prints a stack trace
 * and exits 1, so "you forgot a flag" became indistinguishable from "somebody
 * deployed under you". Measured: this path returned 1 where it must return 2.
 */
function preflight() {
  if (!PROJECT) die(2, 'usage: --project-ref <ref> --expect-version <n> [--slug mcp]');
  if (!EXPECT || !/^\d+$/.test(EXPECT)) {
    die(2, 'usage: --expect-version <n> is required.',
      'It is the version you verified against. Without it this cannot tell a',
      'concurrent deploy from a normal one, which is the whole point.');
  }
  if (!token) die(2, 'SUPABASE_ACCESS_TOKEN is required to read the control plane before deploying.');
}

/** Read the live function from the Management API. Never from a cached file. */
async function readLive() {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT}/functions/${SLUG}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!res.ok) die(2, `could not read the live function: HTTP ${res.status}`);
  const j = await res.json();
  return { version: Number(j.version), hash: String(j.ezbr_sha256 ?? ''), verifyJwt: j.verify_jwt };
}

async function main() {
  preflight();
  const before = await readLive();

if (before.version !== Number(EXPECT)) {
  die(
    1,
    'REFUSED: concurrent-deploy',
    `  you verified against version ${EXPECT}; the control plane now reports ${before.version}.`,
    '  Somebody deployed between your check and this upload, so your verification',
    '  describes a world that no longer exists. Deploying now would either revert',
    '  their change or re-ship identical bytes as a new version.',
    '',
    '  Re-run the deploy check against the CURRENT live reading, then retry with',
    `  --expect-version ${before.version}.`,
  );
}

/*
 * verify_jwt IS PRESERVED, NOT ASSUMED. The mcp function runs with it OFF
 * because it authenticates against its own token tables, and the CLI default
 * turns it back ON -- which refuses every registration-token client at once and
 * reads as a credential outage rather than a deploy mistake.
 */
const flags = ['functions', 'deploy', SLUG, '--project-ref', PROJECT, '--use-api'];
if (before.verifyJwt === false) flags.push('--no-verify-jwt');

console.log(`deploying ${SLUG} to ${PROJECT} (live was version ${before.version})`);
try {
  execFileSync('npx', ['supabase', ...flags], { stdio: 'inherit' });
} catch (err) {
  die(2, `the deploy command failed: ${err.message}`);
}

const after = await readLive();

/*
 * VERIFIED BY THE HASH, NOT THE COUNTER. A version bump is not evidence the
 * bytes changed -- 22 to 23 and 27 to 28 both moved the counter and shipped
 * nothing. If the hash is unchanged this says so rather than reporting success.
 */
console.log(`version ${before.version} -> ${after.version}`);
console.log(`hash    ${before.hash.slice(0, 12)} -> ${after.hash.slice(0, 12)}`);
console.log(`verify_jwt ${after.verifyJwt}`);

if (after.hash === before.hash) {
  die(1,
    'REFUSED-AFTER-THE-FACT: nothing-shipped',
    '  the artifact hash did not change, so this deploy moved the counter and',
    '  changed no bytes. Either the tree was already live, or the wrong tree was',
    '  uploaded. Do not record this as a release.');
}

if (after.verifyJwt !== before.verifyJwt) {
  die(1, `verify_jwt changed from ${before.verifyJwt} to ${after.verifyJwt} -- this breaks bearer-token clients.`);
}

  console.log('DEPLOYED and confirmed: the bytes changed.');
}

try {
  await main();
} catch (err) {
  if (err instanceof Refusal) {
    for (const l of err.lines) console.error(l);
    process.exitCode = err.code;
  } else {
    console.error(`could not run: ${err.message}`);
    process.exitCode = 2;
  }
}
