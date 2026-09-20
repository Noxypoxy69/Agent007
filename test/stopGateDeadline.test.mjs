/*
 * WHY THIS FILE EXISTS.
 *
 * THE STOP GATE COULD BE KILLED INTO A SILENT ALLOW.
 *
 * Claude Code "cancels a `command`, `http`, or `mcp_tool` hook that reaches its
 * `timeout`, discarding the hook's output, so on most events a timed-out hook
 * renders no decision" (hooks reference, verbatim). The two events it then names
 * as exceptions are PreModelSwitch, where a cancelled hook DOES block, and
 * PreToolUse, where it explicitly does not. Stop is neither. A Stop hook blocks
 * only by RENDERING a block decision, so a Stop gate killed mid-run does not
 * refuse -- it says nothing, and nothing ends the turn approved.
 *
 * That is the shape already documented at the top of
 * bin/agentbridge-claude-guard.mjs for a guard that cannot load: the control
 * does not fail to a refusal, it fails to ABSENCE, and absence reads as consent.
 *
 * IT COSTS MORE THAN ONE HOOK, BECAUSE THREE LAYERS DELEGATE HERE.
 * src/shellAllowlist.mjs: "SO THE BOUNDARY IS NOT HERE. It is the Stop gate."
 * src/claudeGuard.mjs says it twice more -- every `mcp__` tool and every tool it
 * cannot classify are "not blocked here, detected at Stop by protected-file
 * drift". Silence this one and all three delegations go silent with it, and the
 * way to silence it is not an exploit: it is to make the machine slow.
 *
 * WHAT WAS ACTUALLY WRONG. The hook allowed 190s. This gate spent up to 180s of
 * it inside a single spawnSync with the suite. Nothing anywhere related those
 * two numbers -- not a check, not a comment -- so ~10s was left over for node
 * startup, hashing every protected file and every baseline test, recursive test
 * discovery, and stopping the suite. Measured healthy on the operator's machine:
 * ~0.4s, so the margin held by roughly twenty times. It held by COINCIDENCE, on
 * a healthy machine, with neither number aware of the other.
 *
 * THE TEST IS THE REAL REGRESSION, NOT A THROWN ERROR. The gate is run with an
 * outer killer standing in for Claude Code's, against a suite that outlasts the
 * budget. It must produce a block ITSELF, before that killer fires. Against the
 * pre-fix gate the killer wins: stdout empty, no decision, turn approved.
 *
 * BOTH DIRECTIONS ARE ASSERTED. A gate that only refuses is an outage, so a
 * green suite inside the budget must still come back APPROVED -- through the
 * same deadline machinery, proven rather than assumed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A suite that is green in milliseconds -- the control for every refusal below. */
const PASSING_SUITE = 'import { test } from "node:test";\ntest("fast and green", () => {});\n';

/*
 * A suite that outlasts every budget in this file. It SLEEPS rather than spins,
 * so a run that gets stopped costs nothing, and it is longer than the stand-in
 * hook deadline too -- which is what makes the pre-fix failure unambiguous:
 * there is no way for the old gate to finish, so the killer always won.
 */
const SLOW_SUITE = 'import { test } from "node:test";\n'
  + 'test("slower than the hook budget", async () => {\n'
  + '  await new Promise((resolve) => { setTimeout(resolve, 30_000); });\n'
  + '});\n';

/** The Stop hook block Claude Code would read, declaring a timeout of its own. */
const stopHook = (timeout) => ({
  hooks: {
    Stop: [{
      matcher: '',
      hooks: [{
        type: 'command',
        command: 'node "$CLAUDE_PROJECT_DIR/scripts/claude-stop-gate.mjs"',
        timeout,
      }],
    }],
  },
});

