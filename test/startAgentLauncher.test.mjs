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
import { spawnSync, spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, realpathSync, existsSync, linkSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
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

test('agent.cmd IS EXECUTED, and must really set the id and really land in the repo', (t) => {
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
  /*
   * THIS TEST RUNS THE REAL agent.cmd, WHICH REGISTERS A WORKTREE BESIDE
   * THE REPO AND DOES NOT REMOVE IT. Every clone that runs this file left
   * another wt-<id> behind, which is the mechanism that manufactured the
   * stale worktrees now sitting on this machine -- and a stale one is what
   * makes the probe above fail for the wrong reason.
   *
   * So: note whether it existed BEFORE, and remove it afterwards only if
   * this run created it. In the shared checkout wt-code-a is a real agent's
   * workspace and must be left completely alone; in a fresh clone it never
   * pre-exists, so the clone cleans up after itself.
   */
  const agentWt = path.join(path.dirname(REPO), 'wt-code-a');
  const wtPreexisted = existsSync(agentWt);
  t.after(async () => {
    if (wtPreexisted || !existsSync(agentWt)) return;
    /*
     * THE FIRST VERSION OF THIS TRIED ONCE AND SILENTLY DID NOTHING. I
     * measured it in a clone: worktree left behind true, still registered
     * true. agent.cmd leaves a process holding the directory for a moment
     * after the test returns, so a single remove races it -- the same
     * mistake as the three-rmSync-calls-in-a-microsecond sweep, made again
     * one hook along.
     *
     * A cleanup that claims to work and does not is worse than none,
     * because the litter then has a paragraph saying it cannot exist.
     */
    for (let attempt = 0; attempt < 5; attempt += 1) {
      spawnSync('git', ['worktree', 'remove', '--force', agentWt], { cwd: REPO, encoding: 'utf8' });
      try { rmSync(agentWt, { recursive: true, force: true }); } catch { /* handle open */ }
      if (!existsSync(agentWt)) break;
      await new Promise((r) => { setTimeout(r, 200 * (attempt + 1)); });
    }
    spawnSync('git', ['worktree', 'prune'], { cwd: REPO, encoding: 'utf8' });
    if (existsSync(agentWt)) {
      process.stderr.write(`[startAgentLauncher] could not remove ${agentWt} -- it is litter, `
        + 'and a later run against it will fail on the missing .claude/settings.json\n');
    }
  });

  const box = mkdtempSync(path.join(tmpdir(), 'agentcmd-exec-'));
  const elsewhere = mkdtempSync(path.join(tmpdir(), 'agentcmd-cwd-'));
  /*
   * THE REPORT LIVES OUTSIDE `box`, BECAUSE `box` IS ON THE CHILD'S PATH.
   *
   * v5 put it at path.join(box, 'report.txt') and prepended box to PATH so
   * the stub claude.cmd would be found. A blind audit then took the first
   * PATH entry inside agent.cmd -- one `for /f "tokens=1 delims=;"` line --
   * and wrote the report itself: no cd, no set, no claude, 8 of 8 GREEN.
   * Telling the subject where the evidence goes is the same mistake as
   * telling it what to print, one variable further out.
   */
  /*
   * A RANDOM PREFIX, NOT A FIXED ONE. An auditor enumerated the vault with
   * one line -- for /d %%D in ("%TEMP%\agentcmd-vault-*") -- because
   * mkdtemp only randomises the SUFFIX. This removes that route on its own.
   * It does NOT make the vault unfindable: the path is still written into
   * box\claude.cmd, which the subject can read. See the long note below.
   */
  const vault = mkdtempSync(path.join(tmpdir(), `${Math.random().toString(36).slice(2, 10)}-`));
  const report = path.join(vault, 'report.txt');
  /* Generated here and NEVER exported to the subject. Its presence is the proof. */
  const nonce = `n-${Math.random().toString(16).slice(2)}-${Date.now()}`;
  /*
   * BOUND AND CLEANED UP. This was an inline mkdtemp in the child env, so
   * nothing ever removed it: an audit counted 117 stale agentcmd-home-*
   * directories on this machine against 0 leaked vaults.
   */
  const childHome = mkdtempSync(path.join(tmpdir(), 'agentcmd-home-'));
  try {
    /*
     * THE STUB REPORTS THROUGH A FILE, NOT THROUGH STDOUT, AND THAT IS THE
     * WHOLE POINT OF THIS VERSION.
     *
     * v3 ran agent.cmd and matched its combined stdout for STUB_ID=[code-a].
     * A blind audit then replaced the cd, both set lines and the claude
     * invocation with three `echo STUB_...` lines and an `exit /b 0` -- no
     * cd, no variable, no launch -- and the file stayed 8 of 8 GREEN. The
     * subject was printing the words the gate was looking for. Executing it
     * had narrowed the blind spot and not removed it, because the verdict was
     * still a regex over a string the subject controls.
     *
     * A file at a path the TEST invents and passes in by env is not a string
     * the launcher can produce by talking. agent.cmd never sees %STUB_REPORT%
     * except to pass it through, and it has no reason to write there. If the
     * report is absent, claude did not run -- whatever stdout says.
     */
    /*
     * THE REPORT PATH IS BAKED INTO THE STUB, NOT PASSED IN THE ENVIRONMENT.
     *
     * v4 passed it as STUB_REPORT in the child env -- which handed it to the
     * SUBJECT. A blind audit then wrote an agent.cmd with no cd, no set and
     * no claude that simply redirected three echo lines into %STUB_REPORT%
     * and exited 0: 8 of 8 GREEN, every assertion defeated at once, including
     * the existsSync positive control.
     *
     * So the channel was never unforgeable; it was a string the subject was
     * told. Fourth version of this gate, fourth spelling of one mistake --
     * the evidence was produced by the thing under test.
     *
     * Now the path is a literal inside the stub file the TEST writes, and the
     * stub reports a NONCE the test generates and never puts in the child's
     * environment.
     *
     * ═══ AND THAT CLAIM WAS STILL FALSE. READ THIS BEFORE WRITING v8. ═══
     *
     * This comment used to end: "agent.cmd cannot write to a path it is never
     * given, and cannot produce a nonce it never sees, so a report bearing
     * that nonce is proof the stub ran." Two independent blind audits
     * defeated it the same way, and they were right:
     *
     *   BOTH THE PATH AND THE NONCE ARE WRITTEN, IN PLAINTEXT, INTO
     *   box\claude.cmd -- and `box` is prepended to the child's PATH by this
     *   very test, because that is how the stub gets found.
     *
     * One `for /f "tokens=1 delims=;" %%A in ("%PATH%")` line finds box, one
     * `findstr` pulls out both secrets, and a launcher with no cd, no set and
     * no claude writes a perfect report: 8 of 8 green. One auditor also found
     * a second, independent route -- `%TEMP%\agentcmd-vault-*` was an
     * enumerable fixed prefix.
     *
     * STOP LOOKING FOR A BETTER HIDING PLACE. Six versions have now moved the
     * secret: into stdout, into the environment, into box, into a vault, into
     * the stub's text. The move fails every time for a structural reason:
     *
     *   The stub must be ON THE CHILD'S PATH to be launched at all, so the
     *   subject can always read it. Anything the stub needs in order to write
     *   the report -- where to write, what to write -- is therefore readable
     *   by the subject, which can then write the report itself. There is no
     *   channel that reaches the stub and not the launcher, because the
     *   launcher is the stub's parent and owns its whole environment.
     *
     * SO STATE THE PROPERTY THIS GATE ACTUALLY HAS, rather than overclaiming
     * a seventh time (rule 8: an adversarial probe bounds nothing, and the
     * answer is to fix the matcher -- here the matcher cannot be fixed, so
     * the bound gets written down instead):
     *
     *   IT CATCHES A LAUNCHER THAT DOES NOT DO THE WORK. Drop the cd, drop
     *   either set, drop the claude invocation, and the report is absent or
     *   wrong, because the stub is the only thing that would have written it.
     *   That is the failure this gate exists for -- the day-long outage came
     *   from a launcher that quietly stopped setting AGENTBRIDGE_AGENT_ID,
     *   not from one that forged evidence.
     *
     *   IT DOES NOT CATCH DELIBERATE FORGERY, and cannot. A launcher that
     *   reads claude.cmd and writes the report itself passes. Nothing in a
     *   shared filesystem can prevent that.
     *
     * WHERE THE EVIDENCE FOR THAT COMES FROM, stated because it is not mine.
     * Two independent auditors demonstrated the forgery, one with a full
     * md5 ledger of the swapped-in agent.cmd and 8 of 8 green, and their two
     * routes differed:
     *
     *   route A  read the nonce from the stub, find the vault by enumerating
     *            a FIXED prefix under the child's TEMP.  <- closed above, by
     *            randomising the prefix. That auditor's exact script no
     *            longer finds the vault.
     *   route B  read BOTH the path and the nonce out of the stub on PATH.
     *            NOT closed, and not closable -- see above.
     *
     * I tried twice to reproduce route B here and both attempts died on cmd
     * quoting, so the unforgeability claim is retracted on THEIR measurement
     * rather than on a demonstration of my own. That is worth saying plainly:
     * a failed reproduction is not counter-evidence, and treating my own two
     * broken batch scripts as proof the gate holds would be exactly the
     * self-certification rule 20 exists to stop.
     *
     * Anyone tempted to close this properly: the only sound direction left is
     * to stop asking the child for evidence and observe the process tree from
     * outside -- confirm a real `claude` process existed with the expected
     * parent, cwd and environment. That is a different and much heavier test,
     * and it should be a deliberate decision, not a seventh patch.
     */
    writeFileSync(path.join(box, 'claude.cmd'),
      '@echo off\r\n'
      + `> "${report}" echo NONCE=[${nonce}]\r\n`
      + `>>"${report}" echo ID=[%AGENTBRIDGE_AGENT_ID%]\r\n`
      + `>>"${report}" echo LANE=[%AGENTBRIDGE_LANE%]\r\n`
      + `>>"${report}" echo CWD=[%CD%]\r\n`);

    const r = spawnSync(process.env.ComSpec || 'cmd.exe',
      ['/c', path.join(REPO, 'agent.cmd'), 'code-a', 'lane7'], {
        cwd: elsewhere,
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          /*
           * AGENTBRIDGE_HOME is isolated here even though agent.cmd touches no
           * store today. The moment it gains a register-session call these two
           * tests would write into the operator's live store, which is rule 21
           * and is a defect this repository has already paid for twice.
           */
          AGENTBRIDGE_HOME: childHome,
          PATH: `${box}${path.delimiter}${process.env.PATH ?? ''}`,
        },
      });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;

    /*
     * A NEGATIVE NEEDS THE POSITIVE FIRST (rule 5). The report's EXISTENCE is
     * the proof claude ran at all; every assertion after it would pass
     * vacuously against a launcher that started nothing.
     */
    assert.ok(existsSync(report),
      `agent.cmd never reached claude -- no stub report was written. stdout was:\n${out}`);
    const said = readFileSync(report, 'utf8');

    /*
     * THE NONCE IS THE POSITIVE CONTROL, AND v5 NEVER ASSERTED IT.
     *
     * v5's commit message said "the positive control is now the nonce, not
     * the file's existence". It was not: the assertion went into a patch that
     * silently did not apply and I did not check, so the nonce was generated,
     * echoed by the stub, and compared to nothing. A blind audit found four
     * references to it and no assertion. I then repeated the same silent-patch
     * mistake twice more while fixing it, which is why this one went in with
     * an editor rather than a script.
     *
     * The subject never sees this value, so a report carrying it is evidence
     * the STUB wrote the file, not merely that a file exists.
     */
    assert.ok(said.includes(`NONCE=[${nonce}]`),
      `the report does not carry the stub's nonce, so it was not written by claude. Report:\n${said}`);

    assert.match(said, /ID=\[code-a\]/,
      'AGENTBRIDGE_AGENT_ID did not reach claude. Without it the SessionStart poll hook '
      + 'declines and exits 0: the watcher never runs and the roster shows this agent offline.');
    assert.match(said, /LANE=\[lane7\]/,
      'the second argument must reach claude as AGENTBRIDGE_LANE');

    const seen = /CWD=\[([^\]]*)\]/.exec(said);
    assert.ok(seen, `the stub reported no cwd. Report was:\n${said}`);

    /*
     * THE PROPERTY IS "somewhere that loads the guard", NOT "the repo root",
     * and this assertion said the second for a while after it stopped being
     * true. 224c1b8 gave every agent its own worktree and agent.cmd now ends
     * with `cd /d "%AGENT_WT%"`, so claude legitimately starts in
     * <home>/wt-code-a. The test kept comparing against REPO and had been
     * red ever since -- a stale assertion, not a regression in the launcher.
     *
     * Its own message says what it cares about: ".claude/settings.json, and
     * therefore the guard, the Stop gate and the poll hook". A git worktree
     * carries that file, so the thing to check is that the file is THERE,
     * which is true of the repo root and of any worktree of it and false of
     * the home directory -- the case that actually caused the outage.
     */
    const startedIn = realpathSync.native(seen[1]);
    assert.ok(existsSync(path.join(startedIn, '.claude', 'settings.json')),
      'claude started somewhere that carries no .claude/settings.json, so it loads no guard, '
      + `no Stop gate and no poll hook. Started in: ${startedIn}`);

    /*
     * And it must be the repository or a worktree of it, not merely any
     * directory that happens to have a .claude -- otherwise the check above
     * could be satisfied by a decoy.
     */
    /*
     * A TREE git CANNOT DESCRIBE IS A FAILURE, NOT AN EXCEPTION, and the
     * version that let execFileSync throw manufactured a false defect.
     *
     * An auditor hit it: agent.cmd REUSES an existing wt-<id> beside the
     * repo, and against a stale one whose backing clone had been deleted
     * git answered "fatal: not a git repository: (NULL)", status 128. The
     * test ERRORED instead of failing, which reads like a defect in the
     * launcher rather than litter on the machine -- rule 21, and the
     * previous assertion was a pure string compare that could not throw at
     * all, so this is a failure mode the fix introduced.
     */
    const commonDirOf = (cwd) => {
      const r = spawnSync('git', ['rev-parse', '--git-common-dir'],
        { cwd, encoding: 'utf8' });
      if (r.status !== 0) {
        return { ok: false, why: String(r.stderr ?? r.error?.message ?? '').trim() || `git exited ${r.status}` };
      }
      return { ok: true, dir: String(r.stdout).trim() };
    };

    const started = commonDirOf(startedIn);
    assert.ok(started.ok,
      `git cannot describe the directory claude started in (${startedIn}): ${started.why}. `
      + 'If that path is a leftover worktree from an earlier run whose clone is gone, this is '
      + 'litter on the machine and not a defect in agent.cmd -- remove it and run again');
    const here = commonDirOf(REPO);
    assert.ok(here.ok, `git cannot describe the repository itself: ${here.why}`);
    const gitCommon = started.dir;
    const repoCommon = here.dir;
    assert.equal(
      realpathSync.native(path.resolve(startedIn, gitCommon)).toLowerCase(),
      realpathSync.native(path.resolve(REPO, repoCommon)).toLowerCase(),
      `claude started outside this repository and its worktrees: ${startedIn}`,
    );

    /*
     * EXACTLY 0, NOT MERELY "NOT 2". The previous version asserted !== 2, so
     * appending `exit /b 1` after claude -- a launcher that reports failure on
     * every successful session -- survived. So did `exit /b 0`, which SWALLOWS
     * claude's status and makes every session look successful.
     */
    assert.equal(r.status, 0, `a successful launch must exit 0, got ${r.status}. Output:\n${out}`);
  } finally {
    rmSync(box, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
    rmSync(childHome, { recursive: true, force: true });
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
   * AN echo LINE IS AN EXECUTABLE LINE, AND STRIPPING IT WAS THE HOLE.
   *
   * FIFTH VERSION. The four before it argued about the MATCHER; an auditor
   * showed the matcher was never the weak part -- the INPUT was. Every
   * version fed on agent.cmd with rem, :: AND echo lines removed, and an
   * echo line is not a comment. cmd.exe prints the echo payload and then
   * RUNS whatever follows an unquoted separator on the same line.
   *
   * Measured here, one probe file per form, a stub npm.cmd on PATH:
   *
   *     rem  A & npm run TAIL        inert     (rem eats the rest of the line)
   *     :: B & npm run TAIL          inert
   *     echo C & npm run TAIL        NPM RAN
   *     @echo D & npm run TAIL       NPM RAN
   *     echo.& npm run TAIL          NPM RAN
   *     echo E | npm run TAIL        NPM RAN
   *     echo F && npm run TAIL       NPM RAN
   *     echo   see: npm run x        inert     (no separator: printed only)
   *
   * So v4's headline -- "ANY MENTION OF npm IN AN EXECUTABLE LINE IS
   * REFUSED" -- was false, and an agent.cmd carrying
   * "echo warming up & call npm run agent:check" passed 8/8 while really
   * running npm and really launching claude. The gate was green on exactly
   * the thing it exists to stop.
   *
   * AND MY "COST TODAY IS ZERO" WAS MEASURED WRONG. I reported agent.cmd's
   * three npm mentions as "all three in comments". Line 35 is an echo
   * statement, not a comment. The zero-cost result came from discarding an
   * executable line and recording it as prose -- the same mistake, inside
   * the evidence for the claim.
   *
   * THE FIX IS IN THE INPUT, NOT THE PATTERN. Split each line into
   * STATEMENTS on unquoted & && and |, then drop the ones that cannot run
   * anything: a rem/:: line disappears entirely because it really does eat
   * its separators, and an echo STATEMENT disappears while the rest of its
   * line survives. What is left is what cmd would execute, and that is what
   * the matcher sees.
   *
   * The stripping still exists for the reason it always did -- agent.cmd
   * explains in prose why npm was abandoned, and matching a subject's own
   * commentary is hollow gate 13. It is now narrowed to the part that is
   * genuinely inert, which is a property I measured rather than assumed.
   */
  const cmd = readFileSync(path.join(REPO, 'agent.cmd'), 'utf8');

  /*
   * CMD.EXE'S CARET PHASE, WHICH v5 DID NOT MODEL AND AN AUDITOR USED.
   *
   * The caret is removed BEFORE cmd decides what the command name is, so a
   * launcher can run npm without the file containing the string "npm" --
   * and five rounds of this matcher, all operating on the raw text, could
   * not see it. Rule 8: the probe does not bound the hole, the matcher does.
   *
   * MEASURED, not read off the parser documentation. A stub npm.cmd on PATH
   * writes a marker file, so "did npm run" is a fact about the process
   * table rather than about a string. Eleven spellings through cmd.exe:
   *
   *     npm run x                      RAN
   *     "npm" run x                    RAN
   *     n^pm run x                     RAN    <- caret removed from the name
   *     n^p^m run x                    RAN
   *     n"p"m run x                    RAN    <- quotes split the name
   *     n^ <newline> pm run x          RAN    <- caret at EOL joins the lines
   *     echo warming & npm run x       RAN
   *     set "N=npm" / call %N% run x   RAN
   *
   *     "n^pm" run x                   no     <- inside quotes the caret is LITERAL
   *     echo a ^& npm run x            no     <- the escaped & is not a separator
   *     rem npm^ <newline> npm run x   no     <- rem swallows the joined line too
   *
   * THE LAST THREE ARE WHY THIS IS A MODEL AND NOT A STRIPPER. Deleting
   * every caret would catch the first six and then refuse all three of
   * these, which run nothing -- a gate red on an innocent launcher is one
   * people switch off (rule 16). The caret means different things inside
   * quotes, before a separator and at end of line, so all three are
   * represented.
   */
  const CARET_PHASE = (text) => {
    const out = [];                       // { c, esc, quote }
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      if (c === '"') { quoted = !quoted; out.push({ c, esc: false, quote: true }); continue; }
      if (!quoted && c === '^') {
        const next = text[i + 1];
        if (next === undefined) continue;                  // a trailing caret vanishes
        if (next === '\r' || next === '\n') {              // line continuation
          i += (next === '\r' && text[i + 2] === '\n') ? 2 : 1;
          continue;
        }
        out.push({ c: next, esc: true, quote: false });    // literal, never a separator
        i += 1;
        continue;
      }
      out.push({ c, esc: false, quote: false, inQuote: quoted });
    }
    return out;
  };

  /** The text cmd would match a command NAME against: quote marks removed. */
  const spell = (chars) => chars.filter((x) => !x.quote).map((x) => x.c).join('');

  /** What cmd.exe would actually run: statements, minus the inert ones. */
  /*
   * VARIABLE INDIRECTION, WHICH THE CARET FIX LEFT OPEN AND AN AUDITOR
   * WALKED THROUGH. v6 modelled cmd.exe's escape phase and stopped there;
   * cmd expands %VAR% before it reads the command name just as surely as it
   * removes a caret. MEASURED through a real cmd.exe with a marker-writing
   * stub npm.cmd -- every one of these RAN npm while the matcher said the
   * text was clean:
   *
   *     set A=n / set B=pm / call %A%%B% run x       NPM RAN
   *     set A=n / set B=pm / %A%%B% run x            NPM RAN   (no call)
   *     set P=n / set Q=p / set R=m / %P%%Q%%R%      NPM RAN
   *     set V=np / set V=%V%m / call %V% run x       NPM RAN   (self-append)
   *     setlocal enabledelayedexpansion
   *       set A=n / set B=pm / call !A!!B! run x     NPM RAN   (delayed)
   *
   * v6's own table listed `set "N=npm" / call %N%` as RAN, and the matcher
   * caught it only INCIDENTALLY -- the literal "npm" survives in the `set`
   * line. Split across two variables and nothing is left to match. That is
   * rule 8 again: the caret was fixed at the matcher and the indirection
   * class was extended by one example.
   *
   * The delayed form is expanded too, though `!A!` is literal without
   * `setlocal enabledelayedexpansion`. Over-approximating costs a false
   * refusal only for a launcher that writes `!NAME!` AND defines NAME, and
   * an over-refusal here is visible immediately.
   *
   * NOT CLOSED, AND SAID SO RATHER THAN DISCOVERED LATER: a value read from
   * a FILE or from the environment (`set /p`, `for /f`) is not derivable
   * from the text, and no static matcher can be. The negative control
   * below (`%A%%B%hing` -> `nothing`) is there so the expansion cannot
   * quietly start refusing everything instead.
   */
  const expandVars = (st, vars) => {
    let out = st;
    for (let pass = 0; pass < 8; pass += 1) {
      const next = out.replace(/[%!]([A-Za-z_][A-Za-z0-9_]*)[%!]/g,
        (whole, name) => (vars.has(name.toUpperCase()) ? vars.get(name.toUpperCase()) : whole));
      if (next === out) break;
      out = next;
    }
    return out;
  };

  const executableStatements = (text) => {
    const kept = [];
    /* set NAME=VALUE, carried across statements the way cmd carries it. */
    const vars = new Map();

    /* Lines, split only on newlines the caret phase left standing. */
    const lines = [[]];
    for (const x of CARET_PHASE(text)) {
      if (x.c === '\n' && !x.esc) { lines.push([]); continue; }
      if (x.c === '\r' && !x.esc) continue;
      lines[lines.length - 1].push(x);
    }

    for (const lineChars of lines) {
      const line = spell(lineChars).replace(/^\s*@?\s*/, '');
      /* rem and :: swallow the remainder of the line, separators included. */
      if (/^(?:rem\b|::)/i.test(line)) continue;

      /* Split on & or | that are neither quoted nor caret-escaped. */
      const parts = [[]];
      let quoted = false;
      for (const x of lineChars) {
        if (x.quote) { quoted = !quoted; parts[parts.length - 1].push(x); continue; }
        if (!quoted && !x.esc && (x.c === '&' || x.c === '|')) { parts.push([]); continue; }
        parts[parts.length - 1].push(x);
      }

      for (const part of parts) {
        const raw = spell(part).replace(/^\s*@?\s*/, '').trim();
        if (raw === '') continue;
        if (/^(?:rem\b|::)/i.test(raw)) continue;

        /* Expansion happens BEFORE the assignment is recorded, so that
         * `set V=%V%m` reads the OLD V, exactly as cmd does. */
        const st = expandVars(raw, vars);

        const assign = /^set\s+(?:\/[aA]\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(st);
        if (assign) vars.set(assign[1].toUpperCase(), assign[2].trim());

        /* "echo whatever" and "echo." PRINT their payload; they run nothing. */
        if (/^echo(?:\b|\.)/i.test(st)) continue;
        kept.push(st);
      }
    }
    return kept.join('\n');
  };

  const executable = executableStatements(cmd);

  /*
   * ONE MATCHER, AND IT IS A SUBSTRING ON PURPOSE. v4 shipped two of
   * different strength -- a word-boundary RUNS_NPM plus a bare /npm/i
   * assertion underneath it -- so the documented rule was weaker than the
   * shipped behaviour, and pnpm was refused by accident rather than by
   * decision. A substring is the honest version of fail-closed: pnpm and
   * the other run-script wrappers are the same architecture and the same
   * headless risk, so catching them is the outcome we want, stated rather
   * than stumbled into.
   */
  const RUNS_NPM = /npm/i;

  assert.doesNotMatch(executable, RUNS_NPM,
    'agent.cmd must not run npm: npm pipes stdin and claude comes up headless, which is the bug '
    + 'd0e3f88 fixed. This gate fails CLOSED on the token -- see the note above for what that '
    + 'does and does not bound.');

  /* Every spelling four auditors demonstrated, plus the echo-chained ones. */
  for (const runsIt of [
    'npm run start-agent',
    'call npm test',
    'a && npm exec claude',
    '@npm.cmd run x',
    'cmd /c npm run start-agent',
    'cmd.exe /c npm test',
    'start /b npm run agent',
    'if exist claude.cmd npm run x',
    'powershell -c "npm run x"',
    "for /f %%i in ('npm run x') do echo %%i",
    '"C:\\Program Files\\nodejs\\npm.cmd" run start-agent',
    '%APPDATA%\\npm\\npm.cmd run x',
    'npm frobnicate',
    'npm --silent run start-agent',
    'npm --prefix "%~dp0" run agent',
    'npm -s run agent',
    '"npm" run start-agent',
    'npm.ps1 run agent',
    'node "%APPDATA%\\npm\\node_modules\\npm\\bin\\npm-cli.js" run agent',
    /* variable indirection, each MEASURED through a real cmd.exe to run npm */
    'set A=n\r\nset B=pm\r\ncall %A%%B% run x',
    'set A=n\r\nset B=pm\r\n%A%%B% run x',
    'set P=n\r\nset Q=p\r\nset R=m\r\ncall %P%%Q%%R% run x',
    'set V=np\r\nset V=%V%m\r\ncall %V% run x',
    'setlocal enabledelayedexpansion\r\nset A=n\r\nset B=pm\r\ncall !A!!B! run x',
    /* the caret and quote spellings, each MEASURED to execute npm */
    'n^pm run x',
    'n^p^m run x',
    'n"p"m run x',
    'n^\r\npm run x',
    '"n^pm" run x & npm run y',
    /* the echo-chained forms, each MEASURED above to execute npm */
    'echo warming up & npm run start-agent',
    'echo warming up & call npm run agent:check',
    '@echo off & npm run start-agent',
    'echo.& npm run start-agent',
    'echo x | npm run start-agent',
    'echo x && npm run start-agent',
  ]) {
    assert.match(executableStatements(runsIt), RUNS_NPM,
      `"${runsIt}" RUNS npm and must be refused`);
  }

  /*
   * INERT BY MEASUREMENT, so they must survive the stripping and NOT match
   * -- otherwise the gate is red on a launcher that runs nothing, and a
   * permanently red gate is one people switch off (rule 16).
   */
  for (const inert of [
    'rem  see: npm run agent:check',
    ':: npm is deliberately not used',
    'rem  A & npm run TAIL',
    'echo   Run  npm run agent:check -- %1 --print',
    /* MEASURED inert: expansion must not turn into refusing everything */
    'set A=n\r\nset B=ot\r\ncall %A%%B%hing run x',
    'set A=n\r\ncall %A%ode --version',
    /* MEASURED inert: the caret means something different in each of these */
    '"n^pm" run x',
    'echo a ^& npm run x',
    'rem npm^\r\nnpm run x',
  ]) {
    assert.doesNotMatch(executableStatements(inert), RUNS_NPM,
      `"${inert}" executes nothing and must be allowed`);
  }

  /*
   * ═══ AND THIS IS THE RULE THAT ACTUALLY BOUNDS IT ═══
   *
   * THE npm MATCHER ABOVE HAS NOW BEEN OUT-SPELLED THREE TIMES: five
   * literal forms, then the caret, then variable indirection -- and an
   * auditor broke the indirection fix too, with six more spellings it
   * MEASURED running npm through a real cmd.exe:
   *
   *     set A=nqm            / call %A:q=p% run x      substitution modifier
   *     set A=xxnpm          / call %A:~2% run x       substring modifier
   *     set "A-1=n"          / call %A-1%%A-2% run x   hyphen in the name
   *     set "x.1=n"          / call %x.1%%x.2% run x   dot in the name
   *     call set "A=n"       / call %A%%B% run x       assignment behind call
   *     for %%v in (n) do set A=%%v / call %A%%B%      assignment in a for body
   *
   * I reproduced all six, plus the negative control staying inert. Every one
   * is derivable from the text, so none is excused by the "a value read from
   * a file or the environment is not derivable" bound I wrote.
   *
   * EXTENDING THE REGEX AGAIN WOULD BE EXTENDING BY EXAMPLE A FOURTH TIME,
   * which is precisely what rule 8 forbids and what the last three rounds
   * each did. cmd's expansion is not a thing a pattern wins against.
   *
   * SO THE QUESTION CHANGES, exactly as it did for the npm flag rail: stop
   * asking "does this text run npm" and ask "does this launcher ever put an
   * EXPANSION where the command name goes". It does not need to, and every
   * one of the nine spellings across three rounds does -- that is not a
   * coincidence, it is the only way to hide a command name in text.
   *
   * agent.cmd needs exactly two external programs, both written literally:
   * node, inside the for /f that resolves the worktree, and claude. cd, set,
   * if, for, echo and exit are builtins and run nothing. So a variable in
   * command position is not a thing this file has any reason to contain, and
   * refusing it costs the launcher nothing it currently does.
   */
  const COMMAND_POSITIONS = (statement) => {
    const out = [];
    const push = (tok) => { if (tok) out.push(tok); };
    const firstWord = (text) => (/^\s*([^\s(]+)/.exec(text ?? '') ?? [])[1];

    /* The statement's own command, and anything behind `call`. */
    let head = statement.trim();
    while (/^call\s+/i.test(head)) head = head.replace(/^call\s+/i, '');
    push(firstWord(head));

    /* for /f ... in ('CMD') do CMD : both inner positions are commands. */
    const inClause = /\bin\s*\(\s*'([^']*)'/i.exec(statement);
    if (inClause) push(firstWord(inClause[1]));
    const doClause = /\bdo\s+(.*)$/i.exec(statement);
    if (doClause) {
      let body = doClause[1].trim();
      while (/^call\s+/i.test(body)) body = body.replace(/^call\s+/i, '');
      push(firstWord(body));
    }
    return out;
  };

  const EXPANSION = /[%!]/;

  test_commandPositionsAreLiteral: {
    const offenders = [];
    for (const statement of executable.split('\n')) {
      if (statement.trim() === '') continue;
      for (const cmdToken of COMMAND_POSITIONS(statement)) {
        if (EXPANSION.test(cmdToken)) offenders.push(`${cmdToken}   in:  ${statement.trim()}`);
      }
    }
    assert.deepEqual(offenders, [],
      'agent.cmd puts a variable expansion where the command name goes. That is the only way to '
      + 'spell a command name so this file cannot read it, and every evasion found in three rounds '
      + 'of the npm matcher needed it. Write the program name literally:\n  '
      + offenders.join('\n  '));
  }

  /*
   * RULE 1 FOR THE RULE ITSELF. Six spellings that defeated the npm matcher,
   * each MEASURED to run npm, must all be caught by command position alone --
   * and the shapes the launcher legitimately uses must not be.
   */
  for (const runsIt of [
    'set A=nqm\r\ncall %A:q=p% run x',
    'set A=xxnpm\r\ncall %A:~2% run x',
    'set "A-1=n"\r\nset "A-2=pm"\r\ncall %A-1%%A-2% run x',
    'set "x.1=n"\r\nset "x.2=pm"\r\ncall %x.1%%x.2% run x',
    'call set "A=n"\r\ncall set "B=pm"\r\ncall %A%%B% run x',
    'for %%v in (n) do set A=%%v\r\nset B=pm\r\ncall %A%%B% run x',
    'set A=n\r\nset B=pm\r\ncall %A%%B% run x',
  ]) {
    /*
     * EITHER RULE MAY CATCH IT, and which one does is the interesting part.
     * The expansion-aware matcher resolves the spellings it can model and
     * the command-position rule catches the ones it cannot: %A%%B% expands
     * to a literal npm and the first sees it, while %A:q=p% and the
     * hyphenated names are unmodellable and only the second does.
     *
     * The claim is the DISJUNCTION. Asserting either rule alone is how the
     * previous three rounds each looked closed.
     */
    const expanded = executableStatements(runsIt);
    const byMatcher = RUNS_NPM.test(expanded);
    const byPosition = expanded.split(String.fromCharCode(10))
      .some((st) => COMMAND_POSITIONS(st).some((c) => EXPANSION.test(c)));
    assert.equal(byMatcher || byPosition, true,
      `this spelling runs npm and neither rule caught it: ${JSON.stringify(runsIt)}`);
  }

  for (const legitimate of [
    'cd /d "%~dp0"',
    'set "AGENTBRIDGE_AGENT_ID=%~1"',
    'if not "%~2"=="" set "AGENTBRIDGE_LANE=%~2"',
    'cd /d "%AGENT_WT%"',
    String.raw`for /f "delims=" %%p in ('node "%~dp0scripts\agent-worktree.mjs" "%AGENTBRIDGE_AGENT_ID%"') do set "AGENT_WT=%%p"`,
    'claude',
  ]) {
    const statements = executableStatements(legitimate).split('\n');
    const caught = statements.some((st) => COMMAND_POSITIONS(st).some((c) => EXPANSION.test(c)));
    assert.equal(caught, false,
      `a shape the launcher legitimately uses was refused, which is an outage (rule 16): ${legitimate}`);
  }

  /*
   * THE SPLITTER IS THE LOAD-BEARING PART NOW, so it is asserted directly on
   * fixtures rather than inferred from agent.cmd's current contents. v4
   * asserted that agent.cmd DOES discuss npm as a precondition, which made
   * MENTIONING npm a requirement -- so deleting the historical prose, a
   * legitimate cleanup, turned the gate red. An auditor measured that too.
   * Nothing here depends on what agent.cmd happens to say today.
   */
  assert.equal(executableStatements('echo hello & goodbye'), 'goodbye',
    'the echo payload is dropped and the chained command survives');
  assert.equal(executableStatements('rem hello & goodbye'), '',
    'a rem line disappears entirely, separators included');
  assert.equal(executableStatements('echo "a & b"'), '',
    'a separator inside quotes is literal, so this is one echo statement');
});

test('THE PROCESS TABLE, NOT THE REPORT: a forged report does not prove claude ran', async (t) => {
  /*
   * THE EVIDENCE CHANNEL THE SUBJECT CANNOT WRITE.
   *
   * Five versions of the token matcher, four auditors, and the standing
   * conclusion was that a launcher which writes the report itself cannot be
   * caught -- because the stub must be on the child's PATH to be launched,
   * so the subject can always read whatever the stub needs.
   *
   * That is true of FILES and it was the wrong conclusion. It only holds
   * while the evidence is something written. The OS knows whether a process
   * existed, agent.cmd does not author the process table, and a forged
   * report cannot put a pid in it.
   *
   * So the gate stops relying on the report alone. The report still proves
   * cwd and the environment, which the process table does not expose; the
   * process table proves the launch, which the report cannot. Neither is
   * sufficient and together they cover what each other misses.
   *
   * MEASURED before writing this, three launchers through the same harness:
   *
   *     real     cd + set + claude   -> claude LAUNCHED (new pid)
   *     hollow   exit /b 0           -> NO claude process appeared
   *     forger   writes the report,
   *              launches nothing    -> NO claude process appeared
   *
   * The forger is the exact shape that defeated v4 with 8 of 8 green.
   *
   * ONLY PIDS NEW SINCE THIS LAUNCH COUNT. The first version of this probe
   * saw the previous run's still-live grandchild and reported the HOLLOW
   * launcher as having launched claude -- a stale observation, the same
   * class of error as measuring a dirty worktree. The baseline is taken
   * after reaping, and the stub is reaped again afterwards.
   */
  /*
   * C-3: box AND home LOSE THE PREFIX TOO, and the comment that said
   * "neither literal appears anywhere for a launcher to match on" was only
   * true of the image and the vault. box is the cwd, the head of PATH, and
   * the directory holding claude.cmd -- which names the vault image by
   * absolute path in plaintext. So %TEMP%\agentcmd-ptree-*\claude.cmd was
   * still a glob that finds this run's image, and the C-2 litter below
   * proves such directories survive.
   *
   * An auditor could not turn that into a forged pass, because livePids()
   * filters on this run's random image name and the descent check means a
   * launcher that starts it has in fact started a process. The property
   * held; the sentence was wider than what was asserted. Both are fixed
   * rather than only the sentence.
   */
  const nonce = () => randomBytes(9).toString('hex');
  const box = mkdtempSync(path.join(tmpdir(), `${nonce()}-`));
  const home = mkdtempSync(path.join(tmpdir(), `${nonce()}-`));
  /*
   * CLEANUP IS BEST-EFFORT AND SAYS SO. A launcher under test can leave a
   * detached process holding a handle on `box`, and rmSync then throws
   * EPERM -- which failed the whole test for a reason that has nothing to
   * do with what it asserts. A gate that goes red on its own tidying is one
   * people learn to ignore (rule 16).
   */
  /*
   * C-2: REAP FIRST, THEN SWEEP, AND WAIT BETWEEN ATTEMPTS.
   *
   * 15a90b3's message said "no leftover directories or processes after the
   * run". An auditor caught a run that left both behind, and its derived
   * explanation was right on both counts: node's t.after hooks run in
   * REGISTRATION order, so the sweeps were registered before reap() and ran
   * while a launcher-started process still held a handle on box; and the
   * retry loop fired three rmSync calls within microseconds, which cannot
   * outlast a handle that is about to close.
   *
   * It reproduced under concurrency and not on a solo run, which is why the
   * original claim looked true -- rule 21, in the probe rather than the
   * subject.
   *
   * One hook now, registered after reap exists, so the order is a fact about
   * this code rather than about hook registration. Cleanup stays best-effort:
   * a gate that goes red on its own tidying is one people ignore (rule 16).
   */
  const sweep = async (d) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { rmSync(d, { recursive: true, force: true }); return true; } catch { /* handle open */ }
      await new Promise((r) => { setTimeout(r, 150 * (attempt + 1)); });
    }
    return false;
  };

  /*
   * A DISTINCTLY NAMED IMAGE, derived from process.execPath rather than
   * built, so the process-table question has one unambiguous answer and
   * cannot collide with any other node on this machine (rule 21).
   */
  /*
   * NO LITERAL LEFT TO GLOB, and the previous version of this comment was
   * wrong about its own reasoning.
   *
   * It said the image now sat in "a third directory that is neither the cwd
   * nor on PATH" and treated that as a boundary -- having argued, four lines
   * earlier, that a random FILENAME was "obscurity, not a boundary". It had
   * replaced a random filename under the fixed prefix `claudeproc_` with a
   * random DIRECTORY under the fixed prefix `agentcmd-ptree-img-`: the same
   * class, one directory along. An auditor demonstrated it rather than
   * arguing it:
   *
   *     for /d %%d in ("%TEMP%\agentcmd-ptree-img-*") do
   *       for %%f in ("%%d\claudeproc_*.exe") do start "" "%%f"
   *
   *     AUDIT-PROBE tempglobber: pid=30160 timedOut=false  => PASSED THE GATE
   *
   * Both prefixes are gone. The directory and the image are named from
   * randomBytes, so neither literal appears anywhere for a launcher to match
   * on, and the tempglobber case below pins that.
   *
   * WHAT IS ACTUALLY THE BOUNDARY, since hiding is not one. The claim this
   * gate makes is "the launcher started a process rather than only writing a
   * file about one", and what establishes it is DESCENT: the observed process
   * must be a child of the launcher we spawned. A launcher determined to find
   * the image can read claude.cmd -- it has to be readable to be runnable --
   * and a launcher that reads the path and starts the image HAS started a
   * process, which is the thing being asserted. No test distinguishes
   * launching a program from launching that same program by another route.
   * Making the image hard to stumble upon is defence against an accident, not
   * the proof.
   */
  const image = `${nonce()}.exe`;

  const vault = path.join(tmpdir(), nonce());
  mkdirSync(vault, { recursive: true });
  const imagePath = path.join(vault, image);
  try { linkSync(process.execPath, imagePath); } catch { cpSync(process.execPath, imagePath); }

  /* The stub holds itself alive so the observation is deterministic, not a race. */
  writeFileSync(path.join(box, 'claude.cmd'),
    `@echo off\r\n"${imagePath}" -e "setInterval(() => {}, 50)"\r\n`);

  const ps = (script) => spawnSync('powershell', ['-NoProfile', '-Command', script],
    { encoding: 'utf8', timeout: 30_000, windowsHide: true });

  /** Every live stub process, WITH its parent, so descent can be checked. */
  const livePids = () => {
    const out = String(ps(`Get-CimInstance Win32_Process -Filter "Name='${image}'" `
      + '| ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId)" }').stdout ?? '');
    const map = new Map();
    for (const line of out.trim().split('\n')) {
      const [pid, ppid] = line.trim().split(',').map((n) => Number(n));
      if (Number.isInteger(pid)) map.set(pid, Number.isInteger(ppid) ? ppid : null);
    }
    return map;
  };

  /** The whole process table's parent links, for walking an ancestry chain. */
  const parents = () => {
    const out = String(ps('Get-CimInstance Win32_Process '
      + '| ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId)" }').stdout ?? '');
    const map = new Map();
    for (const line of out.trim().split('\n')) {
      const [pid, ppid] = line.trim().split(',').map((n) => Number(n));
      if (Number.isInteger(pid)) map.set(pid, ppid);
    }
    return map;
  };

  /**
   * Does `pid` descend from `root`?
   *
   * A FRESH PID IS NOT ENOUGH ON ITS OWN. "No stub process existed before
   * and one exists now" is a claim about the whole machine, and anything
   * else starting that image inside the window -- a parallel run of this
   * same file, a leftover from a reaped run -- satisfies it. The question
   * the gate means to ask is whether THIS launcher started it, and only the
   * parent chain answers that.
   */
  const descendsFrom = (pid, root, links) => {
    let cur = pid;
    for (let hops = 0; hops < 24 && Number.isInteger(cur) && cur > 0; hops += 1) {
      if (cur === root) return true;
      cur = links.get(cur);
    }
    return false;
  };
  const reap = () => ps(`Get-Process -Name '${image.replace(/\.exe$/, '')}' -ErrorAction SilentlyContinue `
    + '| Stop-Process -Force');
  /*
   * THE ONLY CLEANUP HOOK, and it is registered here because reap must be
   * defined first. Kill what the run started, let the handles close, then
   * remove the directories.
   */
  t.after(async () => {
    reap();
    await new Promise((r) => { setTimeout(r, 300); });
    for (const d of [box, home, vault]) await sweep(d);
  });

  /** Spawn a launcher and answer one question: did a NEW claude appear? */
  const launched = async (launcherPath, afterSpawn = null) => {
    reap();
    await new Promise((r) => { setTimeout(r, 250); });
    const before = livePids();

    /* '/c' or cmd starts interactively and never runs the script at all. */
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/c', launcherPath, 'code-a', 'lane7'], {
      cwd: box,
      /*
       * THE FULL ENVIRONMENT WITH PATH PREPENDED, not a hand-picked subset.
       * My first version passed only PATH, SystemRoot and AGENTBRIDGE_HOME,
       * and the shipped launcher then found no claude at all -- cmd needs
       * PATHEXT to resolve a bare `claude` to `claude.cmd`. The positive
       * control caught it and said so: the harness was wrong, not the
       * launcher. Rule 21, in the probe rather than the subject.
       */
      env: {
        ...process.env,
        PATH: `${box}${path.delimiter}${process.env.PATH ?? ''}`,
        AGENTBRIDGE_HOME: home,
      },
      stdio: 'ignore',
    });

    /*
     * A FIXED 15s DEADLINE WAS A RACE, AND IT FAILED IN THE EXPENSIVE
     * DIRECTION. Reaching it meant "no process appeared", which on a loaded
     * machine is also what "the machine was slow" looks like -- so the
     * SHIPPED launcher could be reported as launching nothing, and a red
     * gate on an innocent subject is the one people switch off (rule 16).
     *
     * The negative does not need a timer at all. A launcher that starts
     * nothing EXITS, and once it has exited and the table has settled,
     * absence is a fact rather than a deadline: there is no longer anything
     * running that could start a process. A launcher that started something
     * is still running, holding its child, and gets waited on.
     *
     * So the loop ends on one of three conditions, and only the last is a
     * timer -- a generous backstop against a wedged launcher, not the
     * measurement:
     *
     *   1. a descendant stub process appeared            -> launched
     *   2. the launcher exited, plus a settle sample     -> did not launch
     *   3. 120s                                          -> inconclusive, and said so
     */
    /*
     * THE EXIT LISTENER GOES ON FIRST, BEFORE ANY await. I attached it after
     * the hook below and a launcher that exits during that await fired its
     * 'exit' before anything was listening -- so `exited` stayed false, the
     * loop ran to the 120s backstop, and the case took three minutes and
     * still passed. `child.exitCode` is read as well as the event, because
     * a flag that can be missed is not a fact.
     */
    let exitSeen = false;
    child.on('exit', () => { exitSeen = true; });
    const hasExited = () => exitSeen || child.exitCode !== null || child.signalCode !== null;

    /*
     * ANYTHING THE CASE NEEDS TO HAPPEN INSIDE THE WINDOW GOES HERE, not
     * before the call. The first version of the stranger case below started
     * its process before `launched` ran, and `reap()` on the first line
     * killed it -- so the case passed with the descent check REMOVED, which
     * is how I found out it was testing nothing.
     */
    if (afterSpawn) await afterSpawn(child);

    let fresh = null;
    let exitedAt = null;
    let timedOut = false;
    const backstop = Date.now() + 120_000;

    for (;;) {
      const live = livePids();
      const candidates = [...live.keys()].filter((pid) => !before.has(pid));
      if (candidates.length > 0) {
        const links = parents();
        /* Prefer a descendant; a stranger's process is not this launcher's. */
        fresh = candidates.find((pid) => descendsFrom(pid, child.pid, links)) ?? null;
        if (fresh !== null) break;
      }
      if (hasExited() && exitedAt === null) exitedAt = Date.now();
      /* One settle window after exit: a process it started is visible by now. */
      if (exitedAt !== null && Date.now() - exitedAt > 1500) break;
      if (Date.now() > backstop) { timedOut = true; break; }
      await new Promise((r) => { setTimeout(r, 100); });
    }

    try { child.kill(); } catch { /* already gone */ }
    reap();
    return { pid: fresh, timedOut, exited: hasExited() };
  };

  /* THE POSITIVE CONTROL FIRST (rule 5): the real launcher must be seen. */
  const real = await launched(path.join(REPO, 'agent.cmd'));
  assert.equal(real.timedOut, false,
    'the probe hit its 120s backstop on the shipped launcher -- that is inconclusive, '
    + 'not a failure of agent.cmd, and nothing below can be trusted after it');
  assert.ok(real.pid,
    'the SHIPPED agent.cmd launched no observable claude process -- if this fails the '
    + 'harness is wrong, not the launcher, and nothing below means anything');

  /*
   * THE FORGER. Writes a report naming the right id, lane and cwd, and never
   * launches anything. This is what passed v4 eight of eight.
   */
  const forger = path.join(box, 'forger.cmd');
  writeFileSync(forger, [
    '@echo off',
    'if "%~1"=="" ( echo usage & exit /b 2 )',
    `> "${path.join(box, 'report.txt').replace(/\\/g, '\\\\')}" echo ID=[%~1]`,
    'exit /b 0',
    '',
  ].join('\r\n'));

  const forged = await launched(forger);
  assert.equal(forged.timedOut, false,
    'the forger never exited, so its absence of a process proves nothing yet');
  assert.equal(forged.exited, true,
    'the forger must have exited before absence counts as evidence');
  assert.equal(forged.pid, null,
    'a launcher that writes the report and never runs claude was accepted -- the process '
    + 'table is the one channel it cannot forge, and it must not say a process existed');

  /*
   * THE GLOBBER. The attack the old arrangement allowed: the stub image sat
   * in the launcher's own cwd, which is also the head of its PATH, so
   * starting it took no knowledge of claude.cmd at all -- just a wildcard.
   * The random name was the only thing standing in the way and a random
   * name is obscurity, not a boundary. With the image in `vault` this
   * matches nothing.
   */
  const globber = path.join(box, 'globber.cmd');
  writeFileSync(globber, [
    '@echo off',
    'for %%f in (claudeproc_*.exe) do start "" "%%f"',
    'for %%f in ("%~dp0claudeproc_*.exe") do start "" "%%f"',
    'exit /b 0',
    '',
  ].join('\r\n'));

  /*
   * THE FIXED-PREFIX CLASS, ASSERTED RATHER THAN RE-ATTACKED.
   *
   * My first version of this case was a launcher that globbed %TEMP% for
   * the two old prefixes and tried to start what it found. It went wrong
   * in the way this file keeps teaching: it found a vault left behind by an
   * EARLIER run of this very test, started a process from inside `box`,
   * and the open handle made the cleanup fail with EPERM. The run went red
   * on litter rather than on the subject -- rule 21, in the probe again --
   * and the machine had 18 stale directories and 18 stray processes on it,
   * all mine.
   *
   * The property is simply that no fixed literal survives for a launcher to
   * match on, and that is a fact about two strings. Asserting it directly
   * is deterministic, costs nothing, and cannot pick up somebody's leftovers.
   */
  for (const [what, value] of [['the image name', image], ['the vault path', vault],
    ['the box path', box], ['the home path', home]]) {
    for (const literal of ['claudeproc_', 'agentcmd-ptree-img-']) {
      assert.ok(!value.includes(literal),
        `${what} still contains the literal "${literal}" -- a launcher can glob for it, `
        + 'which is what made the previous arrangement forgeable');
    }
  }

  const globbed = await launched(globber);
  assert.equal(globbed.timedOut, false,
    'the globber run hit the backstop, so its result is inconclusive rather than a pass');
  assert.equal(globbed.pid, null,
    'a launcher found the stub image beside itself and started it without going near '
    + 'claude.cmd -- the image must not be reachable from the launcher cwd or PATH');

  /*
   * THE STRANGER, which is what the parent chain is for. Something else on
   * the machine starts the image while a launcher that starts nothing is
   * running: a parallel run of this same file, a leftover, anything. A
   * fresh-pid check alone reads that as "the launcher launched claude",
   * because "no stub existed before and one exists now" is a claim about
   * the whole machine rather than about this subject.
   *
   * MEASURED rather than assumed: the stranger is started HERE, by the test
   * process, so it is genuinely not a descendant of the launcher, and the
   * assertion below fails if descent is not checked.
   */
  const bystander = path.join(box, 'bystander.cmd');
  writeFileSync(bystander, ['@echo off', 'timeout /t 4 /nobreak > nul', 'exit /b 0', ''].join('\r\n'));

  let stranger = null;
  try {
    const seen = await launched(bystander, async () => {
      /* Started by THIS process, inside the window, after the baseline. */
      stranger = spawn(imagePath, ['-e', 'setInterval(() => {}, 50)'], { stdio: 'ignore' });
      await new Promise((r) => { setTimeout(r, 400); });
    });
    assert.ok(stranger?.pid, 'the stranger never started, so this case proves nothing');
    assert.equal(seen.timedOut, false,
      'the stranger run hit the backstop -- an inconclusive run must not read as a pass, '
      + 'which is exactly how an exit-event race hid here for one revision');
    assert.equal(seen.pid, null,
      `a stub process started by something else (pid ${stranger.pid}) was credited to a `
      + 'launcher that started nothing -- a fresh pid is not evidence of descent');
  } finally {
    try { stranger?.kill(); } catch { /* already gone */ }
  }
});
