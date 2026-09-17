#!/usr/bin/env node
import { evaluateClaudeTool, hookDecision } from '../src/claudeGuard.mjs';

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
