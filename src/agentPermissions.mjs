import { guardExecution, OUTCOME, normalizeCommand } from './preExecutionGuard.mjs';

/**
 * THE OTHER HALF OF THE PROMPT PROBLEM: what the coding agent is told it may do
 * BEFORE it starts, derived from the same guard rather than written out again.
 *
 * preExecutionGuard closes the case where the task already knows its commands.
 * An agent choosing commands as it goes never reaches that check -- it asks its
 * OWN permission system, which knows nothing about leases, worktrees or the
 * ledger, and whose only vocabulary is a prompt on somebody's laptop. So the
 * answer has to be loaded into the agent at launch, in the agent's own
 * configuration language.
 *
 * DERIVED, NOT TRANSCRIBED. Every rule below is produced by asking
 * guardExecution about a real command and keeping the ones it allowed. A
 * hand-written allow-list beside a policy engine is a second policy that
 * disagrees with the first the day either changes, and the disagreement is
 * invisible because both look reasonable. If the guard stops allowing a local
 * commit, this list loses it in the same commit, without anybody remembering.
 *
 * NEVER A BLANKET GRANT, and this is the line to hold when somebody is tired.
 * "Allow everything, it is a disposable worktree" is one sentence away and it
 * ends the whole exercise: a worker that may run anything may publish, deploy,
 * or write to a protected branch, and the fact that its container is thrown
 * away afterwards does not un-publish any of it. The scope is closed, and
 * `assertNoBlanketGrant` refuses a wildcard that would reopen it.
 *
 * WHAT THIS FILE CANNOT DO, said plainly. It configures an agent; it does not
 * contain one. If an engine ignores its own permission configuration, or offers
 * a mode that prompts anyway, nothing here detects that -- the runner's
 * prompt detection does, after the fact. This is the door, not the wall.
 *
 * PURE. Placement, the ledger and the clock arrive as arguments.
 */

const arr = (v) => (Array.isArray(v) ? v : []);
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * The commands a coding task actually needs, as argv rather than as patterns.
 *
 * ARGV BECAUSE THE GUARD ANSWERS ABOUT COMMANDS. Asking it about a pattern
 * would mean inventing a second thing for it to classify, and the point of
 * deriving the list is that the question asked here is the same question asked
 * at execution. A command that would be refused at execution must not appear in
 * the launch configuration; otherwise the agent is told yes and then told no.
 */
export const CANDIDATE_COMMANDS = Object.freeze([
  { file: 'git', args: ['status'] },
  { file: 'git', args: ['diff'] },
  { file: 'git', args: ['log'] },
  { file: 'git', args: ['show'] },
  { file: 'git', args: ['add', '-A'] },
  { file: 'git', args: ['commit', '-m', 'message'] },
  { file: 'git', args: ['restore', 'path'] },
  { file: 'git', args: ['stash'] },
  { file: 'git', args: ['push'] },
  { file: 'git', args: ['merge', 'branch'] },
  { file: 'git', args: ['reset', '--hard'] },
  { file: 'npm', args: ['test'] },
  { file: 'npm', args: ['run', 'verify'] },
  { file: 'npm', args: ['run', 'deploy:audited'] },
]);

/**
 * How much of a command line identifies it, per executable.
 *
 * THE FIRST VERSION TOOK ONE ARGUMENT AND SILENTLY WIDENED THE SCOPE. `npm run
 * verify` rendered as `npm run:*`, which also matches `npm run deploy:audited`
 * -- a command the guard had just REFUSED in the same call. The allow-list
 * would have granted, in the engine's own configuration, exactly the thing the
 * policy denied, and both halves looked correct in isolation.
 *
 * That is why `assertRulesDoNotCoverDenied` exists below rather than a wider
 * number here. A depth is a guess about every command that will ever be added;
 * the assertion is a property, and it fails when the guess is wrong.
 */
const IDENTIFYING_ARGS = Object.freeze({ npm: 2, pnpm: 2, yarn: 2, bun: 2 });
const identify = (cmd) =>
  [cmd.file, ...arr(cmd.args).slice(0, IDENTIFYING_ARGS[String(cmd.file).toLowerCase()] ?? 1)]
    .filter((t) => !String(t).startsWith('-'))
    .join(' ');

/** How each engine spells "do not stop and ask". */
const ENGINES = Object.freeze({
  'claude-code': {
    nonInteractive: ['--print', '--permission-mode', 'acceptEdits'],
    allowFlag: '--allowed-tools',
    render: (cmd) => `Bash(${identify(cmd)}:*)`,
    prefixOf: (rule) => String(rule).replace(/^Bash\(/, '').replace(/:\*\)$/, ''),
  },
  codex: {
    nonInteractive: ['exec', '--full-auto'],
    allowFlag: '--allow',
    render: (cmd) => identify(cmd),
    prefixOf: (rule) => String(rule),
  },
});

