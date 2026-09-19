/**
 * observe-sha (bin/agentbridge.mjs) MUST run npm through its JS entry point, never
 * as bare 'npm'. On Windows npm is a .cmd shim and node 24 refuses to spawn a .cmd
 * without a shell (CVE-2024-27980): execFile('npm') is ENOENT, execFile('npm.cmd')
 * is EINVAL, so observe-sha never completed on this machine (9cdb400 fixed it by
 * going through node_modules/npm/bin/npm-cli.js).
 *
 * A blind audit of 9cdb400 found the fix correct but UNPINNED: the existing
 * test/auditWorkspaceUsesNpmCli.test.mjs reads only scripts/audit-workspace.mjs, so
 * reverting the observe-sha call sites back to run('npm', ...) would restore the
 * Windows bug with a fully green suite. This is that missing gate. bin/agentbridge.mjs
 * has top-level execution and cannot be imported, so it is checked as source text.
 *
 * IT PINS THE CONSTRUCT, NOT A MENTION. An earlier sibling gate matched the bare
 * string /npm-cli\.js/, which the diagnostic console.error('...npm-cli.js not found
 * beside node...') satisfied even with the workaround removed -- CLAUDE.md hollow
 * gate 13. So this asserts the path.join(...) resolver and the run(process.execPath,
 * [npmCli ...]) invocation, which a string in a message cannot fake, and asserts the
 * bad spelling is ABSENT. A fresh session must confirm it goes green now AND red if a
 * call site is reverted to run('npm', ...).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(fileURLToPath(new URL('../bin/agentbridge.mjs', import.meta.url)), 'utf8');
// Comment-blank so a mention in prose can neither satisfy nor trip the check.
// String literals are NOT blanked, which is why the assertions pin CONSTRUCTS
// (path.join, run(process.execPath, [npmCli) that cannot appear inside a string.
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + m.slice(p.length).replace(/./g, ' '));

test('observe-sha resolves npm-cli.js with path.join, not a bare mention', () => {
  assert.match(CODE, /path\.join\([^;]*['"]npm-cli\.js['"]\s*\)/,
    'must RESOLVE npm-cli.js via path.join -- a string in a diagnostic message must not satisfy this');
});

test('observe-sha invokes npm as node + npm-cli.js, and never as bare npm', () => {
  assert.match(CODE, /run\(\s*process\.execPath\s*,\s*\[\s*npmCli\b/,
    'npm must be run as run(process.execPath, [npmCli, ...]) -- node executing the JS entry point');
  assert.doesNotMatch(CODE, /(run|execFile\w*|spawn\w*)\(\s*['"]npm(\.cmd)?['"]/,
    'must not run/spawn bare npm or npm.cmd -- that is the Windows .cmd bug');
});
