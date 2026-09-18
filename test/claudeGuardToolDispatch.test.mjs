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
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { evaluateClaudeTool, isProtectedPath } from '../src/claudeGuard.mjs';
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

/* ============================================================================
 * THE KEY DECIDES, NOT THE STRING. Both directions, because the first attempt
 * at this failed in each of them within an hour.
 * ==========================================================================*/

test('a field that CONTAINS a protected name is not a field that NAMES one', () => {
  /*
   * Relocating the backstop made it scan every unjudged field, so editing an
   * UNPROTECTED file was refused because a replacement string mentioned a
   * protected one. With seventeen protected entries including package.json and
   * five src module paths, that is every import-path rename and every doc edit
   * quoting the rules. Measured against the parent: all four newly refused.
   */
  const j = (tool, input) => evaluateClaudeTool({
    tool_name: tool, tool_input: input, cwd: repoRoot, session_id: 's',
  }).allowed;
  assert.equal(j('Edit', { file_path: 'docs/notes.md', old_string: 'CLAUDE.md', new_string: 'README.md' }), true);
  assert.equal(j('Write', { file_path: 'docs/n.md', content: 'CLAUDE.md' }), true);
  assert.equal(j('Bash', { command: 'ls', description: 'CLAUDE.md' }), true);
  assert.equal(j('MultiEdit', { file_path: 'docs/n.md', edits: [{ old_string: 'CLAUDE.md', new_string: 'x' }] }), true);
});

test('but a path-shaped key is caught at ANY depth, including under a container that is not', () => {
  /*
   * The first fix filtered top-level keys only, so {ops:[{to:"..."}]} was
   * skipped wholesale -- the container's name is not path-shaped even though
   * the leaf's is. An existing test caught that, which is the only reason it
   * did not ship. Containers are traversed; leaves are gated by their own key.
   */
  const j = (input) => evaluateClaudeTool({
    tool_name: 'SomeBatchTool', tool_input: input, cwd: repoRoot, session_id: 's',
  }).allowed;
  assert.equal(j({ source: 'a.txt', destination: '.claude/settings.json' }), false);
  assert.equal(j({ ops: [{ to: 'docs/ORDER.md' }] }), false, 'nested under a non-path key');
  assert.equal(j({ paths: ['CLAUDE.md'] }), false, 'array elements inherit the array key');
  assert.equal(j({ command: 'ls', source: 'a', destination: '.claude/settings.json' }), false,
    'a benign judged field must not switch it off');
});

test('node cannot be pointed at a DIRECTORY to run what the session put inside it', () => {
  /*
   * git cat-file -e succeeds for a tree and git diff --quiet reports nothing
   * about untracked files, so every tracked directory answered "inherited" --
   * and node resolves a directory to its main. Write src/index.js, then
   * `node src`, and the payload ran. Two calls, no flag, no metacharacter.
   */
  const dirs = (t) => (t === 'src' || t === 'test' || t === '.' ? 'not-a-file' : 'inherited');
  assert.equal(judgeShellCommand('node src', { mayExecute: dirs }).allowed, false);
  assert.equal(judgeShellCommand('node .', { mayExecute: dirs }).allowed, false);
  assert.equal(judgeShellCommand('node --test test', { mayExecute: dirs }).allowed, false);
});

