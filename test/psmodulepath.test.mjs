import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { platform } from 'node:os';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { childEnv, run } from '../src/exec.mjs';
import { protectSecret, unprotectSecret, verifyPermissions } from '../src/secretstore.mjs';
import { probeProcesses } from '../src/processes.mjs';

/**
 * Windows PowerShell 5.1 inheriting PowerShell 7's PSModulePath.
 *
 * THE REAL REGRESSION, 2026-09-14, the first time this package ran on Windows.
 * A PS7 shell started node, node's environment carried PS7's PSModulePath, and
 * every `powershell.exe` child searched the PS7 module tree first:
 *
 *   The 'ConvertTo-SecureString' command was found in the module
 *   'Microsoft.PowerShell.Security', but the module could not be loaded.
 *
 * DPAPI sealing failed, so `init` stored the machine secret in PLAINTEXT and
 * `doctor` reported FAIL. `Get-Acl` failed for the same reason, so the
 * permission check could not run either. Nothing about the code was wrong; the
 * module SEARCH PATH was.
 *
 * These tests poison the parent environment exactly as a PS7 shell does, and
 * require the child to work anyway. Without the fix in src/exec.mjs they fail
 * with the message above -- which is how they were confirmed to be capable of
 * failing rather than merely passing.
 *
 * Both consumers are covered, because the fix is centralised in run() and a
 * test of only the secret path would not notice someone re-introducing the bug
 * in processes.mjs:
 *
 *   1. the secret / DPAPI path  (Microsoft.PowerShell.Security)
 *   2. listAll() / Get-CimInstance  (Microsoft.PowerShell.Management)
 */

const isWin = platform() === 'win32';

/**
 * THE POISON IS BUILT, NOT NAMED.
 *
 * This used to be the literal PSModulePath from the machine the bug was found
 * on, PS7 Store package and all:
 *
 *   c:\\program files\\windowsapps\\microsoft.powershell_7.6.6.0_x64__...\\Modules
 *
 * That is a fact about ONE machine, and on 2026-09-21 it stopped being true.
 * The repository moved to a PC with no PowerShell 7 installed: the path
 * resolved to nothing, 5.1 fell through to the real module, and the control
 * below went red saying the tests after it prove nothing. It was right, and it
 * is the only reason this was noticed rather than silently passing.
 *
 * So the poison is now CONSTRUCTED. A directory named exactly
 * Microsoft.PowerShell.Security, declaring the cmdlets the real one exports,
 * whose RootModule points at an assembly that does not exist. 5.1 searches
 * PSModulePath in order, finds this copy first, cannot load it, and reports
 * the same failure the PS7 tree produced:
 *
 *   The 'ConvertTo-SecureString' command was found in the module
 *   'Microsoft.PowerShell.Security', but the module could not be loaded.
 *
 * MEASURED 2026-09-21, each against a positive control on a clean path that
 * returned LOADED (without it, "everything is BLOCKED" would just mean
 * powershell is broken here and every reading would be worthless):
 *
 *   RootModule=missing.dll + CmdletsToExport   BLOCKED  <- used
 *   no RootModule    + CmdletsToExport        BLOCKED  but a DIFFERENT error
 *   RootModule=missing.dll, no CmdletsToExport LOADED
 *   CompatiblePSEditions=@('Core') + Cmdlets   BLOCKED
 *   CompatiblePSEditions=@('Core'), no Cmdlets LOADED
 *   a malformed manifest                       LOADED
 *
 * AN EARLIER VERSION OF THIS TABLE WAS WRONG AND TWO BLIND AUDITS CAUGHT IT.
 * It claimed CompatiblePSEditions=@('Core') LOADED, i.e. that the edition tag
 * was what PowerShell skipped on. It is not: row 4 blocks. Rows 3 and 5 load
 * for the same reason an EMPTY DIRECTORY loads -- no cmdlet index -- so the
 * edition tag demonstrates nothing either way. The discriminator is
 * CmdletsToExport, and the retracted row is kept above so nobody re-derives it.
 *
 * The mechanism is reproduced rather than the machine, so this holds on any
 * Windows host, with or without PS7 -- which is the defect class 180debd
 * ("Two fixtures had picked up a fact about this machine") names.
 *
 * POISON_MARKER IS LOAD-BEARING. Two tests below ask whether a child inherited
 * the poisoned path, and the only way to ask is to look for something that is
 * IN it. That used to be the substring "windowsapps" -- which on the machine
 * the bug was found on ALSO occurred in the UNPOISONED ambient value, so the
 * positive assertion could not distinguish "cmd.exe's path was left untouched"
 * from "it was replaced with the parent's clean value". An mkdtemp name cannot
 * appear ambiently, so that ambiguity is gone.
 *
 * The mkdtemp prefix is DERIVED from this token (`${POISON_MARKER}-`), so the
 * two cannot drift apart as the file stands. The hazard is for whoever splits
 * them: give the directory a literal prefix and leave this token behind, and
 * the NEGATIVE assertion in the cleared-path test goes vacuous while the
 * POSITIVE one in the cmd.exe test goes RED -- measured, and the pairing rule 5
 * asks for. Splitting them also silently disables the orphan sweep below, which
 * matches on this same token. An earlier draft of this comment claimed both
 * assertions went quietly vacuous; a blind audit measured that they do not, and
 * an alarm that overstates its own risk is still a comment that lies.
 */
