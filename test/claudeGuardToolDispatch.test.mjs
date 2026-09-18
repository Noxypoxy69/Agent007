/*
 * ISOLATE THE GUARD HOME BEFORE ANYTHING ELSE IN THIS FILE.
 *
 * These assertions ask whether a protected path is refused. That answer depends
 * on the OVERRIDE STORE, which lives outside the repository -- so without this
 * line an operator's grant, a file this suite does not control and cannot see,
 * changes the verdict. Measured 2026-09-18 by audit: with a grant active for
 * src/guardSession.mjs this file went from 0 failures to 1, and two sibling
 * files moved the same way. A security test an operator can flip is not a test.
 *
 * Set before the guard modules are imported, because readOverride resolves the
 * home per call from this variable.
 */
import { mkdtempSync as __iso } from 'node:fs';
import { tmpdir as __tmp } from 'node:os';
import __isoPath from 'node:path';
process.env.AGENTBRIDGE_HOME = __iso(__isoPath.join(__tmp(), 'guard-test-home-'));

/*
 * WHY THIS FILE EXISTS.
 *
 * On 2026-09-17, on the operator's Windows machine, a real Claude Code session
 * ran `rm src/claudeGuard.mjs` and the file was DELETED. git reported
 * `D src/claudeGuard.mjs`. Nothing refused it.
 *
 * Two layers of the same mistake. `.claude/settings.json` submitted only
 * "Bash|Edit|MultiEdit|Write|NotebookEdit", and Windows sessions run shell
 * through a PowerShell tool. And `evaluateClaudeTool` dispatched on
 * `toolName === 'Bash'`, ending in `return { allowed: true }` for everything
 * else -- so even with the matcher fixed, the guard would have approved it.
 *
 * Both layers enumerated the spellings they knew. CLAUDE.md rule 8: an
 * adversarial probe bounds nothing; fix the matcher, not the five strings the
 * prober happened to try. So this file does not test "PowerShell is blocked".
 * It tests the PROPERTY that the tool's NAME does not decide the outcome.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateClaudeTool } from '../src/claudeGuard.mjs';
import { judgeShellCommand } from '../src/shellAllowlist.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/*
 * The literal command that deleted this guard, kept verbatim. CLAUDE.md rule 2:
 * the mutation must be the REAL regression. `echo hi` proves nothing here.
 */
const THE_REGRESSION = 'rm src/claudeGuard.mjs';

/*
 * Not a list of shells -- a list chosen to be WIDER than any list the guard
 * could hold: the names we know, the ones we do not, and shapes a future
 * harness might invent. If the guard ever dispatches on names again, the
 * unknown entries go red.
 */
const TOOL_NAMES = [
  'Bash', 'PowerShell', 'powershell', 'pwsh', 'Shell', 'Cmd', 'Terminal',
  'BashTool', 'RunCommand', 'Execute', 'Totally__New__Tool', 'x', 'ZZZ-9',
];

test('a mutating command is refused under every tool name, not just Bash', () => {
  for (const name of TOOL_NAMES) {
    /*
     * POSITIVE FIRST (rule 5). Without this, a deny below could mean "the tool
     * name was unrecognised" rather than "the command was judged" -- the gate
     * would pass for the wrong reason and would keep passing if shell judging
     * were removed entirely.
     */
    const readOnly = evaluateClaudeTool({
      tool_name: name, tool_input: { command: 'git status' }, cwd: repoRoot, session_id: 's',
    });
    assert.equal(readOnly.allowed, true, `${name}: a read-only command must reach the shell rail and pass`);

    const verdict = evaluateClaudeTool({
      tool_name: name, tool_input: { command: THE_REGRESSION }, cwd: repoRoot, session_id: 's',
    });
    assert.equal(verdict.allowed, false, `${name}: ${THE_REGRESSION} must be refused`);
    /*
     * NOT A PROXY (rule 4). `allowed === false` would also be satisfied by
     * 'unclassified-tool', which would mean the command was never judged at
     * all. The id names WHICH control fired.
     */
    assert.equal(verdict.id, 'shell-not-allowlisted', `${name}: must be refused BY THE SHELL RAIL, not incidentally`);
  }
});