test('npm forwards everything after -- to the script, so those operands are judged too', () => {
  /*
   * `npm test -- pwn.mjs` becomes `node --test "test/**" pwn.mjs` and executed.
   * The node branch had just been hardened against exactly that command; the
   * identical execution was one npm spelling away and unjudged.
   */
  const classify = (t) => (t.startsWith('test/') ? 'inherited' : /\.mjs$/.test(t) ? 'untracked-file' : 'not-a-file');
  assert.equal(judgeShellCommand('npm test -- pwn.mjs', { mayExecute: classify }).allowed, false);
  assert.equal(judgeShellCommand('npm test -- ./pwn.mjs', { mayExecute: classify }).allowed, false);
  assert.equal(judgeShellCommand('npm test -- test/a.test.mjs', { mayExecute: classify }).allowed, true);
  assert.equal(judgeShellCommand('npm test', { mayExecute: classify }).allowed, true);

  /*
   * AND A FLAG CARRIES ITS VALUE AFTER AN `=`, WHERE THE FILTER COULD NOT SEE IT.
   *
   * The forwarded list dropped every token starting with "-", so the space form
   * was judged and the equals form was invisible. Every one of these is a node
   * flag whose value is a MODULE NODE LOADS, so the execution this test was
   * written to refuse went through in a spelling one character away:
   *
   *   npm test -- --import ./pwn.mjs     DENY
   *   npm test -- --import=./pwn.mjs     ALLOW      <- found by blind audit
   *
   * Asserted as the SHAPE rather than a list of flag names: enumerating
   * --import, --require, --experimental-loader and --test-reporter is the
   * mistake this file has lost to repeatedly, and node keeps adding loader
   * flags. Any flag value that names an uninherited file is refused, including
   * spellings nobody has thought of.
   */
  for (const flag of ['--import', '--require', '--experimental-loader', '--test-reporter', '--totally-new-loader']) {
    assert.equal(judgeShellCommand(`npm test -- ${flag}=./pwn.mjs`, { mayExecute: classify }).allowed, false,
      `${flag}=./pwn.mjs forwards an uninherited module to node`);
    assert.equal(judgeShellCommand(`npm test -- ${flag} ./pwn.mjs`, { mayExecute: classify }).allowed, false,
      `${flag} ./pwn.mjs must stay refused too`);
  }

  /*
   * THE NEGATIVES, and they are what keep this from becoming a refusal of every
   * flag. An over-blocking rail gets switched off, which loses every layer.
   */
  for (const ok of ['--test-reporter=tap', '--test-name-pattern=something', '--test-concurrency=4', '--watch']) {
    assert.equal(judgeShellCommand(`npm test -- ${ok}`, { mayExecute: classify }).allowed, true,
      `${ok} names no file and must not be refused`);
  }
  assert.equal(judgeShellCommand('npm test -- --import=test/a.test.mjs', { mayExecute: classify }).allowed, true,
    'a flag value that IS inherited is fine — the question is provenance, not the equals sign');
});

/* ============================================================================
 * THREE LIVE DEFECTS FROM THE AUDIT OF 29c0957, a02f408 AND e4b1760.
 * All three were already on the server when they were found.
 * ==========================================================================*/

/*
 * AN 8.3 ALIAS IS ASSIGNED BY CREATION ORDER, SO IT IS NOT A PROPERTY OF THE
 * NAME AND MUST NEVER BE HARDCODED.
 *
 * The first version of this test asserted a literal 8.3 alias for the guard
 * binary. That is the alias
 * NTFS happened to give the guard binary in the operator's checkout. In a fresh
 * `git clone` of the same repository the same file is AGENTB~2.MJS, because the
 * directory's entries were created in a different order. So the test failed on
 * every clone -- including the clone that rule 20 REQUIRES an auditor to make,
 * which means the one test covering this attack was broken for exactly the
 * reader whose job is to check it. Found by blind audit, 2026-09-18.
 *
 * Ask the OS for the alias instead. `dir /x` is the alias table's owner, the
 * same reasoning that put realpathSync.native in the resolver: the OS owns the
 * mapping, so the OS is what gets asked.
 */
