import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { permissionScope, agentLaunch, readDenials, ENGINE_IDS } from '../src/agentPermissions.mjs';
import { hookSettings } from '../src/agentToolBoundary.mjs';
import { run as execRun } from '../src/exec.mjs';

/**
 * ═══ THE HALF THAT HAD NEVER BEEN RUN ═══
 *
 * `agentPermissions.mjs` derives a coding agent's launch scope from the same
 * guard that decides commands at execution, it refuses a blanket grant in every
 * spelling, and it refuses to launch on an empty allow-list. All of that was
 * mutation-proved. NONE OF IT HAD EVER BEEN POINTED AT A CODING AGENT.
 *
 * It did not start. The argv the module emitted exited 1 before a model was
 * called, because `--allowed-tools <tools...>` is variadic and had eaten the
 * prompt. A module cannot be "verified" against a command line nobody has typed
 * -- that is hollow gate 3 with a different column: a configuration nothing
 * ever consumed.
 *
 * ═══ WHY THE ASSERTIONS HERE ARE NOT ABOUT PROMPTS ═══
 *
 * `test/unattendedLoop.test.mjs` asserts that an agent which asks fails the
 * attempt, and proves its own detector by making a scripted agent print
 * "Do you want to proceed? [y/n]". That detector is a prose heuristic, and
 * A REAL ENGINE DOES NOT WRITE THAT SENTENCE. Measured 2026-09-16, Claude Code
 * 2.1.273, blocked on a command outside its allow-list:
 *
 *   "The `git add -A` command needs your approval to proceed -- please approve
 *    it so I can continue with staging, committing, and finishing the task."
 *
 *   exit code 0.  is_error false.  subtype "success".  interactivePrompt null.
 *   No commit.
 *
 * Every signal the runner has said clean run. The work had stopped dead on an
 * approval. So this file asserts on `permission_denials` -- what the engine
 * itself reports it refused -- and never on the exit code, never on `is_error`,
 * and never on the absence of a sentence. Rule 4: verify the far end.
 *
 * Adding "needs your approval" to the prompt regex was the tempting fix and is
 * refused on rule 8: a probe bounds nothing, and five more phrasings ship with
 * the next model. The structured field is the matcher.
 *
 * ═══ WHY IT SKIPS, AND LOUDLY ═══
 *
 * It spends money and needs a credentialled binary, so it is opt-in. A silent
 * skip renders "I could not check" identically to "I checked and it was fine",
 * which is the defect this repository has found more times than any other, so
 * every skip below says what went unchecked.
 *
 *   AGENTBRIDGE_LIVE_AGENT=1 npm test
 *
 * Last run green 2026-09-16 in a Linux cloud container, Claude Code 2.1.273.
 */

const LIVE = process.env.AGENTBRIDGE_LIVE_AGENT === '1';
const BINARY = process.env.AGENTBRIDGE_AGENT_BINARY ?? 'claude';
const PLACEMENT = {
  isDisposable: true, branch: 'work/t1', leaseValid: true, fenceCurrent: true,
  task_id: 't-live', project: 'agentbridge', repo: 'agentbridge', lane: 'agentbridge',
};
const TASK = 'In the current working directory: read value.txt, increase the number in it by '
  + 'exactly one, then run `npm test`, then run `git add -A`, then commit with the message '
  + '"raise the value". Do not ask any questions.';

