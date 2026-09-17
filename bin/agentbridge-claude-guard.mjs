#!/usr/bin/env node
import { evaluateClaudeTool, hookDecision } from '../src/claudeGuard.mjs';
import { writeSnapshot } from '../src/guardSession.mjs';

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