function shortNamesIn(dir) {
  const out = new Map();
  if (process.platform !== 'win32') return out;
  let text;
  try {
    text = execFileSync('cmd', ['/c', 'dir', '/x', dir], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
  } catch { return out; }
  for (const line of text.split('\n')) {
    // "09/17/2026  10:03 PM   5,940 SOMEAL~1.MJS a-long-file-name.mjs"
    // The alias column is EMPTY when the long name is already 8.3-legal, so the
    // tilde is the reliable marker for a generated alias. None of the names
    // here contain spaces; a name that did would need a wider parse.
    // The long name may contain SPACES -- a home directory with a space in it
    // is exactly the
    // directory that matters on this machine -- so the tail is captured lazily
    // rather than as a single non-space token. Requiring \S+ made this find
    // nothing for that directory, and the test above then SKIPPED loudly, which
    // is how it was caught instead of passing as a phantom.
    const m = line.match(/(\S*~\d\S*)\s+(.+?)\s*$/);
    if (m) out.set(m[2].toLowerCase(), m[1]);
  }
  return out;
}

/** Rewrite each component of a repo-relative path as its 8.3 alias where one exists. */
function shortPathOf(root, rel) {
  let dir = root;
  const parts = [];
  for (const component of rel.split('/')) {
    const alias = shortNamesIn(dir).get(component.toLowerCase());
    parts.push(alias ?? component);
    dir = path.join(dir, component);
  }
  return parts.join('/');
}

test('8.3 SHORT NAMES are the same file, and case-folding alone did not cover them', (t) => {
  /*
   * e4b1760 folded case and argued folding is "a PROPERTY, not a lookalike
   * list". It was a property of one alias class. realpathSync does not expand
   * short names; realpathSync.native does, because the OS owns the alias table.
   * Measured: writing CLAUDE~1/SETTIN~1.JSO modifies .claude/settings.json and
   * git reports the canonical path as modified.
   */
  const PROTECTED_SAMPLES = [
    '.claude/settings.json',
    'src/claudeGuard.mjs',
    'src/guardSession.mjs',
    'src/shellAllowlist.mjs',
    'bin/agentbridge-claude-guard.mjs',
  ];

  const aliased = PROTECTED_SAMPLES
    .map((rel) => [rel, shortPathOf(repoRoot, rel)])
    .filter(([rel, short]) => short !== rel);

  /*
   * RULE 6: ASSERT THE PRECONDITION, DO NOT GUARD ON IT. 8.3 generation can be
   * switched off per volume (fsutil 8dot3name), and on such a machine there are
   * no aliases and therefore no attack -- but "no aliases" and "the resolver is
   * broken" must not look alike. Skip LOUDLY rather than passing quietly.
   */
  if (aliased.length === 0) {
    t.skip('this volume generates no 8.3 aliases, so there is nothing to resolve');
    return;
  }

  for (const [rel, short] of aliased) {
    assert.equal(isProtectedPath(short, repoRoot), true,
      `${short} is the OS alias for ${rel} and must resolve to the protected file`);
  }

  /*
   * THE NEGATIVE, and it corrects an earlier audit: an alias in bin/ is not
   * automatically a control. agentbridge-attempt.mjs is NOT protected, so its
   * alias must come back free -- whatever the OS happened to name it.
   */
  const freeAlias = shortPathOf(repoRoot, 'bin/agentbridge-attempt.mjs');
  assert.equal(isProtectedPath(freeAlias, repoRoot), false,
    `${freeAlias} is agentbridge-attempt.mjs, which is not a protected control`);
  assert.equal(isProtectedPath('docs/notes.md', repoRoot), false);
});

/**
 * The 8.3 spelling of a WHOLE absolute directory path, built by asking dir /x
 * about each ancestor in turn.
 *
 * The first version shelled out to `cmd /c for %I in ("<dir>") do @echo %~sI`,
 * which is the documented way to get a short path -- and through execFileSync
 * the quoting came back mangled, doubling the drive and dropping every
 * separator. The test
 * then asserted against a nonsense root, and because a CANONICAL relative path
 * resolves under ANY root, the assertions passed anyway. A broken helper and a
 * fixture that could not fail, agreeing with each other.
 *
 * Reuses shortNamesIn, which is already proven above, instead of a second
 * mechanism that needed its own quoting rules.
 */
function shortDirOf(dir) {
  if (process.platform !== 'win32') return null;
  const parts = dir.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return null;
  let cursor = `${parts[0]}\\`;
  const spelled = [parts[0]];
  for (const part of parts.slice(1)) {
    const alias = shortNamesIn(cursor).get(part.toLowerCase());
    spelled.push(alias ?? part);
    cursor = path.join(cursor, part);
  }
  const joined = spelled.join('\\');
  return joined !== dir ? joined : null;
}

test('AN ENCLOSING REPOSITORY IS NOT THIS PROJECT — the over-block half', (t) => {
  /*
   * The widening first asked git: `rev-parse --show-toplevel`, which answers
   * "the repository enclosing this directory". That is a different question from
   * "which project is this session for", and the difference over-blocks.
   *
   * A plain project folder inside a dotfiles-style repository made everything
   * under the ENCLOSING repo's .claude/ unwritable -- including agent memory:
   *
   *   cwd = <dotfiles-repo>/proj
   *   ../.claude/projects/p1/MEMORY.md   DENY
   *   ../.claude/settings.json           DENY, with "configures the Stop gate
   *                                      itself", about a gate never read here
   *
   * ~/.claude/ is Claude Code's USER-level directory; <project>/.claude/ is the
   * project's. Same name, different things. An over-blocking guard gets switched
   * off, which loses every layer, so this direction matters as much as the
   * under-block the widening was for.
   */
  const lab = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'ab-enclose-')));
  t.after(() => rmSync(lab, { recursive: true, force: true }));

  const dot = path.join(lab, 'dot');
  const proj = path.join(dot, 'proj');
  mkdirSync(path.join(dot, '.claude', 'projects', 'p1'), { recursive: true });
  mkdirSync(proj, { recursive: true });
  writeFileSync(path.join(dot, '.claude', 'settings.json'), '{}\n');
  writeFileSync(path.join(dot, '.claude', 'projects', 'p1', 'MEMORY.md'), '# memory\n');
  writeFileSync(path.join(proj, 'app.mjs'), '// app\n');
  const g = (...a) => execFileSync('git', a, { cwd: dot, stdio: 'ignore' });
  g('init', '-q');
  g('config', 'user.email', 't@example.invalid');
  g('config', 'user.name', 'T');
  g('add', '-A');
  g('commit', '-qm', 'dotfiles');

  const prev = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = proj;
  try {
    for (const rel of ['../.claude/projects/p1/MEMORY.md', '../.claude/settings.json']) {
      assert.equal(isProtectedPath(rel, proj), false,
        `${rel} belongs to an enclosing repository, not this project, and must stay writable`);
    }
    assert.equal(isProtectedPath('app.mjs', proj), false, "the project's own file must stay writable");
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prev;
  }
});

