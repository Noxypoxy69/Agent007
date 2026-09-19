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
  /*
   * THIS MATCHED THE SUBJECT'S OWN ERROR MESSAGE, AND SO IT COULD NOT FAIL.
   *
   * The assertion was `match(CODE, /npm-cli\.js/)`. Comment-blanking was in
   * place, but STRING LITERALS were not blanked -- and the subject contains
   *
   *   console.log('installing   SKIPPED -- npm-cli.js not found beside node');
   *
   * so the gate was satisfied by the diagnostic that fires when the workaround
   * is MISSING. Measured 2026-09-18: reverting the resolution to `const cli =
   * 'npm'` left this test green, 1 of 1, with the Windows bug fully restored.
   *
   * That is CLAUDE.md hollow gate 13 -- a gate matching `lease_token` inside
   * the CLI's own error message about a missing lease_token -- reproduced in a
   * test written the same night the rule was being quoted.
   *
   * Blanking string contents as well would break the third assertion below,
   * which NEEDS the quotes to spot execFile('npm'). So instead of widening the
   * blanking, the first assertion now pins the CONSTRUCT: the path.join that
   * resolves the entry point, which prose and diagnostics cannot satisfy.
   */
  assert.match(CODE, /path\.join\([^;]*['"]npm-cli\.js['"]\s*\)/,
    'must RESOLVE npm-cli.js with path.join, not merely mention it -- a string in an error '
    + 'message satisfied the old assertion while the workaround was gone');
  assert.match(CODE, /process\.execPath/, 'must spawn node (process.execPath), not npm directly');
  assert.doesNotMatch(CODE, /(execFile\w*|spawn\w*)\(\s*['"]npm(\.cmd)?['"]/,
    'must not spawn bare npm or npm.cmd -- that is the Windows .cmd bug');
});