/**
 * NO RULE MAY COVER A COMMAND THE GUARD REFUSED.
 *
 * The property the derivation is supposed to have, asserted instead of assumed.
 * A rendered rule is a prefix match, so a rule can be strictly broader than the
 * command it came from; when it is, it can reach across into the denied half
 * without anybody writing anything wrong. Checked against the refusals this
 * same call produced, so it is comparing the two halves of one answer rather
 * than against a fixture that may not resemble the real scope.
 */
export function assertRulesDoNotCoverDenied(rules, denied, engine) {
  const spec = ENGINES[engine];
  if (!spec) throw new TypeError(`agent permissions: unknown engine ${JSON.stringify(engine)}`);
  for (const rule of arr(rules)) {
    const prefix = spec.prefixOf(rule);
    for (const d of arr(denied)) {
      const line = [d.command.file, ...arr(d.command.args)].join(' ');
      if (line === prefix || line.startsWith(`${prefix} `)) {
        throw new Error(
          `agent permissions: rule ${JSON.stringify(rule)} also grants ${JSON.stringify(line)}, `
            + `which the guard refused as ${d.code}. A rule broader than the verdict it came `
            + 'from grants in the engine exactly what the policy denied',
        );
      }
    }
  }
  return rules;
}

export const ENGINE_IDS = Object.freeze(Object.keys(ENGINES));

/**
 * A wildcard that would let the agent run anything, in any engine's spelling.
 *
 * Checked rather than trusted, because the grant that reopens everything is one
 * careless entry and it looks like all the others.
 */
export function assertNoBlanketGrant(rules) {
  for (const rule of arr(rules)) {
    const r = String(rule).trim();
    if (r === '*' || r === '**' || r === 'Bash(*)' || r === 'Bash(*:*)' || r === 'all'
        || /^bash\(\s*\*/i.test(r)) {
      throw new Error(
        `agent permissions: ${JSON.stringify(rule)} grants every command. A disposable `
          + 'worktree does not un-publish a push or un-deploy a deploy, so "it gets thrown '
          + 'away" is not an argument for a blanket grant',
      );
    }
  }
  return rules;
}

/**
 * Which of the candidate commands this placement may run, and which it may not.
 *
 * Returns both lists. The refused half is not waste: it is what the agent is
 * told explicitly to deny, so an engine that would otherwise prompt has an
 * answer already, and it is what a reviewer reads to see what the worker could
 * not have done.
 */
export function permissionScope(placement = {}, decisions = [], { now } = {}) {
  if (!nonEmpty(now)) throw new TypeError('permissionScope requires a `now` timestamp');
  const allow = [];
  const deny = [];
  for (const cmd of CANDIDATE_COMMANDS) {
    const verdict = guardExecution(cmd, placement, decisions, { now });
    (verdict.outcome === OUTCOME.ALLOW ? allow : deny).push({
      command: cmd,
      action: verdict.action ?? normalizeCommand(cmd.file, cmd.args),
      ...(verdict.outcome === OUTCOME.ALLOW ? {} : { code: verdict.code, decider: verdict.decider ?? null }),
    });
  }
  return { allow, deny };
}

/**
 * The argv that starts a coding agent which cannot stop to ask.
 *
 * @param engine  one of ENGINE_IDS
 * @param opts    { binary, prompt, scope }  scope from permissionScope
 */
export function agentLaunch(engine, { binary = null, scope, extraArgs = [] } = {}) {
  const spec = ENGINES[engine];
  if (!spec) {
    throw new TypeError(
      `agent permissions: unknown engine ${JSON.stringify(engine)}; known: ${ENGINE_IDS.join(', ')}`,
    );
  }
  if (!scope || !Array.isArray(scope.allow)) {
    throw new TypeError('agent permissions: a scope from permissionScope is required');
  }
  /*
   * AN EMPTY ALLOW-LIST IS A REFUSAL, NOT A LAUNCH WITH NO RULES. Several
   * engines read "no allow-list" as "use your defaults", which is how a scope
   * that denied everything becomes a worker with an interactive fallback.
   */
  if (scope.allow.length === 0) {
    throw new Error(
      'agent permissions: the scope allows nothing, and launching with an empty allow-list '
        + 'means the engine falls back to its own defaults -- which is where the prompt lives',
    );
  }

  const rules = assertRulesDoNotCoverDenied(
    assertNoBlanketGrant([...new Set(scope.allow.map((a) => spec.render(a.command)))]),
    scope.deny,
    engine,
  );
  return {
    file: binary ?? engine,
    args: [...spec.nonInteractive, spec.allowFlag, rules.join(','), ...arr(extraArgs)],
    rules,
  };
}