const git = async (cwd, ...args) => {
  const r = await execRun('git', args, { cwd, timeoutMs: 20000 });
  if (!r.ok) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.error}`);
  return r.stdout.trim();
};

/** A repository with one commit, a check script, and an `npm test` that runs it. */
async function scratchRepo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'liveagent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await git(dir, 'init', '--quiet', '-b', 'work/t1');
  await git(dir, 'config', 'user.email', 'harness@example.invalid');
  await git(dir, 'config', 'user.name', 'harness');
  await git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'value.txt'), '1\n');
  writeFileSync(path.join(dir, 'check.mjs'),
    "import {readFileSync} from 'node:fs';\n"
    + "const v = Number(readFileSync(new URL('./value.txt', import.meta.url), 'utf8').trim());\n"
    + "console.log(v === 2 ? '# tests 1\\n# pass 1\\n# fail 0' : '# tests 1\\n# pass 0\\n# fail 1');\n"
    + 'process.exit(v === 2 ? 0 : 1);\n');
  writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: 'live', version: '1.0.0', type: 'module',
      scripts: { test: 'node check.mjs' } }, null, 2));
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '--quiet', '-m', 'base');
  return { dir, sha: await git(dir, 'rev-parse', 'HEAD') };
}

/**
 * Launch the real engine with exactly the argv the module emits.
 *
 * THE ENVIRONMENT IS THE PARENT'S HERE AND THAT IS A KNOWN GAP, not an
 * oversight. `executorLocal` allow-lists the child's environment precisely so a
 * coding agent does not inherit the daemon's credentials -- but a real engine
 * needs ITS credentials to start at all, and nothing yet names which variables
 * those are. So this file passes the ambient environment and says so; wiring
 * the engine's credential set into the executor's allow-list is open work, and
 * a test that quietly inherited everything would have hidden the question.
 */
async function launchLive(dir, placement) {
  const scope = permissionScope(placement, [], { now: new Date().toISOString() });
  const launch = agentLaunch('claude-code', { binary: BINARY, scope, prompt: TASK });
  const r = await execRun(launch.file, launch.args,
    { cwd: dir, timeoutMs: 300000, env: process.env });
  return { scope, launch, r };
}

/** Does a credentialled binary answer at all? Checked before anything is concluded. */
async function engineAnswers() {
  const r = await execRun(BINARY, ['--print', '--', 'Reply with exactly the word PONG.'],
    { cwd: tmpdir(), timeoutMs: 120000, env: process.env });
  return r.ok && /PONG/.test(r.stdout) ? null : (r.stderr || r.error || 'no PONG').slice(0, 200);
}

// ── the hermetic half: it runs everywhere, and it is the regression gate ────

/**
 * THE SHAPE THAT DID NOT START, GUARDED WITHOUT NEEDING A BINARY.
 *
 * This is the part that belongs in CI. It does not prove the flags are the
 * right flags -- only the live test below can do that -- but it does fail the
 * moment the argv goes back to the ordering that was measured broken, which is
 * a regression a comment cannot hold.
 */
test('NO BARE VALUE MAY FOLLOW A VARIADIC ALLOW FLAG BEFORE THE TERMINATOR', () => {
  const scope = permissionScope(PLACEMENT, [], { now: new Date().toISOString() });
  const launch = agentLaunch('claude-code', { scope, prompt: TASK, extraArgs: ['--model', 'sonnet'] });

  const flagAt = launch.args.indexOf('--allowed-tools');
  assert.notEqual(flagAt, -1, 'the allow flag left the argv entirely');
  // the rules are its one legitimate value; the terminator must come next
  assert.equal(launch.args[flagAt + 1], launch.rules.join(','));
  assert.equal(launch.args[flagAt + 2], '--',
    'the option list is not terminated, so the next bare token is swallowed as a tool rule — '
    + 'which is how `--print` exited 1 with "Input must be provided"');

  // and the task itself survives to the far side of the terminator
  assert.equal(launch.args[launch.args.length - 1], TASK, 'the prompt did not reach the argv');

  // an engine argument sits among the options, never after the variadic flag
  assert.ok(launch.args.indexOf('--model') < flagAt, 'extraArgs would be eaten as tool rules');
});

test('THE DOCUMENTED `prompt` OPTION IS ACTUALLY EMITTED', () => {
  /*
   * It was in the JSDoc and not in the destructuring, so a caller that passed
   * one launched an agent with no task and got a usage error from the engine.
   * Absent is not zero: a silently dropped option reads as a working call.
   */
  const scope = permissionScope(PLACEMENT, [], { now: new Date().toISOString() });
  assert.ok(agentLaunch('claude-code', { scope, prompt: 'x' }).args.includes('x'));
  assert.equal(agentLaunch('claude-code', { scope }).args.includes('x'), false);
});

test('A DENIAL LIST THAT COULD NOT BE READ IS NULL, NOT AN EMPTY ONE', () => {
  /*
   * The distinction the whole live test rests on. `[]` means the engine
   * reported its refusals and there were none. `null` means nothing could be
   * read -- and reporting that as a clean sheet is exactly how a blocked run
   * passes for a working one.
   */
  assert.equal(readDenials('claude-code', 'not json at all'), null);
  assert.equal(readDenials('claude-code', JSON.stringify({ result: 'ok' })), null,
    'a result with no permission_denials key cannot report zero denials');
  assert.deepEqual(readDenials('claude-code', JSON.stringify({ permission_denials: [] })), []);
  assert.deepEqual(
    readDenials('claude-code', JSON.stringify({
      permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'git add -A' } }],
    })),
    [{ tool: 'Bash', command: 'git add -A' }],
  );
  assert.throws(() => readDenials('not-an-engine', '{}'), /unknown engine/);
});

test('EVERY ENGINE DECLARES A BINARY, AND IT IS NOT THE ENGINE ID', () => {
  /*
   * `file: binary ?? engine` defaulted to "claude-code", which is not an
   * executable on any machine. Nothing caught it because nothing had spawned
   * the result.
   */
  const scope = permissionScope(PLACEMENT, [], { now: new Date().toISOString() });
  for (const engine of ENGINE_IDS) {
    const file = agentLaunch(engine, { scope }).file;
    assert.ok(file && !file.includes(' '), `${engine} has no binary`);
  }
  assert.equal(agentLaunch('claude-code', { scope }).file, 'claude');
});

// ── the live half ───────────────────────────────────────────────────────────

test('A REAL CODING AGENT LAUNCHES UNDER THE DERIVED SCOPE AND COMMITS UNATTENDED', async (t) => {
  if (!LIVE) {
    return t.skip('NOT CHECKED: set AGENTBRIDGE_LIVE_AGENT=1 to run a real coding agent. '
      + 'The flags in ENGINES are UNVERIFIED on this machine; the argv-shape gates above '
      + 'only prove the ordering, not that the engine accepts the flags.');
  }
  const why = await engineAnswers();
  if (why) {
    return t.skip(`NOT CHECKED: \`${BINARY}\` did not answer a trivial prompt (${why}). `
      + 'Nothing below ran, so "no prompt appeared" here would mean "no agent appeared".');
  }

  const { dir, sha } = await scratchRepo(t);
  const { scope, launch, r } = await launchLive(dir, PLACEMENT);

  // the precondition, asserted rather than assumed: this scope really does
  // grant the commit, so a commit below is the allow-list working
  assert.ok(launch.rules.includes('Bash(git commit:*)'), 'the scope never granted a commit');
  assert.ok(scope.deny.some((d) => d.command.file === 'git' && d.command.args[0] === 'push'),
    'a scope that denies nothing cannot show the allow-list is load-bearing');

  assert.equal(r.killed, false, `the engine was shot at its deadline: ${r.error}`);
  assert.equal(r.code, 0, `the engine exited ${r.code}: ${(r.stderr || '').slice(0, 400)}`);

  // WHAT THE ENGINE SAYS IT REFUSED. Null would mean unreadable, and unreadable
  // is not "nothing was refused".
  const denials = readDenials('claude-code', r.stdout);
  assert.notEqual(denials, null, 'the engine reported no machine-readable denial list');
  assert.deepEqual(denials, [], `the agent was blocked on: ${JSON.stringify(denials)}`);

  // and the far end: the work is in git, not in a summary the agent wrote
  const head = await git(dir, 'rev-parse', 'HEAD');
  assert.notEqual(head, sha, 'no new commit was produced');
  assert.equal(readFileSync(path.join(dir, 'value.txt'), 'utf8').trim(), '2');
  assert.deepEqual((await git(dir, 'diff', '--name-only', `${sha}..HEAD`)).split('\n').filter(Boolean),
    ['value.txt']);
  assert.equal(await git(dir, 'status', '--porcelain'), '', 'the tree was left dirty');
});