/** A throwaway git repo carrying the guard, declaring a Stop timeout of its own. */
function scratchRepo({ stopTimeoutS, suite, localTimeoutS = null }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'stop-deadline-'));
  for (const d of ['src', 'scripts', 'bin']) cpSync(path.join(repoRoot, d), path.join(dir, d), { recursive: true });
  for (const d of ['.claude', 'docs', 'test']) mkdirSync(path.join(dir, d), { recursive: true });
  for (const f of ['package.json', 'package-lock.json', 'CLAUDE.md', 'THIRD_PARTY_CODE.md']) {
    writeFileSync(path.join(dir, f), '{}\n');
  }
  for (const f of ['docs/ORDER.md', 'docs/ROADMAP.md', 'docs/CLAUDE_GUARD_PROVENANCE.md']) {
    writeFileSync(path.join(dir, f), 'x\n');
  }
  /*
   * A REAL .claude/settings.json, because the budget is READ FROM IT. A
   * placeholder would send every case down the "no hook deadline could be read"
   * path, and this file would then prove nothing about the thing it exists for.
   * It is also the ONLY difference between the approval below and the refusal
   * below that: same code, same green suite, different declared timeout.
   */
  writeFileSync(path.join(dir, '.claude', 'settings.json'), `${JSON.stringify(stopHook(stopTimeoutS), null, 2)}\n`);
  if (localTimeoutS !== null) {
    writeFileSync(path.join(dir, '.claude', 'settings.local.json'), `${JSON.stringify(stopHook(localTimeoutS), null, 2)}\n`);
  }
  /* test/claudeGuard.test.mjs is a PROTECTED path, so it must be a real file the
   * suite can actually run, not a placeholder that fails to parse. */
  writeFileSync(path.join(dir, 'test', 'claudeGuard.test.mjs'), suite);
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '.');
  git('add', '-A');
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'],
    { cwd: dir, stdio: 'ignore' });
  return dir;
}

/**
 * Run the gate the way Claude Code does, INCLUDING THE KILLER.
 *
 * `killAfterMs` stands in for the hook deadline: at that point Claude Code
 * cancels the hook and discards whatever it had written, which is the silent
 * allow. A test that ran the gate WITHOUT the killer would be timing a
 * stopwatch; with it, an over-running gate produces exactly what production
 * produces -- empty stdout, no decision.
 */
function stop(dir, sessionId, killAfterMs = null) {
  /*
   * NODE_TEST_CONTEXT MUST NOT BE INHERITED, AND THIS IS NOT HOUSEKEEPING.
   *
   * node sets NODE_TEST_CONTEXT=child-v8 inside a test subprocess. Pass it on
   * and the gate's own `node --test` speaks the v8 child protocol instead of
   * TAP, emits no `# tests` summary, and the gate refuses every single run with
   * tap-summary-invalid -- including the run that is supposed to be APPROVED.
   * Observed here first as four red tests with one identical cause.
   *
   * A refusal for that reason would make the deadline assertions in this file
   * pass while measuring nothing: the gate would be blocking because it could not
   * read TAP, not because it ran out of time. Exactly the failure the repository
   * has already paid for twice -- an outcome printed next to a condition that
   * never actually held.
   */
  const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, AGENTBRIDGE_HOME: path.join(dir, 'home') };
  delete env.NODE_TEST_CONTEXT;

  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'claude-stop-gate.mjs')], {
    input: JSON.stringify({ session_id: sessionId }),
    encoding: 'utf8',
    env,
    ...(killAfterMs === null ? {} : { timeout: killAfterMs, killSignal: 'SIGKILL' }),
  });
  let parsed = {};
  try { parsed = JSON.parse(r.stdout || '{}'); } catch { parsed = {}; }
  return {
    elapsedMs: Date.now() - started,
    killed: r.error?.code === 'ETIMEDOUT',
    reason: parsed.reason ?? '',
    blocked: parsed.decision === 'block',
  };
}

/**
 * Mint the baseline first. Without it the gate stops at the snapshot branch and
 * never reaches the suite, so every assertion below would pass for the wrong
 * reason -- a refusal, yes, but not the refusal being tested.
 */
function primed(dir, sessionId) {
  const first = stop(dir, sessionId);
  assert.match(first.reason, /baseline-created/,
    `precondition: the baseline must mint first, got: ${first.reason}`);
}