const POISON_MARKER = 'ab-ps7-poison';

/*
 * DERIVED FROM THE ENVIRONMENT, NOT FROM THIS MACHINE, and the comment that
 * used to sit here was false.
 *
 * It claimed the tail stopped "a poison with no valid tail passing for the
 * wrong reason". Two independent blind audits falsified that on 2026-09-21:
 * repointing it at a nonexistent path changes no verdict in this file, because
 * the shadow wins on search ORDER alone. The tail is kept only because it
 * reproduces the SHAPE of the recorded environment -- the real tree last,
 * behind the shadowing one -- and for no stronger reason than that.
 *
 * src/exec.mjs refuses to hardcode this path -- its reasoning is that an empty
 * value makes Windows PowerShell rebuild its own default, which "stays correct
 * on a machine with a different system root or a 32-bit host". That is a
 * paraphrase and is marked as one: an earlier draft of this comment said "in
 * those words", and a reader who greps for a quoted phrase that was never
 * quoted finds nothing. A literal here would have been the same one-machine
 * fact the header above claims to have eliminated, in the file that claims it.
 */
const SYSTEM_51_MODULES = path.join(
  process.env.SystemRoot ?? 'C:\\WINDOWS',
  'System32', 'WindowsPowerShell', 'v1.0', 'Modules',
);

/*
 * EVERY MODULE THIS PACKAGE DRIVES THROUGH powershell.exe, NOT ONLY THE ONE
 * THAT BROKE FIRST.
 *
 * The recorded 2026-09-14 poison was an entire PS7 tree, so it shadowed every
 * module at once. A fixture that shadows only Microsoft.PowerShell.Security
 * reproduces the symptom that was REPORTED and silently drops the rest:
 * Get-CimInstance, ConvertTo-Json and Select-Object become structurally
 * incapable of failing for a shadowing reason on any machine, which is a
 * narrowing nobody would find later by reading a green run. Measured and
 * reported by a blind audit, 2026-09-21.
 *
 * Get-CimInstance lives in CimCmdlets, NOT in Microsoft.PowerShell.Management.
 * Measured with (Get-Command Get-CimInstance).ModuleName. The header at the top
 * of this file says Management and has been wrong about it since 2026-09-14 --
 * left alone here deliberately, because correcting prose is a separate change
 * from this one and mixing them is how a fix becomes unreviewable.
 */
const SHADOWED = Object.freeze({
  'Microsoft.PowerShell.Security': ['ConvertTo-SecureString', 'ConvertFrom-SecureString', 'Get-Acl', 'Set-Acl'],
  'Microsoft.PowerShell.Utility': ['ConvertTo-Json', 'ConvertFrom-Json', 'Select-Object'],
  'Microsoft.PowerShell.Management': ['Get-Process', 'Get-Item', 'Get-ChildItem'],
  CimCmdlets: ['Get-CimInstance', 'New-CimSession'],
});

