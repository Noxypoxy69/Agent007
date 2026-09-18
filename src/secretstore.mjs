import { platform } from 'node:os';
import { stat } from 'node:fs/promises';
import { run } from './exec.mjs';

/**
 * Machine-secret storage.
 *
 * POSIX: plaintext in a 0600 file. `chmod` is real here and mode is verified.
 * Windows: DPAPI, user+machine scoped, via PowerShell's SecureString
 *   round-trip. The secret is passed on STDIN, never as an argument — argv is
 *   world-readable on Windows and that is the very leak we are closing.
 *   The file ACL is then verified and any non-inherited grant to an identity
 *   outside {current user, SYSTEM, Administrators} is a hard failure.
 *
 * A pretend chmod is worse than no chmod, because it reads as protection in a
 * threat model where none exists.
 */

const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

// Fixed literals. Nothing is interpolated into either script.
const PROTECT_PS = `
$ErrorActionPreference='Stop'
$p = [Console]::In.ReadToEnd()
if ($p.Length -eq 0) { exit 3 }
$ss = ConvertTo-SecureString -String $p -AsPlainText -Force
ConvertFrom-SecureString -SecureString $ss
`;

const UNPROTECT_PS = `
$ErrorActionPreference='Stop'
$b = [Console]::In.ReadToEnd().Trim()
if ($b.Length -eq 0) { exit 3 }
$ss = ConvertTo-SecureString -String $b
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss)
try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
`;

const ACL_PS = `
$ErrorActionPreference='Stop'
$path = [Console]::In.ReadToEnd().Trim()
$acl = Get-Acl -LiteralPath $path
$rules = @()
foreach ($r in $acl.Access) {
  $rules += [pscustomobject]@{
    Identity  = $r.IdentityReference.Value
    Rights    = $r.FileSystemRights.ToString()
    Type      = $r.AccessControlType.ToString()
    Inherited = $r.IsInherited
  }
}
[pscustomobject]@{
  Owner = $acl.Owner
  User  = "$env:USERDOMAIN\\$env:USERNAME"
  Sid   = ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
  Rules = $rules
} | ConvertTo-Json -Compress -Depth 4
`;

export const isWindows = () => platform() === 'win32';

/** Wrap a plaintext secret for storage. Returns a JSON-serialisable record. */
export async function protectSecret(plaintext) {
  if (!isWindows()) return { scheme: 'plaintext', value: plaintext };
  const r = await run('powershell.exe', [...PS, PROTECT_PS], { input: plaintext, timeoutMs: 20000 });
  if (!r.ok || !r.stdout.trim()) {
    return { scheme: 'plaintext', value: plaintext, degraded: true,
      degradedReason: r.error || `powershell exit ${r.code}` };
  }
  return { scheme: 'dpapi-user', value: r.stdout.trim() };
}

/** Recover a plaintext secret. Returns {ok, secret, reason}. */
export async function unprotectSecret(stored) {
  if (!stored) return { ok: false, reason: 'no-secret' };
  if (typeof stored === 'string') return { ok: true, secret: stored, scheme: 'plaintext' };
  if (stored.scheme === 'plaintext') return { ok: true, secret: stored.value, scheme: 'plaintext' };
  if (stored.scheme !== 'dpapi-user') return { ok: false, reason: `unknown-scheme:${stored.scheme}` };
  if (!isWindows()) return { ok: false, reason: 'dpapi-blob-on-non-windows' };

  const r = await run('powershell.exe', [...PS, UNPROTECT_PS], { input: stored.value, timeoutMs: 20000 });
  if (!r.ok || !r.stdout.trim()) {
    return { ok: false, reason: `dpapi-decrypt-failed: ${r.error || 'exit ' + r.code}` };
  }
  return { ok: true, secret: r.stdout.replace(/\r?\n$/, ''), scheme: 'dpapi-user' };
}

const BENIGN = [/\\SYSTEM$/i, /\\Administrators$/i, /^BUILTIN\\Administrators$/i, /^NT AUTHORITY\\SYSTEM$/i];

/** Parse the ACL probe output. Split out so it is testable without Windows. */
export function evaluateAcl(info) {
  const problems = [];
  const user = String(info.User || '').toLowerCase();
  for (const r of info.Rules || []) {
    if (r.Type !== 'Allow') continue;
    const id = String(r.Identity);
    if (id.toLowerCase() === user) continue;
    if (BENIGN.some((re) => re.test(id))) continue;
    problems.push({ identity: id, rights: r.Rights, inherited: r.Inherited });
  }
  return { ok: problems.length === 0, owner: info.Owner ?? null, user: info.User ?? null, problems };
}

/**
 * Verify the secret file is not readable beyond the current user.
 * Returns {ok, scheme, detail}. Never throws — the caller decides whether a
 * failure is fatal.
 */
export async function verifyPermissions(file) {
  if (!isWindows()) {
    try {
      const st = await stat(file);
      const mode = st.mode & 0o777;
      return (mode & 0o077) === 0
        ? { ok: true, scheme: 'posix-mode', detail: { mode: mode.toString(8) } }
        : { ok: false, scheme: 'posix-mode', detail: { mode: mode.toString(8),
            problem: 'group or other has access' } };
    } catch (e) { return { ok: false, scheme: 'posix-mode', detail: { error: String(e.message) } }; }
  }

  const r = await run('powershell.exe', [...PS, ACL_PS], { input: file, timeoutMs: 20000 });
  if (!r.ok) return { ok: false, scheme: 'windows-acl', detail: { error: r.error || `exit ${r.code}` } };
  let info;
  try { info = JSON.parse(r.stdout); }
  catch { return { ok: false, scheme: 'windows-acl', detail: { error: 'unparseable acl output' } }; }
  if (info.Rules && !Array.isArray(info.Rules)) info.Rules = [info.Rules];
  return { ok: evaluateAcl(info).ok, scheme: 'windows-acl', detail: evaluateAcl(info) };
}

/** Tighten the ACL to the current user: break inheritance, grant only them. */
export async function hardenPermissions(file) {
  if (!isWindows()) return { ok: true, scheme: 'posix-mode', detail: 'chmod applied by caller' };
  const user = `${process.env.USERDOMAIN ?? ''}\\${process.env.USERNAME ?? ''}`;
  const inherit = await run('icacls.exe', [file, '/inheritance:r'], { timeoutMs: 20000 });
  const grant = await run('icacls.exe', [file, '/grant:r', `${user}:F`], { timeoutMs: 20000 });
  return { ok: inherit.ok && grant.ok, scheme: 'windows-acl',
    detail: { inheritance: inherit.ok, grant: grant.ok, error: inherit.error || grant.error || null } };
}
