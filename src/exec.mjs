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
function childEnv(file, override) {
  /*
   * AN EXPLICIT ENVIRONMENT REPLACES THE PARENT'S, IT DOES NOT EXTEND IT.
   *
   * Every caller here is a git or PowerShell command that needs the ambient
   * environment, so inheriting is the right default and stays the default. A
   * disposable EXECUTOR is the opposite case: it runs a coding agent that must
   * not be handed every credential this process holds, and the first time that
   * matters is the first time an agent prints its own environment.
   *
   * The PSModulePath repair below still applies, because a caller choosing its
   * own environment has not thereby chosen the broken module path.
   */
  const base = override ?? process.env;
  if (!isWindowsPowerShell(file)) return base;
  return { ...base, PSModulePath: '' };
}

/**
 * Prompt shapes a child writes when it is about to wait for a person.
 *
 * DETECTION IS SEPARATE FROM PREVENTION AND THE TWO GET CONFUSED CONSTANTLY.
 * Closing stdin PREVENTS the hang: a read returns end-of-file instead of
 * blocking until the timeout. It detects nothing, because a tool that prompts
 * and then takes the default on EOF looks, from out here, exactly like a tool
 * that never asked -- and the default it takes is the one nobody chose.
 *
 * So the prompt is detected by its text, which is a heuristic and is labelled
 * one. It cannot be exhaustive: this list holds the shapes actually seen. What
 * makes it worth having anyway is the direction of its errors -- a missed
 * prompt is the behaviour we already have, while a match is a loud, specific
 * record of an executor that was configured to run unattended and was not.
 */
const PROMPT_SHAPES = [
  /\bdo you want to (proceed|continue)\b/i,
  /\?\s*\[y\/n\]/i,
  /\(y(es)?\/n(o)?\)\s*[:?]?\s*$/im,
  /\bpress (enter|any key)\b/i,
  /*
   * A URL CONTAINS COLONS, which the first version of this did not survive:
   * `password for [^:]*:` stopped at the colon in "https:" and never reached
   * the prompt's own. Found by its own negative test, which is the argument for
   * asserting the positive alongside every negative -- "ordinary text is not a
   * prompt" passes perfectly against a pattern that matches nothing at all.
   */
  /\bpass(word|phrase)\b[^\n]{0,80}:[ \t]*$/im,
  /^\s*\d\)\s.*\n(\s*\d\)\s.*\n)+.*choose/im,
];

/** Which shape matched, or null. Named so a record can say what it saw. */
export function interactivePrompt(text) {
  const t = typeof text === 'string' ? text : '';
  for (const re of PROMPT_SHAPES) {
    const m = t.match(re);
    if (m) return { pattern: String(re), token: m[0].trim().slice(0, 120) };
  }
  return null;
}

/**
 * THE RUNNER RULE FOR AN UNATTENDED WORKER: stdin closed, no terminal, and a
 * prompt is a defect rather than a pause.
 *
 * A screenshot on 2026-09-16 showed a coding agent stopped on "Do you want to
 * proceed?" for a local commit. Until now this function gave every child a
 * stdin PIPE that was never written to and never closed, so a child that read
 * it blocked until the timeout killed it. At the 15-second default that reads
 * as a slow command. At an executor's thirty-minute timeout it is half an hour
 * of a lease spent waiting for a keypress on a machine nobody is sitting at,
 * and the kill arrives with no exit code and no explanation of what was asked.
 *
 * `interactive: true` restores the pipe for the rare caller that genuinely
 * feeds a child, and it is opt-in so the safe shape is what you get by default.
 */
export async function run(file, args, { cwd, timeoutMs = 15000, maxBuffer = 8 * 1024 * 1024, input = null, env = null, interactive = false } = {}) {
  if (typeof file !== 'string' || !file.length) throw new TypeError('exec: file must be a string');
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    throw new TypeError('exec: args must be an array of strings');
  }
  return new Promise((resolve) => {
    const child = execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer, shell: false, windowsHide: true, env: childEnv(file, env) },
      (err, stdout, stderr) => {
        /*
         * A PROCESS THAT WAS KILLED HAS NO EXIT CODE, AND `?? 0` INVENTED ONE.
         *
         * execFile's timeout kills the child and reports an error with no
         * numeric code, so the old default reported a killed run as code 0 --
         * the shape of a clean finish. Callers reading `code` alone could not
         * tell a process that succeeded from one the runner shot. `signal` and
         * `killed` are now surfaced so a caller can say "no exit code" instead
         * of guessing, and `code` is null in exactly that case.
         */
        const killed = Boolean(err) && (err.killed === true || typeof err.signal === 'string');
        const numeric = typeof err?.code === 'number' ? err.code : null;
        const prompted = interactive ? null : interactivePrompt(`${stderr ?? ''}\n${stdout ?? ''}`);
        resolve({
          ok: !err,
          code: err ? (killed ? null : (numeric ?? null)) : 0,
          signal: err?.signal ?? null,
          killed,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          error: err ? String(err.message) : null,
          /*
           * Reported even when the command SUCCEEDED, and that is the case that
           * matters: a tool that asked, got end-of-file and took its default
           * exits zero having made a choice nobody made. A green result with
           * this field set is the one worth looking at.
           */
          interactivePrompt: prompted,
        });
      });
    // Secrets are passed on stdin, never as arguments: argv is readable by any
    // process on the machine, which is the exact problem src/argv.mjs exists for.
    if (input != null) { child.stdin.end(input); }
    /*
     * OTHERWISE CLOSE IT, AND CLOSE IT HERE RATHER THAN BY OPTION.
     *
     * An `stdio` option looks like the obvious way to do this and is silently
     * ignored: execFile builds its own spawn options and forwards cwd, env,
     * uid, gid, shell and windowsHide -- not stdio. I wrote it that way first,
     * watched the child still hang for the whole timeout, and only then read
     * how execFile actually calls spawn. A configuration that is accepted
     * without effect is the worst shape available, because the code reads as
     * though the rule is enforced.
     *
     * Ending the writable side gives the child end-of-file on fd 0, which is
     * what a prompt needs to stop waiting.
     */
    else if (!interactive && child.stdin) { child.stdin.end(); }
  });
}
