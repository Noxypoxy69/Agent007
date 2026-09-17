#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let input;
try {
  input = JSON.parse(raw || '{}');
} catch {
  input = null;
}

function response(decision, reason) {
  process.stdout.write(`${JSON.stringify(decision === 'approve' ? {} : { decision: 'block', reason })}\n`);
}

if (!input) {
  response('block', '[agentbridge:stop-input-invalid] Stop hook input was not valid JSON.');
  process.exit(0);
}
const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const protectedPaths = ['.claude', 'CLAUDE.md', 'package.json', 'package-lock.json', 'src/claudeGuard.mjs', 'src/moduleGraph.mjs', 'bin/agentbridge-claude-guard.mjs', 'scripts/claude-stop-gate.mjs', 'test/claudeGuard.test.mjs', 'docs/ROADMAP.md', 'docs/ORDER.md', 'docs/CLAUDE_GUARD_PROVENANCE.md', 'THIRD_PARTY_CODE.md'];
try {
  const changed = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', ...protectedPaths], { cwd: root, encoding: 'utf8' }).trim();
  if (changed) {
    response('block', `[agentbridge:protected-control-changed] Refusing completion because protected controls changed outside the guard:\n${changed}`);
    process.exit(0);
  }
} catch (error) {
  response('block', `[agentbridge:control-audit-failed] Could not audit protected controls: ${error.message}`);
  process.exit(0);
}

const testDir = path.join(root, 'test');
let tests;
try {
  tests = readdirSync(testDir).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => path.join('test', name));
} catch (error) {
  response('block', `[agentbridge:test-discovery-failed] ${error.message}`);
  process.exit(0);
}
if (tests.length === 0) {
  response('block', '[agentbridge:zero-test-files] No test files were discovered.');
  process.exit(0);
}

const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests], {
  cwd: root,
  encoding: 'utf8',
  timeout: 180_000,
  maxBuffer: 32 * 1024 * 1024,
});
const output = `${run.stdout || ''}\n${run.stderr || ''}`;
if (run.error || run.signal || run.status !== 0) {
  response('block', `[agentbridge:test-run-failed] status=${String(run.status)} signal=${String(run.signal)} error=${run.error?.message || 'none'}`);
  process.exit(0);
}

function one(label) {
  const hits = [...output.matchAll(new RegExp(`^# ${label} (\\d+)$`, 'gm'))];
  return hits.length === 1 ? Number(hits[0][1]) : null;
}
const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map((label) => [label, one(label)]));
if (Object.values(counts).some((value) => value === null)) {
  response('block', `[agentbridge:tap-summary-invalid] Expected exactly one complete TAP summary; observed ${JSON.stringify(counts)}.`);
  process.exit(0);
}
if (counts.tests <= 0 || counts.fail !== 0 || counts.cancelled !== 0 || counts.pass + counts.fail + counts.cancelled + counts.skipped + counts.todo !== counts.tests) {
  response('block', `[agentbridge:tap-counts-refused] Test counts do not prove a clean reconciled run: ${JSON.stringify(counts)}.`);
  process.exit(0);
}
response('approve');
