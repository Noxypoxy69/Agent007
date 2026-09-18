import { readFileSync } from 'node:fs';

/*
 * A CREDENTIAL THAT CAN ONLY ARRIVE BY A ROUTE THE GUARD FORBIDS IS A
 * CREDENTIAL NOBODY CAN PRESENT.
 *
 * Until 2026-09-18 the only source for the registration token was the process
 * environment. A guarded session cannot put anything there, and all three
 * refusals that stop it are CORRECT:
 *
 *   export FOO=bar          "export" has no approved read-only shape
 *   FOO=bar node ...        a leading environment assignment can change what
 *                           the command resolves to
 *   FOO=$(cat f) node ...   the command contains a shell metacharacter
 *
 * Their combined effect was that every guarded agent registered LOCAL-ONLY --
 * invisible to every other machine -- and the only repair was the operator
 * typing the secret into each session by hand. That is hollow gate 15 wearing
 * different clothes: a client that needs a credential it cannot acquire.
 *
 * WHY A FLAG AND NOT A WELL-KNOWN PATH. The first attempt at this also read a
 * zero-config default at <AGENTBRIDGE_HOME>/registration-token. That is a
 * different thing in kind and it is the part that was wrong. Today a token
 * enters a process only when somebody deliberately puts it there; an ambient
 * well-known path means ANY code that reaches registrationConfig() silently
 * acquires a live credential it was never handed. Refused by review before it
 * shipped, 2026-09-18.
 *
 * So the token arrives per invocation, named on the command line, or not at
 * all. The PATH is not a secret and may be written down; the VALUE is and may
 * not. The shell rail already permits `cat <that path>`, so a guarded agent
 * gains no capability it did not have -- this removes an accident, not a
 * control.
 *
 * NOT DONE HERE, AND SAID OUT LOUD SO NOBODY ASSUMES IT: this does not check
 * the file's ACL. src/secretstore.mjs has verifyPermissions() for that, it is
 * async, and wiring it belongs with the code that decides whether a loose ACL
 * is fatal or advisory. A world-readable token file is accepted by this module
 * today.
 */

/**
 * The largest thing that could sensibly be a token. A file bigger than this is
 * something else -- a key bundle, a log, a pasted transcript -- and reading it
 * as a credential would put its whole contents in an Authorization header.
 */
export const TOKEN_FILE_MAX_BYTES = 4096;

/**
 * Read one token out of a file. Returns {token, problem}.
 *
 * `problem` is null when the file is simply ABSENT, because an unconfigured
 * machine is a normal state. It is a STRING whenever the file exists and cannot
 * be used: a present-but-unusable credential is a misconfiguration somebody can
 * fix, and staying quiet about it is the "NOT CONFIGURED, exit 0" trap this
 * repository already has one of.
 *
 * Never throws, and never puts the token value into the problem text -- the
 * problem string is printed, and a printed credential is a leaked one.
 */
