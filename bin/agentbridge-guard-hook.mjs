#!/usr/bin/env node
import { decideToolUse, toHookOutput, DECISION } from '../src/agentToolBoundary.mjs';

/**
 * The thin shim that puts the Bridge guard on a coding agent's tool boundary.
 *
 * ALL THE DECIDING IS IN `src/agentToolBoundary.mjs` AND NONE IS HERE, for the
 * reason CLAUDE.md gives about the edge function: a guard that only exists
 * inside an entry point is a guard the suite cannot import and nobody has ever
 * watched fail. This file reads stdin, writes stdout, and carries no policy.
 *
 * Placement arrives in the environment because the engine controls the argv:
 * the hook is named as a command string in a settings file, and there is
 * nowhere to put the lease.
 *
 *   AGENTBRIDGE_PLACEMENT  JSON {isDisposable, branch, leaseValid, fenceCurrent, ...}
 *
 * A MISSING OR UNREADABLE PLACEMENT IS A REFUSAL, not an empty object. An empty
 * placement leaves `leaseValid` undefined, and `guardExecution` only refuses on
 * an explicit `false` -- so a typo in the variable name would quietly grant
 * every command the action classifier likes, with no lease checked at all. That
 * is the shape of hollow gate 3: a guard reading a field nothing ever wrote.
 */
async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  const fail = (reason) => {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: DECISION.DENY,
        permissionDecisionReason: reason },
    }));
  };

  let placement;
  try {
    placement = JSON.parse(process.env.AGENTBRIDGE_PLACEMENT ?? '');
  } catch {
    return fail('AGENTBRIDGE_PLACEMENT is missing or is not JSON, so no lease, fence or '
      + 'workspace could be checked. The Bridge guard refuses rather than assume a placement.');
  }
  if (!placement || typeof placement !== 'object' || Array.isArray(placement)) {
    return fail('AGENTBRIDGE_PLACEMENT is not an object, so there is no placement to check.');
  }

  let event;
  try { event = JSON.parse(raw); }
  catch { return fail('the hook payload was not JSON, so the tool call could not be classified.'); }

  process.stdout.write(JSON.stringify(
    toHookOutput(decideToolUse(event, placement, [], { now: new Date().toISOString() })),
  ));
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: DECISION.DENY,
      permissionDecisionReason: `the Bridge guard hook failed: ${e.message}` },
  }));
});
