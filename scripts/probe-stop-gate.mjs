#!/usr/bin/env node
/**
 * RUN THE STOP GATE AND SHOW EVERYTHING IT SAID, INCLUDING STDERR.
 *
 * The gate's own tests parse stdout as JSON and throw stderr away, which is
 * correct for them -- Claude Code only reads stdout -- and useless when the
 * question is WHY the gate produced nothing.
 *
 * And producing nothing is the failure that matters. This script has no
 * try/catch by design: an uncaught throw exits 1 with EMPTY STDOUT, which
 * Claude Code reads as NO DECISION, and no decision from a Stop hook ends the
 * turn. A crash in the gate is therefore a SILENT ALLOW, indistinguishable from
 * approval unless somebody reads the stderr nobody captures.
 *
 * Measured need: after wiring verification into the gate,
 * `test/stopGateDeadline.test.mjs` reported `{"blocked":false,"reason":""}` in
 * 410ms. Every hypothesis about which line threw was a guess, and two of them
 * were wrong.
 *
 * READ-ONLY with respect to the repository. It spawns the gate exactly as the
 * hook does. The gate itself may write a session snapshot, which is what it
 * does on any run.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sessionId = process.argv[2] ?? 'probe-stop-gate';
const active = process.argv.includes('--active');

const started = Date.now();
const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'claude-stop-gate.mjs')], {
  cwd: root,
  encoding: 'utf8',
  input: JSON.stringify({ session_id: sessionId, stop_hook_active: active }),
  env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  maxBuffer: 32 * 1024 * 1024,
});

console.log(`exit      ${r.status}`);
console.log(`signal    ${r.signal ?? 'none'}`);
console.log(`error     ${r.error?.message ?? 'none'}`);
console.log(`elapsed   ${Date.now() - started}ms`);
console.log('');
console.log('--- stdout (this is ALL Claude Code reads) ---');
console.log(r.stdout === '' ? '(EMPTY -- Claude Code reads this as NO DECISION, which ENDS THE TURN)' : r.stdout);
console.log('--- stderr ---');
console.log(r.stderr === '' ? '(empty)' : r.stderr);

process.exit(0);
