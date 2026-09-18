/**
 * Command-line sanitisation.
 *
 * argv is visible in the OS process table, and people put tokens in it. This
 * module is ALLOWLIST-based: a token is published only if it is recognisably
 * safe. Anything unrecognised is redacted. That loses some readability and is
 * the correct trade — an unredacted credential on the wire is unrecoverable,
 * an over-redacted flag costs one question.
 *
 * Raw command lines never leave this module.
 */

const SENSITIVE_FLAG = /^--?(token|password|passwd|pass|secret|key|api[-_]?key|auth|authorization|bearer|credential|cred|header|H|p|u|user|private[-_]?key|access[-_]?key|session|cookie|dsn|conn|connection[-_]?string)$/i;
const SENSITIVE_ASSIGN = /^([A-Za-z_][\w.-]*(?:TOKEN|SECRET|KEY|PASS(?:WORD)?|PWD|AUTH|CRED\w*|SESSION|COOKIE|DSN|CONN\w*|URL|URI|BEARER|SIGNATURE|SALT|SEED)[\w.-]*)=(.*)$/i;

/** Shapes that are secrets regardless of where they appear. */
const SECRET_SHAPE = [
  /^eyJ[A-Za-z0-9_-]{10,}\./,                       // JWT
  /^(sk|pk|rk)-[A-Za-z0-9_-]{16,}$/i,               // OpenAI/Stripe-style
  /^(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}$/,       // GitHub
  /^github_pat_[A-Za-z0-9_]{20,}$/,
  /^xox[baprs]-[A-Za-z0-9-]{10,}$/,                 // Slack
  /^glpat-[A-Za-z0-9_-]{16,}$/,                     // GitLab
  /^npm_[A-Za-z0-9]{20,}$/,
  /^AKIA[0-9A-Z]{12,}$/,                            // AWS access key id
  /^AIza[0-9A-Za-z_-]{30,}$/,                       // Google API key
  /^[A-Fa-f0-9]{24,}$/,                             // long hex (HMAC keys, digests)
  /^[A-Za-z0-9+/]{28,}={0,2}$/,                     // long base64
  /^[A-Za-z0-9_-]{28,}$/,                           // long opaque token
  /:\/\/[^/@\s]+:[^/@\s]+@/,                        // credentials embedded in a URL
];

/** Conservative shape for a token we are willing to publish verbatim. */
const SAFE_TOKEN = /^[\w@.\-+/\\:]{1,64}$/;
const SAFE_ASSIGN = /^[A-Za-z_][\w.-]{0,40}=[\w@.\-+/\\:]{0,40}$/;

export const REDACTED = '<<redacted:arg>>';
const MAX_ARGS = 12;

export function looksSecret(tok) {
  return SECRET_SHAPE.some((re) => re.test(tok));
}

