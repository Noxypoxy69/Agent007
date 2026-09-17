import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { readSnapshot, isBaselineTest, isProtectedRelPath } from './guardSession.mjs';
import { judgeShellCommand } from './shellAllowlist.mjs';

const SKIP_MARKER = /(?:\b(?:it|test|describe|context)\.skip\s*\(|\bx(?:it|test|describe|context)\s*\(|@pytest\.mark\.(?:skip|xfail)|@unittest\.skip|\bpytest\.skip\s*\(|@Disabled\b|@Ignore\b|\bt\.Skip(?:Now)?\s*\(|#\[ignore\]|\[Ignore\])/;

/*
 * THE PATH LIST LIVES IN guardSession.mjs AND NOWHERE ELSE.
 *
 * There were two of them and they disagreed: this layer protected
 * docs/ROADMAP.md, docs/ORDER.md and all of .claude/**, the Stop snapshot did
 * not, so a write that bypassed PreToolUse changed them undetected. Two lists of
 * one thing drift the moment somebody edits one.
 */


/*
 * shellPathTokens lived here and is deleted. It extracted path-like tokens so
 * they could be matched against protected paths -- a denylist of spellings,
 * which node -e, python3 -c, eval, find -delete and perl -e all walked through.
 * The allowlist in src/shellAllowlist.mjs replaced it, and keeping a dead
 * tokeniser around would invite somebody to reach for the losing approach again.
 */
export function normalizedCandidates(filePath, cwd = process.cwd()) {
  if (typeof filePath !== 'string' || filePath.length === 0) return [];
  const absolute = path.resolve(cwd, filePath);
  const out = [absolute.replaceAll('\\', '/')];
  try {
    out.push(realpathSync(absolute).replaceAll('\\', '/'));
  } catch {
    try {
      out.push(path.join(realpathSync(path.dirname(absolute)), path.basename(absolute)).replaceAll('\\', '/'));
    } catch {
      // A missing parent is still judged by its lexical absolute path.
    }
  }
  return [...new Set(out)];
}

export function isProtectedPath(filePath, cwd = process.cwd()) {
  const root = path.resolve(cwd);
  return normalizedCandidates(filePath, cwd).some((candidate) => {
    const rel = path.relative(root, candidate).split(path.sep).join('/');
    if (rel.startsWith('..')) return false;      // outside the repo is not ours to judge
    return isProtectedRelPath(rel);
  });
}

/**
 * A test that was present when the session began.
 *
 * The previous rule made EVERY existing test immutable, which meant a test
 * written sixty seconds ago could not have a typo fixed: create, then edit, and
 * the edit was denied as `existing-test-immutable`. It would also have blocked
 * the single most important repair of this session -- inverting a test that
 * asserted a vulnerability was correct behaviour. Seven of eleven commits on
 * this branch modified an existing test.
 *
 * So the line is drawn at the SESSION BOUNDARY. Baseline tests carry the
 * evidence the session inherited and are protected; tests the session created
 * are its own work and stay editable. With no snapshot this returns false and
 * the Stop gate refuses separately -- one control failing closed, not two
 * guessing.
 */
export function isSessionBaselineTest(filePath, cwd = process.cwd(), sessionId = null) {
  /*
   * THE SESSION ID MUST ARRIVE HERE. readSnapshot became session-scoped and this
   * call site was not updated, so it looked for a snapshot under the key
   * 'no-session-id', found none, returned false, and every inherited test was
   * editable through Edit/Write. Stop would have caught it afterwards; the
   * PreToolUse protection this function exists for was simply not running.
   */
  const snapshot = readSnapshot(cwd, sessionId);
  /*
   * NO RESOLVABLE SNAPSHOT MEANS FAIL CLOSED. Returning false here said "this is
   * not a baseline test", so with a missing or unmatched session id EVERY
   * inherited test was editable. An unknown session cannot prove a file is new,
   * and "cannot prove" is not "permitted": any existing test file is treated as
   * baseline until a snapshot says otherwise.
   */
  if (!snapshot) {
    return normalizedCandidates(filePath, cwd)
      .some((c) => /(?:^|\/)test\/.+\.test\.mjs$/i.test(c) && existsSync(c));
  }
  for (const candidate of normalizedCandidates(filePath, cwd)) {
    const rel = path.relative(snapshot.repoRoot, candidate).split(path.sep).join('/');
    if (isBaselineTest(rel, snapshot)) return true;
  }
  return false;
}

function deny(id, reason) {
  return { allowed: false, id, reason };
}

/*
 * TOOLS ARE JUDGED BY THE SHAPE OF THEIR INPUT, NOT BY THEIR NAME.
 *
 * This function used to end in `return { allowed: true }` for every tool name it
 * did not recognise, and .claude/settings.json only submitted
 * "Bash|Edit|MultiEdit|Write|NotebookEdit". On Windows, Claude Code runs shell
 * commands through a PowerShell tool, which was in neither list. Measured on the
 * operator's machine 2026-09-17 (item 7): `rm src/claudeGuard.mjs` reached the
 * shell, git reported `D src/claudeGuard.mjs`, and NOTHING refused. The guard
 * failed to protect its own source file.
 *
 * Adding "PowerShell" to the two lists would have closed that one spelling and
 * left every other one open -- CLAUDE.md rule 8: fix the matcher, not the five
 * strings the prober happened to try. The shell rail below learned this already
 * ("ALLOWLIST, NOT DETECTION"); the dispatch one level above it had not.
 *
 * So the name no longer decides. A tool carrying a COMMAND is judged as a shell;
 * a tool carrying a PATH is judged as a write; a tool known to be read-only
 * passes; and anything left over is REFUSED, because a guard that cannot
 * classify an operation has not established that it is safe.
 */

/*
 * Known read-only tools, checked FIRST and deliberately generous.
 *
 * First because Read carries a file_path, and routing it through the write
 * checks would refuse `Read CLAUDE.md` as a protected control -- a guard that
 * blocks reading the rules is one people turn off, which loses every layer at
 * once. Generous because the cost of a wrong entry here is one unguarded
 * read-only call, while the cost of omitting a genuinely read-only tool is that
 * ordinary work stops and somebody disables the hook.
 */
const READ_ONLY_TOOLS = new Set([
  // read the repository
  'Read', 'NotebookRead', 'Glob', 'Grep', 'LS',
  // read the outside world
  'WebFetch', 'WebSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ToolSearch',
  // session bookkeeping that never touches a repository file
  'TodoRead', 'TodoWrite', 'ExitPlanMode', 'EnterPlanMode', 'AskUserQuestion',
  'SlashCommand', 'Skill', 'Monitor', 'ReadNotifications',
  // background-shell bookkeeping. The COMMAND was judged when it was submitted;
  // reading its output or killing it cannot write anything new.
  'BashOutput', 'KillShell', 'KillBash',
  // delegation. A subagent is not a bypass: its own tool calls arrive at this
  // same hook, so it is judged call by call rather than trusted wholesale.
  'Task', 'Agent', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskOutput', 'TaskStop',
  'SendMessage', 'ListAgents',
]);

const STRUCTURED_EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/*
 * DIAGNOSTIC ONLY -- NOT THE SECURITY BOUNDARY. These names exist so that a
 * shell tool arriving without a command string gets "did not provide a command"
 * instead of the generic refusal. An unlisted shell tool is still caught, by
 * carrying a command field. Do not reintroduce dispatch on this set.
 */
const SHELL_TOOL_NAMES = new Set(['Bash', 'PowerShell', 'Shell', 'Cmd', 'Terminal', 'pwsh', 'powershell']);

const COMMAND_FIELDS = ['command', 'script', 'cmd'];
const PATH_FIELDS = ['file_path', 'notebook_path', 'filePath', 'path'];

function firstStringField(input, fields) {
  for (const field of fields) {
    const value = input[field];
    if (typeof value === 'string' && value.length > 0) return { field, value };
  }
  return null;
}

function judgeWrite(filePath, input, cwd, sessionId) {
  if (isProtectedPath(filePath, cwd)) {
    return deny('protected-control', `${filePath} is part of the guard or completion contract`);
  }
  if (isSessionBaselineTest(filePath, cwd, sessionId)) {
    return deny('baseline-test-immutable', `${filePath} was present when the session began; baseline tests are not editable from inside it`);
  }
  const content = String(input.content ?? input.new_string ?? '');
  SKIP_MARKER.lastIndex = 0;
  if (/\.test\.mjs$/i.test(filePath) && SKIP_MARKER.test(content)) {
    return deny('test-disabled', `Refusing to create disabled test ${filePath}`);
  }
  return { allowed: true };
}

function judgeShell(command) {
  /*
   * ALLOWLIST, NOT DETECTION. Mutation used to be detected by extracting path
   * tokens, which closed the spellings it knew and nothing else: node -e,
   * python3 -c, eval, find -delete and perl -e were all allowed, measured
   * against the shipped guard. An interpreter builds paths at runtime and a
   * denylist of a programming language cannot win. So the question is now what
   * is KNOWN read-only, and everything else is refused.
   */
  const verdict = judgeShellCommand(command);
  if (!verdict.allowed) {
    return deny('shell-not-allowlisted',
      `${verdict.reason}. Repository writes go through the structured edit tools, where the path is a field rather than a string to be parsed`);
  }

  /*
   * NO SECOND PATH CHECK. One was here and it refused `sed -n '1,20p' CLAUDE.md`
   * -- a READ of a protected file. The allowlist already guarantees the command
   * cannot write, so naming a protected path is not a reason to refuse.
   *
   * TWO RESIDUAL HOLES, NAMED RATHER THAN IMPLIED. `npm test` and `node --test`
   * execute JavaScript from the repository, and a test file the session created
   * is editable by design -- so a new test can call fs.unlinkSync. `npm run`
   * executes package.json scripts, which are protected from edits but were
   * whatever they were at session start. Neither is PREVENTED here. Both are
   * detected at Stop, by protected-file drift and baseline-test drift, which is
   * the same posture as an MCP write: caught afterwards, not blocked.
   */
  return { allowed: true };
}

export function evaluateClaudeTool({ tool_name: toolName, tool_input: input = {}, cwd = process.cwd(), session_id: sessionId = null } = {}) {
  if (typeof toolName !== 'string' || !input || typeof input !== 'object') {
    return deny('malformed-hook-input', 'Hook input is missing a tool name or tool input object');
  }

  /*
   * CHECKED BEFORE THE COMMAND AND PATH ROUTING, AND THAT ORDER IS THE WEAK
   * POINT OF THIS DESIGN. Read carries a file_path, so checking paths first
   * would refuse `Read CLAUDE.md`; SlashCommand carries a field literally named
   * `command` holding a slash-command name, so judging commands first would
   * refuse `/help` as an un-allowlisted shell command. Both are the kind of
   * refusal that gets a guard switched off.
   *
   * The cost is that this set now decides, and it is an ALLOW list: omitting a
   * tool blocks work LOUDLY and is fixed in one line, while wrongly adding a
   * tool that can execute or write is silent and reopens exactly the hole this
   * dispatch was rewritten to close. Nothing that can run a command or touch a
   * file belongs in it. Weigh an addition on that, not on convenience.
   */
  if (READ_ONLY_TOOLS.has(toolName)) return { allowed: true };

  /*
   * MCP tools keep the posture they already had: not blocked here, detected at
   * Stop by protected-file drift. Blocking them at PreToolUse is a separate
   * decision with its own blast radius, and smuggling it into this repair would
   * make a security change nobody reviewed for that.
   */
  if (toolName.startsWith('mcp__')) return { allowed: true };

  const command = firstStringField(input, COMMAND_FIELDS);
  if (command) return judgeShell(command.value);

  if (SHELL_TOOL_NAMES.has(toolName)) {
    return deny('missing-command', `${toolName} did not provide a command string`);
  }

  const target = firstStringField(input, PATH_FIELDS);
  if (target) return judgeWrite(target.value, input, cwd, sessionId);

  if (STRUCTURED_EDIT_TOOLS.has(toolName)) {
    return deny('missing-write-path', `${toolName} did not provide a path`);
  }

  /*
   * DEFAULT DENY. The line that used to be here said `return { allowed: true }`
   * and is the whole reason this file could be deleted from a shell the guard
   * was never shown. An unclassifiable tool is not a safe tool; it is one this
   * guard has no opinion about, and "no opinion" must not read as "approved".
   */
  return deny('unclassified-tool',
    `${toolName} carries neither a command this guard can judge nor a path it can check, and is not in READ_ONLY_TOOLS. `
    + 'If it cannot write to the repository, add it to that set in src/claudeGuard.mjs -- a one-line change, '
    + 'and a far cheaper failure than the silent hole this default-deny replaced');
}

export function hookDecision(result) {
  if (result?.allowed === true) return {};
  const id = result?.id ?? 'guard-error';
  const reason = result?.reason ?? 'Guard could not establish that this operation is safe';
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[agentbridge:${id}] ${reason}. This guard fails closed; ask the owner for an intentional override.`,
    },
  };
}