test('the gate refuses before the hook deadline instead of being killed into a silent allow', (t) => {
  const HOOK_TIMEOUT_S = 20;
  const dir = scratchRepo({ stopTimeoutS: HOOK_TIMEOUT_S, suite: SLOW_SUITE });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  primed(dir, 'deadline-session');

  const verdict = stop(dir, 'deadline-session', HOOK_TIMEOUT_S * 1000);

  /*
   * THE ASSERTION THIS FILE EXISTS FOR. Before the fix the stand-in killer won:
   * killed=true, stdout empty, blocked=false. Claude Code reads that as no
   * decision, and no decision from a Stop hook ends the turn -- the gate
   * approving unverified work by being too slow to disagree.
   */
  assert.equal(verdict.killed, false,
    `the hook deadline killed the gate, so it rendered no decision -- which IS an approval (${verdict.elapsedMs}ms)`);
  assert.equal(verdict.blocked, true,
    `a suite that could not finish must refuse, got: ${JSON.stringify(verdict)}`);
  assert.match(verdict.reason, /stop-deadline/,
    `the refusal must name the deadline so it is actionable, got: ${verdict.reason}`);
  assert.ok(verdict.elapsedMs < HOOK_TIMEOUT_S * 1000,
    `the gate must speak BEFORE the deadline, not race it (${verdict.elapsedMs}ms of ${HOOK_TIMEOUT_S * 1000}ms)`);

  /*
   * AND THE SUITE PROCESSES WERE ACTUALLY REAPED.
   *
   * THIS FILE AGREED WITH THE BROKEN CODE FOR AS LONG AS THE BUG EXISTED. An
   * auditor reverted the abort-and-reap to the pre-fix state -- the version
   * where `Promise.race` cancelled nothing and every timed-out Stop orphaned a
   * full suite per shard -- and this file stayed 5/5 GREEN. `/stop-deadline/`
   * is printed by BOTH deadline branches, the pre-run "too little budget"
   * refusal and the post-run reap, so the assertion above cannot tell a gate
   * that killed its children from one that abandoned them. Rule 4: a proxy
   * agrees with the truth right up until something unusual happens.
   *
   * This run DOES reach the post-run branch (it spends most of its budget in
   * the suite), so the count is the far end: a number greater than zero means
   * live children were found and killed.
   */
  /*
   * WHICH DEADLINE BRANCH FIRES IS A PROPERTY OF THE MACHINE, NOT THE CODE,
   * AND PINNING ONE WAS A RULE 21 DEFECT I SHIPPED HERE.
   *
   * The gate has three refusals that all name stop-deadline: two PRE-RUN
   * budget checks (claude-stop-gate.mjs:966 and :1100, both firing when what
   * is left drops under MIN_SUITE_MS) and the POST-RUN reap. With a 20s
   * budget, whether the work before verification leaves 5s decides which one
   * you get -- so on an idle machine this reached the reap, and under
   * full-suite load it reached the pre-run branch.
   *
   * I asserted the post-run branch unconditionally. It passed 5/5 standalone
   * and went red in the full suite, which is exactly the shape rule 21
   * describes: a test encoding an accident of the machine that wrote it.
   *
   * So this asserts what is TRUE OF THE CODE on every machine -- it refuses,
   * it names a deadline, it is not killed -- and additionally checks the reap
   * whenever the post-run branch is the one that ran. That last clause is a
   * conditional, which rule 6 normally forbids; it is acceptable here ONLY
   * because the reap is pinned unconditionally elsewhere, at the unit level,
   * in test/verifyRunnerCancellation.test.mjs ("ABORTING A RUN SIGKILLS ITS
   * CHILDREN" and "killLiveShards REAPS A CHILD THE ABORT DID NOT"). Without
   * that, this would be a guard dressed as an assertion.
   */
  const postRun = /killed rather than orphaned/.test(verdict.reason);
  if (postRun) {
    const reaped = Number(/(\d+) suite process\(es\) were killed/.exec(verdict.reason)?.[1] ?? -1);
    assert.ok(reaped >= 1,
      `the gate reached the post-run deadline and reaped nothing (reaped=${reaped}). Every timed-out Stop `
      + `then leaks a full suite per shard, unbounded across turns: ${verdict.reason}`);
  } else {
    assert.match(verdict.reason, /less than the|cannot finish|NOTHING WAS VERIFIED/,
      `the refusal is a deadline but matches neither known branch, so the gate has grown a third path `
      + `nobody is asserting on: ${verdict.reason}`);
  }
});