/** Split a command line on whitespace, honouring single and double quotes. */
export function tokenize(cmd) {
  const out = [];
  let cur = '', quote = null, any = false;
  for (const ch of String(cmd)) {
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; any = true; continue; }
    if (/\s/.test(ch)) { if (cur || any) { out.push(cur); cur = ''; any = false; } continue; }
    cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

const basename = (p) => String(p).split(/[\\/]/).pop() || p;

const EXE_EXT = /\.(exe|cmd|bat|com|ps1)$/i;

/**
 * Win32_Process often returns an UNQUOTED executable path, and Windows paths
 * contain spaces ("C:\\Program Files\\nodejs\\node.exe"). Naive tokenising
 * splits that into "C:\\Program" + "Files\\nodejs\\node.exe", which would
 * publish a wrong executable and shift every argument.
 *
 * If the first token has no executable extension, join forward until one does.
 * Returns [executableTokens, remainingArgs].
 */
export function splitExecutable(toks) {
  if (!toks.length) return [[], []];
  if (EXE_EXT.test(toks[0])) return [[toks[0]], toks.slice(1)];
  for (let i = 1; i < Math.min(toks.length, 6); i++) {
    if (EXE_EXT.test(toks[i])) return [toks.slice(0, i + 1), toks.slice(i + 1)];
  }
  return [[toks[0]], toks.slice(1)];   // bare name like `npm` or `node`
}

/**
 * Returns { executable, args, argCount, redactedCount, truncated }.
 * `executable` is a basename only — the full path is already published as the
 * worktree field where it is meaningful, and elsewhere it is just surface area.
 */
export function sanitizeCommand(cmd) {
  const toks = tokenize(cmd);
  if (!toks.length) return { executable: null, args: [], argCount: 0, redactedCount: 0, truncated: false };

  const [exeToks, rest] = splitExecutable(toks);
  const executable = basename(exeToks.join(' ')).slice(0, 64);
  const args = [];
  let redactedCount = 0;
  let pendingSensitive = false;

  for (const tok of rest.slice(0, MAX_ARGS)) {
    if (pendingSensitive) { args.push(REDACTED); redactedCount++; pendingSensitive = false; continue; }

    if (SENSITIVE_FLAG.test(tok)) { args.push(tok); pendingSensitive = true; continue; }

    const eq = tok.indexOf('=');
    if (tok.startsWith('-') && eq > 0) {
      const name = tok.slice(0, eq);
      if (SENSITIVE_FLAG.test(name)) { args.push(`${name}=${REDACTED}`); redactedCount++; continue; }
    }

    const assign = tok.match(SENSITIVE_ASSIGN);
    if (assign) { args.push(`${assign[1]}=${REDACTED}`); redactedCount++; continue; }

    if (looksSecret(tok)) { args.push(REDACTED); redactedCount++; continue; }

    if (SAFE_TOKEN.test(tok) || SAFE_ASSIGN.test(tok)) { args.push(tok); continue; }

    args.push(REDACTED); redactedCount++;         // unrecognised shape: drop it
  }

  // A sensitive flag in the final published position would otherwise leave its
  // value unredacted just outside the window. Mark it explicitly.
  if (pendingSensitive) { args.push(REDACTED); redactedCount++; }

  return {
    executable,
    args,
    argCount: rest.length,
    redactedCount,
    truncated: rest.length > MAX_ARGS,
  };
}

/*
 * ------------------------------------------------------------------------
 * POSITIONALS, WHICH IS PARSING RATHER THAN SANITISING, AND LIVES HERE
 * BECAUSE THE ALTERNATIVE WAS A THIRD INLINE COPY.
 *
 * check-first and verify-sha each carried their own loop, and both had the same
 * defect. Measured, not reasoned about:
 *
 *   check-first --json roster   ->  topic parsed as ""   (then: "no prior work")
 *   verify-sha  --json <rev>    ->  revision lost entirely
 *
 * The loop skipped the token after ANY flag, on the assumption that every flag
 * takes a value. `--json` does not. So a boolean flag ate the positional, and in
 * check-first's case the tool then reported nothing found for a topic it had
 * never been given -- absent presented as zero, in the command whose entire job
 * is stopping duplicate work.
 *
 * WHY AN EXPLICIT VALUELESS SET RATHER THAN A VALUE SET. Both lists can be
 * wrong; the question is how they fail. Forget a VALUE flag and its argument
 * becomes a positional, polluting the topic -- silent and wrong. Forget a
 * VALUELESS flag and it eats a positional, so the command refuses with "name a
 * commit" -- loud and obviously wrong. Between two incomplete lists, take the
 * one whose omissions announce themselves.
 *
 * `--flag=value` never consumes a following token, in either list.
 */

/** Flags that take no value anywhere in this CLI. Callers may add their own. */
export const VALUELESS_FLAGS = Object.freeze([
  'json', 'help', 'dry-run', 'once', 'watch', 'sql',
  'show-secret', 'strict-shared', 'registry-live', 'confirm-audited',
]);

export function positionals(argv, { valueless = VALUELESS_FLAGS } = {}) {
  const novalue = new Set(valueless.map((f) => f.replace(/^--/, '')));
  const words = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i += 1) {
    const a = typeof list[i] === 'string' ? list[i] : '';
    if (!a.startsWith('--')) { words.push(a); continue; }
    if (a.includes('=')) continue;                   // --flag=value carries its own
    if (novalue.has(a.slice(2))) continue;           // boolean: the next token is not its value
    const next = list[i + 1];
    if (next !== undefined && !next.startsWith('--')) i += 1;
  }
  return words;
}