/**
 * TWO KEYS, TWO DIFFERENT JOBS, AND THE COMMENT HERE USED TO CREDIT THE WRONG
 * ONE WITH THE WHOLE EFFECT.
 *
 * CmdletsToExport is the load-bearing one. It is the index command discovery
 * reads, so it is what makes PowerShell choose THIS copy of the module over the
 * real one further down the path. Remove it and the shadow is never consulted:
 * the cmdlet loads normally and the fixture is inert (measured -- see the table
 * in the header).
 *
 * RootModule naming an assembly that is not there does not decide WHETHER the
 * call fails; it decides HOW. With it, the failure is the authentic 2026-09-14
 * message, "found in the module ... but the module could not be loaded".
 * Without it the call still fails, as "the term is not recognized" -- a
 * different defect that would send a reader looking for a typo.
 *
 * So they are not interchangeable and the earlier comment, which attributed the
 * block to RootModule alone, would have led whoever trimmed this fixture to
 * delete exactly the wrong line. Stated precisely, because "both are required"
 * was itself measured too strong: removing RootModule changes NO verdict in
 * this file -- every test lands identically. It is kept for message fidelity,
 * so that a failure here reads as the 2026-09-14 defect and not as a typo, and
 * that is a claim about the next human to see a red run, not about the suite.
 */
function shadowManifest(cmdlets) {
  return `@{
  ModuleVersion = '7.0.0.0'
  RootModule = 'NoSuchAssembly-DoesNotExist.dll'
  CmdletsToExport = @(${cmdlets.map((c) => `'${c}'`).join(',')})
}`;
}

let poisonRoot = null;

/** Built once, lazily, so a non-Windows run creates nothing. */
function poisonedPath() {
  if (poisonRoot === null) {
    sweepStalePoison();
    poisonRoot = mkdtempSync(path.join(tmpdir(), `${POISON_MARKER}-`));
    writeFileSync(path.join(poisonRoot, OWNER_PID), String(process.pid), 'utf8');
    for (const [name, cmdlets] of Object.entries(SHADOWED)) {
      const mod = path.join(poisonRoot, 'Modules', name);
      mkdirSync(mod, { recursive: true });
      writeFileSync(path.join(mod, `${name}.psd1`), shadowManifest(cmdlets), 'utf8');
    }
  }
  return `${path.join(poisonRoot, 'Modules')};${SYSTEM_51_MODULES}`;
}

/*
 * maxRetries BECAUSE THIS IS WINDOWS. `force` swallows ENOENT; it does nothing
 * about the EBUSY or EPERM an antivirus scanner or the search indexer produces
 * while still holding a file the run has just read. Without the retries a
 * scanner's timing turns the whole file red for a reason that has nothing to do
 * with the code under test, which is the kind of red that teaches people to
 * skim past reds.
 */