test('a command is judged in whichever field carries it', () => {
  for (const field of ['command', 'script', 'cmd']) {
    const verdict = evaluateClaudeTool({
      tool_name: 'SomeFutureShell', tool_input: { [field]: THE_REGRESSION }, cwd: repoRoot, session_id: 's',
    });
    assert.equal(verdict.allowed, false, `input.${field} must be judged`);
    assert.equal(verdict.id, 'shell-not-allowlisted', `input.${field} must reach the shell rail`);
  }
});

test('a write to a protected path is refused under an unfamiliar tool name', () => {
  for (const field of ['file_path', 'path', 'filePath']) {
    const verdict = evaluateClaudeTool({
      tool_name: 'SomeFutureEditor',
      tool_input: { [field]: 'src/guardSession.mjs', content: 'x' },
      cwd: repoRoot,
      session_id: 's',
    });
    assert.equal(verdict.allowed, false, `input.${field} must be checked`);
    assert.equal(verdict.id, 'protected-control');
  }
});

test('an unclassifiable tool that names a protected path is still refused', () => {
  /*
   * THE BACKSTOP, NOT THE BOUNDARY. A tool with no command and no recognised
   * path field is allowed through -- default-denying those refused 24 of a real
   * 54-tool roster, which is an outage, not a guard. But a protected path
   * appearing under SOME field name nobody anticipated is still caught.
   */
  const hidden = evaluateClaudeTool({
    tool_name: 'SomeFileMover',
    tool_input: { source: 'a.txt', destination: 'src/claudeGuard.mjs' },
    cwd: repoRoot,
    session_id: 's',
  });
  assert.equal(hidden.allowed, false, 'a protected path under an unanticipated field must still be caught');
  assert.equal(hidden.id, 'protected-control');

  const nested = evaluateClaudeTool({
    tool_name: 'SomeBatchTool',
    tool_input: { ops: [{ to: 'docs/ORDER.md' }] },
    cwd: repoRoot,
    session_id: 's',
  });
  assert.equal(nested.allowed, false, 'the backstop must see into nested structures');
});

test('an unclassifiable tool that touches nothing in the repo is allowed', () => {
  /*
   * POSITIVE HALF (rule 5 and rule 15). Without this the gate above would pass
   * just as well if the guard refused EVERYTHING, which is the exact failure
   * this pair replaced.
   */
  for (const name of ['CronList', 'ListSkills', 'PushNotification', 'SearchPlugins', 'SomethingBrandNew']) {
    const verdict = evaluateClaudeTool({ tool_name: name, tool_input: { q: 'hello' }, cwd: repoRoot, session_id: 's' });
    assert.equal(verdict.allowed, true, `${name} cannot touch the repo and must not be blocked (id was ${verdict.id})`);
  }
});

/*
 * THE OVERRIDE INCENTIVE IS PART OF THE THREAT MODEL. A guard that blocks
 * ordinary work gets switched off, and switching it off loses every layer at
 * once. These are as load-bearing as the refusals above.
 */
