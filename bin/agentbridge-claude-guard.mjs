#!/usr/bin/env node
import { evaluateClaudeTool, hookDecision } from '../src/claudeGuard.mjs';
import { writeSnapshot } from '../src/guardSession.mjs';

/*
 * --session-start records what the repository looked like BEFORE the session.
 * Everything downstream compares against it, so it must run first; the Stop gate
 * refuses outright when it is missing rather than assuming nothing changed.
 */
if (process.argv.includes('--session-start')) {
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const file = writeSnapshot(root);
  process.stdout.write(`${JSON.stringify({ systemMessage: `agentbridge guard: session snapshot written to ${file}` })}\n`);
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
  ? evaluateClaudeTool(payload)
  : { allowed: false, id: 'invalid-json', reason: 'Claude hook input was not valid JSON' };

process.stdout.write(`${JSON.stringify(hookDecision(result))}\n`);
