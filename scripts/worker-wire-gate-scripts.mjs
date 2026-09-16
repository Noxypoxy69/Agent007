#!/usr/bin/env node
/*
 * THE FIRST WORKER COMMAND, AND IT IS DELIBERATELY NOT AN LLM.
 *
 * agentbridge work does CLAIM, RUN, VERIFY, RETURN. Everything except RUN has
 * been proven in isolation; the chain has never executed unattended because
 * nothing was ever put in the RUN slot. A model in that slot on the first
 * attempt would mean two unproven things at once -- the loop, and whatever the
 * model decided to do -- and a failure could not be attributed to either.
 *
 * So this does one real, small, idempotent job instead, and the only question
 * the run answers is whether the loop carries it.
 *
 * THE JOB. scripts/check-edge-deploy.mjs and bin/agentbridge-deploy-check.mjs
 * are the two gates in front of a production deploy, and neither has an npm
 * script. They are reachable only by anyone who already knows the path, which
 * is how check-edge-deploy sat invoked-by-nothing while the deploy it existed
 * to catch shipped nothing at 19:37 on 2026-09-16.
 *
 * IDEMPOTENT ON PURPOSE. A worker can be assigned the same task twice -- the
 * lease can expire mid-run and the task returns to the pool -- so running twice
 * must not produce two edits or a failure. It writes only when something is
 * missing and says so either way.
 *
 * It runs in an isolated worktree that the workspace manager created, with cwd
 * set to it, so it edits its own copy and never a shared checkout.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const WANTED = {
  'check:edge-deploy': 'node scripts/check-edge-deploy.mjs',
  'deploy:check': 'node bin/agentbridge-deploy-check.mjs',
};

const cwd = process.cwd();
const pkgPath = path.join(cwd, 'package.json');

let pkg;
try {
  pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
} catch (err) {
  console.error(`worker: cannot read package.json at ${pkgPath}: ${err.message}`);
  process.exit(2);
}

pkg.scripts ??= {};
const added = [];
for (const [name, cmd] of Object.entries(WANTED)) {
  if (pkg.scripts[name] === cmd) continue;
  if (pkg.scripts[name] && pkg.scripts[name] !== cmd) {
    // Somebody else's definition. Leave it: a worker overwriting a script it
    // did not write is how one lane silently reverts another.
    console.log(`worker: ${name} already defined differently, leaving it alone`);
    continue;
  }
  pkg.scripts[name] = cmd;
  added.push(name);
}

if (added.length === 0) {
  console.log('worker: both gate scripts already wired, nothing to do');
  process.exit(0);
}

await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`worker: wired ${added.join(', ')} into package.json`);
process.exit(0);
