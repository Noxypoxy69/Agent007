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
   * A REFUSED REPLACEMENT IS REPORTED, NOT SWALLOWED. Re-running this used to
   * overwrite the baseline with whatever state the repository was in, which was
   * the entire reset bypass: damage a file, re-run --session-start, and Stop
   * approves the damage. Initialise once; a second call says so.
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

const result = payload
  ? evaluateClaudeTool({ ...payload, cwd: payload.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), session_id: payload.session_id ?? null })
  : { allowed: false, id: 'invalid-json', reason: 'Claude hook input was not valid JSON' };

process.stdout.write(`${JSON.stringify(hookDecision(result))}\n`);
