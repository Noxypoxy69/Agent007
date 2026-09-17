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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  readSnapshot, protectedDrift, baselineTestDrift, discoverTests,
  baselineBlockingDriftFromGit, writeSnapshot,
} from '../src/guardSession.mjs';

/*
 * BEING KILLED IS A SILENT ALLOW, SO THE HOOK DEADLINE IS PART OF THIS GATE'S JOB.
 *
 * Claude Code "cancels a `command`, `http`, or `mcp_tool` hook that reaches its
 * `timeout`, discarding the hook's output, so on most events a timed-out hook
 * renders no decision" (hooks reference, verbatim). The two events it names as
 * exceptions are PreModelSwitch, where a cancelled hook DOES block, and
 * PreToolUse, where it explicitly does not. Stop is neither. This gate blocks
 * only by RENDERING a decision, so a run that is killed does not refuse -- it
 * says nothing, and nothing ends the turn approved.
 *
 * Same shape as the unloadable guard at the top of
 * bin/agentbridge-claude-guard.mjs: the control fails to ABSENCE, and absence
 * reads as consent. It costs more than one hook, because three layers delegate
 * here -- src/shellAllowlist.mjs ("SO THE BOUNDARY IS NOT HERE. It is the Stop
 * gate") and src/claudeGuard.mjs twice, for every `mcp__` tool and every tool it
 * cannot classify. Silence this and all three go silent with it, and silencing
 * it needs no exploit: it needs a slow machine.
 *
 * WHAT WAS WRONG. The hook allowed 190s and the spawnSync below took up to 180s
 * of it as a CONSTANT. Nothing related the two numbers -- not a check, not a
 * comment -- so ~10s was left for node startup, hashing every protected file and
 * every baseline test, recursive discovery, and stopping the suite. Measured
 * healthy on the operator's machine: ~0.4s. The margin held by roughly twenty
 * times, by coincidence, with neither number aware of the other, and nothing
 * anywhere would have noticed either one moving.
 *
 * SO THE BUDGET IS READ FROM THE DECLARATION CLAUDE CODE KILLS BY, and the suite
 * is given the time actually LEFT rather than a constant. The gate now stops the
 * suite itself and refuses, in time for the refusal to be read.
 *
 * THE RESIDUAL, NAMED RATHER THAN IMPLIED. Everything before the spawn is
 * synchronous, so no in-process timer can interrupt it: if hashing alone ever
 * outran the whole budget, this process would still be killed mid-hash and still
 * fail open. Closing that needs a watchdog outside this process, which is a
 * different change with its own blast radius. What is closed here is the part
 * that takes minutes -- the suite -- and the part that was unbounded: a child
 * that would not die.
 */

/** Claude Code's documented default for a `command` hook that declares no timeout. */
const DEFAULT_COMMAND_HOOK_TIMEOUT_S = 600;

/*
 * Held back from the suite for stopping it and writing the refusal. Deliberately
 * generous: the run that needs this reserve is by definition on a machine too
 * slow to finish the suite, so a reserve sized for a healthy machine would be
 * spent by the one case it exists for.
 */
const OUTPUT_RESERVE_MS = 10_000;

/*
 * Below this a run cannot reach a TAP summary, so the only outcome left is a
 * refusal. Starting one anyway spends what remains of the budget and arrives at
 * the same refusal later -- possibly too late for anyone to read it.
 */
const MIN_SUITE_MS = 5_000;

/*
 * What the suite gets when NO hook deadline can be established. That is not the
 * "absent is not zero" case: an unreadable Stop entry also describes this script
 * being run by hand or from a harness, where nothing is going to kill it, and
 * refusing those would rebuild the dead end test/stopGateRecovery.test.mjs
 * exists to prevent. The loss is named instead: in that state this gate is
 * exactly as good as it was before the deadline existed, and no better.
 */
const UNDECLARED_SUITE_MS = 180_000;

/**
 * The time this process has before Claude Code kills it, read from the SAME
 * declarations Claude Code kills by.
 *
 * A constant here would be a second copy of a number owned by settings.json, and
 * two copies drifting apart IS the bug. Reading it means the hook timeout is
 * changed in one place and this gate follows; there is no second number to keep
 * in sync, and no margin held by coincidence.
 *
 * TRUSTING THIS FILE IS SAFE, AND IT IS WORTH SAYING WHY, because a control
 * reading its own limits out of an editable file usually is not. A session that
 * raised the declared timeout could make this gate believe it had hours while
 * Claude Code still killed it at 190s -- the silent allow, bought with one JSON
 * edit. It cannot: `.claude/` is a PROTECTED PREFIX, so an edit to it during the
 * session is protected-control drift, and the drift check above has already
 * blocked and exited before this function is ever consulted.
 *
 * THE SMALLEST DECLARATION WINS, not the first one found. Claude Code merges
 * project and local settings, so this script can be registered more than once --
 * and several registrations mean several killers, of which the EARLIEST governs.
 * Taking the largest, or the first, would be borrowing time from a killer that
 * is not the one about to fire.
 *
 * RESIDUAL, NAMED: a registration in user-level or managed settings lives
 * outside this repository and is not read here. If one exists with a shorter
 * timeout, this gate is back to a margin it cannot see -- which is why the
 * refusal messages below always print the budget and where it came from, so a
 * surprise is diagnosable from the block itself rather than from a guess.
 *
 * Returns null for "no deadline could be established", which is not the same
 * claim as "no deadline exists".
 */