test('a green suite inside the budget is still approved', (t) => {
  /*
   * THE POSITIVE, AND IT IS NOT DECORATION. Everything else here is a refusal,
   * and a deadline that refused every turn would satisfy those assertions
   * perfectly while being a total outage -- which is how a guard gets switched
   * off, losing all three delegated layers at once. Same machinery, approved.
   */
  const dir = scratchRepo({ stopTimeoutS: 190, suite: PASSING_SUITE });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  primed(dir, 'healthy-session');

  const verdict = stop(dir, 'healthy-session', 190_000);
  assert.equal(verdict.killed, false);
  assert.equal(verdict.blocked, false,
    `a green suite well inside the budget must be approved, got: ${verdict.reason}`);
  assert.equal(verdict.reason, '', 'an approval carries no reason');
});

test('a budget too small to finish is refused rather than started', (t) => {
  /*
   * THE PRE-SUITE PATH. When what is left after node startup, hashing and
   * discovery cannot reach a TAP summary, starting the run spends the rest of
   * the budget and arrives at the same refusal too late for anyone to read it.
   *
   * IT IS ALSO THE PROOF THAT THE BUDGET IS READ FROM settings.json RATHER THAN
   * BEING A CONSTANT IN THE GATE. This is the test above exactly -- same repo,
   * same green suite, same code -- with one number changed from 190 to 12. That
   * suite would PASS if it were run, so an approval is precisely what a gate
   * ignoring the declaration would produce here.
   */
  const dir = scratchRepo({ stopTimeoutS: 12, suite: PASSING_SUITE });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  primed(dir, 'cramped-session');

  const verdict = stop(dir, 'cramped-session', 12_000);
  assert.equal(verdict.killed, false);
  assert.equal(verdict.blocked, true,
    `too little budget to verify is not a reason to approve, got: ${JSON.stringify(verdict)}`);
  assert.match(verdict.reason, /stop-deadline/, `got: ${verdict.reason}`);
  assert.ok(verdict.elapsedMs < 5_000,
    `it must refuse without starting a run it cannot finish (${verdict.elapsedMs}ms)`);
});

test('the SMALLEST declared timeout governs, not the first one found', (t) => {
  /*
   * Claude Code merges project and local settings, so this script can be
   * registered more than once -- and several registrations mean several killers,
   * of which the EARLIEST is the one that actually fires. Reading the first
   * entry, or the largest, is borrowing time from a killer that is not the one
   * about to kill you: the gate would believe it had 190s and be cancelled at
   * 12s, back to rendering no decision.
   *
   * settings.json says 190 here and the local file says 12. A gate reading the
   * project file alone would run the green suite and APPROVE.
   */
  const dir = scratchRepo({ stopTimeoutS: 190, localTimeoutS: 12, suite: PASSING_SUITE });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  primed(dir, 'two-declarations');

  const verdict = stop(dir, 'two-declarations', 12_000);
  assert.equal(verdict.blocked, true,
    `the 12s declaration must govern, got: ${JSON.stringify(verdict)}`);
  assert.match(verdict.reason, /stop-deadline/, `got: ${verdict.reason}`);
  assert.match(verdict.reason, /settings\.local\.json/,
    `the refusal must say WHICH declaration it obeyed, got: ${verdict.reason}`);
});

test('an unreadable hook declaration leaves the gate working rather than wedged', (t) => {
  /*
   * WHAT "NO DEADLINE COULD BE READ" MUST NOT MEAN.
   *
   * "Absent is not zero" governs measurements of the TREE: an unmeasurable file
   * is unknown, never clean. This is a different absence. No readable Stop entry
   * also describes a developer running this script by hand, and every harness
   * that spawns it directly -- there is no killer in those cases, and refusing
   * them would rebuild the dead end test/stopGateRecovery.test.mjs exists to
   * prevent: block, retry, block, until somebody switches the hook off.
   *
   * SO THE LOSS IS NAMED RATHER THAN HIDDEN. In this state the gate is exactly
   * as good as it was before the deadline existed -- no worse, and no better.
   */
  const dir = scratchRepo({ stopTimeoutS: 190, suite: PASSING_SUITE });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, '.claude', 'settings.json'), 'not json at all\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'break settings'],
    { cwd: dir, stdio: 'ignore' });

  primed(dir, 'undeclared-session');
  const verdict = stop(dir, 'undeclared-session');
  assert.equal(verdict.blocked, false,
    `an unreadable declaration must not refuse every turn forever, got: ${verdict.reason}`);
});