test("the declared project root still protects that project's controls from a subdirectory", (t) => {
  /*
   * RULE 5 for the test above: if the declared root protected nothing, the
   * "must stay writable" assertions would pass by the guard being broken.
   */
  const lab = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'ab-declared-')));
  t.after(() => rmSync(lab, { recursive: true, force: true }));

  const real = path.join(lab, 'real');
  const sub = path.join(real, 'projA');
  mkdirSync(path.join(real, '.claude'), { recursive: true });
  mkdirSync(path.join(real, 'src'), { recursive: true });
  mkdirSync(sub, { recursive: true });
  writeFileSync(path.join(real, '.claude', 'settings.json'), '{}\n');
  writeFileSync(path.join(real, 'src', 'claudeGuard.mjs'), '// guard\n');
  const g = (...a) => execFileSync('git', a, { cwd: real, stdio: 'ignore' });
  g('init', '-q');
  g('config', 'user.email', 't@example.invalid');
  g('config', 'user.name', 'T');
  g('add', '-A');
  g('commit', '-qm', 'real');

  const prev = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = real;
  try {
    assert.equal(isProtectedPath('../.claude/settings.json', sub), true,
      "this project's hook configuration must stay protected from a subdirectory");
    assert.equal(isProtectedPath('../src/claudeGuard.mjs', sub), true,
      "this project's guard source must stay protected from a subdirectory");
    assert.equal(isProtectedPath('../notes.md', sub), false,
      'an ordinary file must stay writable');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prev;
  }
});

