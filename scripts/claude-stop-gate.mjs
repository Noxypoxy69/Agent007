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
import {
  readSnapshot, protectedDrift, baselineTestDrift, discoverTests, writeSnapshot,
} from '../src/guardSession.mjs';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let input;
try { input = JSON.parse(raw || '{}'); } catch { input = null; }

const out = (reason) => {
  process.stdout.write(`${JSON.stringify(reason ? { decision: 'block', reason } : {})}\n`);
  process.exit(0);
};

if (!input) out('[agentbridge:stop-input-invalid] Stop hook input was not valid JSON.');

/*
 * Claude Code sets stop_hook_active=true when this turn is already continuing
 * because a Stop hook blocked once. Blocking again here creates an autonomous
 * verification loop. Ending the turn is NOT approval: the message explicitly
 * records that the previous Stop refusal remains unresolved and requires a new
 * owner/user turn before more work continues.
 */
if (input.stop_hook_active === true) {
  process.stdout.write(`${JSON.stringify({
    systemMessage: '[agentbridge:stop-loop-break] A Stop hook already blocked this turn. Ending the turn unapproved instead of re-entering the same autonomous verification loop. Resolve the prior guard refusal in a fresh turn.',
  })}\n`);
  process.exit(0);
}

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

/*
 * The session id comes from the Stop payload, so this reads the baseline THIS
 * session created. Keyed by repository alone, two concurrent sessions shared and
 * overwrote one file.
 */
const sessionId = input.session_id ?? null;
let snapshot = readSnapshot(root, sessionId);
if (!snapshot) {
  /*
   * A MISSING BASELINE USED TO BE A DEAD END, AND IT BRICKED REAL SESSIONS.
   *
   * Refusing on an absent snapshot is right -- absent is not clean -- but there
   * was no way back. A session whose SessionStart never ran (begun before the
   * hook was wired, or outside the repo) cannot write its own baseline, because
   * only --session-start does, and it cannot run that either: `node` is
   * allowlisted only with --test. So it blocked, retried and blocked again,
   * forever. Observed on the operator's machine 2026-09-17, on every terminal at
   * once. A control with no recovery path is an outage, and an outage is how a
   * guard gets switched off entirely.
   *
   * So the gate now asks git, which does not need a snapshot to have an opinion,
   * and mints a baseline ONLY from a tree git calls clean. It still blocks this
   * turn either way -- nothing here approves anything -- but a recoverable state
   * becomes recoverable on the next one.
   */
  /*
   * THE REFUSAL ITSELF NOW LIVES IN writeSnapshot, NOT HERE.
   *
   * This path used to perform the cleanliness check and then mint. That left
   * every OTHER caller of writeSnapshot -- notably --session-start, which is the
   * path every session actually takes -- minting with no check at all, so a new
   * session could baseline a damaged tree and its Stop gate would report no
   * drift. Duplicating the check into the second caller would have been the
   * same mistake with a longer fuse; the control belongs to the act of minting.
   *
   * What stays here is the WORDING, because advice is caller-specific and a
   * refusal a person cannot act on is an outage waiting to happen.
   */
  const minted = writeSnapshot(root, sessionId);
  if (!minted.ok) {
    const who = `No readable snapshot for session ${sessionId ?? '(none supplied)'}`;
    if (minted.cause === 'unmeasurable') {
      out(`[agentbridge:no-session-snapshot] ${who}, and git could not be consulted to check the protected files independently. Refusing: unknown is not clean.`);
    }
    if (minted.cause === 'dirty') {
      /*
       * The advice is per status code because "commit or restore these" is
       * useless for an untracked file, and `.claude/` is a PREFIX entry -- so a
       * stray untracked file under it blocks minting forever, which is its own
       * outage. An untracked file there is still refused rather than waved
       * through: local settings can switch hooks off, so a file this session
       * could have created is not something it gets to certify as normal.
       */
      const advise = (code) => (code.startsWith('?')
        ? 'untracked: delete it, commit it, or add it to .gitignore'
        : 'modified or deleted: commit it or restore it with git');
      out(`[agentbridge:no-session-snapshot] ${who}, and ${minted.reason}:\n${minted.drift.map((d) => `  ${d.file} [${d.kind}] ${d.now} -- ${advise(d.now)}`).join('\n')}\nResolve these, or start a fresh session so SessionStart records a baseline properly.`);
    }
    out(`[agentbridge:no-session-snapshot] ${who}, and one could not be created: ${minted.reason}`);
  }
  out(`[agentbridge:baseline-created] This session had no baseline, so THIS TURN COULD NOT BE VERIFIED and is not approved. git reports the protected files and baseline tests match the repository, so a baseline has now been recorded at ${minted.file}. The next turn will be checked against it normally.`);
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
