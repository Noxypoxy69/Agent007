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
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, realpathSync, existsSync } from 'node:fs';
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
    assert.equal(
      realpathSync.native(seen[1]).toLowerCase(),
      realpathSync.native(REPO).toLowerCase(),
      'claude must start IN THE REPOSITORY, or it loads no .claude/settings.json and '
      + `therefore no guard, no Stop gate and no poll hook. Started in: ${seen[1]}`,
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

  /** What cmd.exe would actually run: statements, minus the inert ones. */
  const executableStatements = (text) => {
    const kept = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/^\s*@?\s*/, '');
      /* rem and :: swallow the remainder of the line, separators included. */
      if (/^(?:rem\b|::)/i.test(line)) continue;

      /* Split on unquoted & or |; a separator inside quotes is literal. */
      const parts = [];
      let cur = '';
      let quoted = false;
      for (const ch of line) {
        if (ch === '"') { quoted = !quoted; cur += ch; continue; }
        if (!quoted && (ch === '&' || ch === '|')) { parts.push(cur); cur = ''; continue; }
        cur += ch;
      }
      parts.push(cur);

      for (const part of parts) {
        const st = part.replace(/^\s*@?\s*/, '').trim();
        if (st === '') continue;
        if (/^(?:rem\b|::)/i.test(st)) continue;
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
  ]) {
    assert.doesNotMatch(executableStatements(inert), RUNS_NPM,
      `"${inert}" executes nothing and must be allowed`);
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
