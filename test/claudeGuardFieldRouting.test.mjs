/**
 * A COMMAND DOES NOT EXCUSE A PATH (T-096 N4, T-103).
 *
 * evaluateClaudeTool returned the SHELL verdict for any payload carrying a
 * command, so {command:'git status', file_path:'CLAUDE.md'} was allowed with the
 * protected path never examined; and only the first field of each list was ever
 * read. No existing test could fail for it: none carried two fields at once.
 *
 * Every refusal is asserted by its exact id, never by `allowed === false`: a
 * denial for some other reason would satisfy a bare negative while the property
 * went untested. Each negative is preceded by the positive that shows the call
 * reaches the check. The pairings are GENERATED from the exported field lists
 * (CLAUDE.md rule 7), so a field added to either list is covered on arrival.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { evaluateClaudeTool, COMMAND_FIELDS, PATH_FIELDS } from '../src/claudeGuard.mjs';

const ROOT = mkdtempSync(path.join(tmpdir(), 'ab-field-routing-'));
process.on('exit', () => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ } });

const SESSION = `t103-${randomUUID()}`;
const call = (tool_name, tool_input) => evaluateClaudeTool({ tool_name, tool_input, cwd: ROOT, session_id: SESSION });

test('control: each half is judged on its own as expected', () => {
  assert.ok(COMMAND_FIELDS.length > 0 && PATH_FIELDS.length > 0, 'the field lists did not load');
  assert.deepEqual(call('Bash', { command: 'git status' }), { allowed: true },
    'git status alone was refused, so the pairings below cannot isolate the path');
  assert.equal(call('Edit', { file_path: 'CLAUDE.md', old_string: 'a', new_string: 'b' }).id, 'protected-control',
    'CLAUDE.md alone is not protected here, so the pairings below prove nothing');
  assert.deepEqual(call('Edit', { file_path: 'src/ordinary.mjs', old_string: 'a', new_string: 'b' }), { allowed: true },
    'an ordinary edit was refused, so a refusal below could be for any reason');
});

for (const cf of COMMAND_FIELDS) {
  for (const pf of PATH_FIELDS) {
    test(`{${cf}: allowlisted, ${pf}: CLAUDE.md} is judged as a write too`, () => {
      assert.equal(call('SomeTool', { [cf]: 'git status', [pf]: 'CLAUDE.md' }).id, 'protected-control',
        `a protected ${pf} beside an allowlisted ${cf} was never examined`);
    });
  }
}

test('every path field is judged, not only the first one listed', () => {
  assert.equal(call('SomeTool', { file_path: 'README.md', path: 'CLAUDE.md' }).id, 'protected-control',
    'a protected path in a later path field was ignored because an earlier field held a benign one');
});

test('every command field is judged, not only the first one listed', () => {
  assert.equal(call('SomeTool', { command: 'git status', script: 'rm -rf src' }).id, 'shell-not-allowlisted',
    'a destructive script beside an allowlisted command was never judged');
});

test('a refused command is still refused as a shell when a benign path rides along', () => {
  assert.equal(call('SomeTool', { command: 'rm -rf src', file_path: 'README.md' }).id, 'shell-not-allowlisted');
});

test('control: an allowlisted command beside an ordinary path is still allowed', () => {
  assert.deepEqual(call('SomeTool', { command: 'git status', file_path: 'README.md' }), { allowed: true },
    'the repair refuses ordinary payloads, which is how a guard gets switched off');
});