after(() => {
  if (poisonRoot !== null) {
    rmSync(poisonRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

/*
 * AN ORPHANED POISON TREE IS NOT INERT SCRATCH, WHICH IS WHY THIS SWEEP EXISTS.
 *
 * after() does not run if the process is killed -- a timeout, a Ctrl-C, a
 * harness that SIGKILLs a slow suite -- and what is left behind is a set of
 * directories named Microsoft.PowerShell.Security, .Utility, .Management and
 * CimCmdlets holding manifests built to make those cmdlets unloadable. Measured
 * by a blind audit: putting TEMP alone on PSModulePath is enough to inherit the
 * trap, because 5.1 finds the module two levels down. The orphans survive both
 * SIGKILL and SIGTERM.
 *
 * OWNERSHIP, NOT AGE, DECIDES WHETHER A DIRECTORY MAY BE DELETED, AND AN
 * EARLIER VERSION OF THIS GOT THAT WRONG IN A WAY THAT WAS MEASURED.
 *
 * That version swept anything older than an hour, and argued the hour was
 * protection because "an hour is far longer than any run". It is not a fact
 * about ownership: mtime is stamped when the fixture is BUILT and never
 * refreshed, so it measures when a run STARTED, not whether anyone is still
 * using it. A blind audit planted a populated, in-use fixture with a backdated
 * mtime and this sweep destroyed it, silently, while reporting a green run.
 *
 * So each fixture now records the pid that owns it, and a directory whose owner
 * is ALIVE is never touched at any age. Age only decides the fate of
 * directories with no live owner -- the genuine orphans, and older fixtures
 * from before this marker existed.
 *
 * TWO THINGS THIS DOES NOT PROMISE. A pid can be recycled, which makes the
 * sweep SKIP a real orphan -- it under-cleans rather than deleting something
 * live, which is the direction to fail in. And EPERM from process.kill means
 * the process exists but belongs to another user, so it counts as alive;
 * reading it as "dead" would rebuild the exact bug above.
 *
 * Best effort by construction: a LOCKED directory throws here and is skipped. A
 * previous comment claimed an open handle was enough to protect one and that
 * was measured false -- Node opens with FILE_SHARE_DELETE, so a plain read
 * handle does not stop a delete. Only a lock does. A fixture-cleanup failure
 * must never be the reason a suite goes red.
 */
const OWNER_PID = '.owner-pid';

function ownerIsAlive(dir) {
  let pid = null;
  try { pid = Number.parseInt(readFileSync(path.join(dir, OWNER_PID), 'utf8'), 10); } catch { return null; }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function sweepStalePoison(maxAgeMs = 60 * 60 * 1000) {
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith(`${POISON_MARKER}-`)) continue;
      const dir = path.join(tmpdir(), name);
      try {
        const alive = ownerIsAlive(dir);
        if (alive === true) continue;
        if (alive === null && Date.now() - statSync(dir).mtimeMs < maxAgeMs) continue;
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch { /* locked, or gone between readdir and stat: leave it */ }
    }
  } catch { /* no tmpdir listing: nothing to sweep */ }
}

/*
 * ONE PROBE PER SHADOWED MODULE, NOT ONE FOR THE WHOLE FIXTURE.
 *
 * The control used to probe Microsoft.PowerShell.Security alone, which made the
 * other three shadows unasserted premises: if the Utility, Management or
 * CimCmdlets shadow went inert on some future Windows build, the ACL and
 * process-enumeration gates would go quietly vacuous with the control still
 * green. That is the failure the control exists to prevent, one module wide
 * instead of zero. Found by a blind audit after the fixture was broadened and
 * the control was not.
 *
 * All four run in ONE child per direction rather than eight children, because a
 * premise check that costs five seconds is a premise check somebody deletes.
 */
const MODULE_PROBES = Object.freeze({
  'Microsoft.PowerShell.Security': "$null = ConvertTo-SecureString -String 'x' -AsPlainText -Force",
  'Microsoft.PowerShell.Utility': '$null = ConvertTo-Json -InputObject @{a=1}',
  'Microsoft.PowerShell.Management': '$null = Get-Item -LiteralPath $env:SystemRoot',
  CimCmdlets: '$null = Get-CimInstance -ClassName Win32_OperatingSystem',
});

/** Ask a child which of the shadowed modules it can load, under a path we choose. */
async function probeModules(psModulePath) {
  const script = Object.entries(MODULE_PROBES)
    .map(([name, cmd]) => `try { ${cmd}; '${name}=LOADED' } catch { '${name}=BLOCKED' }`)
    .join('; ');
  const out = await probeScript(psModulePath, script);
  return Object.fromEntries(Object.keys(MODULE_PROBES)
    .map((name) => [name, new RegExp(`${name.replace(/\./g, '\\.')}=LOADED`).test(out) ? 'LOADED' : 'BLOCKED']));
}

/** Run a script in a powershell child under a PSModulePath we choose. */
async function probeScript(psModulePath, script) {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    const c = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { shell: false, windowsHide: true, env: { ...process.env, PSModulePath: psModulePath } },
      (_e, so, se) => resolve(String(so || se || '')),
    );
    c.stdin.end('');
  });
}

/** Poison process.env for the duration of `fn`, then put it back exactly. */
async function withPoisonedEnv(fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'PSModulePath');
  const previous = process.env.PSModulePath;
  process.env.PSModulePath = poisonedPath();
  try {
    return await fn();
  } finally {
    if (had) process.env.PSModulePath = previous;
    else delete process.env.PSModulePath;
  }
}

// ── the control: prove the poison is real ───────────────────────────────────

