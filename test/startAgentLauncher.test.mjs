/**
 * THE LAUNCHER, GATED. b00d96e AND d0e3f88 SHIPPED WITH NO TEST AT ALL.
 *
 * Found by scripts/audit-auto.mjs pointed at its author's own commits:
 *
 *   b00d96e  SKIP   no test files touched (2 source file(s))
 *   d0e3f88  SKIP   no test files touched (2 source file(s))
 *
 * b00d96e added the launcher because nothing in the repository set
 * AGENTBRIDGE_AGENT_ID, so the SessionStart poll hook declined and exited 0 --
 * the watcher had never run once and the roster showed everyone offline while
 * they were working. d0e3f88 then fixed the launcher, because the first one
 * COULD NOT LAUNCH: it spawned claude under `npm run`, npm pipes stdin, claude
 * saw no TTY and came up headless with
 *
 *   Input must be provided either through stdin or as a prompt argument
 *
 * Danny hit that on the first use. Two commits about a thing being unusable,
 * neither with a check that it is usable.
 *
 * WHAT THESE TESTS PIN, and why each one is the real property rather than a
 * spelling of it:
 *
 *  - the script RUNS TO COMPLETION with stdin piped, which is exactly the
 *    condition that broke it. A reintroduced spawn-with-inherit either errors
 *    or hangs here, and both are caught.
 *  - the store it consults is AGENTBRIDGE_HOME, not the operator's real home.
 *    That is rule 21: before this, `known()` spelled out homedir() and so the
 *    roster it validated against was an accident of one machine, unreachable
 *    from any isolated context.
 *  - a typo is REFUSED, because a typo here does not fail -- it mints a second
 *    identity on the roster and work is routed by identity.
 *  - agent.cmd actually ASSIGNS the variable and invokes claude. Pinning the
 *    construct rather than a mention is the b7032cf lesson: that gate matched
 *    "npm-cli.js" inside its subject's own error message and passed while the
 *    workaround was gone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER = path.join(REPO, 'scripts', 'start-agent.mjs');

/**
 * An isolated store holding agent ids that exist on NO real machine, so a test
 * that accidentally reads the operator's registrations fails instead of
 * passing by coincidence.
 */
function storeWith(ids) {
  const home = mkdtempSync(path.join(tmpdir(), 'start-agent-home-'));
  mkdirSync(home, { recursive: true });
  writeFileSync(
    path.join(home, 'registrations.json'),
    JSON.stringify(ids.map((agent_id) => ({ agent_id, session_id: `s-${agent_id}` }))),
  );
  return home;
}

