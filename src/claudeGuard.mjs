import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

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
  /(?:^|\/)test\/claudeGuard\.test\.mjs$/i,
  /(?:^|\/)docs\/(?:ROADMAP|ORDER|THIRD_PARTY_CODE)\.md$/i,
  /(?:^|\/)docs\/CLAUDE_GUARD_PROVENANCE\.md$/i,
];

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

export function isExistingTest(filePath, cwd = process.cwd()) {
  const candidates = normalizedCandidates(filePath, cwd);
  return candidates.some((candidate) => /(?:^|\/)test\/[^/]+\.test\.mjs$/i.test(candidate) && existsSync(candidate));
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
    if (isExistingTest(filePath, cwd)) {
      return deny('existing-test-immutable', `Existing test ${filePath} is immutable during a coding session`);
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
    const protectedMention = PROTECTED.some((rule) => rule.test(command.replaceAll('\\', '/')));
    if (protectedMention) return deny('protected-control-shell', 'Shell command may mutate a protected control file');
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