test('psmodulepath: the poison actually reaches an unfixed child', { skip: !isWin }, async () => {
  // Spawned with execFile DIRECTLY, not through run(), and that is deliberate:
  // run() is the thing under test and would hand the child a cleared path, so a
  // control routed through it could never see the poison. The environment is
  // handed over verbatim -- i.e. what the code did before the fix. An earlier
  // version of this comment said "by way of run()", which described neither the
  // code below it nor anything that could work.
  //
  // If this does NOT fail, the poison is inert and every assertion below is
  // vacuous, so the suite would be proving nothing.
  const NAMES = Object.keys(MODULE_PROBES);

  /*
   * THE POSITIVE CONTROL, AND IT IS AN ASSERTION RATHER THAN A CLAIM IN A
   * COMMENT. An earlier version of this file stated in its header that the
   * poison had been "measured against a positive control on a clean path" --
   * and that measurement lived nowhere in the suite. A blind audit found it.
   *
   * Without this, "BLOCKED under poison" is satisfied on any machine where the
   * cmdlet fails for some unrelated reason, and every assertion below goes
   * green while proving nothing (rule 5: a negative needs the positive first).
   *
   * The clean value is '' -- exactly what the fix installs -- so this asserts
   * the repair direction as well as the premise.
   */
  const clean = await probeModules('');
  for (const name of NAMES) {
    assert.equal(
      clean[name], 'LOADED',
      `powershell cannot load ${name} even UNPOISONED, so nothing below can mean anything: ${JSON.stringify(clean)}`,
    );
  }

  const poisoned = await probeModules(poisonedPath());
  for (const name of NAMES) {
    assert.equal(
      poisoned[name], 'BLOCKED',
      `the poison no longer shadows ${name}, so every test that depends on it proves nothing: ${JSON.stringify(poisoned)}`,
    );
  }
});

// ── consumer 1: the secret / DPAPI path ─────────────────────────────────────

test('psmodulepath: DPAPI sealing survives a PS7-poisoned parent', { skip: !isWin }, async () => {
  const sealed = await withPoisonedEnv(() => protectSecret('regression-secret-value'));
  assert.equal(sealed.scheme, 'dpapi-user', `expected DPAPI, got ${sealed.scheme}: ${sealed.degradedReason ?? ''}`);
  assert.notEqual(sealed.degraded, true);
  // Fail-closed guarantee: a degraded seal must never silently carry plaintext.
  assert.equal(String(sealed.value).includes('regression-secret-value'), false);
});

test('psmodulepath: DPAPI round-trip survives a PS7-poisoned parent', { skip: !isWin }, async () => {
  const round = await withPoisonedEnv(async () => {
    const sealed = await protectSecret('round-trip-secret-value');
    return unprotectSecret(sealed);
  });
  assert.equal(round.ok, true, `round trip failed: ${round.reason ?? ''}`);
  assert.equal(round.secret, 'round-trip-secret-value');
  assert.equal(round.scheme, 'dpapi-user', 'round trip fell back to plaintext');
});

test('psmodulepath: the ACL check runs at all under a poisoned parent', { skip: !isWin }, async () => {
  // Get-Acl is ALSO in Microsoft.PowerShell.Security, so it died of the same
  // cause and init reported "windows-acl FAILED" alongside the plaintext seal.
  //
  // Asserts the probe EXECUTED, not that the ACL was judged good: a fresh temp
  // file inherits a broad ACL and is legitimately ok:false. The tell is which
  // shape verifyPermissions returns -- `detail.error` means the powershell call
  // itself died, whereas an evaluateAcl result means it ran and had an opinion.
  // Asserting on the error TEXT is what made an earlier version of this test
  // vacuous: it passed with the fix removed.
  const dir = await mkdtemp(path.join(tmpdir(), 'ab-psmp-'));
  const file = path.join(dir, 'config.json');
  await writeFile(file, '{}', 'utf8');
  const res = await withPoisonedEnv(() => verifyPermissions(file));
  assert.equal(res.scheme, 'windows-acl');
  assert.equal(
    Object.prototype.hasOwnProperty.call(res.detail ?? {}, 'error'),
    false,
    `the ACL probe never ran: ${JSON.stringify(res.detail)}`,
  );
  assert.ok(Array.isArray(res.detail?.problems), 'no evaluateAcl verdict, so Get-Acl produced nothing');
});

// ── consumer 2: process enumeration ─────────────────────────────────────────