test('ordinary read-only work is not blocked', () => {
  const allowed = [
    ['Read', { file_path: 'CLAUDE.md' }],          // protected, but a READ
    ['Read', { file_path: '.claude/settings.json' }],
    ['Grep', { pattern: 'x' }],
    ['Glob', { pattern: '**/*.mjs' }],
    ['Task', { prompt: 'x' }],
    ['TodoWrite', { todos: [] }],
    ['mcp__Bridge__list_agents', {}],
    ['Bash', { command: 'npm test' }],
    /*
     * These are the ones the fix itself nearly broke. Widening the matcher to
     * "*" means EVERY tool now reaches the guard, so every ordinary tool that
     * is not classifiable would have been refused as 'unclassified-tool'. That
     * is the override incentive: a guard that blocks ordinary work gets
     * switched off, and switching it off loses every layer at once.
     */
    ['BashOutput', { bash_id: '1' }],
    ['KillShell', { shell_id: '1' }],
    ['SlashCommand', { command_name: 'help' }],
    ['Skill', { skill: 'x' }],
    ['AskUserQuestion', { questions: [] }],
    ['ExitPlanMode', { plan: 'x' }],
    ['TaskCreate', { title: 'x' }],
    ['TaskUpdate', { id: '1' }],
    ['SendMessage', { to: 'x', message: 'y' }],
    ['ListAgents', {}],
    ['ToolSearch', { query: 'x' }],
    ['WebSearch', { query: 'x' }],
  ];
  for (const [name, input] of allowed) {
    const verdict = evaluateClaudeTool({ tool_name: name, tool_input: input, cwd: repoRoot, session_id: 's' });
    assert.equal(verdict.allowed, true, `${name} must not be blocked (id was ${verdict.id})`);
  }
});

/*
 * READS THE SHIPPED FILE, DOES NOT RECONSTRUCT THE RULE (rule 2). A gate that
 * rebuilt the matcher from its own idea of the right answer would agree with
 * itself straight through the regression it exists to catch.
 */
test('the shipped PreToolUse matcher submits every tool to the guard', () => {
  const settings = JSON.parse(readFileSync(path.join(repoRoot, '.claude', 'settings.json'), 'utf8'));
  const preToolUse = settings?.hooks?.PreToolUse;
  assert.ok(Array.isArray(preToolUse) && preToolUse.length > 0, 'PreToolUse must be configured at all');
  for (const entry of preToolUse) {
    assert.equal(
      entry.matcher, '*',
      `PreToolUse matcher must be "*" and not an enumeration of tool names; found ${JSON.stringify(entry.matcher)}`,
    );
  }
});

test('settings.json ends with a newline', () => {
  const raw = readFileSync(path.join(repoRoot, '.claude', 'settings.json'), 'utf8');
  assert.equal(raw.endsWith('\n'), true, 'a file without a trailing newline fuses onto whatever follows it');
});

/*
 * THE SHELL RAIL WAS POSIX-ONLY WHILE RUNNING ON A POWERSHELL MACHINE.
 *
 * Measured on the operator's Windows machine 2026-09-17: Get-Content,
 * Get-ChildItem, Select-String, Test-Path and Get-Location were all refused,
 * and so was `sed -n '1,20p' CLAUDE.md` -- the exact read named in
 * src/claudeGuard.mjs as the reason a path check was removed. The comment
 * described a repair that had never been made.
 *
 * Both directions are asserted here. A rail that only refuses is an outage and
 * gets switched off, which loses the Stop gate with it; a rail that only
 * permits is decoration.
 */
test('PowerShell read-only cmdlets are accepted', () => {
  for (const command of [
    'Get-Content CLAUDE.md', 'get-content CLAUDE.md', 'Get-ChildItem -Path src',
    'Select-String -Pattern foo -Path src/x.mjs', 'Test-Path src/claudeGuard.mjs',
    'Get-Location', 'gci src', 'sls -Pattern foo src/x.mjs',
  ]) {
    assert.equal(judgeShellCommand(command).allowed, true, `${command} is a read and must be allowed`);
  }
});

test('PowerShell writers and execution stay refused', () => {
  for (const command of [
    'Set-Content CLAUDE.md x', 'Add-Content CLAUDE.md x', 'Clear-Content CLAUDE.md',
    'Out-File CLAUDE.md', 'Remove-Item src/claudeGuard.mjs', 'Move-Item a b',
    'Copy-Item a b', 'New-Item x', 'Invoke-Expression x', 'Start-Process cmd',
  ]) {
    assert.equal(judgeShellCommand(command).allowed, false, `${command} writes or executes and must be refused`);
  }
});

