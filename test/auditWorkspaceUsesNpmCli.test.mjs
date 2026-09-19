/**
 * scripts/audit-workspace.mjs MUST run npm through its JS entry point, never as
 * bare 'npm'. On Windows npm is a .cmd shim and node 24 refuses to spawn a .cmd
 * without a shell (CVE-2024-27980): execFile('npm') is ENOENT and
 * execFile('npm.cmd') is EINVAL. Reverting to bare npm silently breaks the audit
 * runner on the exact platform it exists to run on. The file has top-level side
 * effects (it clones and runs a suite on import), so it cannot be imported; this
 * pins the workaround as source text, the way test/edgeSourceGuards does for the
 * Deno edge function.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(fileURLToPath(new URL('../scripts/audit-workspace.mjs', import.meta.url)), 'utf8');
// Comment-blank so a mention in prose can neither satisfy nor trip the check.
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + m.slice(p.length).replace(/./g, ' '));

test('audit-workspace runs npm via npm-cli.js beside node, not bare npm', () => {
  assert.match(CODE, /npm-cli\.js/, 'must reference npm-cli.js');
  assert.match(CODE, /process\.execPath/, 'must spawn node (process.execPath), not npm directly');
  assert.doesNotMatch(CODE, /(execFile\w*|spawn\w*)\(\s*['"]npm(\.cmd)?['"]/,
    'must not spawn bare npm or npm.cmd -- that is the Windows .cmd bug');
});