/**
 * THE CONTRACT TEST, and the real coverage for processes.mjs.
 *
 * THIS PARAGRAPH USED TO SAY THE OPPOSITE, AND IT WAS LEFT BEHIND BY A CHANGE
 * TO THE FIXTURE ABOVE. It read:
 *
 *   Get-CimInstance  OK  CimCmdlets     |  ConvertTo-Json  OK  Utility
 *   "processes.mjs was NOT broken by this, and a test asserting
 *    'probeProcesses still works' passes with the fix removed -- it proves
 *    nothing."
 *
 * That was true of the 2026-09-14 measurement and of the narrow fixture that
 * shadowed Microsoft.PowerShell.Security alone. It is false of THIS file. The
 * fixture now shadows every module this package drives, so under it:
 *
 *   ConvertTo-SecureString  BLOCKED      Get-CimInstance  BLOCKED
 *   Get-Acl                 BLOCKED      ConvertTo-Json   BLOCKED
 *                                        Select-Object    BLOCKED
 *
 * and "process enumeration still works end to end" GOES RED when the fix is
 * removed. It is a gate, not decoration. Measured both ways: with a
 * Security-only shadow it stays green, with the full shadow it fails.
 *
 * A blind audit found the stale paragraph still sitting here and named the real
 * risk, which was not that it was merely out of date -- it was that it told the
 * next reader this test proves nothing, which is an instruction to delete a
 * working gate.
 *
 * The shared guarantee below is still the durable one: every powershell.exe
 * child spawned through run() gets a cleared PSModulePath, whichever cmdlet
 * happens to collide in a given year.
 */
test('psmodulepath: every powershell.exe child gets a cleared PSModulePath', { skip: !isWin }, async () => {
  const r = await withPoisonedEnv(() =>
    run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      '"PSMP=[" + $env:PSModulePath + "]"',
    ]),
  );
  assert.equal(r.ok, true, `powershell failed: ${r.error ?? ''}`);
  assert.equal(
    r.stdout.includes(POISON_MARKER),
    false,
    `child inherited the poisoned module path: ${r.stdout.trim()}`,
  );
});

test('psmodulepath: process enumeration still works end to end', { skip: !isWin }, async () => {
  // A REAL GATE UNDER THIS FIXTURE, not the wiring check it used to be: the
  // shadow covers CimCmdlets, so removing the fix in src/exec.mjs turns this
  // test red. It said "not a proof of the fix" for as long as the fixture
  // shadowed only Microsoft.PowerShell.Security.
  const res = await withPoisonedEnv(() => probeProcesses([process.cwd()]));
  assert.equal(res.probeOk, true, `process probe failed: ${res.error ?? ''}`);
  assert.ok(res.byWorktree && typeof res.byWorktree === 'object');
});

// ── the guarantees the fix must not have traded away ────────────────────────

test('psmodulepath: only powershell.exe gets a rewritten environment', { skip: !isWin }, async () => {
  // A non-PowerShell child must still inherit PSModulePath untouched, or the
  // fix has quietly become a global environment rewrite.
  const r = await withPoisonedEnv(() =>
    run('cmd.exe', ['/d', '/s', '/c', 'echo %PSModulePath%']),
  );
  assert.equal(r.ok, true, `cmd.exe failed: ${r.error ?? ''}`);
  assert.ok(
    r.stdout.includes(POISON_MARKER),
    `inherited PSModulePath was altered for a non-PowerShell child: ${r.stdout.trim()}`,
  );
});

/*
 * THESE THREE ASSERT THE SHIPPED FUNCTION. THE ONE THEY REPLACED DID NOT.
 *
 * It defined its own basename lambda and asserted against string literals, so
 * it agreed with itself: every mutation of the real matcher in src/exec.mjs
 * left it green, including widening it to strip pwsh -- which is the single
 * regression its own name promised to catch. Its comment said "kept in step
 * with isWindowsPowerShell() in src/exec.mjs", and nothing kept it in step.
 *
 * childEnv is imported and called directly. It is pure, so these run on any
 * platform and carry no { skip: !isWin } -- which also means that on a
 * non-Windows runner, where the other tests in this file skip, what is left is
 * real coverage instead of a tautology.
 *
 * The matcher is asserted THROUGH childEnv rather than on its own, because
 * childEnv is its only production caller: a matcher that is correct while
 * nothing asks it is the defect one layer up.
 */