test('sed is accepted as a line-range print and refused as a write primitive', () => {
  for (const command of [
    "sed -n '1,20p' CLAUDE.md", 'sed -n "1,20p" src/collect.mjs',
    'sed -n 1,20p CLAUDE.md', 'sed -n 5p src/x.mjs',
  ]) {
    assert.equal(judgeShellCommand(command).allowed, true, `${command} is the documented read`);
  }
  /*
   * A BLANKET sed ENTRY WOULD HAVE BEEN A HOLE. The w command and the s///w
   * flag both create files, carrying no metacharacter and no write flag for the
   * earlier checks to catch. These are the cases that make the narrow shape
   * necessary rather than fussy.
   */
  for (const command of [
    "sed -n '1w out.txt' CLAUDE.md", "sed -n 's/a/b/w out.txt' CLAUDE.md",
    "sed -i 's/a/b/' CLAUDE.md", 'sed --in-place s/a/b/ CLAUDE.md',
  ]) {
    assert.equal(judgeShellCommand(command).allowed, false, `${command} can write and must be refused`);
  }
});

test('Workflow cannot bypass the guard merely because its payload field is named script', () => {
  const verdict = evaluateClaudeTool({
    tool_name: 'Workflow',
    tool_input: { script: "require('node:fs').unlinkSync('src/claudeGuard.mjs')" },
    cwd: repoRoot,
    session_id: 's',
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.id, 'workflow-exec-untrusted');
});

/* ============================================================================
 * THE SWEEP HOLE. The named-path check was sound and covered the wrong half.
 *
 * Measured 2026-09-17 at 1489931, by calling judgeShellCommand directly:
 * `git add src/claudeGuard.mjs` was DENIED -- the spelling CLAUDE.md mandates --
 * while `git add -A`, `git add .`, `git add -u`, `git commit -am`,
 * `git restore .`, `git checkout --force`, `git switch --force` and
 * `git switch --discard-changes` were all ALLOWED. Every one of them reaches the
 * guard's own source without naming it. The guard refused the documented
 * workflow and permitted the sweep.
 * ==========================================================================*/

test('a sweeping stage or commit cannot reach a protected file without naming it', () => {
  for (const command of [
    'git add -A', 'git add .', 'git add -u', 'git add --all',
    'git commit -a -m x', 'git commit -am x', 'git commit --all -m x',
  ]) {
    assert.equal(judgeShellCommand(command).allowed, false, `ALLOWED: ${command}`);
  }
});

test('git restore . disarms the hook for the rest of the session, and is refused', () => {
  /*
   * The sharpest row in the table. It reverts the whole working tree including
   * src/claudeGuard.mjs, and the hook re-imports that module on every call, so
   * PreToolUse is disarmed the moment the command returns. The pathspec spelling
   * of the same operation was already refused; this closes the sweep spelling.
   */
  assert.equal(judgeShellCommand('git restore .').allowed, false);
  assert.equal(judgeShellCommand('git checkout .').allowed, false);
});

test('force is refused in every spelling it has, not just the one -f collides with', () => {
  /*
   * `git checkout -f` denied only by coincidence: WRITE_FLAGS carries -f meaning
   * --file. Narrowing WRITE_FLAGS to the flags it was written for -- a reasonable
   * tidy-up -- would have silently removed the only refusal here.
   */
  for (const command of [
    'git checkout -f', 'git checkout --force', 'git checkout -f other-branch',
    'git switch --force', 'git switch --discard-changes', 'git switch -f other',
  ]) {
    assert.equal(judgeShellCommand(command).allowed, false, `ALLOWED: ${command}`);
  }
});

test('THE WORKFLOW IS NOT REFUSED, because an over-block is how a rail gets switched off', () => {
  /*
   * This repository has paid for two over-blocks already. Closing the sweep must
   * not close committing by pathspec, which is the shape CLAUDE.md requires.
   */
  for (const command of [
    'git commit -m x', 'git commit -F -', 'git commit --amend --no-edit',
    'git add src/collect.mjs', 'git checkout -b newbranch',
    'git status', 'git fetch origin master',
  ]) {
    assert.equal(judgeShellCommand(command).allowed, true, `newly REFUSED: ${command}`);
  }
});

test('MUTATION: the verb classification is derived from GIT_WRITE and cannot silently gap', async () => {
  /*
   * Enumerating these by hand produced the same gap twice -- nine verbs and two
   * named, leaving fetch, push, switch and tag unassigned; the first correction
   * still missed switch. The module now asserts its own classification against
   * GIT_WRITE at load. This test proves that assertion is load-bearing by
   * reading the source rather than by trusting that it is still there.
   */
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/shellAllowlist.mjs', import.meta.url), 'utf8');
  assert.match(src, /classification is out of step with GIT_WRITE/,
    'the load-time derivation check was removed; a new GIT_WRITE verb can now become a hole');
  assert.match(src, /GIT_WRITE_VERBS\s*=\s*Object\.freeze\(\s*\n?\s*GIT_WRITE\.source/,
    'the verb list must be DERIVED from GIT_WRITE, not typed beside it');
});

/* ============================================================================
 * RECORDING A TEST IS NOT OVERWRITING ONE, AND THE RAIL CONFLATED THEM.
 *
 * The baseline-test clause exists because `git restore test/a.test.mjs` REPLACES
 * an inherited test with whatever HEAD holds. add and commit cannot alter a
 * file's content; they record it. The clause applied to both, and once the sweep
 * spellings were closed alongside it, the two checks together left NO permitted
 * spelling for staging any test file from a guarded session -- not the orphaned
 * ones, not a test written a minute ago. Rule 17: an outage is how a guard gets
 * switched off, which loses every layer at once.
 *
 * isProtectedRelPath stays unconditional; only the broader glob is narrowed.
 * Measured against the rail at a0bdbf9 plus this change.
 * ==========================================================================*/

test('a session can stage and commit a test it wrote, which the rail had made impossible', () => {
  assert.equal(judgeShellCommand('git add -N test/anything.test.mjs').allowed, true);
  assert.equal(judgeShellCommand('git commit test/anything.test.mjs -m msg').allowed, true);
});

test('but a baseline test still cannot be OVERWRITTEN by the verbs that overwrite', () => {
  assert.equal(judgeShellCommand('git restore test/anything.test.mjs').allowed, false);
  assert.equal(judgeShellCommand('git checkout HEAD -- test/anything.test.mjs').allowed, false);
});

test('and a PROTECTED path is refused by every verb, recorders included', () => {
  /*
   * The narrowing must not reach isProtectedRelPath. test/claudeGuard.test.mjs
   * is protected by name, so `git add` of it stays refused while `git add` of an
   * ordinary test is now permitted -- that pair is the whole point.
   */
  assert.equal(judgeShellCommand('git add -N test/claudeGuard.test.mjs').allowed, false);
  assert.equal(judgeShellCommand('git commit test/claudeGuard.test.mjs -m msg').allowed, false);
});

/* ============================================================================
 * THE node EXECUTION GATE. Shipped once with no tests, and three bypasses
 * passed a fully green suite because of it.
 *
 * Every assertion here drives judgeShellCommand with an INJECTED classifier, so
 * the rail stays pure and the cases are the ones that were actually measured as
 * working disarms at 2812d8a. The gate's default is permissive by design -- a
 * caller with no session context must not be broken -- which is exactly why the
 * gated behaviour needs its own coverage: with no predicate supplied, none of
 * these assertions would fail even if the gate were deleted.
 * ==========================================================================*/

/** bin/ and scripts/ shipped; helper.mjs is a file the session wrote; the rest are arguments. */
const classify = (t) => {
  if (t.startsWith('bin/') || t.startsWith('scripts/') || t.startsWith('test/')) return 'inherited';
  if (/\.(mjs|js|cjs)$/i.test(t)) return 'untracked-file';
  return 'not-a-file';
};
const nodeVerdict = (cmd) => judgeShellCommand(cmd, { mayExecute: classify }).allowed;

test('THE TWO-CALL DISARM: a script the session wrote cannot be run', () => {
  assert.equal(nodeVerdict('node helper.mjs'), false);
  assert.equal(nodeVerdict('node ./helper.mjs'), false);
});

test('--test DOES NOT EXEMPT THE LINE, which is how the first fix was bypassed', () => {
  /*
   * `tokens.includes('--test')` returned allowed before the gate ran, and node
   * passes a trailing --test to the SCRIPT as argv, so the payload executed.
   * Both spellings were measured running the file end to end.
   */
  assert.equal(nodeVerdict('node helper.mjs --test'), false);
  assert.equal(nodeVerdict('node --test helper.mjs'), false);
  assert.equal(nodeVerdict('node -r ./helper.mjs --test'), false);
});

test('A FLAG THAT CARRIES CODE OR A FILE IS REFUSED, INCLUDING ONES THAT DO NOT EXIST YET', () => {
  /*
   * Round three of the same bypass. `--import=./pwn.mjs` starts with a dash, so
   * the operand filter stripped it out before anything judged it -- while the
   * comment above that filter claimed nothing was exempt. --eval= needs no
   * script argument at all. Measured executing a payload end to end.
   *
   * The repair is an ALLOWLIST of flags rather than a fourth attempt at listing
   * the dangerous ones, because node's flag surface grows every release. These
   * assertions are examples of a closed class, not the class itself: an unknown
   * flag is refused, which is what makes the list finite.
   */
  for (const cmd of [
    'node --import=./pwn.mjs bin/agentbridge.mjs status',
    'node --eval=1+1',
    'node --require=./helper.cjs bin/agentbridge.mjs',
    'node --experimental-loader=./pwn.mjs bin/agentbridge.mjs',
    'node -r=./helper.cjs bin/agentbridge.mjs',
    'node --watch bin/agentbridge.mjs',
    'node --a-flag-invented-after-this-was-written bin/agentbridge.mjs',
  ]) {
    assert.equal(nodeVerdict(cmd), false, `ALLOWED: ${cmd}`);
  }
});

test('--test RUNS EVERY OPERAND, so every operand is judged', () => {
  /*
   * Round 4's premise was "with no value-taking flag permitted, operands[0] is
   * unambiguously the program" -- false for the single flag it permitted. node
   * --test executes every path operand as a module. On the strength of that
   * premise round 4 deleted the check that caught it, and measured:
   *
   *   node --test test/real.test.mjs pwn.mjs   ALLOWED, and pwn.mjs ran
   *
   * which is the two-call disarm, reopened by the commit that claimed to close
   * it. Order does not matter; both positions execute.
   */
  assert.equal(nodeVerdict('node --test test/a.test.mjs helper.mjs'), false);
  assert.equal(nodeVerdict('node --test helper.mjs test/a.test.mjs'), false);
  assert.equal(nodeVerdict('node --test test/a.test.mjs'), true, 'a single inherited test still runs');
});

test('FLAGS AFTER THE PROGRAM ARE ARGV, and refusing them refused the CLI', () => {
  /*
   * node stops interpreting its own flags at the first non-flag token; what
   * follows belongs to the program. Round 4 rejected any dash-token anywhere,
   * which denied `node bin/agentbridge.mjs status --json` -- the documented
   * machine-readable form of this repository's own tool -- while its commit
   * message congratulated itself on retiring a narrower over-block.
   */
  assert.equal(nodeVerdict('node bin/agentbridge.mjs status --json'), true);
  assert.equal(nodeVerdict('node bin/agentbridge.mjs delegate --task foo'), true);
  assert.equal(nodeVerdict('node bin/agentbridge.mjs check-first topic --repo .'), true);
});

test('but a node flag BEFORE the program is still judged', () => {
  assert.equal(nodeVerdict('node --import=./helper.mjs bin/agentbridge.mjs status'), false);
  assert.equal(nodeVerdict('node --watch bin/agentbridge.mjs'), false);
});

test('ARGUMENTS ARE ARGUMENTS: an untracked file passed to a repo tool is not execution', () => {
  /*
   * The previous fix refused any untracked file in a later operand, to stop an
   * option value laundering the script. With no value-taking flag permitted the
   * program is unambiguous, so that rule was retired -- it had been refusing
   * ordinary work: handing a file you just created to a repository tool.
   */
  assert.equal(nodeVerdict('node bin/agentbridge.mjs check-first notes.txt'), true);
  assert.equal(nodeVerdict('node bin/agentbridge.mjs observe-sha README.md'), true);
});

test('an option VALUE cannot launder the real script past the check', () => {
  /*
   * node options taking a separate value put that value first, so reading only
   * the first operand judged the tracked path and ran the untracked one behind
   * it. Measured: this command really did execute helper.mjs.
   */
  assert.equal(nodeVerdict('node --title bin/agentbridge.mjs helper.mjs'), false);
});

test('A SUBCOMMAND IS NOT A SCRIPT -- the repository CLI must keep working', () => {
  /*
   * Judging every operand refused `node bin/agentbridge.mjs status` and with it
   * every command in this repo. That is the outage rule 17 is about, and it was
   * caught by writing this row down rather than by anything in the suite.
   */
  assert.equal(nodeVerdict('node bin/agentbridge.mjs status'), true);
  assert.equal(nodeVerdict('node bin/agentbridge.mjs check-first topic'), true);
  assert.equal(nodeVerdict('node scripts/claude-stop-gate.mjs'), true);
});

test('node --test on an inherited test is allowed; node -e is still refused', () => {
  assert.equal(nodeVerdict('node --test test/claudeGuard.test.mjs'), true);
  assert.equal(nodeVerdict('node -e x'), false);
  assert.equal(nodeVerdict('node --eval x'), false);
});

test('MUTATION: deleting the gate must break these, or they prove nothing', () => {
  /*
   * The default classifier is permissive, so a caller passing no predicate sees
   * the pre-gate behaviour. If these tests were written without the injected
   * classifier they would pass with the gate removed -- which is precisely how
   * three measured bypasses shipped under a green suite.
   */
  assert.equal(judgeShellCommand('node helper.mjs').allowed, true,
    'with no classifier the gate is inert -- if this flips, the default changed and every caller without session context is now refused');
  assert.equal(nodeVerdict('node helper.mjs'), false,
    'with a classifier it bites -- if this flips, the gate is gone');
});

/* ============================================================================
 * EVERY FIELD OF EVERY SHAPE, AND THE BACKSTOP OVER THE LEFTOVERS.
 *
 * The first repair for the decoy-field class judged a command AND a path and
 * then bet on field ORDERING one line lower: firstStringField takes the first
 * match and discards the rest. PATH_FIELDS is scanned file_path first, and
 * NotebookEdit's real parameter is notebook_path -- so a decoy file_path stole
 * the verdict and wrote disableAllHooks into .claude/settings.json, removing the
 * Stop hook in the same permitted call. It shipped with no tests at all.
 * ==========================================================================*/

test('a decoy path field cannot steal the verdict from the one the tool uses', () => {
  const judge = (input) => evaluateClaudeTool({
    tool_name: 'NotebookEdit', tool_input: input, cwd: repoRoot, session_id: 's',
  }).allowed;
  assert.equal(judge({ notebook_path: '.claude/settings.json', new_source: 'x' }), false);
  assert.equal(judge({ file_path: 'scratch.txt', notebook_path: '.claude/settings.json', new_source: 'x' }), false,
    'the decoy must not win: notebook_path is the field NotebookEdit actually uses');
});

test('a benign field does not switch the backstop off', () => {
  /*
   * The backstop's own comment names "a hypothetical mover with source and
   * destination" as its reason to exist, and one extra field disabled it,
   * because the shape branches returned before it was reached.
   */
  const mover = (extra) => evaluateClaudeTool({
    tool_name: 'MoveFile',
    tool_input: { ...extra, source: 'a.txt', destination: '.claude/settings.json' },
    cwd: repoRoot, session_id: 's',
  }).allowed;
  assert.equal(mover({}), false, 'control: the backstop fires with no decoy');
  assert.equal(mover({ command: 'ls' }), false, 'a benign command must not disable it');
  assert.equal(mover({ path: 'a.txt' }), false, 'nor a benign path');
});

test('THE BACKSTOP MUST NOT EAT ORDINARY WORK, which is why it reads only unjudged fields', () => {
  /*
   * Running it over the WHOLE input would refuse `cat CLAUDE.md` -- a judged
   * field legitimately names protected paths. The leftovers are the set this
   * guard has no model of, which is what the backstop was always for.
   */
  const bash = (command) => evaluateClaudeTool({
    tool_name: 'Bash', tool_input: { command }, cwd: repoRoot, session_id: 's',
  }).allowed;
  assert.equal(bash('cat CLAUDE.md'), true);
  assert.equal(bash('git status'), true);
  assert.equal(evaluateClaudeTool({
    tool_name: 'Write', tool_input: { file_path: 'notes.md', content: 'x' }, cwd: repoRoot, session_id: 's',
  }).allowed, true);
});

/* ============================================================================
 * A PATHSPEC IS NOT A FILENAME. ASK GIT WHAT IT COVERS.
 *
 * The everything-selector check compared each operand against the literal
 * string "." and nothing else, so every other spelling of "everything" swept
 * protected controls untouched. Measured against the shipped rail, all ALLOW:
 *
 *   git restore :/  ./  .//  "./"  *  src  src/  ..  :!nothing
 *   git add     :/  *   src  ..          git commit :/ -m msg
 *
 * Adding those spellings to the literal-dot list is the enumeration that has
 * lost here four times on the node branch and twice on this one. The grammar
 * belongs to git, so git is asked -- the caller injects a resolver and an
 * operand names every protected file git says it covers. A spelling nobody has
 * thought of is answered correctly for free.
 * ==========================================================================*/

/** Stands in for git: these operands sweep the repo, those name one file. */
const sweeps = new Set([':/', './', './/', '*', 'src', 'src/', ':!nothing', ':^nope', ':(top)']);
const covers = (t) => (sweeps.has(t) ? ['src/claudeGuard.mjs', 'CLAUDE.md'] : []);
const railVerdict = (cmd) => judgeShellCommand(cmd, { pathspecCovers: covers }).allowed;

test('every spelling of "everything" is refused, not just the literal dot', () => {
  for (const cmd of [
    'git restore :/', 'git restore ./', 'git restore .//', 'git restore *',
    'git restore src', 'git restore src/', 'git restore :!nothing', 'git restore :^nope',
    'git add :/', 'git add *', 'git add src', 'git commit :/ -m msg',
    'git checkout -- :/',
  ]) {
    assert.equal(railVerdict(cmd), false, `ALLOWED: ${cmd}`);
  }
});

test('and a spelling this test never lists is refused too, because git answers it', () => {
  /*
   * The point of injecting the resolver rather than listing spellings: a
   * pathspec form nobody anticipated is judged by what it COVERS. If this ever
   * starts passing, the resolver has been replaced by an enumeration again.
   */
  const exotic = 'git restore :(glob,attr:!binary)**/*';
  assert.equal(
    judgeShellCommand(exotic, { pathspecCovers: () => ['src/claudeGuard.mjs'] }).allowed,
    false,
    'an operand the test does not know about must still be refused when git says it covers a control',
  );
});

test('ORDINARY WORK SURVIVES: an operand covering nothing protected is allowed', () => {
  for (const cmd of [
    'git add src/collect.mjs', 'git add notes.md', 'git status',
    'git commit -m msg', 'git diff --stat',
  ]) {
    assert.equal(railVerdict(cmd), true, `newly REFUSED: ${cmd}`);
  }
});

test('with no resolver the behaviour is the old literal check, so other callers are unchanged', () => {
  assert.equal(judgeShellCommand('git restore :/').allowed, true, 'no resolver: unchanged');
  assert.equal(judgeShellCommand('git restore .').allowed, false, 'the literal dot still dies on its own');
});
