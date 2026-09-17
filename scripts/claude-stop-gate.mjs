#!/usr/bin/env node
/**
 * THE STOP GATE. Compares against the SESSION SNAPSHOT, never against HEAD.
 *
 * The first version audited `git diff --name-only HEAD -- <protected>`, which a
 * commit hides. Demonstrated: write the stop gate, `git commit -am wip`, and the
 * gate approved everything. Content against a pre-session snapshot cannot be
 * hidden that way, and it also catches writes that never reached PreToolUse at
 * all -- an MCP repository write, a subagent, a wrapper script. Those are NOT
 * prevented; they are detected here, which is the only claim made for them.
 *
 * FAILS CLOSED on a missing or unreadable snapshot, because "nobody knows" is
 * not "nothing changed".
 */
import { spawnSync } from 'node:child_process';
import { readSnapshot, protectedDrift, baselineTestDrift, discoverTests } from '../src/guardSession.mjs';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let input;
try { input = JSON.parse(raw || '{}'); } catch { input = null; }

const out = (reason) => {
  process.stdout.write(`${JSON.stringify(reason ? { decision: 'block', reason } : {})}\n`);
  process.exit(0);
};

if (!input) out('[agentbridge:stop-input-invalid] Stop hook input was not valid JSON.');

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

/*
 * The session id comes from the Stop payload, so this reads the baseline THIS
 * session created. Keyed by repository alone, two concurrent sessions shared and
 * overwrote one file.
 */
const sessionId = input.session_id ?? null;
const snapshot = readSnapshot(root, sessionId);
if (!snapshot) {
  out(`[agentbridge:no-session-snapshot] No readable snapshot for session ${sessionId ?? '(none supplied)'}. Refusing: an absent baseline is not a clean one.`);
}

const drift = protectedDrift(root, snapshot);
if (drift.length) {
  out(`[agentbridge:protected-control-changed] Protected controls differ from the session snapshot (committing does not hide this):\n${drift.map((d) => `  ${d.file}: ${d.now}`).join('\n')}`);
}

/*
 * BASELINE TESTS ARE COMPARED, NOT MERELY RECORDED. snapshot.tests was collected
 * and never checked, so a weakened inherited test would be RUN by the block
 * below and pass -- the suite grading itself against rules the session had just
 * relaxed. Measured: a weakened baseline test produced zero drift.
 */
const testDrift = baselineTestDrift(root, snapshot);
if (testDrift.length) {
  out(`[agentbridge:baseline-test-changed] Tests present at session start differ from the snapshot:\n${testDrift.map((d) => `  ${d.file}: ${d.now}`).join('\n')}`);
}

/* RECURSIVE, matching `npm test`'s test/** glob. A flat readdir runs a different
 * suite from the one the project declares, and would approve a run that silently
 * skipped every nested test. */
const tests = discoverTests(root);
if (tests.length === 0) out('[agentbridge:zero-test-files] No test files were discovered.');

const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests], {
  cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024,
});
const output = `${run.stdout || ''}\n${run.stderr || ''}`;
if (run.error || run.signal || run.status !== 0) {
  out(`[agentbridge:test-run-failed] status=${String(run.status)} signal=${String(run.signal)} error=${run.error?.message || 'none'}`);
}

const one = (label) => {
  const hits = [...output.matchAll(new RegExp(`^# ${label} (\\d+)$`, 'gm'))];
  return hits.length === 1 ? Number(hits[0][1]) : null;
};
const counts = Object.fromEntries(
  ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map((l) => [l, one(l)]),
);
if (Object.values(counts).some((v) => v === null)) {
  out(`[agentbridge:tap-summary-invalid] Expected exactly one complete TAP summary; observed ${JSON.stringify(counts)}.`);
}
if (
  counts.tests <= 0 || counts.fail !== 0 || counts.cancelled !== 0
  || counts.pass + counts.fail + counts.cancelled + counts.skipped + counts.todo !== counts.tests
) {
  out(`[agentbridge:tap-counts-refused] Test counts do not prove a clean reconciled run: ${JSON.stringify(counts)}.`);
}
out(null);
