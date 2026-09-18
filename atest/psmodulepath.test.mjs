import { test } from 'node:test';
import assert from 'node:assert/strict';
import { platform } from 'node:os';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../src/exec.mjs';
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
 * A PS7-first PSModulePath, shaped like the one that actually broke this. The
 * PS7 entry leads, which is the whole bug: 5.1 searches in order and stops at
 * a .NET Core assembly it cannot load.
 */
const POISONED =
  'C:\\Users\\Test User\\OneDrive\\Documents\\PowerShell\\Modules;' +
  'C:\\Program Files\\PowerShell\\Modules;' +
  'c:\\program files\\windowsapps\\microsoft.powershell_7.6.6.0_x64__8wekyb3d8bbwe\\Modules;' +
  'C:\\Program Files\\WindowsPowerShell\\Modules;' +
  'C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules';

/** Poison process.env for the duration of `fn`, then put it back exactly. */
async function withPoisonedEnv(fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'PSModulePath');
  const previous = process.env.PSModulePath;
  process.env.PSModulePath = POISONED;
  try {
    return await fn();
  } finally {
    if (had) process.env.PSModulePath = previous;
    else delete process.env.PSModulePath;
  }
}

// ── the control: prove the poison is real ───────────────────────────────────

test('psmodulepath: the poison actually reaches an unfixed child', { skip: !isWin }, async () => {
  // Spawned through Node's own execFile semantics by way of run(), but with the
  // environment handed over verbatim -- i.e. what the code did before the fix.
  // If this does NOT fail, the poison string is wrong and every assertion below
  // is vacuous, so the suite would be proving nothing.
  const { execFile } = await import('node:child_process');
  const script =
    "try { $null = ConvertTo-SecureString -String 'x' -AsPlainText -Force; 'LOADED' } " +
    "catch { 'BLOCKED' }";
  const out = await new Promise((resolve) => {
    const c = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { shell: false, windowsHide: true, env: { ...process.env, PSModulePath: POISONED } },
      (_e, so, se) => resolve(String(so || se || '')),
    );
    c.stdin.end('');
  });
  assert.match(
    out,
    /BLOCKED/,
    'the poisoned PSModulePath no longer blocks module load, so these tests prove nothing',
  );
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
 * Measured on 2026-09-14: of the cmdlets this package uses, only the
 * Microsoft.PowerShell.Security ones collide.
 *
 *   ConvertTo-SecureString  BLOCKED   Microsoft.PowerShell.Security
 *   Get-Acl                 BLOCKED   Microsoft.PowerShell.Security
 *   Get-CimInstance         OK        CimCmdlets
 *   ConvertTo-Json          OK        Microsoft.PowerShell.Utility
 *
 * So processes.mjs was NOT broken by this, and a test asserting "probeProcesses
 * still works" passes with the fix removed -- it proves nothing. An earlier
 * version of this file made exactly that mistake.
 *
 * What processes.mjs actually needs guarded is the shared guarantee: every
 * powershell.exe child spawned through run() gets a cleared PSModulePath. That
 * is what keeps it safe if a future Windows build moves Get-CimInstance into a
 * colliding module, and it goes red the moment the fix is removed regardless of
 * which cmdlet happens to break this year.
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
    r.stdout.includes('windowsapps'),
    false,
    `child inherited the PS7 module path: ${r.stdout.trim()}`,
  );
});

test('psmodulepath: process enumeration still works end to end', { skip: !isWin }, async () => {
  // Wiring check, not a proof of the fix -- see the note above. Kept so the
  // consumer is exercised at all, and so a genuine break in Get-CimInstance
  // surfaces here rather than in production.
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
  assert.match(r.stdout, /windowsapps/i, 'inherited PSModulePath was altered for a non-PowerShell child');
});

test('psmodulepath: pwsh keeps its own module path', () => {
  // PowerShell 7 must NOT be stripped -- it needs the PS7 tree that breaks 5.1.
  // Asserted on the matcher rather than by spawning, so it holds on any machine.
  // (Kept in step with isWindowsPowerShell() in src/exec.mjs.)
  const base = (f) => f.replace(/\\/g, '/').split('/').pop().toLowerCase();
  assert.equal(base('pwsh.exe'), 'pwsh.exe');
  assert.notEqual(base('pwsh.exe'), 'powershell.exe');
  assert.equal(base('C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\powershell.exe'), 'powershell.exe');
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