test('A CONTROL IS PROTECTED FROM A SUBDIRECTORY TOO — both rails share the repository frame', () => {
  /*
   * isProtectedPath judged relative to the session's CWD and returned false for
   * anything starting with ".." -- reading "outside this directory" as "outside
   * the repository, not ours to judge". So every control was unprotected from
   * any subdirectory. Measured through the shipped binary with cwd at
   * <repo>/projA, all ALLOW:
   *
   *   ../.claude/settings.json   ../src/claudeGuard.mjs
   *   ../CLAUDE.md               ../package.json
   *   <absolute>/.claude/settings.json      ../../src/claudeGuard.mjs
   *
   * THE DISCRIMINATOR, and the reason this is a bug rather than a scope
   * decision: ../test/claudeGuard.test.mjs was DENIED throughout, because the
   * baseline-test rail already resolved into the repository. Two rails, one
   * repository, opposite answers. cwd arrives from the hook payload, and
   * starting a session in a subdirectory is ordinary rather than an attack.
   */
  const sub = path.join(repoRoot, 'test');
  const deeper = path.join(repoRoot, 'src', 'memory');

  // RULE 5: the positive first. These are protected from the root, or the
  // subdirectory assertions below say nothing about the frame.
  for (const rel of ['src/claudeGuard.mjs', 'CLAUDE.md', '.claude/settings.json', 'package.json']) {
    assert.equal(isProtectedPath(rel, repoRoot), true, `precondition: ${rel} from the repo root`);
  }

  for (const rel of ['../src/claudeGuard.mjs', '../CLAUDE.md', '../.claude/settings.json', '../package.json']) {
    assert.equal(isProtectedPath(rel, sub), true,
      `${rel} must stay protected when the session stands in a subdirectory`);
  }

  // Two levels down, and by absolute path.
  assert.equal(isProtectedPath('../../src/claudeGuard.mjs', deeper), true,
    'two levels down must not escape the repository frame');
  assert.equal(isProtectedPath(path.join(repoRoot, '.claude', 'settings.json'), sub), true,
    'an absolute path to a control must be protected from anywhere in the repo');

  // THE NEGATIVES, which are what keep this usable rather than a blanket refusal.
  assert.equal(isProtectedPath('../docs/notes.md', sub), false,
    'an ordinary file must stay writable from a subdirectory');
  assert.equal(isProtectedPath('scratch.txt', sub), false,
    'an ordinary file in the subdirectory itself must stay writable');
  assert.equal(isProtectedPath(path.join(repoRoot, '..', 'outside-the-repo.txt'), repoRoot), false,
    'a file genuinely outside the repository is still not ours to judge');
});

test('THE ROOT IS SPELLED THE SAME WAY THE CANDIDATES ARE, or nothing matches', (t) => {
  /*
   * Every candidate goes through realpathSync.native; the root did not, it was
   * lexical. path.relative is total: if cwd arrives as an 8.3 alias and the
   * candidate resolves to the long form, they share no prefix, every rel starts
   * with ".." and isProtectedPath returns FALSE FOR EVERYTHING.
   *
   * Measured before the fix, cwd spelled with the alias:
   *   CLAUDE~1/settings.json   ALLOW      (DENY with the long spelling)
   *   CLAUDE~1/SETTIN~1.JSO    ALLOW
   *   src/CLAUDE~1.MJS         ALLOW
   *
   * cwd reaches the guard from the payload or CLAUDE_PROJECT_DIR, neither of
   * which the guard controls, so the whole alias defence was conditional on a
   * spelling an attacker picks. Found by blind audit.
   */
  const shortRoot = shortDirOf(repoRoot);
  if (!shortRoot) {
    t.skip('no 8.3 spelling for the repo root on this volume, so there is nothing to confuse');
    return;
  }

  /*
   * THE PATHS MUST BE ALIAS-SPELLED TOO, and the first version of this test was
   * a hollow gate for exactly that reason. With a CANONICAL path like
   * ".claude/settings.json", the lexical candidate is shortRoot + that path,
   * which sits under the lexical root and matches whatever the root spelling is
   * -- so the assertion passed with the fix reverted. Watched: mutating the root
   * back to lexical-only left it GREEN.
   *
   * The defect needs BOTH halves spelled as aliases: then the lexical candidate
   * reads "CLAUDE~1/..." which isProtectedRelPath does not recognise, and the
   * native candidate resolves to the LONG root which the lexical root cannot be
   * relative to. Neither matches, and everything is permitted.
   */
  const aliased = ['.claude/settings.json', 'src/claudeGuard.mjs']
    .map((rel) => [rel, shortPathOf(repoRoot, rel)])
    .filter(([rel, alias]) => alias !== rel);

  if (aliased.length === 0) {
    t.skip('no component of these paths has an 8.3 alias on this volume');
    return;
  }

  // RULE 5: the positive first. The alias must be understood under the LONG
  // root, or "unprotected under the short root" says nothing about the root.
  for (const [rel, alias] of aliased) {
    assert.equal(isProtectedPath(alias, repoRoot), true,
      `precondition: ${alias} (for ${rel}) is protected under the long root`);
  }

  for (const [rel, alias] of aliased) {
    assert.equal(isProtectedPath(alias, shortRoot), true,
      `${alias} (for ${rel}) must stay protected when cwd is ALSO spelled as an alias`);
  }

  // Canonical spellings must keep working under the short root as well.
  for (const rel of ['.claude/settings.json', 'src/claudeGuard.mjs', 'CLAUDE.md']) {
    assert.equal(isProtectedPath(rel, shortRoot), true,
      `${rel} must stay protected when cwd is spelled ${shortRoot}`);
  }
  for (const rel of ['docs/notes.md', 'src/tokenFile.mjs']) {
    assert.equal(isProtectedPath(rel, shortRoot), false,
      `${rel} is not a control and must stay free under either spelling`);
  }
});

