#!/usr/bin/env node
/*
 * THE IMPORT IS GUARDED, BECAUSE THIS PROCESS FAILING IS A SILENT ALLOW.
 *
 * Claude Code treats a non-zero PreToolUse exit (other than 2) as a NON-BLOCKING
 * error: the tool proceeds. With static imports, a missing or broken
 * src/claudeGuard.mjs made node exit 1 with empty stdout, so every tool call was
 * approved by a guard that was not there. Measured 2026-09-17: exit=1, stdout
 * empty, ERR_MODULE_NOT_FOUND.
 *
 * That is not hypothetical. src/claudeGuard.mjs was really deleted on the
 * operator's machine that morning. The path list protects this file so it cannot
 * be removed -- but the protection is what disappears when the file does, which
 * is a bootstrapping hole no amount of PROTECTED_PATHS can close from inside.
 *
 * So the refusal below does not depend on anything being importable. It is
 * written out by hand, because a fail-closed default that needs a module to load
 * is not a fail-closed default.
 */
const UNLOADABLE = (detail) => `${JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason:
      `[agentbridge:guard-unloadable] The guard could not be loaded (${detail}), so it cannot establish that `
      + 'this operation is safe. Restore src/claudeGuard.mjs and src/guardSession.mjs from git. '
      + 'This guard fails closed; ask the owner for an intentional override.',
  },
})}\n`;

let evaluateClaudeTool;
let hookDecision;
let writeSnapshot;
try {
  ({ evaluateClaudeTool, hookDecision } = await import('../src/claudeGuard.mjs'));
  ({ writeSnapshot } = await import('../src/guardSession.mjs'));
} catch (e) {
  const detail = String(e?.code ?? e?.message ?? e).slice(0, 120);
  if (process.argv.includes('--session-start')) {
    /*
     * A SessionStart hook cannot deny anything, so there is nothing to block
     * here. Saying so is still worth it: no snapshot gets written, and the Stop
     * gate already refuses outright when the snapshot is missing.
     */
    process.stdout.write(`${JSON.stringify({
      systemMessage: `agentbridge guard: NOT INITIALISED -- the guard could not be loaded (${detail}). `
        + 'No snapshot was written, so the Stop gate will refuse. Restore the guard from git.',
    })}\n`);
  } else {
    process.stdout.write(UNLOADABLE(detail));
  }
  process.exit(0);
}

/*
 * --session-start records what the repository looked like BEFORE the session.
 * Everything downstream compares against it, so it must run first; the Stop gate
 * refuses outright when it is missing rather than assuming nothing changed.
 */
if (process.argv.includes('--session-start')) {
  let startRaw = '';
  for await (const chunk of process.stdin) startRaw += chunk;
  let sessionId = null;
  try { sessionId = JSON.parse(startRaw || '{}')?.session_id ?? null; } catch { sessionId = null; }

  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const r = writeSnapshot(root, sessionId);
  /*
   * A REFUSED MINT IS REPORTED, NOT SWALLOWED.
   *
   * Two different refusals arrive here and both matter.
   *
   * REPLACEMENT: re-running this used to overwrite the baseline with whatever
   * state the repository was in -- damage a file, re-run --session-start, and
   * Stop approves the damage. The exclusive create closed that.
   *
   * IT DID NOT CLOSE THE BYPASS ACROSS SESSIONS, and this comment used to claim
   * otherwise. The snapshot is keyed by repository AND session id, so a new
   * session is a new file and the exclusive create never fires: damage a
   * control, start a fresh session, and THIS LINE minted a clean baseline over
   * it. writeSnapshot now asks git before minting at all, so that refusal
   * surfaces here too.
   */
  process.stdout.write(`${JSON.stringify({
    systemMessage: r.ok
      ? `agentbridge guard: session snapshot initialised at ${r.file}`
      : `agentbridge guard: snapshot NOT replaced -- ${r.reason}`,
  })}\n`);
  process.exit(0);
}

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  payload = null;
}

/*
 * A THROW FROM THE JUDGE IS A DENY, NOT AN ALLOW, AND THAT IS NOT BELT AND
 * BRACES. An uncaught error here exits 1 with EMPTY STDOUT, and this file's own
 * header records that Claude Code reads an empty non-zero result as NON-BLOCKING
 * and lets the tool proceed. So every unhandled exception anywhere under
 * evaluateClaudeTool was an ALLOW.
 *
 * Measured 2026-09-18: an override grant carrying `"expires_at":{"toString":1}`
 * made Date.parse throw, the throw travelled out through overrideCovers and
 * judgeWrite, and a Write of {"hooks":{"disableAllHooks":true}} to
 * .claude/settings.json was permitted. The grant did not have to name the file
 * it unlocked. The module-load fallback above did not help, because the crash
 * happened AFTER a successful import.
 *
 * The root cause is fixed at its source in guardSession.mjs. This is the
 * class-level repair: the bug was one way to reach a general property, that
 * anything thrown here fails open, and fixing only the instance leaves the
 * property. Refusing on an unknown error is the same posture the rest of this
 * guard takes -- unknown is not clean.
 */
let result;
try {
  result = payload
    ? evaluateClaudeTool({ ...payload, cwd: payload.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), session_id: payload.session_id ?? null })
    : { allowed: false, id: 'invalid-json', reason: 'Claude hook input was not valid JSON' };
} catch (err) {
  result = {
    allowed: false,
    id: 'guard-threw',
    reason: `the guard threw while judging this call (${String(err?.message ?? err).slice(0, 200)}). `
      + 'An error is not permission: refusing rather than exiting non-zero with no decision, '
      + 'which Claude Code would treat as non-blocking',
  };
}

process.stdout.write(`${JSON.stringify(hookDecision(result))}\n`);
