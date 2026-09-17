import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { readSnapshot, isBaselineTest, isProtectedRelPath } from './guardSession.mjs';
import { judgeShellCommand } from './shellAllowlist.mjs';

const MUTATING_SHELL = /(?:^|[;&|\n]\s*|\s)(?:rm|unlink|shred|trash|mv|cp|rsync|install|tee|truncate|dd|sed\s+[^;&|\n]*?-i\b|perl\s+[^;&|\n]*?-\w*i\b|git\s+(?:rm|checkout|restore|clean|reset|commit|merge|rebase|push)|npm\s+(?:install|uninstall|pkg\s+(?:set|delete)))\b/i;
const SHELL_REDIRECT = /(?:^|[^<])>{1,2}\|?\s*[^;&|\n]+/;
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

export function evaluateClaudeTool({ tool_name: toolName, tool_input: input = {}, cwd = process.cwd(), session_id: sessionId = null } = {}) {
  if (typeof toolName !== 'string' || !input || typeof input !== 'object') {
    return deny('malformed-hook-input', 'Hook input is missing a tool name or tool input object');
  }

  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(toolName)) {
    const filePath = input.file_path ?? input.notebook_path;
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return deny('missing-write-path', `${toolName} did not provide a path`);
    }
    if (isProtectedPath(filePath, cwd)) {
      return deny('protected-control', `${filePath} is part of the guard or completion contract`);
    }
    if (isSessionBaselineTest(filePath, cwd, sessionId)) {
      return deny('baseline-test-immutable', `${filePath} was present when the session began; baseline tests are not editable from inside it`);
    }
    const content = String(input.content ?? input.new_string ?? '');
    SKIP_MARKER.lastIndex = 0;
    if (/\.test\.mjs$/i.test(filePath) && SKIP_MARKER.test(content)) return deny('test-disabled', `Refusing to create disabled test ${filePath}`);
    return { allowed: true };
  }

  if (toolName === 'Bash') {
    const command = input.command;
    if (typeof command !== 'string') return deny('missing-command', 'Bash did not provide a command string');

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
     * cannot write, so naming a protected path is not a reason to refuse, and a
     * guard that blocks reading the rules is one people turn off.
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

  return { allowed: true };
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