test('A FILE THAT DOES NOT EXIST YET under an aliased directory is still protected', (t) => {
  /*
   * Both realpath calls throw when nothing is behind the path, so the fallback
   * resolves the PARENT -- and it used the non-native resolver, which does not
   * expand 8.3 names. So an EXISTING file under .claude was caught and a NEW one
   * was not:
   *
   *   Write CLAUDE~1/settings.json   DENY
   *   Write CLAUDE~1/newhook.json    ALLOW
   *
   * Creating a hooks config where none exists is the attack the entry exists to
   * stop, so that covered the wrong half.
   */
  const aliasedDotClaude = shortPathOf(repoRoot, '.claude');
  if (aliasedDotClaude === '.claude') {
    t.skip('.claude has no 8.3 alias on this volume');
    return;
  }

  // The positive: the ALIAS is genuinely understood for a file that exists.
  assert.equal(isProtectedPath(`${aliasedDotClaude}/settings.json`, repoRoot), true,
    'precondition: the alias resolves for an existing file');

  for (const name of ['newhook.json', 'settings.local.json', 'brandnew.json']) {
    assert.equal(isProtectedPath(`${aliasedDotClaude}/${name}`, repoRoot), true,
      `creating ${name} under the aliased control directory must be refused`);
    assert.equal(isProtectedPath(`.claude/${name}`, repoRoot), true,
      `creating ${name} under the canonical control directory must be refused`);
  }
});

test('a refusal must not advise something the same refusal would reject', () => {
  /*
   * The node refusal used to end "Commit it first, or run it outside the
   * repository". The second half is false -- a path outside the repository is
   * not inherited either, so it is refused by the same check, with the same
   * message, which then repeats the advice. An auditor spent part of a pass
   * following it.
   *
   * This is the third instance in one day of guidance aimed at people it cannot
   * work for: the registration recipe no guarded session could run, and rule 21
   * telling authors to clone when the rail refuses git clone. So the property is
   * asserted rather than the wording: every path shape the message could be read
   * as suggesting is measured, and the message must not recommend one that is
   * refused.
   */
  const judge = (command) => judgeShellCommand(command, {
    isOverridden: () => false,
    mayExecute: () => 'untracked-file',
    pathspecCovers: () => [],
  });

  const verdict = judge('node scratch/probe.mjs');
  assert.equal(verdict.allowed, false, 'precondition: an uninherited program is refused');

  // Every "somewhere else" a reader might try, and all of them refused.
  for (const elsewhere of ['node /tmp/probe.mjs', 'node ../probe.mjs', 'node C:/temp/probe.mjs']) {
    assert.equal(judge(elsewhere).allowed, false,
      `${elsewhere} is refused, so the message must not suggest it`);
  }

  assert.ok(!/run it outside the repository/i.test(verdict.reason),
    `the refusal recommends an action it also refuses: ${verdict.reason}`);

  // And it must still say the thing that DOES work.
  assert.match(verdict.reason, /commit it first/i,
    'the refusal no longer names the one action that actually resolves it');
});

