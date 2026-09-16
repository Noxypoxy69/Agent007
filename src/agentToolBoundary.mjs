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
 * The separators this file knows how to split on, and nothing else is assumed.
 *
 * `&` IS HERE BECAUSE IT WAS MISSED. The first version of this file treated it
 * as an ordinary word: `git status & git push` split into nothing, parsed as
 * one command whose first token was a read verb, and was ALLOWED. The publish
 * rode behind the status.
 *
 * ── AND REMOVING IT AGAIN IS NOW A NO-OP, WHICH IS THE POINT ──
 *
 * Mutation-tested: delete `&` from this list and every test stays green, because
 * the allow-list below then refuses the line as an unmodelled character instead.
 * That is the inversion doing its job — under the old blocklist a forgotten
 * separator failed OPEN, and under this one it fails CLOSED with a worse error
 * message. Splitting it is better (the refusal names the command that was
 * stopped, which is what a reviewer reads) but no longer load-bearing for
 * safety. Rule 11: written down because no gate can say it.
 */
export const SEPARATOR_TOKENS = Object.freeze(['&&', '||', ';', '|', '&']);
const SEPARATORS = /\s*(?:&&|\|\||;|\||&)\s*/;

/**
 * WHAT A DECOMPOSABLE COMMAND MAY CONTAIN — an ALLOW-LIST, not a list of
 * dangerous constructs, and the difference is the whole point.
 *
 * The first version of this enumerated the things that hide a command: `$(`,
 * backticks, process substitution, newline, redirection. It was tested against
 * exactly those and it passed. `&` was not on it, so a background operator
 * walked through a gate whose own test file said "a status verb followed by a
 * publish, classified on its first word, is a read verb".
 *
 * That is rule 8 with the prober being the author: a blocklist is a claim about
 * every metacharacter a shell will ever have, checked against the handful
 * somebody thought of. So the question is inverted. A command line is
 * decomposable only if every character in it is one this file understands, and
 * anything else -- including a construct nobody here has heard of -- is
 * refused without a line of this file changing.
 *
 * The set is deliberately mean. Quotes and the ordinary punctuation of paths,
 * flags and messages are in; every character with a meaning to a shell is out.
 */
const DECOMPOSABLE = /^[A-Za-z0-9 \t_\-./=:,@+%'"]*$/;

/**
 * Flags that move git somewhere the placement was never checked against.
 *
 * `git -C /other/repo commit` is classified `commit` -- correctly, because that
 * is what it is -- and the placement says a disposable worktree on a work
 * branch. Both are true and they are about DIFFERENT REPOSITORIES. An agent in
 * a throwaway worktree can commit into the main clone through this, and every
 * check passes on the way.
 *
 * `normalizeCommand` already parses past these to find the subcommand, which is
 * right for naming the action and says nothing about where it lands. Refused
 * here rather than classified, because a placement that was never checked is
 * not a placement that passed.
 */
const RELOCATING = ['-C', '--git-dir', '--work-tree', '--namespace'];

/*
 * MATCHED IN BOTH SPELLINGS, because `--work-tree /x` and `--work-tree=/x` are
 * the same instruction to git and only one of them is a separate token. The
 * first version compared whole tokens against a Set and let the equals form
 * through -- the guard refused the flag and granted the flag, depending on a
 * space.
 */
const relocatingFlag = (a) =>
  RELOCATING.find((f) => a === f || a.startsWith(`${f}=`)) ?? null;

/** Why a command line cannot be decomposed safely, or null when it can be. */
export function opaqueReason(line) {
  /*
   * THE SEPARATORS COME OUT FIRST, and the first version of this forgot to do
   * that: `&` is a separator AND a character with a shell meaning, so an
   * allow-list applied to the raw line refused every legitimate `&&` compound
   * -- `git status && git diff`, two commands the policy allows, denied. A
   * guard that refuses everything passes every negative test in this file and
   * is an outage.
   *
   * So what is checked is what is LEFT once the separators this file models
   * have been taken out. Those are handled; anything still there is not.
   */
  const rest = String(line ?? '').split(SEPARATORS).join(' ');
  if (!DECOMPOSABLE.test(rest)) {
    const bad = [...rest].find((c) => !DECOMPOSABLE.test(c));
    return `it contains ${JSON.stringify(bad)}, which has a meaning to a shell that this `
      + 'splitter does not model, so a second command could be hiding in it';
  }
  return null;
}

/** Does this command point git at a tree the placement was not checked against? */
export function relocatesWorkspace(cmd) {
  if (String(cmd?.file ?? '').toLowerCase().replace(/\.(exe|cmd|bat)$/, '') !== 'git') return null;
  const flag = (cmd.args ?? []).map((a) => relocatingFlag(String(a))).find(Boolean);
  return flag ? `${flag} points git at a tree this placement was never checked against` : null;
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
    .split(SEPARATORS)
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
    const printed = [cmd.file, ...cmd.args].join(' ');
    /*
     * CHECKED BEFORE THE GUARD, because the guard would answer correctly about
     * the wrong tree. `git -C /other/repo commit` really is a commit and the
     * placement really is a disposable worktree; they are simply about
     * different repositories, and every check passes on the way through.
     */
    const moved = relocatesWorkspace(cmd);
    if (moved) {
      refusals.push({ command: printed, outcome: OUTCOME.DENY,
        code: 'OUTSIDE_WORKSPACE', reason: moved });
      continue;
    }
    const v = guardExecution(cmd, placement, decisions, { now });
    if (v.outcome !== OUTCOME.ALLOW) {
      refusals.push({ command: printed, outcome: v.outcome, code: v.code, reason: v.reason });
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
/**
 * The settings a coding engine needs in order to call the shim at all.
 *
 * HERE SO THERE IS ONE SPELLING OF THE WIRE FORMAT. The live test wrote this
 * JSON by hand first, which made it a second implementation of the thing it
 * was testing -- and a matcher typo there would have produced a green test
 * against a hook the engine never called.
 *
 * NOTHING IN THIS REPOSITORY CALLS IT YET, and that is stated rather than
 * implied. `attemptPipeline` would pass the resulting file to the engine
 * through `engine_args`; until it does, the guard is reachable only by a caller
 * that opts in, and the entry point declared in `moduleGraph.mjs` is
 * forward-looking. Prose describing an intention as a behaviour is how the
 * reviewer-lease columns got read by something and written by nothing.
 */
export function hookSettings(shimPath, { node = 'node' } = {}) {
  if (!nonEmpty(shimPath)) throw new TypeError('hookSettings requires a path to the shim');
  return {
    hooks: {
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [{ type: 'command', command: `${node} ${shimPath}` }],
      }],
    },
  };
}

export function toHookOutput(verdict) {
  const out = { hookEventName: 'PreToolUse' };
  if (verdict.decision !== DECISION.ABSTAIN) {
    out.permissionDecision = verdict.decision;
    out.permissionDecisionReason = verdict.reason;
  }
  return { hookSpecificOutput: out };
}
