/*
 * WHY THIS FILE EXISTS.
 *
 * The hook ENTRY POINT had no test. Every other test in this repo calls
 * evaluateClaudeTool directly, and the module was never the broken part -- on
 * 2026-09-17 the guard failed to protect its own source file while its unit
 * tests were green, because nothing exercised the wiring. CLAUDE.md rule 17.
 *
 * The property under test is specific and it is not "the guard decides
 * correctly". It is that THIS PROCESS ALWAYS EXITS 0 AND ALWAYS PRINTS A
 * DECISION. Claude Code treats a non-zero PreToolUse exit (other than 2) as a
 * non-blocking error and runs the tool anyway, so a crash here is a silent
 * ALLOW. Measured before the fix: a missing src/claudeGuard.mjs gave exit=1 and
 * empty stdout, which approved everything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A throwaway copy of bin/ and src/, so a test may delete the guard safely. */
function scratchCopy() {
  const dir = mkdtempSync(path.join(tmpdir(), 'guard-bin-'));
  mkdirSync(path.join(dir, 'bin'));
  mkdirSync(path.join(dir, 'src'));
  copyFileSync(path.join(repoRoot, 'bin', 'agentbridge-claude-guard.mjs'), path.join(dir, 'bin', 'agentbridge-claude-guard.mjs'));
  for (const f of readdirSync(path.join(repoRoot, 'src'))) {
    if (f.endsWith('.mjs')) copyFileSync(path.join(repoRoot, 'src', f), path.join(dir, 'src', f));
  }
  return dir;
}

function invoke(dir, payload, args = []) {
  const r = spawnSync(process.execPath, [path.join(dir, 'bin', 'agentbridge-claude-guard.mjs'), ...args], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const denied = (out) => {
  let parsed;
  try { parsed = JSON.parse(out); } catch { return false; }
  return parsed?.hookSpecificOutput?.permissionDecision === 'deny';
};

test('the binary refuses the deletion that started all this', (t) => {
  const dir = scratchCopy();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = invoke(dir, { tool_name: 'PowerShell', tool_input: { command: 'rm src/claudeGuard.mjs' }, cwd: repoRoot, session_id: 's' });
  /* EXACT exit code, not "not zero": a crash is also non-zero and means the opposite. */
  assert.equal(r.status, 0, 'a non-zero exit is a non-blocking error, which RUNS the tool');
  assert.equal(denied(r.stdout), true, `expected a deny decision, got ${r.stdout}`);
});

test('the binary lets ordinary work through', (t) => {
  const dir = scratchCopy();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const payload of [
    { tool_name: 'Bash', tool_input: { command: 'git status' } },
    { tool_name: 'PowerShell', tool_input: { command: 'Get-Content CLAUDE.md' } },
    { tool_name: 'Read', tool_input: { file_path: 'CLAUDE.md' } },
    { tool_name: 'CronList', tool_input: {} },
  ]) {
    const r = invoke(dir, { ...payload, cwd: repoRoot, session_id: 's' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '{}', `${payload.tool_name} must pass, got ${r.stdout}`);
  }
});

/*
 * THE BOOTSTRAPPING HOLE. PROTECTED_PATHS stops the guard being edited, but the
 * protection is what vanishes when the file does -- and the file really was
 * deleted once. A fail-closed default that needs a module to load is not a
 * fail-closed default, so the refusal must survive the guard being gone.
 */
test('the binary fails CLOSED when its own module is missing', (t) => {
  const dir = scratchCopy();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  /* POSITIVE FIRST: prove this copy refuses BEFORE breaking it, or the test
   * below would pass just as well against a harness that never ran. */
  const before = invoke(dir, { tool_name: 'Bash', tool_input: { command: 'rm x' }, cwd: repoRoot, session_id: 's' });
  assert.equal(denied(before.stdout), true, 'control: the intact copy must refuse first');

  rmSync(path.join(dir, 'src', 'claudeGuard.mjs'));
  const after = invoke(dir, { tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: repoRoot, session_id: 's' });
  assert.equal(after.status, 0, 'must not crash: a crash exit is treated as non-blocking and ALLOWS the tool');
  assert.equal(denied(after.stdout), true, `a guard that cannot load must refuse, got ${after.stdout}`);
});

test('the binary fails CLOSED when its own module is corrupt', (t) => {
  const dir = scratchCopy();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'src', 'claudeGuard.mjs'), 'this is not valid javascript {{{');
  const r = invoke(dir, { tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: repoRoot, session_id: 's' });
  assert.equal(r.status, 0);
  assert.equal(denied(r.stdout), true, `a corrupt guard must refuse, got ${r.stdout}`);
});

test('the binary fails CLOSED on malformed hook input', (t) => {
  const dir = scratchCopy();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const raw of ['not json at all', '', '{"tool_name":null,"tool_input":{}}']) {
    const r = invoke(dir, raw);
    assert.equal(r.status, 0);
    assert.equal(denied(r.stdout), true, `malformed input ${JSON.stringify(raw)} must refuse, got ${r.stdout}`);
  }
});

test('--session-start says so rather than silently writing nothing', (t) => {
  const dir = scratchCopy();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  rmSync(path.join(dir, 'src', 'guardSession.mjs'));
  const r = invoke(dir, '{"session_id":"s"}', ['--session-start']);
  assert.equal(r.status, 0);
  /* A SessionStart hook cannot deny, so the contract here is only that it
   * reports. The Stop gate is what refuses when no snapshot exists. */
  assert.match(r.stdout, /NOT INITIALISED/, `expected an explicit failure notice, got ${r.stdout}`);
});