test('AND A SCOPE THE GUARD NARROWS REALLY DOES STOP IT — WITH NO PROMPT TO SEE', async (t) => {
  if (!LIVE) {
    return t.skip('NOT CHECKED: without AGENTBRIDGE_LIVE_AGENT=1 the test above proves only '
      + 'that an argv was built. Whether the allow-list BINDS a real engine — the one '
      + 'question that makes the green above mean anything — is unverified here.');
  }
  const why = await engineAnswers();
  if (why) return t.skip(`NOT CHECKED: \`${BINARY}\` did not answer (${why}).`);

  /*
   * THE MUTATION, AND THE GUARD PRODUCES IT RATHER THAN A HAND-EDITED LIST.
   * The workspace is not disposable, so every write falls to OUTSIDE_WORKSPACE
   * and `git commit` leaves the allow-list by the policy's own reasoning. If a
   * commit still lands, the flags are decoration and the test above was green
   * for a reason that has nothing to do with this module.
   */
  const { dir, sha } = await scratchRepo(t);
  const narrowed = { ...PLACEMENT, isDisposable: false };
  const { launch, r } = await launchLive(dir, narrowed);

  assert.equal(launch.rules.includes('Bash(git commit:*)'), false,
    'the narrowed scope still grants a commit, so it mutates nothing');
  assert.ok(launch.rules.includes('Bash(npm test:*)'),
    'a scope that grants nothing would refuse to launch and prove something else');

  const denials = readDenials('claude-code', r.stdout);
  assert.notEqual(denials, null, 'the engine reported no machine-readable denial list');
  assert.ok(denials.length > 0, 'the engine ran a command the policy had removed from its scope');
  assert.ok(denials.some((d) => /^git\s+add/.test(d.command ?? '')),
    `expected the staging step to be refused, got ${JSON.stringify(denials)}`);

  // the far end again: nothing was committed
  assert.equal(await git(dir, 'rev-parse', 'HEAD'), sha, 'a commit landed outside the scope');

  /*
   * AND THE FINDING THIS FILE EXISTS FOR, ASSERTED SO IT CANNOT BE FORGOTTEN.
   *
   * Every signal the runner already had says this run was fine. The exit code
   * is 0 and the prose detector saw nothing, because a real engine does not
   * write "[y/n]" -- it writes a paragraph. An executor reading either one
   * files a worker that stopped dead as a clean run.
   *
   * If this assertion ever fails, that is GOOD NEWS and not a regression: the
   * engine started announcing itself in a shape the detector can see. Read the
   * denial list above either way; it is the signal that does not depend on
   * anybody's phrasing.
   */
  assert.equal(r.code, 0, 'the engine no longer exits 0 when blocked — re-read this test');
  assert.equal(r.interactivePrompt, null,
    'the prose detector now sees a real engine asking; the comment above is out of date');
});