function hookBudget(root) {
  let best = null;
  for (const name of ['settings.json', 'settings.local.json']) {
    let settings;
    try {
      settings = JSON.parse(readFileSync(path.join(root, '.claude', name), 'utf8'));
    } catch { continue; }
    for (const group of Array.isArray(settings?.hooks?.Stop) ? settings.hooks.Stop : []) {
      for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
        /*
         * Matched by the script this file IS, not by position. A different Stop
         * hook with a longer timeout must not be mistaken for this one.
         */
        if (typeof hook?.command !== 'string' || !hook.command.includes('claude-stop-gate')) continue;
        const declared = Number(hook.timeout);
        const found = Number.isFinite(declared) && declared > 0
          ? { ms: declared * 1000, source: `.claude/${name}, timeout ${declared}s` }
          : {
            ms: DEFAULT_COMMAND_HOOK_TIMEOUT_S * 1000,
            source: `.claude/${name} declares no timeout, so Claude Code's ${DEFAULT_COMMAND_HOOK_TIMEOUT_S}s command-hook default applies`,
          };
        if (best === null || found.ms < best.ms) best = found;
      }
    }
  }
  return best;
}

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
  const gitDrift = baselineBlockingDriftFromGit(root);

  /* null is "could not measure", which is not "measured clean" (rule: absent is not zero). */
  if (gitDrift === null) {
    out(`[agentbridge:no-session-snapshot] No readable snapshot for session ${sessionId ?? '(none supplied)'}, and git could not be consulted to check the protected files independently. Refusing: unknown is not clean.`);
  }

  /*
   * NEVER MINT A BASELINE FROM A MODIFIED TREE. That is exactly the reset bypass
   * writeSnapshot's exclusive create exists to stop -- damage a protected file,
   * acquire a baseline that says the damage was always there. If the protected
   * files already differ, this session does not get to declare that normal.
   */
  if (gitDrift.length) {
    /*
     * The advice is per status code because "commit or restore these" is useless
     * for an untracked file, and `.claude/` is a PREFIX entry -- so a stray
     * untracked file under it blocks minting forever, which is its own outage.
     * An untracked file there is still refused rather than waved through: local
     * settings can switch hooks off, so a file this session could have created
     * is not something it gets to certify as normal.
     */
    const advise = (code) => (code.startsWith('?')
      ? 'untracked: delete it, commit it, or add it to .gitignore'
      : 'modified or deleted: commit it or restore it with git');
    out(`[agentbridge:no-session-snapshot] No readable snapshot for session ${sessionId ?? '(none supplied)'}, and files the baseline would cover already differ from git, so a baseline taken now would adopt that state as normal:\n${gitDrift.map((d) => `  ${d.file} [${d.kind}] ${d.now} -- ${advise(d.now)}`).join('\n')}\nResolve these, or start a fresh session so SessionStart records a baseline properly.`);
  }

  const minted = writeSnapshot(root, sessionId);
  if (!minted.ok) {
    out(`[agentbridge:no-session-snapshot] No readable snapshot for session ${sessionId ?? '(none supplied)'}, and one could not be created: ${minted.reason}`);
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

/*
 * THE SUITE GETS WHAT IS LEFT, NOT A CONSTANT. performance.now() is milliseconds
 * since this process started, so node startup, module load, hashing every
 * protected file and every baseline test, and recursive discovery are all
 * CHARGED against the budget rather than assumed free.
 */
const budget = hookBudget(root);
const spentMs = Math.round(performance.now());
const suiteMs = budget === null ? UNDECLARED_SUITE_MS : budget.ms - spentMs - OUTPUT_RESERVE_MS;

if (budget !== null && suiteMs < MIN_SUITE_MS) {
  out(`[agentbridge:stop-deadline] The work before the suite spent ${spentMs}ms of a ${budget.ms}ms hook budget (${budget.source}), leaving ${suiteMs}ms -- less than the ${MIN_SUITE_MS}ms a run needs to reach a TAP summary. NOTHING WAS VERIFIED, so this turn is not approved. Starting a run that cannot finish would spend the rest of the budget and produce this same refusal too late to be read.`);
}

const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests], {
  cwd: root,
  encoding: 'utf8',
  timeout: suiteMs,
  maxBuffer: 32 * 1024 * 1024,
  /*
   * SIGKILL, NOT THE DEFAULT SIGTERM. spawnSync sends killSignal at the timeout
   * and then WAITS for the child to exit; it never escalates. A test -- or any
   * child of the runner -- that installs a SIGTERM handler would hold this call
   * open indefinitely past the deadline, which is the silent allow rebuilt
   * through a different door, and unbounded rather than merely tight. SIGKILL
   * cannot be trapped. On Windows both already map to TerminateProcess, so this
   * costs nothing there and closes the hole everywhere else.
   */
  killSignal: 'SIGKILL',
});
const output = `${run.stdout || ''}\n${run.stderr || ''}`;

/*
 * A DEADLINE STOP IS REPORTED AS ONE, not folded into test-run-failed. Both
 * refuse, so the security outcome is identical -- but "the suite was cut off
 * because this machine is too slow" and "a test failed" call for opposite
 * responses from whoever reads it, and a refusal nobody can act on is the kind
 * that gets the hook switched off.
 */
if (run.error?.code === 'ETIMEDOUT') {
  out(`[agentbridge:stop-deadline] The suite was still running after ${suiteMs}ms and was stopped so this gate could answer before Claude Code's hook timeout cancels it and discards the answer (budget: ${budget === null ? `${UNDECLARED_SUITE_MS}ms, because no Stop timeout could be read from .claude/settings.json` : `${budget.ms}ms from ${budget.source}`}). NOTHING WAS VERIFIED, so this turn is not approved. A healthy run finishes far inside this; one that does not is a machine to fix, not a reason to approve unverified work.`);
}

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