/** Never piped to anything, so the status is node's own. 20s catches a hang. */
function runLauncher(args, home) {
  const r = spawnSync(process.execPath, [LAUNCHER, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, AGENTBRIDGE_HOME: home },
  });
  return { status: r.status, signal: r.signal, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('the launcher consults AGENTBRIDGE_HOME, not the machine it is running on', () => {
  const home = storeWith(['zeta-not-a-real-agent']);
  try {
    const r = runLauncher(['definitely-not-registered'], home);

    assert.equal(r.status, 2, 'an id absent from the store must be refused');
    assert.match(r.out, /zeta-not-a-real-agent/,
      'it must list the ids from the ISOLATED store -- if this fails it read a different store');

    /*
     * The direction that actually matters. These are real ids in the
     * operator's ~/.agentbridge/registrations.json; seeing one here means the
     * launcher reached past AGENTBRIDGE_HOME into the real home, which is the
     * defect this test exists for.
     */
    for (const real of ['code-a', 'code-b', 'fixer']) {
      assert.doesNotMatch(r.out, new RegExp(`\\b${real}\\b`),
        `leaked "${real}" from the real home store: AGENTBRIDGE_HOME was not honoured`);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a known id runs to completion with stdin piped -- the condition that broke it', () => {
  const home = storeWith(['code-a']);
  try {
    const r = runLauncher(['code-a'], home);

    assert.notEqual(r.signal, 'SIGTERM', 'the launcher hung: it is trying to hold a terminal it does not own');
    assert.equal(r.status, 0, `expected a clean exit, got ${r.status}: ${r.out}`);

    /*
     * The exact failure Danny hit. It is claude's message, so matching it is
     * matching the real symptom rather than a proxy for it.
     */
    assert.doesNotMatch(r.out, /Input must be provided/,
      'claude was launched with piped stdin and came up headless -- d0e3f88 regressed');

    assert.match(r.out, /agent code-a/,
      'it must hand the operator the agent.cmd command that actually works');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('--print reports the variable whose absence kept the watcher from ever running', () => {
  const home = storeWith(['code-b']);
  try {
    const r = runLauncher(['code-b', '--print'], home);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /AGENTBRIDGE_AGENT_ID=code-b/,
      'the whole point of the launcher is this assignment; --print must state it exactly');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('--new lets a genuinely new agent through, so the guard is a reminder not a wall', () => {
  const home = storeWith(['code-a']);
  try {
    const refused = runLauncher(['brand-new-agent'], home);
    assert.equal(refused.status, 2, 'precondition: unknown is refused without --new');

    const allowed = runLauncher(['brand-new-agent', '--new'], home);
    assert.equal(allowed.status, 0,
      '--new must proceed: a new agent has to be startable or the check becomes an outage');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('no id, and an id that would escape the polls directory, are both refused', () => {
  const home = storeWith(['code-a']);
  try {
    assert.equal(runLauncher([], home).status, 2, 'no agent id must be refused');

    /*
     * This value becomes a FILENAME in the poll runner, so the shape check is
     * load-bearing rather than cosmetic.
     */
    for (const bad of ['../escape', 'a/b', '.hidden', '']) {
      const r = runLauncher([bad], home);
      assert.equal(r.status, 2, `"${bad}" must be refused: it becomes a filename in the poll store`);

      /*
       * WITH --new, OR THIS MEASURES THE WRONG GATE. Found by blind audit:
       * delete the SAFE shape check entirely and all six tests stayed green,
       * because a malformed id was being refused by the REGISTRY-MEMBERSHIP
       * check instead -- which this test cannot tell apart, since both exit 2.
       *
       * --new is what makes the difference observable: it stands the
       * membership check down, so SAFE is the only thing left between
       * "../escape" and a filename in the poll store. Without SAFE this line
       * exits 0 and prints `agent : ../escape`.
       */
      const forced = runLauncher([bad, '--new'], home);
      assert.equal(forced.status, 2,
        `"${bad}" must be refused by the SHAPE check even with --new, which stands the registry check down`);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('agent.cmd IS EXECUTED, and must really set the id and really land in the repo', () => {
  /*
   * THIS TEST RUNS agent.cmd. THE TWO VERSIONS BEFORE IT READ agent.cmd AS TEXT,
   * AND BOTH WERE HOLLOW.
   *
   * v1 matched against every non-`rem` line, so agent.cmd could ECHO the words
   * instead of doing them and the gate stayed green. v2 stripped `echo` lines
   * too -- and a blind audit then walked through it THIRTEEN more ways:
   *
   *     @echo / @rem prefixes      one character from the spelling v2 closed
   *     exit /b 0 after setlocal   the script runs NOTHING and the gate passes
   *     goto :eof / goto :label    same
   *     endlocal before claude     reverts the cd AND the variable
   *     if "1"=="2" ( ... )        both block and single-line forms
   *     caret line continuation    swallows the next line
   *     claude moved above the setup
   *
   * That is rule 8 exactly: an adversarial probe bounds nothing. v2 fixed the
   * five strings the prober happened to try. A batch file's meaning is its
   * CONTROL FLOW -- early exit, scope, labels, continuation -- and no amount of
   * pattern-matching source text can see it.
   *
   * So stop reading it and run it. A stub `claude` first on PATH reports what
   * it actually received; agent.cmd is invoked from a directory OUTSIDE the
   * repository, so a missing `cd /d "%~dp0"` cannot be masked by already being
   * in the right place. Every one of those eighteen mutations fails this by
   * construction, because each one changes what the stub prints.
   */
  const box = mkdtempSync(path.join(tmpdir(), 'agentcmd-exec-'));
  const elsewhere = mkdtempSync(path.join(tmpdir(), 'agentcmd-cwd-'));
  try {
    /*
     * The stub shadows the real claude via PATH. It must be .cmd so cmd.exe
     * resolves a bare `claude` to it, and it echoes the three things the
     * launcher exists to deliver.
     */
    writeFileSync(path.join(box, 'claude.cmd'),
      '@echo off\r\n'
      + 'echo STUB_ID=[%AGENTBRIDGE_AGENT_ID%]\r\n'
      + 'echo STUB_LANE=[%AGENTBRIDGE_LANE%]\r\n'
      + 'echo STUB_CWD=[%CD%]\r\n');

    const r = spawnSync(process.env.ComSpec || 'cmd.exe',
      ['/c', path.join(REPO, 'agent.cmd'), 'code-a', 'lane7'], {
        cwd: elsewhere,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, PATH: `${box}${path.delimiter}${process.env.PATH ?? ''}` },
      });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;

    /*
     * A NEGATIVE NEEDS THE POSITIVE FIRST (rule 5): prove claude was reached at
     * all before asserting anything about what it saw, or a script that
     * launches nothing satisfies every "must equal" below by vacuous absence.
     */
    assert.match(out, /STUB_ID=\[/,
      `agent.cmd never reached claude at all -- it launched nothing. Output:\n${out}`);

    assert.match(out, /STUB_ID=\[code-a\]/,
      'AGENTBRIDGE_AGENT_ID did not reach claude. Without it the SessionStart poll hook '
      + 'declines and exits 0: the watcher never runs and the roster shows this agent offline.');
    assert.match(out, /STUB_LANE=\[lane7\]/,
      'the second argument must reach claude as AGENTBRIDGE_LANE');

    /*
     * The cwd is the other half of b00d96e. Compared with realpath on both
     * sides because the temp dir and the repo can differ by 8.3 alias or case,
     * which is a property of this machine rather than of the launcher (rule 21).
     */
    const seen = /STUB_CWD=\[([^\]]*)\]/.exec(out);
    assert.ok(seen, `the stub did not report a cwd. Output:\n${out}`);
    assert.equal(
      realpathSync.native(seen[1]).toLowerCase(),
      realpathSync.native(REPO).toLowerCase(),
      'claude must start IN THE REPOSITORY, or it loads no .claude/settings.json and '
      + `therefore no guard, no Stop gate and no poll hook. Started in: ${seen[1]}`,
    );

    assert.notEqual(r.status, 2, 'a valid id must not hit the usage path');
  } finally {
    rmSync(box, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('agent.cmd with no argument prints usage and exits 2, rather than launching', () => {
  const box = mkdtempSync(path.join(tmpdir(), 'agentcmd-noarg-'));
  try {
    writeFileSync(path.join(box, 'claude.cmd'), '@echo off\r\necho STUB_LAUNCHED\r\n');
    const r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/c', path.join(REPO, 'agent.cmd')], {
      cwd: box, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, PATH: `${box}${path.delimiter}${process.env.PATH ?? ''}` },
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    assert.equal(r.status, 2, `no agent id must exit 2, got ${r.status}. Output:\n${out}`);
    assert.doesNotMatch(out, /STUB_LAUNCHED/,
      'it must not start a session with no identity -- that is how a second roster identity gets minted');
  } finally { rmSync(box, { recursive: true, force: true }); }
});

test('agent.cmd does not route through npm, which pipes stdin and starts claude headless', () => {
  /*
   * The one property that is genuinely about the TEXT rather than the effect:
   * executing it cannot distinguish "claude" from "npm exec claude" when a
   * stub answers to both. rem and echo lines are stripped because agent.cmd's
   * own prose explains why npm was abandoned, and a check matching that
   * explanation would be hollow gate 13 for the fifth time in this file.
   */
  const cmd = readFileSync(path.join(REPO, 'agent.cmd'), 'utf8');
  const executable = cmd
    .split(/\r?\n/)
    .filter((l) => !/^\s*@?\s*(rem\b|::)/i.test(l))
    .filter((l) => !/^\s*@?\s*echo\b/i.test(l))
    .join('\n');

  assert.doesNotMatch(executable, /\bnpm\b/i,
    'agent.cmd must not EXECUTE npm: npm pipes stdin and claude comes up headless, which is the bug d0e3f88 fixed');
});
