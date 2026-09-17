/*
 * THE PROBE THAT BECAME A GATE.
 *
 * On 2026-09-17 a live session on the operator's Windows machine attempted
 * `rm src/claudeGuard.mjs` and `Remove-Item src/claudeGuard.mjs` and both were
 * refused by the repo guard, each refusal carrying the [agentbridge: prefix that
 * distinguishes it from the Claude Code auto-mode classifier (rule 18). That was
 * the first clean observation that the guard is reached at all.
 *
 * It was also ONE OBSERVATION OF TWO VERBS. CLAUDE.md rule 8: an adversarial
 * probe bounds nothing -- it is evidence that a specific attack fails, never
 * evidence that the remaining ones do. `del`, `unlink`, `git rm`, `mv`,
 * `Out-File` and everything nobody has thought of were all untested.
 *
 * So this file does not hard-code the probe. Its fixtures are GENERATED from the
 * guard's own shipped lists:
 *
 *   targets  <- protectedFilesIn(repoRoot)   (src/guardSession.mjs)
 *   allowed  <- ALLOWED_FIRST_TOKENS         (src/shellAllowlist.mjs)
 *
 * Adding a protected path extends the target set. Adding an allowed command
 * extends the positive set and shrinks the refused complement. Neither requires
 * anybody to remember this file exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateClaudeTool } from '../src/claudeGuard.mjs';
import { judgeShellCommand, ALLOWED_FIRST_TOKENS } from '../src/shellAllowlist.mjs';
import { protectedFilesIn } from '../src/guardSession.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* The real shipped list, not a copy of it. */
const TARGETS = protectedFilesIn(repoRoot);

/*
 * Tool names spanning the dispatch layer: the one that always worked, the one
 * that did not and deleted the guard, and names that exist nowhere. A verb must
 * be refused under all of them, because the tool's NAME is not supposed to
 * decide anything any more.
 */
const TOOL_NAMES = ['Bash', 'PowerShell', 'pwsh', 'SomeFutureShell'];

/*
 * Named instances. These do NOT bound the property -- the complement test below
 * does that -- but a regression corpus is how a specific past failure stays
 * fixed. Deliberately free of shell metacharacters so that a refusal here is the
 * verb being refused, not a bracket being refused (rule 4: never assert on a
 * proxy).
 */
const DESTRUCTIVE = [
  'rm', 'rm -f', 'rm -rf', 'del', 'erase', 'unlink', 'shred', 'truncate -s 0',
  'mv', 'cp /dev/null', 'dd if=/dev/null of=', 'tee', 'install',
  'Remove-Item', 'Remove-Item -Force', 'ri', 'Move-Item', 'Copy-Item',
  'Set-Content', 'Add-Content', 'Clear-Content', 'Out-File', 'New-Item',
  'git rm', 'git checkout --', 'git restore', 'git clean -f',
  'node -e process.exit', 'python -c pass', 'perl -e exit', 'eval',
  'Invoke-Expression', 'iex', 'Start-Process', 'bash -c exit', 'sh -c exit',
];

test('every destructive verb is refused against every protected file, under every tool name', () => {
  assert.ok(TARGETS.length > 0, 'precondition: the protected list must not be empty');
  let checked = 0;
  for (const target of TARGETS) {
    for (const verb of DESTRUCTIVE) {
      const command = `${verb} ${target}`;
      for (const toolName of TOOL_NAMES) {
        const verdict = evaluateClaudeTool({
          tool_name: toolName, tool_input: { command }, cwd: repoRoot, session_id: 's',
        });
        assert.equal(verdict.allowed, false, `${toolName}: "${command}" must be refused`);
        checked += 1;
      }
    }
  }
  /*
   * ASSERT THE WORK HAPPENED (rule 9 / rule 14). A loop whose fixture list came
   * back empty passes silently and reports nothing, which is a gate that checked
   * nothing printing a pass.
   */
  assert.equal(checked, TARGETS.length * DESTRUCTIVE.length * TOOL_NAMES.length);
  assert.ok(checked > 1000, `expected a real sweep, only made ${checked} checks`);
});

/*
 * THE TOTAL PROPERTY, and the reason this file is a gate rather than a bigger
 * probe. The destructive corpus above is finite and always will be. The
 * allowlist is finite too -- so its COMPLEMENT is checkable in general, and that
 * covers every verb nobody has thought of yet.
 */
test('the allowlist is the boundary: any unlisted first token is refused', () => {
  const allowed = new Set(ALLOWED_FIRST_TOKENS.map((t) => t.toLowerCase()));
  const candidates = [
    ...DESTRUCTIVE.map((v) => v.split(/\s+/)[0]),
    'wget', 'curl', 'Invoke-WebRequest', 'scp', 'rsync', 'chmod', 'chown', 'ln',
    'mkdir', 'touch', 'patch', 'xargs', 'awk', 'ed', 'vi', 'emacs', 'powershell',
    'cmd', 'wsl', 'docker', 'ssh', 'zzz-unknown-verb', 'Q', 'do-something-new',
  ];
  let refused = 0;
  for (const token of candidates) {
    if (allowed.has(token.toLowerCase())) continue;   // genuinely allowed; not this test's business
    const verdict = judgeShellCommand(`${token} CLAUDE.md`);
    assert.equal(verdict.allowed, false, `"${token}" is not in the allowlist and must be refused`);
    refused += 1;
  }
  assert.ok(refused > 20, `expected a meaningful sweep, only refused ${refused}`);
});

/*
 * THE POSITIVE HALF, WITHOUT WHICH BOTH TESTS ABOVE PASS AGAINST A GUARD THAT
 * REFUSES EVERYTHING. A rail that only refuses is an outage, and an outage gets
 * switched off -- which loses the Stop gate with it.
 *
 * The forms are per-token because some entries are only safe in one shape: git
 * needs a read-only subcommand, node only --test, sed only a line-range print.
 * A new allowlist entry whose default form is refused turns this red, which is
 * the right kind of red: it asks whoever added it to state the safe shape.
 */
const FORMS = {
  git: 'git status',
  node: 'node --test test/x.test.mjs',
  npm: 'npm test',
  sed: 'sed -n 1,5p CLAUDE.md',
  jq: 'jq . package.json',
};

test('every token the allowlist names has an accepted form', () => {
  for (const token of ALLOWED_FIRST_TOKENS) {
    const command = FORMS[token] ?? `${token} CLAUDE.md`;
    const verdict = judgeShellCommand(command);
    assert.equal(verdict.allowed, true,
      `"${command}" is built from the shipped allowlist and must pass (${verdict.reason ?? ''})`);
  }
});

/*
 * The two commands actually observed being refused on the operator's machine,
 * kept verbatim. If either ever starts passing, the thing we watched work has
 * stopped working.
 */
test('the two live-observed refusals stay refused', () => {
  for (const command of ['rm src/claudeGuard.mjs', 'Remove-Item src/claudeGuard.mjs']) {
    for (const toolName of ['Bash', 'PowerShell']) {
      const verdict = evaluateClaudeTool({
        tool_name: toolName, tool_input: { command }, cwd: repoRoot, session_id: 's',
      });
      assert.equal(verdict.allowed, false, `${toolName}: ${command}`);
      assert.equal(verdict.id, 'shell-not-allowlisted',
        `${toolName}: ${command} must be refused BY THE SHELL RAIL, not incidentally`);
    }
  }
});