test('psmodulepath: pwsh keeps its own module path -- asserted on the shipped childEnv', () => {
  // PowerShell 7 must NOT be stripped: it needs the PS7 tree that breaks 5.1.
  const env = { PSModulePath: 'PS7-TREE', PATH: 'p' };
  for (const file of ['pwsh.exe', 'pwsh', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe']) {
    assert.equal(childEnv(file, env).PSModulePath, 'PS7-TREE', `${file} must keep its own module path`);
  }
});

test('psmodulepath: every spelling of Windows PowerShell is cleared, and nothing else is', () => {
  // GENERATED FROM TWO LISTS rather than one example each, so a matcher that is
  // right about the spelling somebody thought of and wrong about a sibling goes
  // red here (rule 7). The negatives are the half that stops a widened matcher.
  const env = { PSModulePath: 'POISON' };
  const CLEARED = [
    'powershell.exe',
    'POWERSHELL.EXE',
    'PowerShell.exe',
    'powershell',
    'C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'C:/WINDOWS/system32/WindowsPowerShell/v1.0/powershell.exe',
  ];
  const UNTOUCHED = ['pwsh.exe', 'pwsh', 'cmd.exe', 'node.exe', 'git.exe', 'powershell-ise.exe', 'notpowershell.exe'];
  for (const file of CLEARED) {
    assert.equal(childEnv(file, env).PSModulePath, '', `${file} should have been cleared`);
  }
  for (const file of UNTOUCHED) {
    assert.equal(childEnv(file, env).PSModulePath, 'POISON', `${file} must not be rewritten`);
  }
});

test('psmodulepath: the cleared value is the EMPTY STRING, and nothing else in the environment moves', () => {
  /*
   * THE VALUE, NOT JUST THE ABSENCE OF THE POISON. Every other test in this
   * file asks whether the poison is gone, which is satisfied by ANY replacement
   * -- a hardcoded system32 path, a nonexistent root, undefined, or a single
   * space. All five of those shipped green before this assertion existed, and
   * src/exec.mjs argues at length that the empty string specifically is what
   * makes a machine with a different system root work.
   *
   * The deep comparison is what catches the other direction: returning ONLY
   * { PSModulePath: '' } and discarding the inherited environment also passed
   * every test in this file, which would hand every powershell child no PATH,
   * no SystemRoot and no USERNAME -- and hardenPermissions() builds an ACL
   * grant out of USERDOMAIN and USERNAME.
   */
  const base = {
    PSModulePath: 'POISON', PATH: 'p', SystemRoot: 'C:\\WINDOWS', USERNAME: 'u', USERDOMAIN: 'd',
  };
  const out = childEnv('powershell.exe', base);
  assert.deepEqual(out, { ...base, PSModulePath: '' });
  assert.equal(out.PSModulePath, '', 'the cleared value must be the empty string, not a path and not undefined');
  assert.equal(Object.prototype.hasOwnProperty.call(out, 'PSModulePath'), true, 'the key must be present, not deleted');
});

test('psmodulepath: a path containing spaces and shell metacharacters stays inert', { skip: !isWin }, async () => {
  // The username on the machine this bug was found on contains a space, and the
  // original suspicion was that the space caused it. It did not -- but the
  // guarantee still has to hold after the env change.
  const weird = 'C:\\Users\\Test User\\; rm -rf $(x) `whoami`';
  const r = await withPoisonedEnv(() =>
    run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      '$p = [Console]::In.ReadToEnd(); "LEN=" + $p.Length',
    ], { input: weird }),
  );
  assert.equal(r.ok, true, `powershell failed: ${r.error ?? ''}`);
  assert.match(r.stdout, new RegExp(`LEN=${weird.length}`), 'stdin payload was mangled or interpreted');
});

test('psmodulepath: the secret still travels on stdin, never argv', { skip: !isWin }, async () => {
  const secret = 'stdin-only-secret-9f3a2b';
  const r = await withPoisonedEnv(() =>
    run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      '$p = [Console]::In.ReadToEnd(); if ($p -eq $null) { exit 3 }; "GOT=" + $p.Length',
    ], { input: secret }),
  );
  assert.equal(r.ok, true);
  assert.match(r.stdout, new RegExp(`GOT=${secret.length}`));
});