// ── the tool boundary, against the real engine ──────────────────────────────

test('THE BRIDGE GUARD ON THE ENGINE\'S OWN TOOL BOUNDARY STOPS A COMMAND IT CHOSE', async (t) => {
  if (!LIVE) {
    return t.skip('NOT CHECKED: whether Claude Code actually CALLS a PreToolUse hook and '
      + 'HONOURS its deny is unverified without AGENTBRIDGE_LIVE_AGENT=1. '
      + 'test/agentToolBoundary.test.mjs covers the decision; only this covers the engine.');
  }
  const why = await engineAnswers();
  if (why) return t.skip(`NOT CHECKED: \`${BINARY}\` did not answer (${why}).`);

  const hookDir = mkdtempSync(path.join(tmpdir(), 'guardhook-'));
  t.after(() => rmSync(hookDir, { recursive: true, force: true }));
  const settings = path.join(hookDir, 'settings.json');
  const shim = path.resolve(import.meta.dirname, '..', 'bin', 'agentbridge-guard-hook.mjs');
  // from the module, not hand-rolled: a matcher typo in a second copy of this
  // wire format would pass this test against a hook the engine never called
  writeFileSync(settings, JSON.stringify(hookSettings(shim)));

  /*
   * THE LAUNCH SCOPE IS THE SAME IN BOTH RUNS AND IT GRANTS THE COMMIT. Only
   * the placement the HOOK sees differs. So whatever happens below cannot be
   * the allow-list talking -- the engine's own configuration says yes in both,
   * which is precisely the case launch-time scope structurally cannot cover:
   * a lease that expires after the agent started.
   */
  const scope = permissionScope(PLACEMENT, [], { now: new Date().toISOString() });
  assert.ok(agentLaunch('claude-code', { scope }).rules.includes('Bash(git commit:*)'),
    'the launch scope does not grant a commit, so this proves nothing about the hook');

  const runWith = async (placement) => {
    const { dir, sha } = await scratchRepo(t);
    /*
     * `--settings` goes through extraArgs and NOT appended to the argv, and the
     * first draft of this test is why: appending it put the flag after the `--`
     * terminator, where it is a positional argument and the hook never loaded.
     * The test had rediscovered the module's own bug from the other side.
     */
    const launch = agentLaunch('claude-code',
      { binary: BINARY, scope, prompt: TASK, extraArgs: ['--settings', settings] });
    const r = await execRun(launch.file, launch.args, {
      cwd: dir, timeoutMs: 300000,
      env: { ...process.env, AGENTBRIDGE_PLACEMENT: JSON.stringify(placement) },
    });
    return { dir, sha, r, head: await git(dir, 'rev-parse', 'HEAD') };
  };

  /*
   * THE POSITIVE FIRST, and it is load-bearing rather than ceremonial: a hook
   * that denied everything would make the negative below pass perfectly while
   * proving only that the agent had been crippled.
   */
  const good = await runWith(PLACEMENT);
  assert.equal(good.r.killed, false, 'the engine was shot at its deadline');
  assert.notEqual(good.head, good.sha, `the hook blocked a run it should have allowed: ${
    JSON.stringify(readDenials('claude-code', good.r.stdout))}`);
  assert.equal(readFileSync(path.join(good.dir, 'value.txt'), 'utf8').trim(), '2');

  // and now the same launch scope with a lease the Bridge no longer honours
  const stale = await runWith({ ...PLACEMENT, leaseValid: false });
  assert.equal(stale.r.killed, false, 'the engine was shot at its deadline');

  const denials = readDenials('claude-code', stale.r.stdout);
  assert.notEqual(denials, null, 'the engine reported no machine-readable denial list');
  assert.ok(denials.length > 0,
    'the engine ran commands the hook refused — a PreToolUse deny is not being honoured');
  assert.equal(stale.head, stale.sha, 'a commit landed under a lease the Bridge had refused');
});
