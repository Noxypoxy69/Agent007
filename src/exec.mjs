import { execFile } from 'node:child_process';

/**
 * The ONLY way this package runs a subprocess.
 *
 * Hard rules, enforced here so they cannot be bypassed elsewhere:
 *  - argv form only. There is no shell. Nothing is ever string-interpolated
 *    into a command line.
 *  - `file` must come from a compile-time constant in this repo, never from
 *    network input. Callers pass literals; nothing reads `file` from a payload.
 *  - args are passed as an array, so a worktree path containing spaces,
 *    quotes, semicolons or backticks is inert data, not syntax.
 */
/**
 * Is this the Windows PowerShell 5.1 executable?
 *
 * Matched on the basename so an absolute path works too, and deliberately NOT
 * matched on `pwsh` -- PowerShell 7 must keep its own module path, and clearing
 * it there would break the thing this fixes.
 */
function isWindowsPowerShell(file) {
  const base = file.replace(/\\/g, '/').split('/').pop() ?? '';
  return base.toLowerCase() === 'powershell.exe' || base.toLowerCase() === 'powershell';
}

/**
 * Windows PowerShell 5.1 inheriting PowerShell 7's PSModulePath cannot load its
 * own modules, and fails in a way that looks like a broken Windows install.
 *
 * When a PS7 shell starts node, node's environment carries PS7's PSModulePath,
 * which leads with the PS7 module tree:
 *
 *   ...\WindowsApps\microsoft.powershell_7.x_x64__...\Modules   <- .NET Core
 *   C:\WINDOWS\system32\WindowsPowerShell\v1.0\Modules          <- .NET Framework
 *
 * 5.1 searches in order, finds PS7's Microsoft.PowerShell.Security first, and
 * cannot load a .NET Core assembly. The error names the module rather than the
 * path, so it reads as "your Windows PowerShell is broken":
 *
 *   The 'ConvertTo-SecureString' command was found in the module
 *   'Microsoft.PowerShell.Security', but the module could not be loaded.
 *
 * `Import-Module` does not rescue it -- it resolves the same wrong copy. Only
 * the search path is wrong.
 *
 * Observed on 2026-09-14 on the first Windows machine this ran on. It broke
 * DPAPI sealing and the ACL check, so init stored the machine secret in
 * PLAINTEXT and doctor reported FAIL. processes.mjs has the same dependency via
 * Get-CimInstance (Microsoft.PowerShell.Management, same tree) and would have
 * failed identically the moment anything called it.
 *
 * Empty string rather than a hardcoded system32 path: an empty PSModulePath
 * makes Windows PowerShell rebuild its own default, which stays correct on a
 * machine with a different system root or a 32-bit host. Naming the path would
 * trade one environment assumption for another.
 *
 * Scoped to powershell.exe alone. Every other subprocess inherits the
 * environment unchanged.
 */
function childEnv(file) {
  if (!isWindowsPowerShell(file)) return process.env;
  return { ...process.env, PSModulePath: '' };
}

export async function run(file, args, { cwd, timeoutMs = 15000, maxBuffer = 8 * 1024 * 1024, input = null } = {}) {
  if (typeof file !== 'string' || !file.length) throw new TypeError('exec: file must be a string');
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    throw new TypeError('exec: args must be an array of strings');
  }
  return new Promise((resolve) => {
    const child = execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer, shell: false, windowsHide: true, env: childEnv(file) },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err?.code ?? 0,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          error: err ? String(err.message) : null,
        });
      });
    // Secrets are passed on stdin, never as arguments: argv is readable by any
    // process on the machine, which is the exact problem src/argv.mjs exists for.
    if (input != null) { child.stdin.end(input); }
  });
}