export function readTokenFile(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    const code = e && e.code ? e.code : '';
    // ENOENT: no such file. ENOTDIR: a path component is a file, which is a
    // typo in the path rather than a deliberate absence -- but both mean "no
    // token here", and neither is evidence of misconfiguration on its own.
    if (code === 'ENOENT' || code === 'ENOTDIR') return { token: '', problem: null };
    if (code === 'EISDIR') return { token: '', problem: 'is a directory' };
    return { token: '', problem: `cannot be read (${code || 'unknown error'})` };
  }

  if (raw.length > TOKEN_FILE_MAX_BYTES) {
    return { token: '', problem: `is larger than ${TOKEN_FILE_MAX_BYTES} bytes, so it is not a token` };
  }

  /*
   * trim() IS WHAT MAKES THIS WORK ON WINDOWS. An editor, or Set-Content, or a
   * here-string leaves a trailing CRLF. A token carrying a stray carriage
   * return fails auth with a 401 -- which this codebase deliberately reports as
   * REJECTED rather than unreachable, i.e. "somebody answered and said no".
   * So the failure mode of not trimming is an agent being told, accurately and
   * uselessly, that its perfectly good credential was refused.
   */
  const token = raw.trim();
  if (!token) return { token: '', problem: 'is empty' };

  /*
   * String.fromCharCode rather than an escape, deliberately. This repository
   * has twice had a literal control byte written into source by a generator
   * that collapsed a doubled backslash -- see CLAUDE.md. Spelling the bytes out
   * cannot be mangled by a layer in between.
   */
  const LF = String.fromCharCode(10);
  const CR = String.fromCharCode(13);
  if (token.includes(LF) || token.includes(CR)) {
    return { token: '', problem: 'has more than one line, and a token file holds the token alone with no comments' };
  }

  /*
   * EVERY BYTE MUST BE LEGAL IN AN HTTP HEADER, OR THE CREDENTIAL GETS PRINTED.
   *
   * Refusing CR and LF was not enough. undici rejects a NUL in a header value
   * and puts THE WHOLE VALUE IN THE ERROR MESSAGE, which the CLI prints:
   *
   *   hosted UNREACHABLE (Headers.append: "Bearer SECRETTOKEN_abc123\u0000x" is
   *   an invalid header value.) -- registered LOCALLY ONLY
   *
   * A BOM-less UTF-16LE file -- what [IO.File]::WriteAllText with
   * UnicodeEncoding(false,false) produces -- is the same shape and echoes every
   * character of the secret interleaved with NULs. Measured by blind audit.
   *
   * This is NEW reachability rather than an old leak: a Windows environment
   * variable cannot contain a NUL, so before the file route existed the value
   * could not get to that code path at all. The commit that added the flag
   * claimed "the value never appears in an error string", and that was true of
   * this module's own strings and false end to end.
   *
   * So the check is what a token IS rather than which characters are known to
   * be dangerous: printable ASCII, no spaces. Every credential this project
   * issues is base64url-ish, and enumerating the bad bytes is the mistake that
   * lost here repeatedly -- NUL was the one nobody listed.
   */
  const ILLEGAL = /[^\x21-\x7e]/;
  if (ILLEGAL.test(token)) {
    /*
     * The POSITION is reported, never the character and never the value. A byte
     * echoed back is a byte of the credential, which is the defect being fixed.
     */
    const at = token.search(ILLEGAL);
    return {
      token: '',
      problem: `contains a character at position ${at} that cannot appear in an HTTP header; a token is printable ASCII with no spaces`,
    };
  }

  return { token, problem: null };
}

/**
 * Build the env bag the CLI hands to src/ modules, with the token from
 * `--token-file` folded in under `varName`.
 *
 * Returns {env, error}. `error` is a STRING the caller must treat as FATAL.
 *
 * FATAL, NOT A WARNING, AND THAT IS THE WHOLE POINT. An absent file is a normal
 * unconfigured machine and stays quiet. But somebody who typed --token-file
 * asked for that file specifically, so degrading to local-only and exiting 0
 * would reproduce exactly the defect this flag exists to fix: an agent that
 * believes it registered, is invisible to every other machine, and whose exit
 * code says success. See rule 15 -- let a gate MOVE rather than close.
 *
 * PRECEDENCE: the flag beats the environment. Both are supplied by the operator,
 * and the one typed on this specific command line is the more deliberate of the
 * two; silently preferring an inherited variable would make the flag a no-op in
 * exactly the sessions that already had a token and were trying to override it.
 */
export function envWithTokenFile(baseEnv, tokenFile, { varName = 'AGENTBRIDGE_REGISTRATION_TOKEN' } = {}) {
  if (tokenFile === undefined || tokenFile === null || tokenFile === false) {
    return { env: baseEnv, error: null };
  }
  // parseArgs yields `true` for a flag with no value, so `--token-file --json`
  // arrives here as a boolean. That is a usage error, not a missing file.
  if (typeof tokenFile !== 'string' || tokenFile.trim() === '') {
    return { env: baseEnv, error: '--token-file needs a path' };
  }

  const file = tokenFile.trim();
  const { token, problem } = readTokenFile(file);
  if (problem) return { env: baseEnv, error: `--token-file ${file}: it ${problem}` };
  if (!token) return { env: baseEnv, error: `--token-file ${file}: no such file` };

  return { env: { ...baseEnv, [varName]: token }, error: null };
}
