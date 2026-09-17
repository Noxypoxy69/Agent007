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
