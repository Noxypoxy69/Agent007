import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { readSnapshot, isBaselineTest } from './guardSession.mjs';

const MUTATING_SHELL = /(?:^|[;&|\n]\s*|\s)(?:rm|unlink|shred|trash|mv|cp|rsync|install|tee|truncate|dd|sed\s+[^;&|\n]*?-i\b|perl\s+[^;&|\n]*?-\w*i\b|git\s+(?:rm|checkout|restore|clean|reset|commit|merge|rebase|push)|npm\s+(?:install|uninstall|pkg\s+(?:set|delete)))\b/i;
const SHELL_REDIRECT = /(?:^|[^<])>{1,2}\|?\s*[^;&|\n]+/;
const SKIP_MARKER = /(?:\b(?:it|test|describe|context)\.skip\s*\(|\bx(?:it|test|describe|context)\s*\(|@pytest\.mark\.(?:skip|xfail)|@unittest\.skip|\bpytest\.skip\s*\(|@Disabled\b|@Ignore\b|\bt\.Skip(?:Now)?\s*\(|#\[ignore\]|\[Ignore\])/;

const PROTECTED = [
  /(?:^|\/)\.claude(?:\/|$)/i,
  /(?:^|\/)CLAUDE(?:\.local)?\.md$/i,
  /(?:^|\/)package(?:-lock)?\.json$/i,
  /(?:^|\/)src\/claudeGuard\.mjs$/i,
  /(?:^|\/)src\/moduleGraph\.mjs$/i,
  /(?:^|\/)bin\/agentbridge-claude-guard\.mjs$/i,
  /(?:^|\/)scripts\/claude-stop-gate\.mjs$/i,
  /(?:^|\/)THIRD_PARTY_CODE\.md$/i,
  /(?:^|\/)src\/guardSession\.mjs$/i,
  /(?:^|\/)test\/claudeGuard\.test\.mjs$/i,
  /(?:^|\/)docs\/(?:ROADMAP|ORDER|THIRD_PARTY_CODE)\.md$/i,
  /(?:^|\/)docs\/CLAUDE_GUARD_PROVENANCE\.md$/i,
];


/**
 * Path-like tokens from a shell command, quotes and redirects handled.
 *
 * Deliberately generous: a token that might be a path is returned, and
 * isProtectedPath decides. Over-returning costs a refused command that can be
 * rephrased; under-returning is the bypass this exists to close.
 *
 * QUOTED AND RELATIVE FORMS NORMALISE TO THE SAME PLACE, because `rm
 * "src/claudeGuard.mjs"`, `rm ./src/claudeGuard.mjs` and
 * `rm src/../src/claudeGuard.mjs` are one operation wearing three spellings.
 * path.resolve collapses all of them; the quotes come off here.
 */
export function shellPathTokens(command) {
  if (typeof command !== 'string') return [];
  const out = [];
  // Split on whitespace outside quotes, keeping redirect operators separable.
  const spaced = command.replace(/([<>]{1,2})/g, ' $1 ');
  const parts = spaced.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) ?? [];
  for (let raw of parts) {
    raw = raw.trim();
    if (raw === '') continue;
    if (/^[<>|&;]+$/.test(raw)) continue;                 // operators
    const unquoted = raw.replace(/^['"]|['"]$/g, '');
    if (unquoted === '' || unquoted.startsWith('-')) continue;   // flags
    // A token is path-like if it has a separator or a file extension.
    if (!/[\\/]/.test(unquoted) && !/\.[A-Za-z0-9]{1,8}$/.test(unquoted)) continue;
    out.push(unquoted);
  }
  return [...new Set(out)];
}

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

export function isProtectedPath(filePath, cwd) {
  return normalizedCandidates(filePath, cwd).some((candidate) => PROTECTED.some((rule) => rule.test(candidate)));
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
export function isSessionBaselineTest(filePath, cwd = process.cwd()) {
  const snapshot = readSnapshot(cwd);
  if (!snapshot) return false;
  for (const candidate of normalizedCandidates(filePath, cwd)) {
    const rel = path.relative(snapshot.repoRoot, candidate).split(path.sep).join('/');
    if (isBaselineTest(rel, snapshot)) return true;
  }
  return false;
}

function deny(id, reason) {
  return { allowed: false, id, reason };
}

export function evaluateClaudeTool({ tool_name: toolName, tool_input: input = {}, cwd = process.cwd() } = {}) {
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
    if (isSessionBaselineTest(filePath, cwd)) {
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
    if (/\bclaude\s+(?:config\s+(?:set|add|remove|rm)|mcp\s+(?:add|remove|rm)|plugin\s+(?:install|uninstall|enable|disable|update|marketplace))\b/i.test(command)) {
      return deny('claude-config-mutation', 'Claude may not rewrite its own tools, plugins, hooks, or permissions');
    }
    if (/\bnpm\s+(?:install|uninstall|pkg\s+(?:set|delete))\b/i.test(command)) {
      return deny('package-control-mutation', 'Claude may not mutate the package manifest or dependency lock during containment');
    }
    const testMention = /(?:^|[\s'"=])(?:\.\/)?test\/[^\s'";&|]+\.test\.mjs\b/i.test(command);
    if (testMention && (MUTATING_SHELL.test(command) || SHELL_REDIRECT.test(command))) {
      return deny('test-removed', 'Shell mutation of an existing test is forbidden');
    }
    if (!MUTATING_SHELL.test(command) && !SHELL_REDIRECT.test(command)) return { allowed: true };
    if (/\bgit\s+push\b[^\n]*(?:\bmain\b|\bmaster\b|--force|-f\b)/i.test(command)) {
      return deny('protected-push', 'Direct or forced pushes to a protected branch are forbidden');
    }
    if (/\bgit\s+(?:reset\s+--hard|clean\s+-[^\n]*f)/i.test(command)) {
      return deny('destructive-git', 'Destructive git cleanup/reset is forbidden');
    }
    /*
     * PATH TOKENS, NOT THE WHOLE COMMAND.
     *
     * This line used to be:
     *   PROTECTED.some((rule) => rule.test(command.replaceAll('\\','/')))
     * and it matched nothing. Every PROTECTED rule is anchored with (?:^|\/)
     * and $ because it describes a PATH; applied to a command string, `rm
     * src/claudeGuard.mjs` has `src` preceded by a space, so the anchor fails.
     * Demonstrated through the real hook binary: rm src/claudeGuard.mjs,
     * cat > .claude/settings.json and printf "" > scripts/claude-stop-gate.mjs
     * were all ALLOWED. The regexes were correct for paths and useless here.
     *
     * So the command is tokenised, each token is normalised against the repo,
     * and isProtectedPath decides -- the same function the structured tools use.
     */
    for (const token of shellPathTokens(command)) {
      if (isProtectedPath(token, cwd)) {
        return deny('protected-control-shell', `Shell command targets protected control ${token}`);
      }
      if (isSessionBaselineTest(token, cwd)) {
        return deny('test-removed', `Shell mutation of baseline test ${token} is forbidden`);
      }
    }
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
