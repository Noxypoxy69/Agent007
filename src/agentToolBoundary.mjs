import { guardExecution, OUTCOME } from './preExecutionGuard.mjs';

/**
 * THE HOLE THAT LAUNCH SCOPE CANNOT CLOSE: an agent that CHOOSES its commands.
 *
 * `preExecutionGuard` answers about commands the task named. `agentPermissions`
 * answers once, at launch, in the engine's own configuration language. Between
 * them sits the case that is most of real agent work -- a command the agent
 * invents halfway through, which was never in the task and never in the
 * allow-list. Until now that command met the ENGINE's permission system and
 * nothing else, and the Bridge's lease, fence and worktree never entered into
 * it.
 *
 * MEASURED 2026-09-16, AND IT WORKS. Claude Code 2.1.273 calls a PreToolUse
 * hook before every Bash tool call and honours a `deny`. Pointed at
 * `guardExecution`, with a scope whose allow-list DID grant `git commit`:
 *
 *   lease valid -> hook allows -> value.txt 1->2, npm test passes, commit lands
 *   lease stale -> hook denies -> `npm test` refused with STALE_AUTHORITY,
 *                                no commit, HEAD still at base
 *
 * The engine's own allow-list said yes and the Bridge said no, at the agent's
 * tool boundary, on a command the agent chose. That is the answer to the open
 * half of item 7b: the guard CAN sit there.
 *
 * ═══ THE BOUNDARY SPEAKS SHELL, THE GUARD SPEAKS ARGV ═══
 *
 * The hook is handed `{"command": "git add -A && git status"}` -- one string,
 * shell syntax, possibly several commands. `normalizeCommand` takes a file and
 * an argv. Nothing in this repository bridged the two, and a bridge that gets
 * it wrong is worse than none: `git status; git push` classified on its first
 * word is a read verb, and the push goes out under it.
 *
 * SO THIS FAILS CLOSED ON ANYTHING IT CANNOT DECOMPOSE. A splitter is not a
 * shell parser and must never pretend to be one. Substitution, backticks,
 * process substitution, redirection and newlines are REFUSED rather than
 * guessed at, because every one of them can hide a second command from a
 * splitter that is only looking for `&&`. An honest refusal costs a round trip;
 * a confident guess costs the thing the guard exists to protect.
 *
 * PURE. The event, the placement and the ledger arrive as arguments.
 */

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

/** What the hook may answer. ABSTAIN emits no decision and leaves the engine's own. */
export const DECISION = Object.freeze({
  ALLOW: 'allow',
  DENY: 'deny',
  ABSTAIN: 'abstain',
});

/**
 * Shell constructs that can conceal a command from a separator-based splitter.
 *
 * WRITTEN AS THE THINGS THAT HIDE A COMMAND, not as "dangerous characters". A
 * quote is not dangerous; `$(` is, because whatever is inside it runs and this
 * file will never see it as a command. Rule 8 applies with force here: the
 * answer to a prober finding `$(git push)` is this list, not five more strings.
 */
const OPAQUE = Object.freeze([
  { re: /\$\(/, why: 'command substitution $( ) hides a command from the splitter' },
  { re: /`/, why: 'backtick substitution hides a command from the splitter' },
  { re: /<\(|>\(/, why: 'process substitution hides a command from the splitter' },
  { re: /[\n\r]/, why: 'a newline separates commands and the splitter does not read it' },
  { re: /[<>]/, why: 'redirection can write files the guard never classified' },
  { re: /\$\{/, why: 'parameter expansion can expand into a different command' },
  { re: /\\\s*$/, why: 'a trailing backslash continues the line somewhere unseen' },
]);

/** Why a command line could not be decomposed, or null when it can be. */
export function opaqueReason(line) {
  const s = String(line ?? '');
  for (const { re, why } of OPAQUE) if (re.test(s)) return why;
  return null;
}

/**
 * Split a shell line into the commands it runs, or null when it is not safe to.
 *
 * NULL IS THE REFUSAL AND IT IS NOT AN EMPTY LIST. An empty list would mean
 * "no commands here", which a caller quite reasonably allows.
 */
export function splitShellCommand(line) {
  if (!nonEmpty(line)) return null;
  if (opaqueReason(line)) return null;
  return String(line)
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const toks = p.split(/\s+/);
      return { file: toks[0], args: toks.slice(1) };
    });
}

/**
 * The Bridge's answer for one tool call the agent chose.
 *
 * EVERY PART OF A COMPOUND MUST PASS. `git status && git push` is not a status
 * command, and taking the verdict of the first part is the exact mistake that
 * makes a guard worse than nothing.
 *
 * @param event      the engine's PreToolUse payload: { tool_name, tool_input }
 * @param placement  { isDisposable, branch, leaseValid, fenceCurrent, ... }
 */
export function decideToolUse(event = {}, placement = {}, decisions = [], { now } = {}) {
  if (!nonEmpty(now)) throw new TypeError('decideToolUse requires a `now` timestamp');

  /*
   * A TOOL THIS GUARD KNOWS NOTHING ABOUT GETS NO OPINION, NOT A BLESSING.
   * Returning `allow` for every non-Bash call would mean that widening the
   * hook's matcher silently granted Write, Edit and WebFetch in one edit,
   * because the guard would be answering questions it cannot classify.
   */
  if (event.tool_name !== 'Bash') {
    return { decision: DECISION.ABSTAIN, refusals: [],
      reason: `the Bridge guard classifies commands; ${JSON.stringify(event.tool_name ?? null)} is not one` };
  }

  const line = event?.tool_input?.command;
  if (!nonEmpty(line)) {
    return { decision: DECISION.DENY, refusals: [],
      reason: 'a Bash call arrived with no command to classify, and an unreadable request '
        + 'is refused rather than waved through' };
  }

  const opaque = opaqueReason(line);
  if (opaque) {
    return { decision: DECISION.DENY, refusals: [],
      reason: `this command cannot be decomposed safely: ${opaque}. Run the steps as separate `
        + 'tool calls so each one can be classified' };
  }

  const refusals = [];
  for (const cmd of splitShellCommand(line)) {
    const v = guardExecution(cmd, placement, decisions, { now });
    if (v.outcome !== OUTCOME.ALLOW) {
      refusals.push({ command: [cmd.file, ...cmd.args].join(' '), outcome: v.outcome,
        code: v.code, reason: v.reason });
    }
  }

  if (refusals.length === 0) {
    return { decision: DECISION.ALLOW, refusals: [], reason: 'the Bridge guard allows every part of this command' };
  }
  return {
    decision: DECISION.DENY,
    refusals,
    reason: `the Bridge guard refused: ${refusals.map((r) => `${r.command} -> ${r.code}: ${r.reason}`).join('; ')}`,
  };
}

/**
 * The decision in the shape Claude Code's PreToolUse hook reads.
 *
 * SEPARATE FROM THE DECIDING, so the policy above can be tested without a
 * wire format and the wire format can change without touching the policy.
 * ABSTAIN emits no `permissionDecision` at all -- an absent field leaves the
 * engine's own configuration in charge, which is what having no opinion means.
 */
export function toHookOutput(verdict) {
  const out = { hookEventName: 'PreToolUse' };
  if (verdict.decision !== DECISION.ABSTAIN) {
    out.permissionDecision = verdict.decision;
    out.permissionDecisionReason = verdict.reason;
  }
  return { hookSpecificOutput: out };
}
