import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/agentbridge.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('../', import.meta.url));

async function who(args) {
  try {
    const { stdout } = await run(process.execPath, [CLI, 'who', ...args], { cwd: REPO, maxBuffer: 32e6 });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(e) };
  }
}

/**
 * BOTH DIRECTIONS, because a gate that only refuses is an outage and one that
 * only permits is decoration. The refusals below all defaulted silently in the
 * first version: `--hours abc` printed "the last 6h" under a confident header,
 * and a mistyped `--registry-live` meant the disagreement alarm -- the only
 * reason to run this command -- never fired while the output looked normal.
 */

for (const [flag, value] of [
  ['hours', 'abc'], ['hours', '0'], ['hours', '-5'],
  ['recent-min', 'x'], ['recent-min', '0'],
  ['registry-live', 'notanumber'], ['registry-live', '-3'], ['registry-live', '1.5'],
]) {
  test(`REFUSES --${flag} ${value} rather than quietly defaulting`, async () => {
    const r = await who([`--${flag}`, value]);
    assert.equal(r.code, 2, `--${flag} ${value} must exit 2`);
    assert.match(r.stderr, new RegExp(`--${flag}`), 'the refusal must name the flag it refused');
    assert.match(r.stderr, /refusing rather than quietly using|is not usable/, 'and say what it declined to do');
    assert.equal(r.stdout.includes('work produced'), false, 'it must not also print a report');
  });
}

test('PERMITS the absent case: no flags at all is the documented default', async () => {
  const r = await who([]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /work produced in the last 6h/);
});

test('PERMITS valid values, and honours them rather than the default', async () => {
  const r = await who(['--hours', '3']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /work produced in the last 3h/);
});

test('--json is parseable and carries the reconcile block', async () => {
  const r = await who(['--hours', '2', '--json', '--registry-live', '0']);
  assert.equal(r.code, 0);
  const d = JSON.parse(r.stdout);
  assert.equal(d.reconcile.joinable, false, 'the two identifier spaces never join');
  assert.equal(d.reconcile.registryLive, 0);
  assert.ok(Array.isArray(d.sessions));
});

test('a directory that is not a repository fails loudly, not emptily', async () => {
  const r = await who(['--repo', '/']);
  assert.equal(r.code, 2, 'exit 2, not a cheerful empty report');
  assert.match(r.stderr, /cannot read git history/);
});

test('the command is in HELP — an undocumented command is a command nobody has', async () => {
  const src = await readFile(CLI, 'utf8');
  assert.match(src, /agentbridge who \[/, 'who must appear in the HELP text');
  assert.match(src, /never route on this|must not be used to route/i,
    'and the help must say it is not a roster, because that is the whole risk of it existing');
});