test('a flag can carry the pathspec list out of the command, and that is refused', () => {
  /*
   * The resolver is only asked about literal operands. --pathspec-from-file
   * sources them from a file, so git is never asked and every check sees
   * nothing. Measured: `git restore --source=2829c0a --pathspec-from-file=ps.txt`
   * rolled the guard and the rail back fifteen commits in one permitted command.
   */
  for (const cmd of [
    'git restore --pathspec-from-file=ps.txt',
    'git restore --pathspec-from-file ps.txt',
    'git checkout HEAD --pathspec-from-file=ps.txt',
    'git add --pathspec-from-file=ps.txt',
    'git restore --source=HEAD~3 --pathspec-from-file=ps.txt',
    'git restore --pathspec-file-nul',
  ]) {
    assert.equal(judgeShellCommand(cmd).allowed, false, `ALLOWED: ${cmd}`);
  }
});

test('a flag VALUE is not a pathspec, so one-word commit messages work again', () => {
  /*
   * Feeding every token to the resolver refused `git commit -m test`, because
   * "test" names test/claudeGuard.test.mjs. It bit exactly the shortest, most
   * ordinary messages, and the refusal named a file the author never mentioned.
   */
  /*
   * The stand-in must agree with the real resolver on the cases the test uses.
   * A first version listed only the message words, so it reported the sweeping
   * operand as harmless and the test passed for the wrong reason -- the exact
   * stub-disagrees-with-reality shape the audit found in the node tests.
   */
  const covers = (t) => (['test', 'docs', 'bin', 'src', 'package.json', ':/', '.', '*'].includes(t) ? ['CLAUDE.md'] : []);
  for (const cmd of ['git commit -m test', 'git commit -m docs', 'git commit -m bin', 'git commit -m src']) {
    assert.equal(judgeShellCommand(cmd, { pathspecCovers: covers }).allowed, true, `refused: ${cmd}`);
  }
  assert.equal(judgeShellCommand('git commit :/ -m msg', { pathspecCovers: covers }).allowed, false,
    'but an actual sweeping operand still dies, message or not');
});

test('the key gate sees camelCase, and still does not see content fields', () => {
  /*
   * The first key gate delimited its alternatives on underscore or a string
   * boundary, so `filename` -- the most common path key there is -- went ALLOW,
   * reopening what the previous commit closed. Substring stems fix that; but a
   * substring list containing `source` would match NotebookEdit's `new_source`
   * and re-break the over-block, so the short ambiguous ones are word-matched
   * and `source` is in neither list.
   */
  const named = (k) => evaluateClaudeTool({
    tool_name: 'MoverTool', tool_input: { [k]: '.claude/settings.json' }, cwd: repoRoot, session_id: 's',
  }).allowed;
  for (const k of ['filename', 'filepath', 'pathname', 'fileName', 'filePath', 'outputPath',
    'targetFile', 'destPath', 'newPath', 'dst', 'srcFile', 'TargetPath', 'output_path', 'destination']) {
    assert.equal(named(k), false, `${k} must be treated as naming a path`);
  }
  const content = (tool, input) => evaluateClaudeTool({ tool_name: tool, tool_input: input, cwd: repoRoot, session_id: 's' }).allowed;
  assert.equal(content('NotebookEdit', { notebook_path: 'docs/n.ipynb', new_source: 'CLAUDE.md' }), true,
    'new_source is content, not a location -- this is why source is in neither list');
  assert.equal(content('Edit', { file_path: 'docs/notes.md', old_string: 'CLAUDE.md', new_string: 'x' }), true);
});
